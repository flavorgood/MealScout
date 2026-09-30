import { z } from "zod";
import { ownerAiProfileCapabilities } from "./ownerAiProfileCapabilities";
import { readPublicProfileSourceChecks } from "./publicProfileSourceChecks";
import { OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA } from "@shared/ownerAiCapabilities";
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  OWNER_AI_CONNECTOR_SCOPES,
  OWNER_AI_PACKET_JSON_SCHEMA,
} from "@shared/ownerAiActions";
import {
  OwnerAiActionError,
  approveOwnerAiDraft,
  createOwnerAiDraft,
  getOwnerAiContext,
  getOwnerAiDraftForConnector,
  getOwnerAiMediaPreview,
  type OwnerAiConnectorPrincipal,
} from "./ownerAiActions";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
] as const;

type JsonRpcId = string | number | null;

const requestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().trim().min(1).max(200),
    params: z.unknown().optional(),
  })
  .strict();

const contextInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    menuOffset: { type: "integer", minimum: 0, maximum: 100000 },
    menuCategoryOffset: { type: "integer", minimum: 0, maximum: 100000 },
    menuItemOffset: { type: "integer", minimum: 0, maximum: 1000000 },
    scheduleOffset: { type: "integer", minimum: 0, maximum: 100000 },
    dealOffset: { type: "integer", minimum: 0, maximum: 100000 },
  },
};

const createDraftInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["idempotencyKey", "request"],
  properties: {
    idempotencyKey: {
      type: "string",
      minLength: 8,
      maxLength: 200,
      pattern: "^[A-Za-z0-9._:-]+$",
      description:
        "A unique stable key for this exact draft attempt. Reuse only when retrying the identical request.",
    },
    request: OWNER_AI_PACKET_JSON_SCHEMA,
  },
};

const draftStatusInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["draftId"],
  properties: {
    draftId: { type: "string", format: "uuid" },
  },
};

const approvalPreviewInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["draftId"],
  properties: {
    draftId: { type: "string", format: "uuid" },
  },
};

const mediaPreviewInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["draftId", "assetKey"],
  properties: {
    draftId: { type: "string", format: "uuid" },
    assetKey: {
      type: "string",
      pattern: "^[a-z0-9-]{3,160}$",
      description:
        "One mediaPreviews assetKey returned by prepare_mealscout_approval.",
    },
  },
};

const approveDraftInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["draftId", "expectedRevision", "consentHandle"],
  properties: {
    draftId: { type: "string", format: "uuid" },
    expectedRevision: { type: "integer", minimum: 1 },
    consentHandle: {
      type: "string",
      minLength: 80,
      maxLength: 4096,
      description:
        "The exact-revision handle returned by prepare_mealscout_approval.",
    },
    ownerConfirmation: {
      type: "string",
      const: "approved",
      description:
        "For pre-2026 clients only: send approved solely after the owner explicitly approves the displayed revision in this chat.",
    },
  },
};

export const OWNER_AI_MCP_TOOLS = [
  {
    name: "get_mealscout_public_source_checks",
    description: "Read private midnight public-link check receipts for this current owner's business. Responses and byte changes remain unverified; this never fetches on demand, approves evidence, changes profile facts, or publishes.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_mealscout_profile_capabilities",
    description: "Read current authenticated native profile type, supported edits and credential state. This grants no application authority.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "preview_mealscout_profile_changes",
    description: "Strict read-only preview against fresh native versions and persisted ownership/type/visibility. Source provenance is declared and unverified. Create a native draft and obtain exact-revision owner consent separately to apply.",
    inputSchema: { type: "object", additionalProperties: false, required: ["request"], properties: { request: OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_mealscout_context",
    title: "Read current MealScout business context",
    description:
      "Read the MealScout business, menus, prices, schedules, deals, social connection readiness, and optimistic-concurrency versions attached to the signed-in owner. Call this before preparing a draft.",
    inputSchema: contextInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "create_mealscout_draft",
    title: "Prepare a MealScout owner-approval draft",
    description:
      "Create an immutable preview containing proposed MealScout changes plus generated social descriptions and artwork. This never approves, applies, or publishes; return the approvalUrl to the owner.",
    inputSchema: createDraftInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_mealscout_draft_status",
    title: "Read a MealScout draft result",
    description:
      "Read approval and per-platform results only for a draft created by this exact signed-in AI connection and business.",
    inputSchema: draftStatusInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "prepare_mealscout_approval",
    title: "Show the exact MealScout approval preview",
    description:
      "Return the exact immutable MealScout changes, generated social descriptions and images, connected destinations, and a short-lived consent handle. Show all of it to the owner and ask for explicit approval before calling approve_mealscout_draft.",
    inputSchema: approvalPreviewInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_mealscout_media_preview",
    title: "Load one frozen MealScout approval image",
    description:
      "Return the exact owner-supplied logo, cover, gallery, menu, deal, or social image frozen into this draft. Load and show every mediaPreviews asset before asking the owner to approve.",
    inputSchema: mediaPreviewInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "approve_mealscout_draft",
    title: "Apply the approved MealScout revision and publish its posts",
    description:
      "Use only after the owner explicitly approves the exact revision shown by prepare_mealscout_approval. MealScout atomically applies that revision, then publishes its approved descriptions and images to the linked social accounts. Modern clients receive an in-chat confirmation request before execution.",
    inputSchema: approveDraftInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const;

const jsonRpcResult = (id: JsonRpcId, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

const jsonRpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const toolError = (error: OwnerAiActionError) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: error.message,
        code: error.code,
        details: error.details,
      }),
    },
  ],
  structuredContent: {
    error: error.message,
    code: error.code,
    details: error.details,
  },
  isError: true,
});

const approvalSecret = () => {
  const secret = String(
    process.env.OWNER_AI_OAUTH_SECRET || process.env.SESSION_SECRET || "",
  );
  if (secret.length < 32) {
    throw new OwnerAiActionError(
      503,
      "OWNER_AI_CONSENT_NOT_CONFIGURED",
      "MealScout AI consent is not configured on this environment",
    );
  }
  return secret;
};

const stableDraftFingerprint = (draft: any) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        id: draft.id,
        revision: draft.revision,
        packet: draft.packet,
        currentSnapshot: draft.currentSnapshot,
        normalizedPlan: draft.normalizedPlan,
        socialDrafts: draft.socialDrafts,
        mediaPreviews: draft.mediaPreviews,
      }),
    )
    .digest("hex");

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const createConsentHandle = (
  principal: OwnerAiConnectorPrincipal,
  draft: any,
) => {
  const payload = Buffer.from(
    JSON.stringify({
      kind: "owner_ai_draft_consent",
      apiKeyId: principal.apiKeyId,
      userId: principal.userId,
      restaurantId: principal.restaurantId,
      draftId: draft.id,
      revision: draft.revision,
      fingerprint: stableDraftFingerprint(draft),
      expiresAt: Date.now() + 15 * 60 * 1000,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", approvalSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
};

const assertConsentHandle = (
  principal: OwnerAiConnectorPrincipal,
  draft: any,
  handle: string,
) => {
  const [payload, signature, extra] = String(handle || "").split(".");
  if (!payload || !signature || extra) {
    throw new OwnerAiActionError(
      400,
      "OWNER_CONSENT_HANDLE_INVALID",
      "Prepare the exact approval preview again before approving",
    );
  }
  const expected = createHmac("sha256", approvalSecret())
    .update(payload)
    .digest("base64url");
  if (!safeEqual(signature, expected)) {
    throw new OwnerAiActionError(
      400,
      "OWNER_CONSENT_HANDLE_INVALID",
      "Prepare the exact approval preview again before approving",
    );
  }
  let decoded: any;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new OwnerAiActionError(
      400,
      "OWNER_CONSENT_HANDLE_INVALID",
      "Prepare the exact approval preview again before approving",
    );
  }
  const valid =
    decoded?.kind === "owner_ai_draft_consent" &&
    decoded.apiKeyId === principal.apiKeyId &&
    decoded.userId === principal.userId &&
    decoded.restaurantId === principal.restaurantId &&
    decoded.draftId === draft.id &&
    decoded.revision === draft.revision &&
    decoded.fingerprint === stableDraftFingerprint(draft) &&
    Number(decoded.expiresAt || 0) > Date.now();
  if (!valid) {
    throw new OwnerAiActionError(
      409,
      "OWNER_CONSENT_HANDLE_STALE",
      "The draft changed or the approval preview expired. Show the owner a fresh exact preview.",
    );
  }
};

const sanitizedDraftForTool = (draft: any) => ({
  ...draft,
  socialDrafts: Array.isArray(draft.socialDrafts)
    ? draft.socialDrafts.map(({ generatedSvg: _generatedSvg, ...social }: any) =>
        social,
      )
    : draft.socialDrafts,
});

const draftToolResult = (draft: any, extra: Record<string, unknown> = {}) => {
  const structuredContent = {
    ...sanitizedDraftForTool(draft),
    ...extra,
  };
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: JSON.stringify(structuredContent) },
  ];
  for (const social of Array.isArray(draft.socialDrafts)
    ? draft.socialDrafts
    : []) {
    if (typeof social?.generatedSvg !== "string") continue;
    content.push({
      type: "image",
      data: Buffer.from(social.generatedSvg, "utf8").toString("base64"),
      mimeType: "image/svg+xml",
      annotations: {
        audience: ["user", "assistant"],
        priority: 1,
      },
      _meta: { platform: social.platform },
    });
  }
  return { content, structuredContent };
};

const approvalPrompt = (draft: any) => {
  const platforms = (Array.isArray(draft.socialDrafts)
    ? draft.socialDrafts
    : []
  )
    .map((social: any) => social.platform)
    .filter(Boolean);
  return [
    `Approve MealScout draft revision ${draft.revision}?`,
    `Intent: ${String(draft.packet?.intent || "Business update")}`,
    ...(draft.currentSnapshot?.settings ? [
      `Effective social preferences: ${JSON.stringify(draft.currentSnapshot.settings.effectiveSocialPosting)}`,
      ...(draft.currentSnapshot.settings.warning ? [draft.currentSnapshot.settings.warning] : []),
    ] : []),
    platforms.length
      ? `After MealScout applies the exact preview, publish its approved descriptions and images to: ${platforms.join(", ")}.`
      : "This revision does not request social publishing.",
    "Choose approve only after reviewing every listed change, description, destination, and generated or retrieved image in this chat.",
  ].join("\n");
};

type McpToolCallContext = {
  protocolVersion: string;
  requestState?: unknown;
  inputResponses?: unknown;
};

const requireScope = (
  principal: OwnerAiConnectorPrincipal,
  scope: (typeof OWNER_AI_CONNECTOR_SCOPES)[number],
) => {
  if (!principal.scopes.includes(scope)) {
    throw new OwnerAiActionError(
      403,
      "CONNECTOR_SCOPE_REQUIRED",
      `AI connection lacks ${scope}`,
    );
  }
};

async function callOwnerAiTool(
  principal: OwnerAiConnectorPrincipal,
  name: string,
  argumentsValue: unknown,
  callContext: McpToolCallContext,
) {
  if (name === "get_mealscout_public_source_checks") {
    requireScope(principal, "owner_ai:context");
    z.object({}).strict().parse(argumentsValue || {});
    await ownerAiProfileCapabilities.read(principal);
    const result = await readPublicProfileSourceChecks(principal.userId, principal.restaurantId);
    // A revoked credential or owner transfer while reading fails closed.
    await ownerAiProfileCapabilities.read(principal);
    if (result.status !== 200) throw new OwnerAiActionError(result.status, "SOURCE_CHECK_ACCESS_DENIED", "Current owner source checks are unavailable");
    const { status: _status, ...checks } = result;
    return toolResult({ ...checks, mode: "read", sourceVerification: "UNVERIFIED", mutationPerformed: false });
  }
  if (name === "get_mealscout_profile_capabilities") {
    requireScope(principal, "owner_ai:context");
    z.object({}).strict().parse(argumentsValue || {});
    return toolResult(await ownerAiProfileCapabilities.read(principal));
  }
  if (name === "preview_mealscout_profile_changes") {
    requireScope(principal, "owner_ai:drafts:create");
    const args = z.object({ request: z.unknown() }).strict().parse(argumentsValue || {});
    return toolResult(await ownerAiProfileCapabilities.preview(principal, args.request));
  }
  if (name === "get_mealscout_context") {
    requireScope(principal, "owner_ai:context");
    const args = z
      .object({
        menuOffset: z.number().int().min(0).max(100_000).optional(),
        menuCategoryOffset: z.number().int().min(0).max(100_000).optional(),
        menuItemOffset: z.number().int().min(0).max(1_000_000).optional(),
        scheduleOffset: z.number().int().min(0).max(100_000).optional(),
        dealOffset: z.number().int().min(0).max(100_000).optional(),
      })
      .strict()
      .parse(argumentsValue || {});
    return toolResult(await getOwnerAiContext(principal.restaurantId, args));
  }
  if (name === "create_mealscout_draft") {
    requireScope(principal, "owner_ai:drafts:create");
    const args = z
      .object({
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{8,200}$/),
        request: z.unknown(),
      })
      .strict()
      .parse(argumentsValue || {});
    return toolResult(
      await createOwnerAiDraft({
        restaurantId: principal.restaurantId,
        createdByUserId: principal.userId,
        connectorApiKeyId: principal.apiKeyId,
        idempotencyKey: args.idempotencyKey,
        request: args.request,
      }),
    );
  }
  if (name === "get_mealscout_draft_status") {
    requireScope(principal, "owner_ai:drafts:read");
    const args = z
      .object({ draftId: z.string().uuid() })
      .strict()
      .parse(argumentsValue || {});
    return draftToolResult(
      await getOwnerAiDraftForConnector(principal, args.draftId),
    );
  }
  if (name === "prepare_mealscout_approval") {
    requireScope(principal, "owner_ai:drafts:read");
    const args = z
      .object({ draftId: z.string().uuid() })
      .strict()
      .parse(argumentsValue || {});
    const draft = await getOwnerAiDraftForConnector(principal, args.draftId);
    if (draft.status !== "draft") {
      throw new OwnerAiActionError(
        409,
        "DRAFT_NOT_APPROVABLE",
        `Draft status is ${draft.status}`,
      );
    }
    return draftToolResult(draft, {
      consentHandle: createConsentHandle(principal, draft),
      consentPrompt: approvalPrompt(draft),
      nextStep:
        "For each mediaPreviews entry, call get_mealscout_media_preview and show that image with the attached generated social images and exact revision. Call approve_mealscout_draft only after the owner explicitly approves all of it in this chat.",
    });
  }
  if (name === "get_mealscout_media_preview") {
    requireScope(principal, "owner_ai:drafts:read");
    const args = z
      .object({
        draftId: z.string().uuid(),
        assetKey: z.string().regex(/^[a-z0-9-]{3,160}$/),
      })
      .strict()
      .parse(argumentsValue || {});
    const draft = await getOwnerAiDraftForConnector(principal, args.draftId);
    const descriptors = (Array.isArray(draft.mediaPreviews)
      ? draft.mediaPreviews
      : []) as Array<Record<string, any>>;
    const descriptor = descriptors.find(
      (preview) => preview.assetKey === args.assetKey,
    );
    if (!descriptor) {
      throw new OwnerAiActionError(
        404,
        "MEDIA_PREVIEW_NOT_FOUND",
        "This image is not part of the exact draft revision",
      );
    }
    const preview = await getOwnerAiMediaPreview(
      principal.userId,
      args.draftId,
      args.assetKey,
    );
    const structuredContent = {
      draftId: draft.id,
      revision: draft.revision,
      assetKey: args.assetKey,
      label: descriptor.label,
      contentSha256: descriptor.contentSha256,
      rightsAffirmed: descriptor.rightsAffirmed,
      rightsAffirmation: descriptor.rightsAffirmation,
    };
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
        {
          type: "image" as const,
          data: preview.buffer.toString("base64"),
          mimeType: preview.contentType,
          annotations: {
            audience: ["user", "assistant"],
            priority: 1,
          },
          _meta: {
            assetKey: args.assetKey,
            contentSha256: descriptor.contentSha256,
          },
        },
      ],
      structuredContent,
    };
  }
  if (name === "approve_mealscout_draft") {
    requireScope(principal, "owner_ai:drafts:approve");
    const args = z
      .object({
        draftId: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        consentHandle: z.string().min(80).max(4096),
        ownerConfirmation: z.literal("approved").optional(),
      })
      .strict()
      .parse(argumentsValue || {});
    const draft = await getOwnerAiDraftForConnector(principal, args.draftId);
    if (draft.status === "applied") {
      const retryMatchesAppliedRevision =
        args.expectedRevision === draft.revision ||
        args.expectedRevision === draft.revision - 1;
      if (!retryMatchesAppliedRevision) {
        throw new OwnerAiActionError(
          409,
          "STALE_DRAFT_REVISION",
          "The approved draft revision does not match this retry",
          { currentRevision: draft.revision },
        );
      }
      return toolResult(
        await approveOwnerAiDraft({
          userId: principal.userId,
          draftId: args.draftId,
          expectedRevision: args.expectedRevision,
        }),
      );
    }
    if (draft.status !== "draft") {
      throw new OwnerAiActionError(
        409,
        "DRAFT_NOT_APPROVABLE",
        `Draft status is ${draft.status}`,
      );
    }
    if (draft.revision !== args.expectedRevision) {
      throw new OwnerAiActionError(
        409,
        "STALE_DRAFT_REVISION",
        "Draft revision changed. Show the owner a fresh exact preview.",
        { currentRevision: draft.revision },
      );
    }
    assertConsentHandle(principal, draft, args.consentHandle);

    if (callContext.protocolVersion === "2026-07-28") {
      const responses =
        callContext.inputResponses &&
        typeof callContext.inputResponses === "object"
          ? (callContext.inputResponses as Record<string, any>)
          : null;
      if (!responses) {
        return {
          resultType: "input_required",
          inputRequests: {
            owner_approval: {
              type: "elicitation",
              message: approvalPrompt(draft),
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["approve"],
                properties: {
                  approve: {
                    type: "boolean",
                    description:
                      "Approve this exact MealScout revision and its listed social publications.",
                  },
                },
              },
            },
          },
          requestState: args.consentHandle,
        };
      }
      if (callContext.requestState !== args.consentHandle) {
        throw new OwnerAiActionError(
          400,
          "OWNER_CONSENT_RESPONSE_INVALID",
          "Approval response did not match the exact preview",
        );
      }
      const response = responses.owner_approval;
      const accepted =
        response?.action === "accept" && response?.content?.approve === true;
      if (!accepted) {
        return toolResult({
          approved: false,
          changed: false,
          published: false,
          message: "The owner declined or cancelled this revision.",
        });
      }
    } else if (args.ownerConfirmation !== "approved") {
      throw new OwnerAiActionError(
        400,
        "EXPLICIT_OWNER_CONSENT_REQUIRED",
        "Ask the owner to approve the exact preview in this chat, then retry with ownerConfirmation=approved",
      );
    }

    return toolResult(
      await approveOwnerAiDraft({
        userId: principal.userId,
        draftId: args.draftId,
        expectedRevision: args.expectedRevision,
      }),
    );
  }
  throw new OwnerAiActionError(404, "MCP_TOOL_NOT_FOUND", "Unknown MealScout tool");
}

export async function handleOwnerAiMcpRequest(
  principal: OwnerAiConnectorPrincipal,
  body: unknown,
  options: { protocolVersion?: string } = {},
) {
  if (Array.isArray(body)) {
    return jsonRpcError(null, -32600, "JSON-RPC batching is not supported");
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  const { method, params } = parsed.data;
  const id = parsed.data.id ?? null;
  const isNotification = parsed.data.id === undefined;

  if (method === "notifications/initialized") return null;
  if (method === "server/discover") {
    return jsonRpcResult(id, {
      protocolVersion: "2026-07-28",
      capabilities: {
        tools: { listChanged: false },
        multiRoundTrip: { inputRequired: true },
      },
      serverInfo: { name: "MealScout Owner AI", version: "1.1.0" },
      instructions:
        "Read context, prepare a draft, show the exact approval preview, and use the approval tool only after explicit owner consent. MealScout applies that exact revision and then publishes to linked socials.",
    });
  }
  if (method === "initialize") {
    const requestedVersion = String((params as any)?.protocolVersion || "");
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
      requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
      ? requestedVersion
      : SUPPORTED_PROTOCOL_VERSIONS[0];
    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "MealScout Owner AI", version: "1.1.0" },
      instructions:
        "Read context, prepare a draft, show the exact approval preview, and call approve_mealscout_draft only after the owner explicitly consents in this chat. MealScout applies that exact revision and then publishes to linked socials.",
    });
  }
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") {
    return jsonRpcResult(id, {
      tools: OWNER_AI_MCP_TOOLS,
      ttlMs: 300_000,
      cacheScope: "global",
    });
  }
  if (method === "tools/call") {
    if (isNotification) return null;
    const call = z
      .object({
        name: z.string().trim().min(1).max(200),
        arguments: z.unknown().optional(),
        requestState: z.unknown().optional(),
        inputResponses: z.unknown().optional(),
      })
      .strict()
      .safeParse(params);
    if (!call.success) {
      return jsonRpcError(id, -32602, "Invalid tool arguments");
    }
    try {
      return jsonRpcResult(
        id,
        await callOwnerAiTool(
          principal,
          call.data.name,
          call.data.arguments || {},
          {
            protocolVersion:
              options.protocolVersion || "2025-11-25",
            requestState: call.data.requestState,
            inputResponses: call.data.inputResponses,
          },
        ),
      );
    } catch (error) {
      if (error instanceof OwnerAiActionError) {
        return jsonRpcResult(id, toolError(error));
      }
      if (error instanceof z.ZodError) {
        return jsonRpcResult(
          id,
          toolError(
            new OwnerAiActionError(
              400,
              "MCP_TOOL_ARGUMENTS_INVALID",
              "MealScout tool arguments are invalid",
              error.issues,
            ),
          ),
        );
      }
      throw error;
    }
  }
  if (isNotification) return null;
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
