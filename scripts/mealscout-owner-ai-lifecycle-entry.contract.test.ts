import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOwnerAiHref } from "../shared/ownerAiNavigation";

const read = (path: string) => readFileSync(path, "utf8");

assert.equal(
  buildOwnerAiHref({
    restaurantId: "restaurant 1",
    source: "onboarding",
    focus: "menu",
    menuSource: "https://example.com/menu?a=1",
    draftId: "draft 1",
  }),
  "/owner-ai?restaurantId=restaurant+1&src=onboarding&focus=menu&menuSource=https%3A%2F%2Fexample.com%2Fmenu%3Fa%3D1&ownerAiDraft=draft+1",
);
assert.equal(buildOwnerAiHref(), "/owner-ai");

const continuation = read("server/services/loginContinuation.ts");
const signup = read("client/src/pages/restaurant-signup.tsx");
const accountSetup = read("client/src/pages/account-setup.tsx");
const postVerification = read("client/src/pages/post-verification.tsx");
const profileSetup = read("client/src/pages/profile-setup.tsx");
const profileHub = read("client/src/pages/profile.tsx");
const settings = read("client/src/pages/profile/settings.tsx");
const profileEditor = read("client/src/components/owner-profile-workspace.tsx");
const ownerDashboard = read("client/src/pages/restaurant-owner-dashboard.tsx");
const ownerAi = read("client/src/pages/owner-ai-actions.tsx");
const auth = read("client/src/hooks/useAuth.ts");

for (const target of [
  "/restaurant-owner-dashboard?setup=profile",
  "/restaurant-owner-dashboard?setup=profile-media",
  "/menu-builder",
  "/restaurant-owner-dashboard?setup=schedule",
]) {
  assert.ok(continuation.includes(`continuationPath = "${target}";`), `Manual setup target must remain primary: ${target}`);
}
assert.doesNotMatch(continuation, /buildOwnerAiHref/);
assert.match(
  continuation,
  /nextRequiredStep = "verification";[\s\S]*continuationPath = "\/restaurant-owner-dashboard\?setup=verification";/,
  "Identity and business-document verification must remain a separate manual step",
);

assert.equal(
  signup.match(/setLocation\(resolveProgressiveBusinessSetupDestination\(signupAuthContext, manualSetupHref, createdRestaurant\?\.id\)\)/g)?.length,
  2,
  "Both submitted and deferred verification handoffs retain progressive context and manual setup",
);
for (const snippet of [
  'const manualSetupHref = useMemo(',
  'target.searchParams.set("restaurantId", createdRestaurant.id)',
  'target.searchParams.set("menuSource", menuSourceUrl)',
  'persistMenuImportDraft(createdRestaurant?.id || null)',
]) assert.ok(signup.includes(snippet), `Restaurant onboarding must preserve: ${snippet}`);
assert.doesNotMatch(signup, /ownerAiSetupHref|owner-ai-onboarding-handoff/);

for (const [name, source, snippets] of [
  ["business profile editor", profileEditor, [
    'data-testid="owner-profile-ai-entry"',
    "Update this profile with any AI",
    "approve the exact revision in the AI chat",
  ]],
  ["optional AI destination", ownerAi, [
    "Use any AI", "Use manual tools", "untrusted evidence",
    "Nothing changes or publishes until",
  ]],
] as const) {
  for (const snippet of snippets) assert.ok(source.includes(snippet), `${name} is missing: ${snippet}`);
}
for (const [name, source, promotion] of [
  ["account setup", accountSetup, /account-setup-owner-ai-introduction/],
  ["post-verification", postVerification, /post-verification-owner-ai-handoff/],
  ["profile setup", profileSetup, /Use the AI you already have/],
  ["profile hub", profileHub, /title: "AI Control"/],
  ["settings", settings, /data-testid="settings-owner-ai-entry"/],
  ["completion checklist", ownerDashboard, /owner-ai-completion-entry|Finish with AI/],
] as const) assert.doesNotMatch(source, promotion, `${name} must not promote AI as the default setup surface`);

assert.match(
  auth,
  /user\?\.businessOnboardingRequired[\s\S]*pathname\.startsWith\("\/owner-ai"\)/,
  "AI Control must still send an owner without an attached business through business onboarding",
);
assert.match(
  settings,
  /isScopedBusinessOwner\([\s\S]*ownsCurrentBusiness/,
  "Settings must expose key management only through actual scoped ownership",
);
assert.match(
  ownerDashboard,
  /ownsSelectedBusiness[\s\S]*source: "profile-editor"/,
  "Business profile AI entry must remain actual-owner scoped",
);

for (const source of [
  signup,
  accountSetup,
  postVerification,
  profileSetup,
  profileHub,
  settings,
  profileEditor,
  ownerDashboard,
  ownerAi,
]) {
  assert.doesNotMatch(source, /AI (?:will|can) auto.?approve/i);
  assert.doesNotMatch(source, /publish(?:es)? immediately/i);
}

assert.match(
  settings,
  /explicitly approve it[\s\S]*Manually copied legacy keys remain[\s\S]*draft-only/,
  "Settings must distinguish consented OAuth execution from legacy draft-only keys",
);
assert.match(
  ownerAi,
  /You approve in chat[\s\S]*AI calls MealScout[\s\S]*linked socials publish/,
  "AI Control must show that the AI executes the consented approval and publish call",
);

console.log("mealscout-owner-ai-lifecycle-entry.contract: PASS");
