import { readFileSync } from "node:fs";

const settings = readFileSync(
  "client/src/pages/profile/settings.tsx",
  "utf8",
);
const shell = readFileSync(
  "client/src/components/business-workspace-shell.tsx",
  "utf8",
);
const accountRoutes = readFileSync(
  "server/routes/authAccountRoutes.ts",
  "utf8",
);
const publicRoutes = readFileSync(
  "server/routes/publicDiscoveryRoutes.ts",
  "utf8",
);

for (const snippet of [
  "<BusinessWorkspaceShell",
  'activeModule="settings"',
  'params.get("restaurantId")',
  'queryKey: ["/api/restaurants/my-restaurants"]',
  "onBusinessChange={handleBusinessChange}",
  'queryKey: ["/api/settings/me"]',
  'method: "PATCH"',
  "publicProfileSettings: {",
  "showAddress,",
  "showContact,",
  "<NotificationSettings />",
  "Public contact visibility",
  "These two settings apply to every public profile owned by this account.",
  "Business-specific details and photos remain in each business workspace.",
  "Profiles affected",
  "Business presentation",
  'setup: "profile"',
  'setup: "profile-media"',
  'buildBusinessHref("/business-team")',
  'buildBusinessHref("/subscribe")',
  'type SettingsTab = "account" | "ai" | "notifications" | "visibility"',
  '<TabsTrigger value="ai"',
  'data-testid="settings-owner-ai-entry"',
  "Use the AI you already have",
  "Link any compatible free or paid AI by signing into",
  "Once you consent to that exact",
  "the AI can approve it and tell",
  "Manually copied legacy keys remain",
  "draft-only",
  "Nothing changes in MealScout or on social media until",
  'source: "settings"',
]) {
  if (!settings.includes(snippet)) {
    throw new Error(`Account settings workspace contract missing: ${snippet}`);
  }
}

for (const presentationOnlySurface of [
  "Public Profile Studio",
  "templatePreset",
  "heroLayout",
  "heroTitle",
  "heroSubtitle",
  "accentColor",
  "fontFamily",
  "featuredLinks",
  "galleryUrls",
  "/api/settings/public-profile/gallery",
  "/api/settings/custom-domain/verify",
  "customDomainHost",
  "Language & Region",
  "Currency",
  "<Navigation",
]) {
  if (settings.includes(presentationOnlySurface)) {
    throw new Error(
      `Presentation-only or duplicate settings surface remains: ${presentationOnlySurface}`,
    );
  }
}

for (const snippet of [
  'label: "Settings"',
  'description: "Account, AI access, visibility, and help"',
  'href: buildWorkspaceHref("/settings", business.id)',
]) {
  if (!shell.includes(snippet)) {
    throw new Error(`Business shell Settings contract missing: ${snippet}`);
  }
}

for (const snippet of [
  'app.get("/api/settings/me", isAuthenticated',
  'app.patch("/api/settings/me", isAuthenticated',
  "...(current.publicProfileSettings || {})",
  "...(parsed.publicProfileSettings || {})",
  '"/api/settings/public-profile/gallery"',
  '"/api/settings/custom-domain/verify"',
]) {
  if (!accountRoutes.includes(snippet)) {
    throw new Error(`Account settings route behavior changed or missing: ${snippet}`);
  }
}

for (const snippet of [
  "publicIdentityStatus",
  '"role_scoped_entity_profiles_only"',
  "linkedEntityProfileCount: profileLinks.length",
  "tierNeutral: true",
  "paidTierRequired: false",
]) {
  if (!accountRoutes.includes(snippet)) {
    throw new Error(`Public identity status contract missing: ${snippet}`);
  }
}
if (/subscription|premium|membership|billing/.test(
  accountRoutes.slice(
    accountRoutes.indexOf("publicIdentityStatus"),
    accountRoutes.indexOf("media:", accountRoutes.indexOf("publicIdentityStatus")),
  ),
)) {
  throw new Error("Public identity status must not depend on paid-tier state");
}
if (
  !settings.includes("Public profile status") ||
  !settings.includes("role-scoped public identity") ||
  !settings.includes("does not require a paid profile tier")
) {
  throw new Error("Settings must explain why account-level public identity is unavailable");
}

for (const snippet of [
  "resolvePublicProfileVisibility(",
  "ownerUser?.publicProfileSettings",
]) {
  if (!publicRoutes.includes(snippet)) {
    throw new Error(`Live public visibility behavior missing: ${snippet}`);
  }
}

console.log("mealscout-account-settings-workspace.contract: PASS");
