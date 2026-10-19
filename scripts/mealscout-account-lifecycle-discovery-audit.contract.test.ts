import { existsSync, readFileSync } from "node:fs";

const auditPath = "MEALSCOUT_ACCOUNT_LIFECYCLE_DISCOVERY_AUDIT.md";
const cleanupMapPath = "CLEANUP_MAP.md";

const requiredFiles = [
  auditPath,
  cleanupMapPath,
  "client/src/App.tsx",
  "client/src/hooks/useAuth.ts",
  "client/src/pages/customer-signup.tsx",
  "client/src/pages/login.tsx",
  "client/src/pages/account-setup.tsx",
  "client/src/pages/post-verification.tsx",
  "client/src/pages/restaurant-owner-dashboard.tsx",
  "client/src/components/business-workspace-shell.tsx",
  "client/src/pages/parking-pass.tsx",
  "client/src/components/dashboard-switcher.tsx",
  "server/unifiedAuth.ts",
  "server/routes/authAccountRoutes.ts",
  "server/routes/truckClaimRoutes.ts",
  "server/routes/hostRoutes.ts",
  "server/routes/bookingRoutes.ts",
  "server/services/loginContinuation.ts",
  "server/services/businessTeamAccess.ts",
  "server/services/parkingPassTruckEligibility.ts",
  "vercel.json",
  "render.yaml",
];

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    throw new Error(
      `Account lifecycle discovery audit missing required file: ${file}`,
    );
  }
}

const read = (path: string) => readFileSync(path, "utf8");
const audit = read(auditPath);
const cleanupMap = read(cleanupMapPath);
const app = read("client/src/App.tsx");
const useAuth = read("client/src/hooks/useAuth.ts");
const customerSignup = read("client/src/pages/customer-signup.tsx");
const login = read("client/src/pages/login.tsx");
const accountSetup = read("client/src/pages/account-setup.tsx");
const postVerification = read("client/src/pages/post-verification.tsx");
const ownerDashboard = read("client/src/pages/restaurant-owner-dashboard.tsx");
const businessWorkspace = read(
  "client/src/components/business-workspace-shell.tsx",
);
const parkingPass = read("client/src/pages/parking-pass.tsx");
const dashboardSwitcher = read("client/src/components/dashboard-switcher.tsx");
const unifiedAuth = read("server/unifiedAuth.ts");
const authAccountRoutes = read("server/routes/authAccountRoutes.ts");
const truckClaimRoutes = read("server/routes/truckClaimRoutes.ts");
const hostRoutes = read("server/routes/hostRoutes.ts");
const bookingRoutes = read("server/routes/bookingRoutes.ts");
const loginContinuation = read("server/services/loginContinuation.ts");
const businessTeamAccess = read("server/services/businessTeamAccess.ts");
const parkingPassTruckEligibility = read(
  "server/services/parkingPassTruckEligibility.ts",
);
const vercel = read("vercel.json");
const render = read("render.yaml");

function requireIncludes(source: string, snippet: string, label = snippet) {
  if (!source.includes(snippet)) {
    throw new Error(`Missing ${label}`);
  }
}

[
  "C9 account lifecycle + discovery boundary audit complete",
  "docs/contract-only stabilization audit",
  "C8 remains NEXT",
  "queued payment/webhook C9 remains queued",
  "## Discovery Entry Points",
  "## Referral Entry",
  "## Session-Stitch Boundary",
  "Guest users can enter through discovery with `?ref`",
  "Guest-safe `/api/auth/user` 401 remains a non-authenticated state",
  "must not flush stored guest referral attribution before auth/session stabilization",
  "/scout?ref=<tag>` is a valid public discovery entry",
  "The `ref` query is attribution metadata only",
  "Internal `admin`, `duper_admin`, and `super_admin` accounts are not affiliate-assigned",
  "Customer mapping note: Customer is the canonical account concept; legacy `diner` is a URL alias only",
  "Legacy URL alias maps to the Customer signup card",
  "there is no backend diner user type",
  "OAuth success query params are hints only",
  "`/api/auth/user` returning 200 is the confirmed signed-in state",
  "Wrong-password recovery is passive",
  "Password reset email is sent only by explicit `/forgot-password` form submit",
  "bare `/account-setup` is not a valid setup completion surface without a token",
  "## SetupMode URL Boundary And Preservation Edge",
  "Setup context such as `?setup=schedule`",
  "`?src=onboarding&focus=schedule` on `/owner-ai`",
  "auth timeout or `/api/auth/user` 401",
  "Invalid or unsafe setup targets must not be blindly trusted",
  "## Owner AI Identity And Consent Boundary",
  "the owner's chosen AI is OAuth-bound to one exact MealScout owner/business pair",
  "OAuth connection consent and content consent are separate",
  "After the actual owner explicitly consents in that AI chat, the AI may call MealScout's approval tool",
  "Manually copied legacy keys remain draft-only",
  "Email verification, business/profile setup, insurance verification, claim verification, password reset, and forced password change are separate lifecycle steps",
  "`/api/business-access/me` represents linked business-team access and must not collapse admin identity into business identity",
  "Food truck schedule-required continuation uses `/restaurant-owner-dashboard?setup=schedule`",
  "`/parking-pass` is a public discovery/search and truck-side booking/schedule surface",
  "food truck owners must not be routed into host-only management",
  "## Blessed Berry Isolation Boundary",
  "The Blessed Berry class of failure is a routing-context isolation issue",
  "`food_truck` users must not be routed into host-only `/parking-pass-manage`",
  "host rows must not be created to repair truck routing",
  "## Multi-Role And Admin Context",
  "Dashboard switching is an explicit admin/staff viewing tool",
  "must not mutate account roles, erase admin permissions",
  "Business-team access is linked-business access, not proof that the system user became that business identity",
  "## Parking Pass Boundaries",
  "Password reset requests must not reveal whether an email exists",
  "Reset emails are sent only from explicit reset-request form submission",
  "Do not change Parking Pass booking, schedule, host, truck, insurance, payout, Premium, or Stripe behavior",
  "Do not add features",
  "Do not change business logic",
  "Do not rename routes, roles, events, files, or user-facing product concepts",
  "Do not add roles or invent a new diner user type",
  "Do not create fake users, fake contractors, fake analytics, placeholder records, or sample data",
].forEach((snippet) =>
  requireIncludes(audit, snippet, `audit snippet ${snippet}`),
);

for (const forbidden of [
  "[cite:",
  "create placeholder",
  "add sample",
  "invented contractor",
  "invented analytics",
]) {
  if (audit.toLowerCase().includes(forbidden.toLowerCase())) {
    throw new Error(`Audit must not contain forbidden scope: ${forbidden}`);
  }
}

[
  "## C9A - Account Lifecycle + Discovery Boundary Audit",
  "Status: `DONE`",
  "Inserted stabilization audit; C8, C9, and C10 are now complete.",
  "did not rename, advance, or imply completion of unrelated runtime work",
].forEach((snippet) =>
  requireIncludes(cleanupMap, snippet, `cleanup map snippet ${snippet}`),
);

requireIncludes(app, '"/scout"', "public /scout prefix");
requireIncludes(app, '"/customer-signup"', "public customer signup prefix");
requireIncludes(app, '"/restaurant-signup"', "public restaurant signup prefix");
requireIncludes(app, '"/claim-truck"', "public claim truck prefix");
requireIncludes(app, '"/parking-pass"', "public parking pass prefix");
requireIncludes(app, '"/account-setup"', "public account setup prefix");
requireIncludes(app, '"/post-verification"', "public post verification prefix");
requireIncludes(
  app,
  'path="/p/:profileType/:profileId"',
  "public profile route",
);
requireIncludes(
  app,
  '<Route path="/parking-pass-manage" component={ParkingPassManage} />',
  "authenticated parking pass management route",
);

[
  "function captureUrlAffiliateRef",
  'urlParams.get("ref")',
  'extractPathAffiliateRef(window.location.pathname || "")',
  "isLikelyCleanAffiliateTagSegment(ref)",
  "setAffiliateRef(ref)",
  "oauthConfirmationPending",
  "hasOAuthCompletionHint",
  'getQueryFn({ on401: "returnNull"',
  "if (!user) return;",
  "isInternalAdmin",
  "setAffiliateRef(null)",
  'setLocation("/change-password")',
].forEach((snippet) =>
  requireIncludes(useAuth, snippet, `useAuth snippet ${snippet}`),
);

[
  'id: "diner"',
  'label: "Find Food"',
  'href: "/customer-signup?role=diner"',
  "getRegistrationUserType",
  ': "customer";',
  "getReferralId",
  "referralId: getReferralId()",
  // The shared builder owns bounded query serialization; the caller supplies
  // claim intent only when the inbound food-truck continuation requested it.
  "businessType: businessSubType",
  "buildRestaurantSignupPath({",
  'intent: BusinessSignupIntent = "create"',
  "businessSubType === \"food_truck\" && inboundBusinessIntent.isClaim",
  '"/event-coordinator/dashboard?setup=onboarding"',
  '"/supplier/dashboard"',
].forEach((snippet) =>
  requireIncludes(
    customerSignup,
    snippet,
    `customer signup snippet ${snippet}`,
  ),
);

[
  'fetchJsonWithRetry<Record<string, any>>("/api/auth/login"',
  'buildAuthPath("/api/auth/google/customer")',
  'buildAuthPath("/api/auth/facebook?userType=customer")',
  'href="/forgot-password"',
  'data-recovery-action="navigate-only"',
  "Invalid email or password. If you cannot sign in, reset your password.",
].forEach((snippet) =>
  requireIncludes(login, snippet, `login snippet ${snippet}`),
);

if (
  login.includes('"/api/auth/forgot-password"') ||
  login.includes("createPasswordResetToken")
) {
  throw new Error("Login page must not trigger password reset email flow");
}

[
  'queryKey: ["/api/auth/validate-setup-token", token]',
  "No token provided",
  "This account setup link is invalid or has expired.",
  "This account setup link has expired or has already been used.",
  '"/api/auth/complete-setup"',
].forEach((snippet) =>
  requireIncludes(accountSetup, snippet, `account setup snippet ${snippet}`),
);

[
  "getSafePath",
  'path === "/account-setup"',
  'if (!params.get("token")) return null;',
  '"/api/auth/resend-verification"',
  '"/api/auth/verification-status"',
].forEach((snippet) =>
  requireIncludes(
    postVerification,
    snippet,
    `post verification snippet ${snippet}`,
  ),
);

[
  'user?.userType === "restaurant_owner"',
  'user?.userType === "food_truck"',
  'setupMode === "schedule"',
  "currentDatedStopScheduleHref",
  "/parking-pass?setup=schedule&truckId=",
].forEach((snippet) =>
  requireIncludes(
    ownerDashboard,
    snippet,
    `owner dashboard snippet ${snippet}`,
  ),
);

[
  'setup: "schedule"',
  "label: availabilityLabel",
  'isFoodTruck ? { truck: "1" } : {}',
].forEach((snippet) =>
  requireIncludes(
    businessWorkspace,
    snippet,
    `business workspace snippet ${snippet}`,
  ),
);

[
  'user?.userType === "food_truck"',
  '"/restaurant-signup?businessType=food_truck&source=parking-pass&claim=1"',
  "Food truck profile required",
  "Connect or claim your business to continue.",
  'setLocation("/host/dashboard")',
  "/api/bookings/truck/",
].forEach((snippet) =>
  requireIncludes(parkingPass, snippet, `parking pass snippet ${snippet}`),
);

[
  "label: 'Admin View'",
  "label: 'Customer View'",
  "label: 'Restaurant View'",
  '{ label: "Host", href: "/host/dashboard"',
  '{ label: "Coordinator", href: "/event-coordinator/dashboard"',
  '{ label: "Supplier", href: "/supplier/dashboard"',
].forEach((snippet) =>
  requireIncludes(
    dashboardSwitcher,
    snippet,
    `dashboard switcher snippet ${snippet}`,
  ),
);

[
  'app.post("/api/auth/customer/register"',
  'app.post("/api/auth/restaurant/register"',
  'app.post("/api/auth/supplier/register"',
  'app.post("/api/auth/login"',
  'app.post("/api/auth/forgot-password"',
  'app.post("/api/auth/reset-password"',
  'app.get("/api/auth/google/customer"',
  'app.get("/api/auth/google/restaurant"',
  '"/api/auth/facebook"',
  "async function applyAffiliateReferral",
  "if (isAdminUserType(user.userType)) return;",
  'app.get("/api/auth/validate-setup-token"',
].forEach((snippet) =>
  requireIncludes(unifiedAuth, snippet, `unified auth snippet ${snippet}`),
);
if (!/app\.post\(\s*["']\/api\/auth\/complete-setup["']\s*,/.test(unifiedAuth)) {
  throw new Error("Missing unified auth complete-setup POST route");
}

[
  'app.get("/api/auth/user"',
  "requiresPasswordReset: true",
  'continuationPath: "/change-password"',
].forEach((snippet) =>
  requireIncludes(
    authAccountRoutes,
    snippet,
    `auth account route snippet ${snippet}`,
  ),
);

[
  '"/api/truck-claims/public-search"',
  '"/api/truck-claims/request"',
  'app.post("/api/truck-claims", isAuthenticated',
  '.set({ userType: "food_truck", updatedAt: new Date() })',
].forEach((snippet) =>
  requireIncludes(truckClaimRoutes, snippet, `truck claim snippet ${snippet}`),
);

[
  "Parking Pass bookings are only available for food trucks.",
  "Verify your email and submit business insurance to book Parking Pass spots.",
].forEach((snippet) =>
  requireIncludes(hostRoutes, snippet, `host route snippet ${snippet}`),
);
[
  "resolveStoredFoodBusinessType",
  "input.truck.insuranceVerified === true",
  "isStaffOrAdminUserType",
].forEach((snippet) =>
  requireIncludes(
    parkingPassTruckEligibility,
    snippet,
    `Parking Pass truck eligibility snippet ${snippet}`,
  ),
);

[
  'app.get("/api/bookings/my-truck"',
  'app.get("/api/bookings/my-host"',
  '"/api/trucks/:truckId/manual-schedule"',
  '"/api/bookings/truck/:truckId/schedule"',
].forEach((snippet) =>
  requireIncludes(bookingRoutes, snippet, `booking route snippet ${snippet}`),
);

[
  'continuationPath: "/account-setup"',
  '"/restaurant-signup?businessType=food_truck&source=auth&claim=1"',
  'continuationPath = "/restaurant-owner-dashboard?setup=profile"',
  'continuationPath = "/restaurant-owner-dashboard?setup=profile-media"',
  'continuationPath = "/menu-builder"',
  'continuationPath = "/restaurant-owner-dashboard?setup=schedule"',
  'continuationPath = "/restaurant-owner-dashboard?setup=verification"',
].forEach((snippet) =>
  requireIncludes(
    loginContinuation,
    snippet,
    `login continuation snippet ${snippet}`,
  ),
);

[
  "Connect or claim your business to continue.",
  "getBusinessAccessContext",
].forEach((snippet) =>
  requireIncludes(
    businessTeamAccess,
    snippet,
    `business access snippet ${snippet}`,
  ),
);

[
  '"source": "/api/(.*)"',
  '"destination": "https://mealscout.onrender.com/api/$1"',
].forEach((snippet) =>
  requireIncludes(vercel, snippet, `vercel api proxy snippet ${snippet}`),
);

["name: mealscout", "autoDeploy: true"].forEach((snippet) =>
  requireIncludes(render, snippet, `render deploy snippet ${snippet}`),
);

console.log("mealscout-account-lifecycle-discovery-audit.contract: PASS");
