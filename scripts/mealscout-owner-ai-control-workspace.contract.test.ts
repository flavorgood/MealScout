import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const page = read("client/src/pages/owner-ai-actions.tsx");
const authorizePage = read("client/src/pages/owner-ai-authorize.tsx");
const app = read("client/src/App.tsx");
const shell = read("client/src/components/business-workspace-shell.tsx");
const navigation = read("client/src/components/navigation.tsx");
const seo = read("client/src/components/seo-head.tsx");
const api = read("client/src/lib/api.ts");

assert.match(app, /const OwnerAiActionsPage = lazy/);
assert.match(app, /const OwnerAiAuthorizePage = lazy/);
assert.match(app, /path="\/owner-ai" component=\{OwnerAiActionsPage\}/);
assert.match(
  app,
  /path="\/owner-ai\/authorize" component=\{OwnerAiAuthorizePage\}/,
);
assert.match(app, /currentPath === "\/owner-ai"/);
assert.match(
  app,
  /const redirectTarget = `\$\{location \|\| "\/dashboard"\}\$\{window\.location\.search \|\| ""\}`/,
);
const guestProtectedRoutes = app.slice(
  app.indexOf("function GuestProtectedRoutes"),
  app.indexOf("function SharedPublicRoutes"),
);
assert.match(
  guestProtectedRoutes,
  /path="\/owner-ai" component=\{RedirectToLogin\}/,
);
assert.match(shell, /id: "ai"/);
assert.match(shell, /href: buildWorkspaceHref\("\/owner-ai", business\.id\)/);
assert.match(navigation, /currentPath === "\/owner-ai"/);
assert.match(seo, /"\/owner-ai"/);
assert.match(
  api,
  /host\.endsWith\("\.vercel\.app"\) \|\| host\.endsWith\("\.onrender\.com"\)/,
);

for (const copy of [
  "Reverse Osmosis",
  "Use the AI you already have",
  "menus, prices",
  "logos and images",
  "schedules, events",
  "social descriptions and artwork",
  "Portable action packet",
  "Prepare changes and social previews",
  "Approve changes and posts",
  "MealScout commits first",
  "Logos, menu photos, and other supplied images",
  "Continue approved posts",
  "Copy current context for any AI",
  "Exact validated MealScout values",
  "Complete the one-surface connection",
  "Copy tool URL",
  "Social accounts held by MealScout",
]) {
  assert.ok(page.includes(copy), `Missing owner AI workflow copy: ${copy}`);
}

// MealScout OAuth is the primary connection. Legacy copied keys remain
// draft-only, while signed-in AIs can execute an exact revision after consent.
assert.match(page, /api\/owner-ai\/mcp/);
assert.match(page, /Sign in with MealScout/);
assert.match(page, /manually copied key can prepare drafts only/i);
assert.match(page, /cannot\s+carry in-chat owner consent, apply changes, or publish/i);
assert.match(page, /social-connections\/status/);
assert.match(page, /missingDraftSocialPlatforms/);
assert.match(page, /\/api\/owner-ai\/credentials/);
assert.match(page, /\/api\/owner-ai\/drafts/);
assert.match(page, /\/approve/);
assert.match(page, /expectedRevision: selectedDraft\?\.revision \|\| 1/);
assert.match(page, /normalizeSocialDrafts/);
assert.match(page, /post\.status/);
assert.match(page, /post\.errorMessage/);
assert.match(page, /post\.providerUrl/);
assert.match(page, /post\.attemptedPayloadText/);
assert.match(page, /selectedDraft\?\.mediaPreviews/);
assert.match(page, /localOwnerAiPreviewUrl/);
assert.match(page, /canContinueSocial/);
assert.match(page, /requiredPreviewKeys/);
assert.match(page, /MEDIA_CHANGED|image changed/i);
assert.match(authorizePage, /Sign in to your AI with MealScout/);
assert.match(authorizePage, /owner_ai:drafts:approve/);
assert.match(authorizePage, /Connect at least one social account/);
assert.match(authorizePage, /\/api\/owner-ai\/oauth\/authorize/);

// Free chats use the same strict packet submitted by direct tool clients.
assert.match(page, /JSON\.parse\(packetText\)/);
assert.match(
  page,
  /`\/api\/owner-ai\/restaurants\/\$\{encodeURIComponent\(restaurantId\)\}\/drafts`/,
);
assert.match(page, /parsed\.packet && typeof parsed\.packet === "object"/);
assert.match(page, /: \{ packet: parsed \}/);
assert.match(page, /schemaVersion: "1\.0"/);
assert.match(page, /schedules:/);
assert.match(page, /kind: "event_stop"/);
assert.match(page, /platforms: \["facebook", "instagram", "x"\]/);

for (const forbidden of [
  /STRIPE_SECRET_KEY/,
  /BREVO_API_KEY/,
  /github actions/i,
  /auto.?approve/i,
  /publish immediately/i,
]) {
  assert.doesNotMatch(page, forbidden);
}

console.log("mealscout-owner-ai-control-workspace.contract: PASS");
