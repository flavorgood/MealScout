import { existsSync, readFileSync } from "node:fs";

const mapPath = "MEALSCOUT_OWNER_DASHBOARD_DECOMPOSITION_MAP.md";
const cleanupMapPath = "CLEANUP_MAP.md";

if (!existsSync(mapPath)) {
  throw new Error("MEALSCOUT_OWNER_DASHBOARD_DECOMPOSITION_MAP.md must exist.");
}

if (!existsSync(cleanupMapPath)) {
  throw new Error("CLEANUP_MAP.md must exist.");
}

const map = readFileSync(mapPath, "utf8");
const cleanupMap = readFileSync(cleanupMapPath, "utf8");
const ownerDashboard = readFileSync("client/src/pages/restaurant-owner-dashboard.tsx", "utf8");
const menuBuilder = readFileSync("client/src/pages/menu-builder.tsx", "utf8");
const parkingPass = readFileSync("client/src/pages/parking-pass-content.tsx", "utf8");
// The role -> dashboard routing decision moved out of dashboard-router.tsx
// (now just a thin redirect shell) into a shared helper so /dashboard and
// account-continuation flows can both use it.
const dashboardRouter = readFileSync("client/src/lib/dashboard-route.ts", "utf8");
const dashboardSwitcher = readFileSync("client/src/components/dashboard-switcher.tsx", "utf8");
const loginContinuation = readFileSync("server/services/loginContinuation.ts", "utf8");
const restaurantOperationsRoutes = readFileSync("server/routes/restaurantOperationsRoutes.ts", "utf8");
const restaurantCoreRoutes = readFileSync("server/routes/restaurantCoreRoutes.ts", "utf8");
const menuRoutes = readFileSync("server/routes/menuRoutes.ts", "utf8");
const profileAccessPolicy = readFileSync("shared/profileAccessPolicy.ts", "utf8");
const combined = `${map}\n${cleanupMap}`;

function requireIncludes(source: string, snippet: string, label = snippet) {
  if (!source.toLowerCase().includes(snippet.toLowerCase())) {
    throw new Error(`Missing ${label}.`);
  }
}

function requireMatch(source: string, pattern: RegExp, label: string) {
  if (!pattern.test(source)) {
    throw new Error(`Missing ${label}.`);
  }
}

[
  "client/src/pages/restaurant-owner-dashboard.tsx",
  "Current Owner Dashboard Responsibilities",
  "Mixed Responsibility Risks",
  "Risky Mutation Areas",
  "Related Owner Surfaces",
  "Server Route Ownership",
  "Proposed Component Boundaries",
  "Static Schedule vs Live Status",
  "Safe Extraction Order",
  "Do-Not-Touch Rules",
  "Missing Docs/Tests Before Future Refactor",
  "Required Validations",
  "Exit Criteria For Future Refactor",
].forEach((snippet) => requireIncludes(map, snippet, snippet));

[
  "selected restaurant state",
  "business access state",
  "dashboard tabs",
  "restaurant owner surfaces",
  "food truck owner/operator surfaces",
  "menu/profile setup surfaces",
  "profile setup/editing",
  "profile completion loop",
  "operating hours/static schedule",
  "live truck location / GPS / WebSocket broadcasting",
  "manual schedule / Parking Pass entry points",
  "deals/marketing surfaces",
  "analytics and Recharts rendering",
  "QR/canvas/social asset generation",
  "media upload/approval",
  "Parking Pass entry points",
  "verification/insurance state display",
  "owner value attribution",
  "dangerous mutation paths",
].forEach((snippet) => requireIncludes(map, snippet, `current responsibility ${snippet}`));

[
  "GPS and WebSocket lifecycle",
  "navigator.geolocation.watchPosition",
  "useFoodTruckSocket",
  "Canvas and QR asset generation",
  "profileDraft",
  "stale local state",
  "analytics rendering",
  "media upload/approval mutations",
  "profile save mutations",
  "dashboard routing/tab state",
].forEach((snippet) => requireIncludes(map, snippet, `mixed responsibility risk ${snippet}`));

[
  "Live location auto-timeout / stop broadcast behavior",
  "`navigator.geolocation.watchPosition` lifecycle",
  "`useFoodTruckSocket` lifecycle",
  "`profileDraft` save/update mutation and stale-state risk",
  "uploadProfileMediaMutation",
  "approveProfileMediaMutation",
  "Operating hours save",
  "Social/QR asset download behavior",
  "Parking Pass booking/cancel entry points",
].forEach((snippet) => requireIncludes(map, snippet, `risky mutation area ${snippet}`));

[
  "client/src/pages/menu-builder.tsx",
  "client/src/pages/online-menu.tsx",
  "client/src/pages/parking-pass.tsx",
  "client/src/pages/dashboard-router.tsx",
  "client/src/components/dashboard-switcher.tsx",
  "client/src/hooks/useAuth.ts",
  "server/routes/restaurantOperationsRoutes.ts",
  "server/routes/restaurantCoreRoutes.ts",
  "server/routes/menuRoutes.ts",
  "server/routes/restaurantSignupRoutes.ts",
  "server/services/loginContinuation.ts",
].forEach((snippet) => requireIncludes(map, snippet, `related surface ${snippet}`));

[
  "OwnerDashboardShell",
  "OwnerProfileCompletionPanel",
  "OwnerProfileEditor",
  "OwnerMenuPanel",
  "OwnerSchedulePanel",
  "OwnerLiveStatusPanel",
  "OwnerDealsPanel",
  "OwnerParkingPassEntryPanel",
  "OwnerVerificationStatusPanel",
  "OwnerAnalyticsPanel",
  "OwnerAssetGenerator",
  "BrandedQrGenerator",
].forEach((snippet) => requireIncludes(map, snippet, `component boundary ${snippet}`));

[
  "static schedule / operating hours belongs to `OwnerSchedulePanel`",
  "Live GPS/broadcasting/websocket state belongs to `OwnerLiveStatusPanel`",
  "do not blur static schedule",
].forEach((snippet) => requireIncludes(map, snippet, `static schedule vs live status ${snippet}`));

[
  "1. Pure display cards only",
  "2. `OwnerAnalyticsPanel` display-only charts",
  "3. `OwnerVerificationStatusPanel`",
  "4. `OwnerProfileCompletionPanel`",
  "5. `OwnerMenuPanel` route/link panel",
  "6. `OwnerParkingPassEntryPanel` route/link panel",
  "7. `OwnerDealsPanel` display shell",
  "8. `OwnerProfileEditor` only after profile draft/save contracts exist",
  "9. `OwnerSchedulePanel` only after setupMode/schedule contracts exist",
  "10. `OwnerLiveStatusPanel` only after GPS/WebSocket lifecycle is isolated/tested",
  "11. `OwnerAssetGenerator` or `BrandedQrGenerator` only after QR/canvas URL behavior is documented/guarded",
].forEach((snippet) => requireIncludes(map, snippet, `extraction order ${snippet}`));

[
  "Do not change owner routes",
  "Do not change login continuation",
  "Do not change Parking Pass access",
  "Do not change insurance verification requirements",
  "Do not change menu gating/discoverability rules",
  "Do not change claim/setup flow",
  "Do not change `setupMode` URL parameter behavior",
  "Do not change `TabsContent` routing logic",
  "Do not touch or extract Canvas/QR generation during mapping",
  "Do not touch or extract `navigator.geolocation` watchers during mapping",
  "Do not change WebSocket session behavior",
  "Do not change endpoint paths",
  "Do not change query keys",
  "Do not change profile save behavior",
  "Do not change profile save payloads",
  "Do not change menu writes",
  "Do not change schedule writes",
  "Do not change media upload/approval behavior",
  "Do not change the profile-access policy without explicit product approval",
  "Do not introduce new features",
].forEach((snippet) => requireIncludes(map, snippet, `do-not-touch rule ${snippet}`));

[
  "`setupMode` URL routing",
  "Owner profile save payloads",
  "QR/canvas canonical URL generation",
  "GPS/WebSocket lifecycle and auto-timeout behavior",
  "Static schedule vs live broadcast separation",
  "Parking Pass entry/cancel behavior if touched",
  "Profile media upload/approval",
].forEach((snippet) => requireIncludes(map, snippet, `missing docs/tests before future refactor ${snippet}`));

[
  "/api/restaurants/my-restaurants",
  "/api/restaurants/:restaurantId/profile-basics",
  "/api/restaurants/:restaurantId/location",
  "/api/restaurants/:restaurantId/operating-hours",
  "/api/restaurants/:restaurantId/truck-session/start",
  "/api/restaurants/:restaurantId/truck-session/end",
  "/api/owner/value-attribution",
  "/api/owner/profile-completion-action",
  "/api/restaurants/:restaurantId/analytics/summary",
  "/api/restaurants/:restaurantId/analytics/export",
  "/api/restaurants/:id/verification/request",
  "/api/owner/menus/:restaurantId",
  "/api/owner/menus",
  "/api/owner/menu-categories",
  "/api/owner/menu-items",
  "/restaurant-owner-dashboard?setup=profile",
  "/menu-builder",
  "/parking-pass-manage",
].forEach((snippet) => requireIncludes(map, snippet, `endpoint or route ${snippet}`));

[
  "node scripts/mealscout-owner-dashboard-decomposition-map.contract.test.ts",
  "node scripts/mealscout-admin-dashboard-decomposition-map.contract.test.ts",
  "node scripts/mealscout-route-map.contract.test.ts",
  "node scripts/repoDoctor.mjs",
  "npm run gate:production",
  "npm run check",
  "npm run build",
].forEach((snippet) => requireIncludes(map, snippet, `validation ${snippet}`));

[
  "Contract tests remain green",
  "No endpoint names changed",
  "No query keys changed",
  "No owner routes changed",
  "No login continuation changed",
  "No Parking Pass access changed",
  "No insurance verification requirements changed",
  "No menu gating/discoverability rules changed",
  "No setupMode URL behavior changed",
  "No TabsContent routing behavior changed",
  "No GPS/WebSocket lifecycle behavior changed",
  "No Canvas/QR URL or download behavior changed",
  "No profile save payload behavior changed",
  "No media upload/approval behavior changed",
  "No mutation behavior changed",
  "Visual behavior is preserved",
  "Component has a clear prop boundary",
].forEach((snippet) => requireIncludes(map, snippet, `exit criteria ${snippet}`));

[
  'user?.userType === "restaurant_owner"',
  'user?.userType === "food_truck"',
  'queryKey: ["/api/business-access/me"]',
  'queryKey: ["/api/restaurants/my-restaurants"]',
  "const hasProfileLocationTools = canManageParkingPass",
  'queryKey: ["/api/bookings/my-truck", selectedRestaurant]',
  "/api/owner/value-attribution",
  "/api/owner/profile-completion-action",
  "profileDraft",
  "setupMode",
  "TabsContent",
  "navigator.geolocation.watchPosition",
  "useFoodTruckSocket",
  "downloadQrPng",
  "downloadBrandedQrAsset",
  "downloadSocialQrGraphic",
  "uploadProfileMediaMutation",
  "approveProfileMediaMutation",
  "/api/restaurants/${selectedRestaurant}/truck-session/start",
  "/api/restaurants/${selectedRestaurant}/truck-session/end",
  "/api/restaurants/${selectedRestaurant}/profile-basics",
  "/api/restaurants/${selectedRestaurant}/operating-hours",
  "/api/restaurants/${selectedRestaurant}/analytics/export",
  "currentDatedStopScheduleHref",
  "/parking-pass?setup=schedule&truckId=",
  "/menu-builder?restaurantId=",
].forEach((snippet) => requireIncludes(ownerDashboard, snippet, `owner dashboard evidence ${snippet}`));

requireIncludes(
  profileAccessPolicy,
  "UNIVERSAL_PROFILE_FREE_TRIAL_ACTIVE = true",
  "current universal profile trial policy",
);

[
  'queryKey: ["/api/owner/menus", restaurantId]',
  'apiRequest("POST", "/api/owner/menus/create"',
  '"Idempotency-Key": attempt.requestId',
  "prepareMenuCreationAttempt",
  "assertMenuCreationReceipt",
  "confirmMenuCreationAttempt",
  'apiRequest("POST", "/api/owner/menu-categories"',
  'apiRequest("POST", "/api/owner/menu-items"',
  "/api/owner/restaurants/${encodeURIComponent(restaurantId)}/ordering-readiness",
].forEach((snippet) => requireIncludes(menuBuilder, snippet, `menu builder evidence ${snippet}`));

[
  'user?.userType === "food_truck"',
  'businessAccess?.permissions?.manageParkingPass === true',
  "/api/business-access/me",
].forEach((snippet) => requireIncludes(parkingPass, snippet, `Parking Pass evidence ${snippet}`));

[
  'roles.has("restaurant_owner") || roles.has("food_truck")',
  'return "/restaurant-owner-dashboard";',
].forEach((snippet) => requireIncludes(dashboardRouter, snippet, `dashboard router evidence ${snippet}`));

[
  'href: "/parking-pass?adminMode=truck"',
  'href: "/menu-builder"',
].forEach((snippet) => requireIncludes(dashboardSwitcher, snippet, `dashboard switcher evidence ${snippet}`));

[
  'continuationPath = "/restaurant-owner-dashboard?setup=profile"',
  'continuationPath = "/restaurant-owner-dashboard?setup=profile-media"',
  'continuationPath = "/menu-builder"',
  'continuationPath = "/restaurant-owner-dashboard?setup=schedule"',
  'continuationPath = "/restaurant-owner-dashboard?setup=verification"',
  'businessAccessSummary?.primaryRestaurantId || ""',
  'target.searchParams.set("restaurantId", primaryBusinessId)',
  'continuationPath = `${target.pathname}${target.search}`',
].forEach((snippet) => requireIncludes(loginContinuation, snippet, `login continuation evidence ${snippet}`));

requireMatch(
  loginContinuation,
  /if \(continuationPath && primaryBusinessId &&\s*\["profile", "profile_visual", "menu", "schedule"\]\.includes\(nextRequiredStep\)\)/,
  "manual setup continuations retain the server-resolved primary business",
);

if (/\bbuildOwnerAiHref\s*\(|continuationPath\s*=\s*["'`]\/owner-ai\b/.test(loginContinuation)) {
  throw new Error("Login continuation must not force AI setup.");
}

[
  '"/api/restaurants/my-restaurants"',
  '"/api/restaurants/:restaurantId/profile-basics"',
  '"/api/restaurants/:restaurantId/location"',
  '"/api/restaurants/:restaurantId/operating-hours"',
  '"/api/restaurants/:restaurantId/truck-session/start"',
  '"/api/restaurants/:restaurantId/truck-session/end"',
  '"/api/owner/value-attribution"',
  '"/api/owner/profile-completion-action"',
].forEach((snippet) => requireIncludes(restaurantOperationsRoutes, snippet, `restaurant operations route ${snippet}`));

[
  'app.post("/api/restaurants"',
  '"/api/restaurants/:id/verification/request"',
  '"/api/restaurants/:restaurantId/analytics/favorites"',
  '"/api/restaurants/:restaurantId/analytics/recommendations"',
].forEach((snippet) => requireIncludes(restaurantCoreRoutes, snippet, `restaurant core route ${snippet}`));

[
  '"/api/owner/menus/:restaurantId"',
  '"/api/owner/menus"',
  '"/api/owner/menu-categories"',
  '"/api/owner/menu-items"',
  '"/api/owner/restaurants/:restaurantId/ordering-readiness"',
].forEach((snippet) => requireIncludes(menuRoutes, snippet, `menu route ${snippet}`));

requireMatch(
  cleanupMap,
  /C7 - Owner Dashboard Decomposition Map[\s\S]*Status: `DONE`/,
  "CLEANUP_MAP.md marks C7 DONE",
);

requireMatch(
  cleanupMap,
  /C8 - Public\/Auth Route Boundary Audit[\s\S]*Status: `DONE`/,
  "CLEANUP_MAP.md marks C8 DONE",
);

const scopeDriftTerms = /\b(Merlin|TradeScout)\b/i;
if (scopeDriftTerms.test(combined)) {
  throw new Error("Owner dashboard decomposition map must not drift into Merlin/TradeScout scope.");
}

const productFeatureLines = combined
  .split(/\r?\n/)
  .filter((line) =>
    /(new product feature|new dashboard|new monetization flow|new provider integration|feature plan)/i.test(
      line,
    ),
  );

for (const line of productFeatureLines) {
  if (!/(no |not |do not|does not|disallowed|without|frozen|approval)/i.test(line)) {
    throw new Error(`Owner dashboard decomposition map appears to introduce feature scope: ${line}`);
  }
}

console.log("mealscout-owner-dashboard-decomposition-map.contract: PASS");
