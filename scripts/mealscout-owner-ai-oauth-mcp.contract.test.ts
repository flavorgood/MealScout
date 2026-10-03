import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.NODE_ENV = "development";
process.env.SESSION_SECRET = "mealscout-owner-ai-contract-only-secret-2026";
process.env.PUBLIC_BASE_URL = "https://www.mealscout.us";
delete process.env.DATABASE_URL;

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const { OWNER_AI_CONNECTOR_SCOPES, OWNER_AI_DRAFT_ONLY_SCOPES } =
  await import("../shared/ownerAiActions");
const {
  OwnerAiOAuthError,
  ownerAiAuthorizationServerMetadata,
  ownerAiMcpResourceUrl,
  ownerAiProfileMcpResourceUrl,
  ownerAiProtectedResourceMetadata,
  registerOwnerAiOAuthClient,
  resolveOwnerAiOAuthClient,
  resolveOwnerAiMcpResource,
} = await import("../server/services/ownerAiOAuth");
const { OWNER_AI_MCP_TOOLS, handleOwnerAiMcpRequest } =
  await import("../server/services/ownerAiMcp");
const { OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA } =
  await import("../shared/ownerAiCapabilities");

assert.deepEqual(OWNER_AI_DRAFT_ONLY_SCOPES, [
  "owner_ai:context",
  "owner_ai:drafts:create",
  "owner_ai:drafts:read",
]);
assert.deepEqual(OWNER_AI_CONNECTOR_SCOPES, [
  ...OWNER_AI_DRAFT_ONLY_SCOPES,
  "owner_ai:drafts:approve",
]);

const resource = ownerAiMcpResourceUrl();
assert.equal(resource, "https://www.mealscout.us/api/owner-ai/mcp");
process.env.PUBLIC_BASE_URL = "https://mealscout.us/";
assert.equal(
  ownerAiMcpResourceUrl(),
  "https://www.mealscout.us/api/owner-ai/mcp",
  "Owner AI must normalize the legacy apex production origin to canonical www",
);
process.env.PUBLIC_BASE_URL = "https://www.mealscout.us";
const targetRestaurantId = "33333333-3333-4333-8333-333333333333";
const targetResource = ownerAiProfileMcpResourceUrl(targetRestaurantId);
assert.equal(
  targetResource,
  `https://www.mealscout.us/api/owner-ai/profiles/${targetRestaurantId}/mcp`,
);
assert.deepEqual(resolveOwnerAiMcpResource(targetResource), {
  resource: targetResource,
  restaurantId: targetRestaurantId,
});
assert.equal(
  resolveOwnerAiMcpResource(
    `https://www.mealscout.us/api/owner-ai/profiles/${targetRestaurantId}/mcp?wrong=1`,
  ),
  null,
  "Profile-bound OAuth resources must reject query widening",
);
for (const invalidResource of [
  `https://www.mealscout.us.evil.example/api/owner-ai/profiles/${targetRestaurantId}/mcp`,
  `https://www.mealscout.us/api/owner-ai/profiles/${targetRestaurantId}/mcp#wrong`,
  `https://www.mealscout.us/api/owner-ai/profiles/${targetRestaurantId}/mcp/extra`,
  `https://www.mealscout.us/api/owner-ai/profiles/${targetRestaurantId}%2Fmcp`,
  `https://www.mealscout.us/api/owner-ai/profiles/33333333-3333-4333-7333-333333333333/mcp`,
]) {
  assert.equal(
    resolveOwnerAiMcpResource(invalidResource),
    null,
    `Profile-bound OAuth resources must reject ${invalidResource}`,
  );
  assert.throws(
    () => ownerAiProtectedResourceMetadata(invalidResource),
    (error: unknown) =>
      error instanceof OwnerAiOAuthError &&
      error.oauthError === "invalid_target",
    "Protected-resource discovery must fail closed for an invalid target",
  );
}
assert.equal(
  ownerAiProtectedResourceMetadata(targetResource).resource,
  targetResource,
);
assert.deepEqual(ownerAiProtectedResourceMetadata(), {
  resource,
  authorization_servers: ["https://www.mealscout.us"],
  bearer_methods_supported: ["header"],
  scopes_supported: [...OWNER_AI_CONNECTOR_SCOPES],
  resource_name: "MealScout Owner AI",
});
const authorizationMetadata = ownerAiAuthorizationServerMetadata();
assert.equal(
  authorizationMetadata.authorization_endpoint,
  "https://www.mealscout.us/owner-ai/authorize",
);
assert.equal(
  authorizationMetadata.token_endpoint,
  "https://www.mealscout.us/api/owner-ai/oauth/token",
);
assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, [
  "S256",
]);
assert.equal(authorizationMetadata.client_id_metadata_document_supported, true);
assert.ok(
  authorizationMetadata.scopes_supported.includes("owner_ai:drafts:approve"),
);

const registration = registerOwnerAiOAuthClient({
  client_name: "Owner's favorite AI",
  redirect_uris: ["http://127.0.0.1:43821/oauth/callback"],
  application_type: "native",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});
assert.match(registration.client_id, /^msai_client_/);
assert.deepEqual(registration.grant_types, [
  "authorization_code",
  "refresh_token",
]);
assert.equal(registration.token_endpoint_auth_method, "none");
const resolvedClient = await resolveOwnerAiOAuthClient(registration.client_id);
assert.equal(resolvedClient.clientName, "Owner's favorite AI");
assert.equal(resolvedClient.applicationType, "native");
assert.deepEqual(resolvedClient.redirectUris, [
  "http://127.0.0.1:43821/oauth/callback",
]);

assert.throws(
  () =>
    registerOwnerAiOAuthClient({
      client_name: "Unsafe AI",
      redirect_uris: ["http://example.com/callback"],
    }),
  (error: unknown) =>
    error instanceof OwnerAiOAuthError &&
    error.oauthError === "invalid_client_metadata",
);
assert.throws(
  () =>
    registerOwnerAiOAuthClient({
      client_name: "Confidential AI",
      redirect_uris: ["https://example.com/callback"],
      token_endpoint_auth_method: "client_secret_basic",
    }),
  /Only public PKCE clients are supported/,
);

const principal = {
  apiKeyId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  restaurantId: "33333333-3333-4333-8333-333333333333",
  scopes: [...OWNER_AI_CONNECTOR_SCOPES],
};
const discovery = (await handleOwnerAiMcpRequest(
  principal,
  { jsonrpc: "2.0", id: 1, method: "server/discover" },
  { protocolVersion: "2026-07-28" },
)) as any;
assert.equal(discovery.result.protocolVersion, "2026-07-28");
assert.equal(discovery.result.capabilities.multiRoundTrip.inputRequired, true);
assert.match(discovery.result.instructions, /explicit owner consent/i);
assert.match(discovery.result.instructions, /publishes to linked socials/i);

const initialized = (await handleOwnerAiMcpRequest(
  principal,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  },
  { protocolVersion: "2025-11-25" },
)) as any;
assert.equal(initialized.result.protocolVersion, "2025-11-25");
assert.match(initialized.result.instructions, /approve_mealscout_draft/);
assert.match(
  initialized.result.instructions,
  /owner explicitly consents in this chat/i,
);

const listed = (await handleOwnerAiMcpRequest(principal, {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/list",
})) as any;
assert.deepEqual(
  listed.result.tools.map((tool: any) => tool.name),
  [
    "get_mealscout_official_source_facts",
    "get_mealscout_public_source_checks",
    "get_mealscout_profile_capabilities",
    "preview_mealscout_profile_changes",
    "get_mealscout_context",
    "create_mealscout_draft",
    "get_mealscout_draft_status",
    "prepare_mealscout_approval",
    "get_mealscout_media_preview",
    "approve_mealscout_draft",
  ],
);
for (const name of ["get_mealscout_official_source_facts", "get_mealscout_public_source_checks", "get_mealscout_profile_capabilities", "preview_mealscout_profile_changes"]) {
  const tool = OWNER_AI_MCP_TOOLS.find((tool) => tool.name === name)!;
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
}
const discoveredPreview = listed.result.tools.find(
  (tool: any) => tool.name === "preview_mealscout_profile_changes",
);
assert.deepEqual(
  discoveredPreview.inputSchema.properties.request,
  OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA,
  "Actual MCP discovery must expose the complete strict preview schema",
);
const { default: express } = await import("express");
const { registerOwnerAiActionRoutes } =
  await import("../server/routes/ownerAiActionRoutes");
const discoveryApp = express();
registerOwnerAiActionRoutes(discoveryApp);
const discoveryServer = discoveryApp.listen(0, "127.0.0.1");
try {
  if (!discoveryServer.listening) {
    await new Promise<void>((resolve, reject) => {
      discoveryServer.once("listening", resolve);
      discoveryServer.once("error", reject);
    });
  }
  const address = discoveryServer.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/owner-ai/openapi.json`,
  );
  assert.equal(response.status, 200);
  const discoveredRest = await response.json() as any;
  const previewSchemas = Object.values(discoveredRest.paths).flatMap(
    (path: any) => {
      const schema = path.post?.requestBody?.content?.["application/json"]?.schema;
      return schema?.$id === OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA.$id ? [schema] : [];
    },
  );
  assert.equal(previewSchemas.length, 1);
  assert.deepEqual(
    previewSchemas[0],
    OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA,
    "Actual REST discovery must match MCP and retain local schema definitions",
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    discoveryServer.close((error) => error ? reject(error) : resolve()),
  );
}
const approvalTool = OWNER_AI_MCP_TOOLS.find(
  (tool) => tool.name === "approve_mealscout_draft",
)!;
assert.equal(approvalTool.annotations.destructiveHint, true);
assert.equal(approvalTool.annotations.openWorldHint, true);
assert.match(
  approvalTool.description,
  /owner explicitly approves the exact revision/i,
);
assert.match(approvalTool.description, /publishes/i);

const noApprovalScope = (await handleOwnerAiMcpRequest(
  { ...principal, scopes: [...OWNER_AI_DRAFT_ONLY_SCOPES] },
  {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "approve_mealscout_draft",
      arguments: {
        draftId: "44444444-4444-4444-8444-444444444444",
        expectedRevision: 1,
        consentHandle: "x".repeat(80),
      },
    },
  },
)) as any;
assert.equal(noApprovalScope.result.isError, true);
assert.equal(
  noApprovalScope.result.structuredContent.code,
  "CONNECTOR_SCOPE_REQUIRED",
);

const oauth = read("server/services/ownerAiOAuth.ts");
const mcp = read("server/services/ownerAiMcp.ts");
const routes = read("server/routes/ownerAiActionRoutes.ts");
const actions = read("server/services/ownerAiActions.ts");
const socialPublishing = read("server/services/socialPublishing.ts");
const serverIndex = read("server/index.ts");
const publicProfilePrerender = read("server/seo/publicProfilePrerender.ts");
const authorizePage = read("client/src/pages/owner-ai-authorize.tsx");
const settings = read("client/src/pages/profile/settings.tsx");
const ownerAiPage = read("client/src/pages/owner-ai-actions.tsx");
const docs = read("OWNER_AI_ACTIONS.md");
const vercel = JSON.parse(read("vercel.json"));

for (const path of [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/api/owner-ai/mcp",
  "/.well-known/oauth-protected-resource/api/owner-ai/profiles/:restaurantId/mcp",
  "/api/owner-ai/oauth/register",
  "/api/owner-ai/oauth/authorize/prepare",
  "/api/owner-ai/oauth/authorize",
  "/api/owner-ai/oauth/token",
  "/api/owner-ai/oauth/revoke",
  "/api/owner-ai/mcp",
  "/api/owner-ai/profiles/:restaurantId/mcp",
  "/api/owner-ai/profiles/:restaurantId/selective-intelligence",
]) {
  assert.ok(routes.includes(path), `Missing OAuth/MCP route: ${path}`);
}
assert.match(routes, /WWW-Authenticate/);
assert.match(routes, /ownerAiOAuthChallengeHeader/);
assert.match(routes, /MCP-Protocol-Version/);
assert.match(routes, /OAuth\/MCP connections can apply and publish/);
assert.match(routes, /exactOwnerProfileBinding: true/);
assert.match(routes, /connectedMealScoutSocialRequired: true/);
assert.match(routes, /OWNER_AI_REMOTE_CONNECTOR_ENABLED/);
assert.match(routes, /requireOwnerAiRemoteConnector/);
assert.match(routes, /remoteConnectorEnabled: ownerAiRemoteConnectorEnabled\(\)/);
assert.match(routes, /operatorKillSwitchAvailable: true/);
assert.match(
  routes,
  /"\/api\/owner-ai\/oauth\/revoke",\s*oauthTokenLimiter/,
  "Emergency disablement must not block credential revocation",
);
assert.match(routes, /manifestCarriesNoAuthorityOrCredentials: true/);
assert.match(routes, /canonicalMealScoutOriginRequired: true/);
assert.match(routes, /profileContentIsUntrustedInput: true/);
assert.match(routes, /instructionsInProfileContentIgnored: true/);
assert.match(
  routes,
  /Use Selective Intelligence to manage this MealScout profile\?/,
);

const serverToServerPaths = serverIndex.slice(
  serverIndex.indexOf("const ownerAiServerToServerPaths"),
  serverIndex.indexOf("// Basic CSRF guard"),
);
for (const path of [
  "/api/owner-ai/connector/drafts",
  "/api/owner-ai/oauth/register",
  "/api/owner-ai/oauth/token",
  "/api/owner-ai/oauth/revoke",
  "/api/owner-ai/mcp",
]) {
  assert.ok(
    serverToServerPaths.includes(path),
    `Server-to-server Owner AI route must not require browser Origin: ${path}`,
  );
}
assert.ok(
  !serverToServerPaths.includes("/api/owner-ai/oauth/authorize"),
  "Owner approval must remain protected by the browser same-origin guard",
);
assert.ok(
  !serverToServerPaths.includes("/api/owner-ai/oauth/authorize/deny"),
  "Owner denial must remain protected by the browser same-origin guard",
);
assert.match(serverToServerPaths, /ownerAiProfileMcpPathPattern/);
assert.match(serverToServerPaths, /\[0-9a-f\]\{8\}/i);

for (const discoveryPath of [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/:path*",
]) {
  assert.ok(
    vercel.rewrites.some(
      (rewrite: any) =>
        rewrite.source === discoveryPath &&
        rewrite.destination.startsWith(
          "https://mealscout.onrender.com/.well-known/",
        ),
    ),
    `Vercel must proxy OAuth discovery to Render: ${discoveryPath}`,
  );
}
assert.ok(
  vercel.routes.some(
    (route: any) => route.src === "/\\.well-known/oauth-authorization-server",
  ),
  "Vercel routes must preserve OAuth authorization-server discovery",
);
assert.ok(
  vercel.routes.some(
    (route: any) =>
      route.src === "/\\.well-known/oauth-protected-resource/(.*)",
  ),
  "Vercel routes must preserve path-specific protected-resource discovery",
);

assert.match(oauth, /code_challenge_method: z\.literal\("S256"\)/);
assert.match(oauth, /resolveOwnerAiMcpResource\(parsed\.data\.resource\)/);
assert.match(oauth, /row\?\.status === "active" && row\?\.accessToken/);
assert.match(oauth, /Connect at least one social publishing account/);
assert.match(oauth, /ACCESS_TOKEN_TTL_MS = 60 \* 60 \* 1000/);
assert.match(oauth, /REFRESH_TOKEN_TTL_MS = 90 \* 24 \* 60 \* 60 \* 1000/);
assert.match(oauth, /Refresh token was already used/);
assert.match(oauth, /resolvePublicHostname/);
assert.match(oauth, /requestPinnedClientMetadata/);
assert.match(oauth, /clientId\.length > 16_000/);

for (const binding of [
  "apiKeyId: principal.apiKeyId",
  "userId: principal.userId",
  "restaurantId: principal.restaurantId",
  "draftId: draft.id",
  "revision: draft.revision",
  "fingerprint: stableDraftFingerprint(draft)",
]) {
  assert.ok(
    mcp.includes(binding),
    `Consent handle is missing binding: ${binding}`,
  );
}
assert.match(mcp, /expiresAt: Date\.now\(\) \+ 15 \* 60 \* 1000/);
assert.match(mcp, /currentSnapshot: draft\.currentSnapshot/);
assert.match(mcp, /mediaPreviews: draft\.mediaPreviews/);
assert.match(mcp, /await getOwnerAiMediaPreview/);
assert.match(mcp, /preview\.buffer\.toString\("base64"\)/);
assert.match(mcp, /call get_mealscout_media_preview/);
assert.match(mcp, /resultType: "input_required"/);
assert.match(
  mcp,
  /response\?\.action === "accept" && response\?\.content\?\.approve === true/,
);
assert.match(mcp, /ownerConfirmation !== "approved"/);
assert.match(mcp, /await approveOwnerAiDraft/);
assert.match(
  mcp,
  /draft\.status === "applied"[\s\S]*draft\.revision - 1/,
  "An interrupted approval call must be safely resumable after the canonical revision commits",
);
assert.match(
  routes,
  /authenticateOwnerAiConnector\(\s*bearerToken\(req\),\s*\)/,
  "MCP transport should authenticate the token once and enforce scopes per tool",
);

assert.match(actions, /SOCIAL_CONNECTION_REQUIRED/);
assert.match(actions, /connectionKind: refresh \? "oauth" : "legacy"/);
assert.match(actions, /connectionExpiresAt: refreshActive/);
assert.match(
  actions,
  /row\.status === "active" && row\.accessToken/,
  "Approval must require a usable social token before applying the revision",
);
assert.match(socialPublishing, /row\.status === "active" && row\.accessToken/);
assert.match(authorizePage, /connectedSocials\.length === 0/);
assert.match(
  authorizePage,
  /The AI can read[\s\S]*apply and publish only after/,
);
assert.match(
  settings,
  /AI can then[\s\S]*approve and publish that exact revision/,
);
assert.match(settings, /credential\.connectionKind === "oauth"/);
assert.match(settings, /owner_ai:drafts:approve/);
assert.match(ownerAiPage, /You approve in chat/);
assert.match(ownerAiPage, /AI calls MealScout/);
assert.match(ownerAiPage, /activeSignedInConnections/);
assert.match(docs, /signed-in AI may be the executor/);
assert.match(docs, /Manually copied legacy bearer keys remain draft-only/);
assert.match(
  routes,
  /after explicit consent to one exact revision[\s\S]*execute approval and publishing/,
  "Public Owner AI instructions must describe consented AI execution, not a universal draft-only boundary",
);
assert.match(publicProfilePrerender, /selective-intelligence-trigger/);
assert.match(
  publicProfilePrerender,
  /application\/vnd\.selective-intelligence\+json/,
);
assert.match(publicProfilePrerender, /application\/mcp\+json/);

console.log("mealscout-owner-ai-oauth-mcp.contract: PASS");
// Importing the OAuth service also imports server infrastructure that may own
// background handles in development. This contract performs no database calls;
// its only HTTP request reads the owned loopback discovery server, now closed.
// Terminate once every assertion has completed.
process.exit(0);
