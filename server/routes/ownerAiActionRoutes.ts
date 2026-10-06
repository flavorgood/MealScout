import { ReverseOsmosisError } from "@tradescout-infinity/reverse-osmosis";
import { registerReverseOsmosisRoutes } from "./reverseOsmosisRoutes";
import { registerOwnerAiNativeProfileRoutes } from "./ownerAiNativeProfileRoutes";
import { registerOnboardingJobRoutes } from "./onboardingJobRoutes";
import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { z, ZodError } from "zod";

import { db } from "../db";
import { isAuthenticated } from "../unifiedAuth";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import {
  OWNER_AI_CONNECTOR_SCOPES,
  OWNER_AI_PACKET_JSON_SCHEMA,
} from "@shared/ownerAiActions";
import { restaurants } from "@shared/schema";
import { OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA } from "@shared/ownerAiCapabilities";
import {
  OwnerAiActionError,
  approveOwnerAiDraft,
  assertActualRestaurantOwner,
  authenticateOwnerAiConnector,
  cancelOwnerAiDraft,
  createOwnerAiConnectorCredential,
  createOwnerAiDraft,
  getOwnerAiContextForCurrentOwner,
  getOwnerAiDraftForOwner,
  getOwnerAiDraftForConnector,
  getOwnerAiSocialPreview,
  getOwnerAiMediaPreview,
  listOwnerAiConnectorCredentials,
  listOwnerAiDrafts,
  revokeOwnerAiConnectorCredential,
  updateOwnerAiDraft,
  type OwnerAiConnectorPrincipal,
} from "../services/ownerAiActions";
import {
  OwnerAiOAuthError,
  authorizeOwnerAiClient,
  denyOwnerAiClient,
  exchangeOwnerAiOAuthToken,
  ownerAiAuthorizationServerMetadata,
  ownerAiOAuthChallengeHeader,
  ownerAiProfileMcpResourceUrl,
  ownerAiProtectedResourceMetadata,
  prepareOwnerAiAuthorization,
  registerOwnerAiOAuthClient,
  revokeOwnerAiOAuthToken,
  revokeRefreshTokensForAccessKey,
} from "../services/ownerAiOAuth";
import { handleOwnerAiMcpRequest } from "../services/ownerAiMcp";
import { ownerAiProfileCapabilities } from "../services/ownerAiProfileCapabilities";
import { createOwnerAiOfficialSourceDraft, readOwnerAiSourceReviews } from "../services/ownerAiSourceReviews";
import { toPublicRestaurantListingWithVisibility } from "../publicProfiles/toPublicRestaurantListingWithVisibility";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";

type ConnectorRequest = Request & {
  ownerAiConnector?: OwnerAiConnectorPrincipal;
};

const ownerAiRemoteConnectorEnabled = () =>
  !["0", "false", "off", "disabled"].includes(
    String(process.env.OWNER_AI_REMOTE_CONNECTOR_ENABLED ?? "true")
      .trim()
      .toLowerCase(),
  );

const requireOwnerAiRemoteConnector = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (ownerAiRemoteConnectorEnabled()) return next();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "300");
  return res.status(503).json({
    error: "MealScout remote owner AI connections are temporarily disabled",
  });
};

const bearerToken = (req: Request) => {
  const match = String(req.headers.authorization || "").match(
    /^Bearer\s+(.+)$/i,
  );
  return match?.[1]?.trim() || "";
};

const connectorIdempotencyKey = (req: Request) => {
  const value = String(req.headers["idempotency-key"] || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new OwnerAiActionError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Connector draft creation requires an Idempotency-Key header (8-200 safe characters)",
    );
  }
  return value;
};

const contextOffsets = (req: Request) => ({
  menuOffset: Math.max(
    0,
    Math.min(
      100_000,
      Number.parseInt(String(req.query.menuOffset || "0"), 10) || 0,
    ),
  ),
  menuCategoryOffset: Math.max(
    0,
    Math.min(
      100_000,
      Number.parseInt(String(req.query.menuCategoryOffset || "0"), 10) || 0,
    ),
  ),
  menuItemOffset: Math.max(
    0,
    Math.min(
      1_000_000,
      Number.parseInt(String(req.query.menuItemOffset || "0"), 10) || 0,
    ),
  ),
  scheduleOffset: Math.max(
    0,
    Math.min(
      100_000,
      Number.parseInt(String(req.query.scheduleOffset || "0"), 10) || 0,
    ),
  ),
  dealOffset: Math.max(
    0,
    Math.min(
      100_000,
      Number.parseInt(String(req.query.dealOffset || "0"), 10) || 0,
    ),
  ),
});

const connectorAuth =
  (scope: (typeof OWNER_AI_CONNECTOR_SCOPES)[number]) =>
  async (req: ConnectorRequest, _res: Response, next: NextFunction) => {
    try {
      req.ownerAiConnector = await authenticateOwnerAiConnector(
        bearerToken(req),
        scope,
      );
      next();
    } catch (error) {
      next(error);
    }
  };

const asyncRoute =
  (handler: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

const credentialCreateSchema = z
  .object({
    restaurantId: z.string().uuid(),
    name: z.string().trim().min(1).max(160).optional(),
    expiresAt: z.string().datetime().optional().nullable(),
  })
  .strict();

const revisionSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

const updateDraftSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    request: z.unknown(),
  })
  .strict();

const oauthAuthorizationFields = (value: Record<string, unknown>) => ({
  response_type: value.response_type,
  client_id: value.client_id,
  redirect_uri: value.redirect_uri,
  code_challenge: value.code_challenge,
  code_challenge_method: value.code_challenge_method,
  scope: value.scope,
  state: value.state,
  resource: value.resource,
  ...(value.restaurant_id ? { restaurant_id: value.restaurant_id } : {}),
});

const instructions = {
  name: "MealScout Owner AI Actions",
  version: "1.0",
  modelNeutral: true,
  purpose:
    "Let an owner use a remote-tool-capable AI to prepare MealScout changes and, after explicit consent to one exact revision, execute approval and publishing. Portable and copied-key fallbacks remain draft-only.",
  sequence: [
    "When the owner pastes a public MealScout profile link, the AI reads its Selective Intelligence manifest and profile-specific MCP link, asks before adoption when no action was requested, and starts MealScout OAuth for that exact profile. The general https://www.mealscout.us/api/owner-ai/mcp resource and portable JSON fallback remain available.",
    "The AI reads current MealScout context through the owner-bound connection.",
    "The AI submits the same portable JSON draft request used by the owner UI.",
    "MealScout generates deterministic platform copy and branded SVG image previews, while preserving any AI-supplied alternatives.",
    "The AI shows the actual owner the exact packet, media-rights affirmation, generated copy, generated image previews, and connected destinations in their current chat.",
    "Only an exact-revision consent handle plus explicit owner approval in that chat (or the MealScout review page fallback) commits MealScout changes and then attempts the selected connected socials sequentially.",
    "The same connector can read only its own draft status and safe per-platform results so the AI chat can report the outcome.",
  ],
  safety: {
    connectorCan: [
      "read its attached business context",
      "create drafts",
      "read status/results for drafts created by that exact connector key and business",
      "after explicit per-revision owner consent, apply that exact draft and publish its approved social posts",
    ],
    connectorCannot: [
      "choose a user or business in request payload",
      "update or cancel a draft",
      "approve a revision the owner has not been shown",
      "reuse consent after the revision changes or the short-lived consent handle expires",
      "publish to a social account that is not connected in MealScout",
    ],
    remoteMedia:
      "Any supplied logo, cover, gallery, menu, deal, or social image URL requires a packet-level owner rights/usage affirmation visible during approval. MealScout-generated fallback cards require no claim.",
    mutationBoundary:
      "No canonical content write, image hosting, social intent, or social publication occurs before explicit actual-owner approval of the exact immutable revision, captured through MCP consent or the MealScout review page.",
  },
  portablePacket: {
    schema: "/api/owner-ai/schema",
    openapi: "/api/owner-ai/openapi.json",
    note: "An AI without tool access can return this exact JSON object for the owner to paste into MealScout.",
  },
  remoteMcp: {
    url: "/api/owner-ai/mcp",
    authorization:
      "OAuth 2.1 authorization code with PKCE and MealScout owner consent",
    tools: [
      "get_mealscout_profile_capabilities",
      "preview_mealscout_profile_changes",
      "get_mealscout_context",
      "create_mealscout_draft",
      "get_mealscout_draft_status",
      "prepare_mealscout_approval",
      "get_mealscout_media_preview",
      "approve_mealscout_draft",
    ],
  },
};

const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "MealScout Owner AI Actions",
    version: "1.1.0",
    description:
      "Vendor-neutral owner AI API. OAuth/MCP connections can apply and publish an exact immutable revision only after per-revision owner consent; manually copied legacy bearer keys remain draft-only.",
  },
  servers: [{ url: "https://www.mealscout.us" }],
  components: {
    securitySchemes: {
      connectorBearer: { type: "http", scheme: "bearer" },
      mealScoutOAuth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://www.mealscout.us/owner-ai/authorize",
            tokenUrl: "https://www.mealscout.us/api/owner-ai/oauth/token",
            scopes: Object.fromEntries(
              OWNER_AI_CONNECTOR_SCOPES.map((scope) => [scope, scope]),
            ),
          },
        },
      },
      ownerSession: { type: "apiKey", in: "cookie", name: "connect.sid" },
    },
    schemas: { OwnerAiDraftRequest: OWNER_AI_PACKET_JSON_SCHEMA },
  },
  paths: {
    "/api/owner-ai/restaurants/{restaurantId}/source-reviews": { get: { operationId: "readMealScoutOfficialSourceReviews", security: [{ ownerSession: [] }], summary: "Read current-owner private nightly semantic proposals; removed or hidden evidence is withheld", responses: { "200": { description: "Private proposals and explicit holds; no application authority" }, "403": { description: "Current native owner/public visibility required" } } } },
    "/api/owner-ai/restaurants/{restaurantId}/source-draft": { post: { operationId: "prepareMealScoutOfficialSourceDraft", security: [{ ownerSession: [] }], summary: "Re-fetch verified official sources and prepare a native draft for exact owner review", requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: false } } } }, responses: { "201": { description: "Native evidence-bound draft created; exact revision approval still required" }, "200": { description: "No supported facts; explicit holds and no draft" }, "409": { description: "Sources or native versions changed" } } } },
    "/api/owner-ai/connector/capabilities": {
      get: {
        operationId: "getMealScoutProfileCapabilities",
        summary: "Read persisted owner-bound native profile type, supported capabilities and credential state",
        security: [{ mealScoutOAuth: ["owner_ai:context"] }, { connectorBearer: [] }],
        responses: { "200": { description: "Read-only capabilities; no application grant" }, "403": { description: "Current owner or credential state rejected" } },
      },
    },
    "/api/owner-ai/connector/preview": {
      post: {
        operationId: "previewMealScoutProfileChanges",
        summary: "Strict read-only preview; source declarations remain unverified and confer no grants",
        security: [{ mealScoutOAuth: ["owner_ai:context", "owner_ai:drafts:create"] }, { connectorBearer: [] }],
        requestBody: { required: true, content: { "application/json": { schema: OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA } } },
        responses: { "200": { description: "Read-only preview, approval required, canApply false" }, "409": { description: "Native versions stale" }, "403": { description: "Authority, visibility or scope rejected" } },
      },
    },
    "/api/owner-ai/connector/context": {
      get: {
        operationId: "getMealScoutOwnerContext",
        summary: "Read context for the business encoded in the connector key",
        security: [
          { mealScoutOAuth: ["owner_ai:context"] },
          { connectorBearer: [] },
        ],
        responses: {
          "200": { description: "Owner-scoped business context and versions" },
        },
      },
    },
    "/api/owner-ai/connector/drafts": {
      post: {
        operationId: "createMealScoutOwnerDraft",
        summary: "Create a non-mutating owner approval draft",
        security: [
          { mealScoutOAuth: ["owner_ai:drafts:create"] },
          { connectorBearer: [] },
        ],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: {
              type: "string",
              minLength: 8,
              maxLength: 200,
              pattern: "^[A-Za-z0-9._:-]+$",
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OwnerAiDraftRequest" },
            },
          },
        },
        responses: {
          "201": { description: "Draft created with approvalUrl" },
          "409": { description: "Context versions are stale" },
        },
      },
    },
    "/api/owner-ai/connector/drafts/{draftId}": {
      get: {
        operationId: "getMealScoutOwnerDraftStatus",
        summary:
          "Read status/results only for a draft created by this exact connector and business",
        security: [
          { mealScoutOAuth: ["owner_ai:drafts:read"] },
          { connectorBearer: [] },
        ],
        parameters: [
          {
            name: "draftId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": { description: "Safe draft and per-platform result status" },
          "404": { description: "Draft not owned by this connector" },
        },
      },
    },
  },
};

export function registerOwnerAiActionRoutes(app: Express) {
  registerOwnerAiNativeProfileRoutes(app);
  registerReverseOsmosisRoutes(app);
  registerOnboardingJobRoutes(app, {
    database: db,
    isAuthenticated,
    limiter: distributedRateLimit({ scope: "owner-ai:onboarding", limit: 12, windowMs: 60_000, key: (req: any) => String(req.user?.id || "unresolved") }),
    enabled: () => process.env.MEALSCOUT_DURABLE_ONBOARDING_ENABLED === "true",
  });
  const connectorRateKey = (req: ConnectorRequest) =>
    req.ownerAiConnector?.apiKeyId || "owner-ai-connector-unresolved";
  const connectorContextLimiter = distributedRateLimit({
    scope: "owner-ai:connector-context",
    limit: 120,
    windowMs: 60 * 1000,
    key: connectorRateKey,
  });
  const connectorDraftCreateLimiter = distributedRateLimit({
    scope: "owner-ai:connector-draft-create",
    limit: 30,
    windowMs: 60 * 60 * 1000,
    key: connectorRateKey,
  });
  const connectorDraftStatusLimiter = distributedRateLimit({
    scope: "owner-ai:connector-draft-status",
    limit: 120,
    windowMs: 60 * 1000,
    key: connectorRateKey,
  });
  const oauthRegistrationLimiter = distributedRateLimit({
    scope: "owner-ai:oauth-register",
    limit: 30,
    windowMs: 60 * 60 * 1000,
    key: (req) => req.ip || "unknown",
  });
  const oauthTokenLimiter = distributedRateLimit({
    scope: "owner-ai:oauth-token",
    limit: 120,
    windowMs: 60 * 60 * 1000,
    key: (req) => req.ip || "unknown",
  });
  const mcpLimiter = distributedRateLimit({
    scope: "owner-ai:mcp",
    limit: 180,
    windowMs: 60 * 1000,
    key: connectorRateKey,
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json(ownerAiAuthorizationServerMetadata()),
  );
  app.get("/.well-known/oauth-protected-resource", (_req, res) =>
    res.json(ownerAiProtectedResourceMetadata()),
  );
  app.get(
    "/.well-known/oauth-protected-resource/api/owner-ai/mcp",
    (_req, res) => res.json(ownerAiProtectedResourceMetadata()),
  );
  app.get(
    "/.well-known/oauth-protected-resource/api/owner-ai/profiles/:restaurantId/mcp",
    (req, res) => {
      const parsedId = z.string().uuid().safeParse(req.params.restaurantId);
      if (!parsedId.success) {
        return res
          .status(404)
          .json({ error: "MealScout profile target not found" });
      }
      const resource = ownerAiProfileMcpResourceUrl(parsedId.data);
      return res.json(ownerAiProtectedResourceMetadata(resource));
    },
  );

  app.post(
    "/api/owner-ai/oauth/register",
    requireOwnerAiRemoteConnector,
    oauthRegistrationLimiter,
    asyncRoute(async (req, res) => {
      res.status(201).json(registerOwnerAiOAuthClient(req.body));
    }),
  );

  app.get(
    "/api/owner-ai/oauth/authorize/prepare",
    requireOwnerAiRemoteConnector,
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(
        await prepareOwnerAiAuthorization(
          oauthAuthorizationFields(req.query as Record<string, unknown>),
          String(req.user.id),
        ),
      );
    }),
  );

  app.post(
    "/api/owner-ai/oauth/authorize",
    requireOwnerAiRemoteConnector,
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(
        await authorizeOwnerAiClient(
          oauthAuthorizationFields(req.body as Record<string, unknown>),
          String(req.user.id),
        ),
      );
    }),
  );

  app.post(
    "/api/owner-ai/oauth/authorize/deny",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(
        await denyOwnerAiClient(
          oauthAuthorizationFields(req.body as Record<string, unknown>),
          String(req.user.id),
        ),
      );
    }),
  );

  app.post(
    "/api/owner-ai/oauth/token",
    requireOwnerAiRemoteConnector,
    oauthTokenLimiter,
    asyncRoute(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.json(await exchangeOwnerAiOAuthToken(req.body));
    }),
  );

  app.post(
    "/api/owner-ai/oauth/revoke",
    oauthTokenLimiter,
    asyncRoute(async (req, res) => {
      await revokeOwnerAiOAuthToken(req.body);
      res.status(200).send();
    }),
  );

  const rejectMcpGet = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res
      .status(405)
      .json({ error: "Use Streamable HTTP POST for MealScout MCP" });
  };
  app.get("/api/owner-ai/mcp", rejectMcpGet);
  app.get("/api/owner-ai/profiles/:restaurantId/mcp", rejectMcpGet);

  const handleMcpPost = async (req: ConnectorRequest, res: Response) => {
    const targetIdResult = req.params.restaurantId
      ? z.string().uuid().safeParse(req.params.restaurantId)
      : null;
    if (targetIdResult && !targetIdResult.success) {
      return res
        .status(404)
        .json({ error: "MealScout profile target not found" });
    }
    const targetRestaurantId = targetIdResult?.success
      ? targetIdResult.data.toLowerCase()
      : null;
    try {
      req.ownerAiConnector = await authenticateOwnerAiConnector(
        bearerToken(req),
      );
    } catch (error) {
      if (error instanceof OwnerAiActionError && error.status === 401) {
        res.setHeader(
          "WWW-Authenticate",
          ownerAiOAuthChallengeHeader(targetRestaurantId),
        );
        return res.status(401).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "MealScout sign-in required" },
        });
      }
      throw error;
    }
    if (
      targetRestaurantId &&
      req.ownerAiConnector.restaurantId.toLowerCase() !== targetRestaurantId
    ) {
      return res.status(403).json({
        jsonrpc: "2.0",
        id: (req.body as any)?.id ?? null,
        error: {
          code: -32003,
          message: "This MealScout connection belongs to a different profile",
        },
      });
    }
    await new Promise<void>((resolve, reject) =>
      mcpLimiter(req, res, (error?: unknown) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (res.headersSent) return;
    const protocolVersion = String(
      req.headers["mcp-protocol-version"] || "2025-11-25",
    );
    const methodHeader = String(req.headers["mcp-method"] || "");
    const nameHeader = String(req.headers["mcp-name"] || "");
    const bodyMethod = String((req.body as any)?.method || "");
    const bodyName = String((req.body as any)?.params?.name || "");
    if (
      (methodHeader && methodHeader !== bodyMethod) ||
      (nameHeader && bodyName && nameHeader !== bodyName)
    ) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: (req.body as any)?.id ?? null,
        error: {
          code: -32600,
          message: "MCP routing headers do not match the request body",
        },
      });
    }
    const response = await handleOwnerAiMcpRequest(
      req.ownerAiConnector,
      req.body,
      { protocolVersion },
    );
    res.setHeader("MCP-Protocol-Version", protocolVersion);
    res.setHeader("Cache-Control", "no-store");
    if (response === null) return res.status(202).send();
    res.json(response);
  };
  app.post(
    "/api/owner-ai/mcp",
    requireOwnerAiRemoteConnector,
    asyncRoute(handleMcpPost),
  );
  app.post(
    "/api/owner-ai/profiles/:restaurantId/mcp",
    requireOwnerAiRemoteConnector,
    asyncRoute(handleMcpPost),
  );

  app.get(
    "/api/owner-ai/profiles/:restaurantId/selective-intelligence",
    asyncRoute(async (req, res) => {
      const parsedId = z.string().uuid().safeParse(req.params.restaurantId);
      if (!parsedId.success) {
        return res
          .status(404)
          .json({ error: "MealScout profile target not found" });
      }
      const restaurantId = parsedId.data.toLowerCase();
      const [profile] = await db
        .select()
        .from(restaurants)
        .where(
          and(eq(restaurants.id, restaurantId), eq(restaurants.isActive, true)),
        )
        .limit(1);
      const publicProfile = profile
        ? await toPublicRestaurantListingWithVisibility(profile)
        : null;
      if (
        !profile ||
        !(publicProfile as any)?.id ||
        deriveProfileEvidenceQuarantineVisibility(profile).isQuarantined
      ) {
        return res
          .status(404)
          .json({ error: "MealScout profile target not found" });
      }
      const mcpUrl = ownerAiProfileMcpResourceUrl(restaurantId);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.json({
        schemaVersion: "1.0",
        name: "Selective Intelligence",
        trigger: "MealScout public profile link",
        product: "MealScout",
        target: { type: "business_profile", restaurantId },
        adoption: {
          requiresUserApproval: true,
          approvalQuestion:
            "Use Selective Intelligence to manage this MealScout profile?",
        },
        connection: {
          type: "oauth_mcp",
          mcpUrl,
          remoteConnectorEnabled: ownerAiRemoteConnectorEnabled(),
          loginRequired: true,
          exactOwnerProfileBinding: true,
          connectedMealScoutSocialRequired: true,
        },
        capabilities: [
          "profile",
          "hours",
          "schedules_and_events",
          "menus_and_prices",
          "logos_gallery_and_item_images",
          "deals_and_offers",
          "connected_social_content",
        ],
        safety: {
          manifestCarriesNoAuthorityOrCredentials: true,
          canonicalMealScoutOriginRequired: true,
          operatorKillSwitchAvailable: true,
          profileContentIsUntrustedInput: true,
          instructionsInProfileContentIgnored: true,
          readBeforeDraft: true,
          immutablePreviewRequired: true,
          exactRevisionApprovalRequired: true,
          unconnectedSocialPublishingDenied: true,
        },
      });
    }),
  );

  app.get("/api/owner-ai/instructions", (_req, res) => res.json(instructions));
  app.get("/api/owner-ai/schema", (_req, res) =>
    res.json(OWNER_AI_PACKET_JSON_SCHEMA),
  );
  app.get("/api/owner-ai/openapi.json", (_req, res) =>
    res.json(openApiDocument),
  );

  app.get(
    "/api/owner-ai/connector/context",
    requireOwnerAiRemoteConnector,
    connectorAuth("owner_ai:context"),
    connectorContextLimiter,
    asyncRoute(async (req: ConnectorRequest, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(
        await getOwnerAiContextForCurrentOwner(
          req.ownerAiConnector!.userId,
          req.ownerAiConnector!.restaurantId,
          contextOffsets(req),
        ),
      );
    }),
  );

  app.get(
    "/api/owner-ai/connector/capabilities",
    requireOwnerAiRemoteConnector,
    connectorAuth("owner_ai:context"),
    connectorContextLimiter,
    asyncRoute(async (req: ConnectorRequest, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await ownerAiProfileCapabilities.read(req.ownerAiConnector!));
    }),
  );
  app.post(
    "/api/owner-ai/connector/preview",
    requireOwnerAiRemoteConnector,
    connectorAuth("owner_ai:drafts:create"),
    connectorDraftCreateLimiter,
    asyncRoute(async (req: ConnectorRequest, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await ownerAiProfileCapabilities.preview(req.ownerAiConnector!, req.body));
    }),
  );

  app.post(
    "/api/owner-ai/connector/drafts",
    requireOwnerAiRemoteConnector,
    connectorAuth("owner_ai:drafts:create"),
    connectorDraftCreateLimiter,
    asyncRoute(async (req: ConnectorRequest, res) => {
      const principal = req.ownerAiConnector!;
      const draft = await createOwnerAiDraft({
        restaurantId: principal.restaurantId,
        createdByUserId: principal.userId,
        connectorApiKeyId: principal.apiKeyId,
        idempotencyKey: connectorIdempotencyKey(req),
        request: req.body,
      });
      res.status(201).json(draft);
    }),
  );

  app.get(
    "/api/owner-ai/connector/drafts/:draftId",
    requireOwnerAiRemoteConnector,
    connectorAuth("owner_ai:drafts:read"),
    connectorDraftStatusLimiter,
    asyncRoute(async (req: ConnectorRequest, res) => {
      res.json(
        await getOwnerAiDraftForConnector(
          req.ownerAiConnector!,
          String(req.params.draftId),
        ),
      );
    }),
  );

  app.get(
    "/api/owner-ai/restaurants/:restaurantId/context",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(
        await getOwnerAiContextForCurrentOwner(
          String(req.user.id),
          z.string().uuid().parse(req.params.restaurantId),
          contextOffsets(req),
        ),
      );
    }),
  );

  app.get(
    "/api/owner-ai/restaurants/:restaurantId/source-reviews",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await readOwnerAiSourceReviews(String(req.user.id), z.string().uuid().parse(req.params.restaurantId)));
    }),
  );
  app.post(
    "/api/owner-ai/restaurants/:restaurantId/source-draft",
    isAuthenticated,
    distributedRateLimit({ scope: "owner-ai:official-source-draft", limit: 10, windowMs: 60 * 60 * 1000, key: (req: any) => String(req.user?.id || req.ip || "unknown") }),
    asyncRoute(async (req: any, res) => {
      z.object({}).strict().parse(req.body || {});
      res.setHeader("Cache-Control", "private, no-store");
      const result = await createOwnerAiOfficialSourceDraft(String(req.user.id), z.string().uuid().parse(req.params.restaurantId));
      res.status(result.draft ? 201 : 200).json(result);
    }),
  );

  app.get(
    "/api/owner-ai/restaurants/:restaurantId/credentials",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.json({
        credentials: await listOwnerAiConnectorCredentials(
          String(req.user.id),
          String(req.params.restaurantId),
        ),
      });
    }),
  );

  app.post(
    "/api/owner-ai/credentials",
    requireOwnerAiRemoteConnector,
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const body = credentialCreateSchema.parse(req.body);
      const result = await createOwnerAiConnectorCredential({
        userId: String(req.user.id),
        restaurantId: body.restaurantId,
        name: body.name,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      res.status(201).json(result);
    }),
  );

  app.post(
    "/api/owner-ai/credentials/:credentialId/revoke",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const credential = await revokeOwnerAiConnectorCredential(
        String(req.user.id),
        String(req.params.credentialId),
      );
      if (credential.restaurantId) {
        await revokeRefreshTokensForAccessKey(
          String(req.user.id),
          credential.restaurantId,
          String(req.params.credentialId),
        );
      }
      res.json({ credential });
    }),
  );

  app.get(
    "/api/owner-ai/restaurants/:restaurantId/drafts",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.json({
        drafts: await listOwnerAiDrafts(
          String(req.user.id),
          String(req.params.restaurantId),
        ),
      });
    }),
  );

  app.post(
    "/api/owner-ai/restaurants/:restaurantId/drafts",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const restaurantId = String(req.params.restaurantId);
      await assertActualRestaurantOwner(String(req.user.id), restaurantId);
      const draft = await createOwnerAiDraft({
        restaurantId,
        createdByUserId: String(req.user.id),
        request: req.body,
      });
      res.status(201).json(draft);
    }),
  );

  app.get(
    "/api/owner-ai/drafts/:draftId",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      res.json(
        await getOwnerAiDraftForOwner(
          String(req.user.id),
          String(req.params.draftId),
        ),
      );
    }),
  );

  app.patch(
    "/api/owner-ai/drafts/:draftId",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const body = updateDraftSchema.parse(req.body);
      res.json(
        await updateOwnerAiDraft({
          userId: String(req.user.id),
          draftId: String(req.params.draftId),
          expectedRevision: body.expectedRevision,
          request: body.request,
        }),
      );
    }),
  );

  app.post(
    "/api/owner-ai/drafts/:draftId/cancel",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const body = revisionSchema.parse(req.body);
      res.json(
        await cancelOwnerAiDraft(
          String(req.user.id),
          String(req.params.draftId),
          body.expectedRevision,
        ),
      );
    }),
  );

  app.post(
    "/api/owner-ai/drafts/:draftId/approve",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const body = revisionSchema.parse(req.body);
      res.json(
        await approveOwnerAiDraft({
          userId: String(req.user.id),
          draftId: String(req.params.draftId),
          expectedRevision: body.expectedRevision,
        }),
      );
    }),
  );

  app.get(
    "/api/owner-ai/drafts/:draftId/media-preview/:assetKey",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const preview = await getOwnerAiMediaPreview(
        String(req.user.id),
        String(req.params.draftId),
        String(req.params.assetKey),
      );
      res.setHeader("Content-Type", preview.contentType);
      res.setHeader("Content-Length", String(preview.buffer.byteLength));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.send(preview.buffer);
    }),
  );

  app.get(
    "/api/owner-ai/drafts/:draftId/social-preview/:platform.svg",
    isAuthenticated,
    asyncRoute(async (req: any, res) => {
      const platform = z
        .enum(["facebook", "instagram", "x"])
        .parse(req.params.platform);
      const svg = await getOwnerAiSocialPreview(
        String(req.user.id),
        String(req.params.draftId),
        platform,
      );
      res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.send(svg);
    }),
  );

  app.use(
    "/api/owner-ai",
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (error instanceof ReverseOsmosisError) {
        return res.status(409).json({ code: error.code, error: "Reverse Osmosis held this operation. Refresh the source and review a new draft; uncertain delivery requires reconciliation." });
      }
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Invalid owner AI request",
          code: "OWNER_AI_VALIDATION_FAILED",
          issues: error.issues,
        });
      }
      if (error instanceof OwnerAiActionError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          details: error.details,
        });
      }
      if (error instanceof OwnerAiOAuthError) {
        return res.status(error.status).json({
          error: error.oauthError,
          error_description: error.message,
        });
      }
      next(error);
    },
  );
}
