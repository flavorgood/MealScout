import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolveProgressivePostVerificationDestination } from "../shared/progressiveOnboarding";

import {
  buildFoodTruckClaimContinuationPath,
  buildRestaurantSignupContinuationPath,
  buildRestaurantSignupPath,
  parseBusinessSignupRouteIntent,
  resolveBusinessAuthProvisioningUserType,
  shouldRestoreBusinessSignupDraft,
} from "../shared/businessSignupIntent";
import {
  isReservedPublicBusinessSlug,
  parseCleanAffiliateBusinessRoute,
} from "../shared/cleanAffiliateLinks";
import { registerAcquisitionPrerenderRoutes } from "../server/seo/acquisitionPrerender";
import {
  buildSafeAccountSetupPath,
  normalizeSafeInternalPath,
} from "../shared/safeInternalPath";
import {
  buildFoodTruckIdentity,
  normalizeFoodTruckIdentityText,
} from "../server/services/foodTruckIdentity";
import { buildSignInContinuationUrl } from "../server/utils/signInContinuation";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

type VercelRoute = {
  source?: string;
  destination?: string;
  src?: string;
  dest?: string;
  has?: Array<{ type?: string; key?: string; value?: string }>;
};

const crawlerUserAgentPattern =
  ".*([Bb][Oo][Tt]|[Cc][Rr][Aa][Ww][Ll][Ee][Rr]|[Ss][Pp][Ii][Dd][Ee][Rr]|[Ss][Ll][Uu][Rr][Pp]|[Cc][Hh][Aa][Tt][Gg][Pp][Tt]-[Uu][Ss][Ee][Rr]|[Aa][Nn][Tt][Hh][Rr][Oo][Pp][Ii][Cc]-[Aa][Ii]|[Cc][Oo][Hh][Ee][Rr][Ee]-[Aa][Ii]).*";
const crawlerUserAgentCondition = {
  type: "header",
  key: "user-agent",
  value: crawlerUserAgentPattern,
};
const crawlerUserAgentMatcher = new RegExp(crawlerUserAgentPattern);
const crawlerUserAgents = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "ExampleCrawler/1.0",
  "ExampleSpider/1.0",
  "Yahoo! Slurp",
  "ChatGPT-User/1.0",
  "Anthropic-AI/1.0",
  "Cohere-AI/1.0",
];
const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

for (const crawlerUserAgent of crawlerUserAgents) {
  assert(
    crawlerUserAgentMatcher.test(crawlerUserAgent),
    `Crawler user agent must match acquisition proxy condition: ${crawlerUserAgent}`,
  );
}
assert.equal(
  crawlerUserAgentMatcher.test(chromeUserAgent),
  false,
  "Ordinary Chrome must fall through to the Vercel SPA.",
);

const vercelConfig = JSON.parse(read("vercel.json")) as {
  rewrites: VercelRoute[];
  routes: VercelRoute[];
};
const acquisitionPaths = ["/for-food-trucks", "/for-restaurants"] as const;
const rewriteFallbackIndex = vercelConfig.rewrites.findIndex(
  (route) => route.destination === "/index.html",
);
const routeFallbackIndex = vercelConfig.routes.findIndex(
  (route) => route.src === "/(.*)" && route.dest === "/index.html",
);

assert(rewriteFallbackIndex >= 0, "Vercel rewrites must retain the SPA fallback.");
assert(routeFallbackIndex >= 0, "Vercel routes must retain the SPA fallback.");
for (const acquisitionPath of acquisitionPaths) {
  const renderDestination = `https://mealscout.onrender.com${acquisitionPath}`;
  const matchingRewrites = vercelConfig.rewrites.filter(
    (route) => route.source === acquisitionPath,
  );
  const matchingRoutes = vercelConfig.routes.filter(
    (route) => route.src === acquisitionPath,
  );
  assert.equal(
    matchingRewrites.length,
    1,
    `${acquisitionPath} must have exactly one rewrite.`,
  );
  assert.equal(
    matchingRoutes.length,
    1,
    `${acquisitionPath} must have exactly one route.`,
  );

  const rewrite = matchingRewrites[0];
  const route = matchingRoutes[0];
  assert.equal(rewrite.destination, renderDestination);
  assert.equal(route.dest, renderDestination);
  assert.deepEqual(rewrite.has, [crawlerUserAgentCondition]);
  assert.deepEqual(route.has, [crawlerUserAgentCondition]);

  const rewriteIndex = vercelConfig.rewrites.indexOf(rewrite);
  const routeIndex = vercelConfig.routes.indexOf(route);

  assert(
    rewriteIndex >= 0 && rewriteIndex < rewriteFallbackIndex,
    `${acquisitionPath} must proxy to Render before the rewrite SPA fallback.`,
  );
  assert(
    routeIndex >= 0 && routeIndex < routeFallbackIndex,
    `${acquisitionPath} must proxy to Render before the route SPA fallback.`,
  );
}

const generic = parseBusinessSignupRouteIntent("");
assert.equal(generic.businessType, "restaurant");
assert.equal(generic.hasExplicitBusinessType, false);
assert.equal(generic.intent, "create");

const create = parseBusinessSignupRouteIntent(
  "?businessType=food_truck&intent=create&source=for-food-trucks&claim=0",
);
assert.deepEqual(
  {
    businessType: create.businessType,
    explicit: create.hasExplicitBusinessType,
    intent: create.intent,
    isClaim: create.isClaim,
    source: create.source,
  },
  {
    businessType: "food_truck",
    explicit: true,
    intent: "create",
    isClaim: false,
    source: "for-food-trucks",
  },
);

const claim = parseBusinessSignupRouteIntent(
  "?businessType=food_truck&claim=1&intent=claim&source=for-food-trucks&q=Taco%20Bus&prefillCity=Austin",
);
assert.equal(claim.isClaim, true);
assert.equal(claim.passthrough.q, "Taco Bus");
assert.equal(claim.passthrough.prefillCity, "Austin");
assert.equal(
  buildRestaurantSignupContinuationPath(claim),
  "/restaurant-signup?businessType=food_truck&intent=claim&source=for-food-trucks&claim=1&q=Taco+Bus&prefillCity=Austin",
);
const exactClaimContinuation = buildFoodTruckClaimContinuationPath({
  listingId: "listing-123",
  q: "Taco Bus",
  source: "setup-invite",
});
assert.equal(
  exactClaimContinuation,
  "/restaurant-signup?businessType=food_truck&intent=claim&source=setup-invite&claim=1&q=Taco+Bus&claimListingId=listing-123",
);
assert.equal(
  buildSafeAccountSetupPath({
    setupToken: "safe-token",
    continuationPath: exactClaimContinuation,
  }),
  "/account-setup?token=safe-token&redirect=%2Frestaurant-signup%3FbusinessType%3Dfood_truck%26intent%3Dclaim%26source%3Dsetup-invite%26claim%3D1%26q%3DTaco%2BBus%26claimListingId%3Dlisting-123",
);
assert.equal(
  buildSafeAccountSetupPath({
    setupToken: "safe-token",
    continuationPath: "https://evil.example/steal",
  }),
  "/account-setup?token=safe-token",
);
assert.equal(
  resolveBusinessAuthProvisioningUserType({
    requestedUserType: "food_truck",
  }),
  "customer",
  "A new Google or email food-truck account is neutral until a profile succeeds.",
);
for (const existingUserType of ["restaurant_owner", "food_truck", "admin"]) {
  assert.equal(
    resolveBusinessAuthProvisioningUserType({
      requestedUserType: "food_truck",
      existingUserType,
    }),
    existingUserType,
    "Existing OAuth accounts must not be downgraded or otherwise rewritten.",
  );
}
assert.equal(
  shouldRestoreBusinessSignupDraft(claim, "food_truck"),
  false,
  "An exact claim must never inherit optional fields from a prior draft.",
);
assert.equal(shouldRestoreBusinessSignupDraft(create, "restaurant"), false);
assert.equal(shouldRestoreBusinessSignupDraft(create, "food_truck"), true);
assert.equal(
  shouldRestoreBusinessSignupDraft(generic, "bar"),
  true,
  "Generic resume keeps the owner's in-progress business type.",
);

const missingCreatePath = buildRestaurantSignupPath({
  businessType: "food_truck",
  intent: "create",
  source: "claim-business",
  passthrough: {
    claimMode: "missing",
    q: "Taco Bus",
    prefillAddress: "10 Main St",
  },
});
assert(missingCreatePath.includes("intent=create"));
assert(!missingCreatePath.includes("claim=1"));
assert.equal(
  parseBusinessSignupRouteIntent(missingCreatePath.split("?")[1]).intent,
  "create",
  "A registry-missing business is a guarded create, not a mislabeled claim.",
);

assert.equal(
  normalizeSafeInternalPath(
    "/restaurant-signup?businessType=food_truck&q=Taco+Bus",
  ),
  "/restaurant-signup?businessType=food_truck&q=Taco+Bus",
);
for (const unsafePath of [
  "/\\evil.example",
  "//evil.example",
  "https://evil.example",
  "/ok\nLocation:https://evil.example",
]) {
  assert.equal(
    normalizeSafeInternalPath(unsafePath),
    null,
    `Unsafe internal redirect accepted: ${JSON.stringify(unsafePath)}`,
  );
}

assert.equal(
  normalizeFoodTruckIdentityText("  TACO---Bus!!!  "),
  "taco bus",
);
assert.deepEqual(
  buildFoodTruckIdentity({
    name: "  TACO---Bus!!!  ",
    address: "101 Main St.",
  }),
  {
    normalizedName: "taco bus",
    normalizedAddress: "101 main st",
    lockKey: "food_truck_identity:taco bus:101 main st",
  },
);
assert.equal(buildFoodTruckIdentity({ name: "!!!", address: "101 Main" }), null);
const safeSignInUrl = buildSignInContinuationUrl({
  req: {
    protocol: "https",
    get(name: string) {
      return name.toLowerCase() === "host" ? "www.mealscout.us" : undefined;
    },
  } as any,
  continuationPath: exactClaimContinuation,
});
assert.equal(
  safeSignInUrl,
  `https://www.mealscout.us/login?redirect=${encodeURIComponent(
    exactClaimContinuation!,
  )}`,
);
assert.equal(
  buildSignInContinuationUrl({
    req: {
      protocol: "https",
      get: () => "www.mealscout.us",
    } as any,
    continuationPath: "https://evil.example/steal",
  }),
  null,
);

assert.equal(
  buildRestaurantSignupPath({
    businessType: "food_truck",
    intent: "create",
    source: "for-food-trucks",
  }),
  "/restaurant-signup?businessType=food_truck&intent=create&source=for-food-trucks",
  "A new truck must not silently inherit claim=1.",
);
assert.equal(
  parseBusinessSignupRouteIntent(
    "?businessType=restaurant&claim=1&intent=claim",
  ).intent,
  "create",
  "Claim intent is only valid for the truck ownership flow.",
);
assert.equal(
  parseBusinessSignupRouteIntent(
    "?businessType=food_truck&source=https%3A%2F%2Fevil.example&q=Truck",
  ).source,
  null,
  "Attribution source must be a small non-PII token.",
);

assert.equal(isReservedPublicBusinessSlug("claim-business"), true);
assert.equal(isReservedPublicBusinessSlug("for-food-trucks"), true);
assert.equal(parseCleanAffiliateBusinessRoute("/claim-business"), null);
assert.equal(parseCleanAffiliateBusinessRoute("/for-food-trucks"), null);

const app = read("client/src/App.tsx");
const landingContent = read("client/src/content/role-landing.ts");
const landingComponent = read("client/src/components/role-landing.tsx");
const visibleSitemap = read("client/src/pages/sitemap.tsx");
const xmlSitemap = read("server/routes/seoRoutes.ts");
const indexNow = read("server/bootstrap/registerSchedulers.ts");
const prerender = read("server/seo/acquisitionPrerender.ts");
const cityLanding = read("client/src/pages/city-landing.tsx");
const claimPage = read("client/src/pages/claim-truck.tsx");
const customerSignup = read("client/src/pages/customer-signup.tsx");
const restaurantSignup = read("client/src/pages/restaurant-signup.tsx");
const login = read("client/src/pages/login.tsx");
const postVerification = read("client/src/pages/post-verification.tsx");
const copy = read("client/src/copy/hostOnboarding.copy.ts");
const unifiedAuth = read("server/unifiedAuth.ts");
const funnelTelemetry = read("client/src/utils/funnelTelemetry.ts");
const restaurantSignupRoutes = read("server/routes/restaurantSignupRoutes.ts");
const restaurantCoreRoutes = read("server/routes/restaurantCoreRoutes.ts");
const truckClaimRoutes = read("server/routes/truckClaimRoutes.ts");
const businessPromotion = read("server/services/businessOnboardingPromotion.ts");
const foodTruckIdentity = read("server/services/foodTruckIdentity.ts");
const accountSetupCompletion = read(
  "server/services/accountSetupCompletion.ts",
);
const accountSetup = read("server/utils/accountSetup.ts");
const signInContinuation = read("server/utils/signInContinuation.ts");
const accountSetupPage = read("client/src/pages/account-setup.tsx");

for (const [source, snippet, message] of [
  [app, 'path="/for-food-trucks" component={ForFoodTrucks}', "SPA route"],
  [app, '"/for-food-trucks"', "public route guard"],
  [visibleSitemap, 'href: "/for-food-trucks"', "visible sitemap"],
  [xmlSitemap, '"/for-food-trucks"', "XML sitemap"],
  [indexNow, '`${baseUrl}/for-food-trucks`', "IndexNow URL"],
  [prerender, 'path: "/for-food-trucks"', "crawler prerender"],
  [cityLanding, '<Link href="/for-food-trucks">', "city internal link"],
] as const) {
  assert(source.includes(snippet), `Missing food-truck acquisition ${message}.`);
}

assert(landingContent.includes('canonicalPath: "/for-food-trucks"'));
assert(
  landingContent.includes("Separate paid orders, deliveries, bookings") &&
    landingContent.includes("shown before payment"),
  "Truck landing must disclose separate transaction charges.",
);
assert(
  landingContent.includes("intent=create&source=for-food-trucks") &&
    landingContent.includes("/claim-business?businessType=food_truck&claim=1&intent=claim&source=for-food-trucks"),
  "Truck landing must expose separate create and claim paths.",
);
assert(
  landingComponent.includes("FUNNEL_EVENTS.landingView") &&
    landingComponent.includes("FUNNEL_EVENTS.primaryCtaClick") &&
    landingComponent.includes('source: "for-food-trucks"'),
  "Truck landing must record view and CTA intent without query/name fields.",
);
assert(
  funnelTelemetry.includes("getSafeReferrer") &&
    funnelTelemetry.includes("toSafeFunnelDestinationPath") &&
    funnelTelemetry.includes("`${referrer.origin}${referrer.pathname}`") &&
    !funnelTelemetry.includes("document.referrer || null"),
  "Funnel telemetry must not retain claim or prefill query values from referrers or destinations.",
);

const restaurantCrawlerStart = prerender.indexOf('path: "/for-restaurants"');
const truckCrawlerStart = prerender.indexOf('path: "/for-food-trucks"');
const restaurantCrawler = prerender.slice(restaurantCrawlerStart, truckCrawlerStart);
assert(!restaurantCrawler.includes("restaurants and food trucks"));
assert(restaurantCrawler.includes("MealScout for Restaurants"));

assert(
  claimPage.includes('title="Claim Your Food Truck | MealScout"') &&
    claimPage.includes('title="Claim Your Food Truck"') &&
    claimPage.includes("didAutoSearch.current = true") &&
    claimPage.includes("buildRestaurantSignupPath"),
  "Claim page must be truck-specific, auto-search inbound q, and preserve canonical claim intent.",
);

assert(
  customerSignup.includes('intent: BusinessSignupIntent = "create"') &&
    customerSignup.includes("inboundBusinessIntent.isClaim") &&
    !customerSignup.includes('params.set("claim", "1")'),
  "Customer signup must only carry claim intent when it was explicitly requested.",
);

assert(
  restaurantSignup.includes('businessType: "restaurant",') &&
    restaurantSignup.indexOf("parseBusinessSignupRouteIntent") <
      restaurantSignup.indexOf("useForm<RestaurantFormData>") &&
    restaurantSignup.includes("signupRouteIntent.hasExplicitBusinessType"),
  "Restaurant signup must classify explicit route intent before its first form render while retaining generic draft resumes.",
);
for (const snippet of [
  "routePresentation.foodTruck.createHero",
  "routePresentation.foodTruck.claimHero",
  "businessType: signupRouteIntent.businessType",
  "intendedNextPath: continuationPath",
  'userType: isFoodTruckRoute ? "food_truck" : "restaurant_owner"',
  "redirect: continuationPath",
  'apiRequest("POST", "/api/auth/restaurant/login", data)',
  'stage: "owner_account_submit"',
  'stage: "restaurant_onboarding_submit"',
  'stage: "owner_linked_truck_profile_completed"',
  "restaurant.ownerId === user?.id",
]) {
  assert(restaurantSignup.includes(snippet), `Missing signup contract: ${snippet}`);
}
assert(
  restaurantSignup.includes("signupRouteIntent.isClaim && !claimSelection") &&
    restaurantSignup.includes("claimSelectionRequiredDescription") &&
    restaurantSignup.includes("claimCreateInstead"),
  "An existing-listing claim must select a claimable registry row before profile submission.",
);
assert(
  restaurantSignup.includes("claimSearchCompleted") &&
    restaurantSignup.includes("isLikelySameTruckListing") &&
    restaurantSignup.includes('params.set("listingId", claimListingId)') &&
    restaurantSignup.includes("exactListing.canClaim === false") &&
    restaurantSignup.includes("setPendingClaimListingId(\"\")") &&
    restaurantSignup.includes("? pendingClaimListingId") &&
    claimPage.includes("claimListingId: row.id") &&
    claimPage.includes('intent: "create"'),
  "Selected claims must survive auth by exact ID, while registry-missing businesses remain duplicate-guarded creates.",
);
assert(
  claimPage.includes("isLoading: isAuthLoading") &&
    claimPage.includes(
      "if (isAuthLoading || !initialQuery || didAutoSearch.current) return;",
    ),
  "Public claim auto-search must wait for auth hydration before choosing its data scope.",
);
assert(
    restaurantSignup.includes("created &&") &&
    restaurantSignupRoutes.includes("created: promoted.created") &&
    businessPromotion.includes("acquireFoodTruckIdentityLock") &&
    businessPromotion.includes("food_truck_identity_exists") &&
    foodTruckIdentity.includes("pg_advisory_xact_lock") &&
    foodTruckIdentity.includes("FOOD_TRUCK_BUSINESS_TYPE_ALIASES") &&
    foodTruckIdentity.includes("restaurants.isFoodTruck") &&
    foodTruckIdentity.includes("lower(trim(coalesce") &&
    restaurantCoreRoutes.includes("resolveStoredFoodBusinessType(restaurantData)") &&
    restaurantCoreRoutes.includes("promoteBusinessSetupToProfile(userId") &&
    restaurantCoreRoutes.includes("req.body?.acceptTerms !== true") &&
    truckClaimRoutes.includes("completionKind: \"claim\"") &&
    truckClaimRoutes.includes("created: true"),
  "Completion telemetry must use server-confirmed one-time create or claim truth.",
);
assert(
  restaurantSignup.includes('"owner_account_google_submit"') &&
    restaurantSignup.includes('"owner_account_google_login"') &&
    restaurantSignup.includes('provider: "google"'),
  "Google owner signup must emit a non-PII submit stage before OAuth navigation.",
);
assert(
  restaurantSignup.includes("transactionDisclosure") &&
    copy.includes("Separate paid orders, deliveries, bookings, or add-ons"),
  "Direct signup must disclose separate paid-transaction charges.",
);
assert(
  unifiedAuth.includes("normalizeSafeInternalPath") &&
    unifiedAuth.includes("buildOAuthErrorRedirect") &&
    unifiedAuth.includes("resolveBusinessAuthProvisioningUserType") &&
    restaurantSignupRoutes.includes("resolveBusinessAuthProvisioningUserType") &&
    restaurantSignupRoutes.includes("provisioningUserType") &&
    unifiedAuth.includes("isBusinessCapableForContinuation(user.userType)") &&
    login.includes("authUrl(buildAuthPath(nextAuthPath))"),
  "Email and Google auth handoffs must preserve a validated owner continuation on success and failure.",
);

const authenticatedSearchStart = truckClaimRoutes.indexOf(
  'app.get("/api/truck-claims/search"',
);
const publicSearchStart = truckClaimRoutes.indexOf(
  '"/api/truck-claims/public-search"',
);
const reminderStart = truckClaimRoutes.indexOf(
  '"/api/truck-claims/request"',
);
const claimMutationStart = truckClaimRoutes.indexOf(
  'app.post("/api/truck-claims"',
);
const authenticatedSearch = truckClaimRoutes.slice(
  authenticatedSearchStart,
  publicSearchStart,
);
const publicSearch = truckClaimRoutes.slice(publicSearchStart, reminderStart);
const reminderMutation = truckClaimRoutes.slice(
  reminderStart,
  claimMutationStart,
);
const claimMutation = truckClaimRoutes.slice(claimMutationStart);
assert(
  authenticatedSearch.includes("req.query?.listingId") &&
    authenticatedSearch.includes("eq(truckImportListings.id, listingId)") &&
    authenticatedSearch.includes("status: truckImportListings.status"),
  "Authenticated claim lookup must guarantee an exact-ID result and return availability status.",
);
assert(
  publicSearch.includes("publicClaimSearchLimiter") &&
    publicSearch.includes("escapeLikePattern") &&
    publicSearch.includes("id: truckImportListings.id") &&
    publicSearch.includes("name: truckImportListings.name") &&
    publicSearch.includes("address: truckImportListings.address") &&
    publicSearch.includes("city: truckImportListings.city") &&
    publicSearch.includes("state: truckImportListings.state") &&
    publicSearch.includes("res.json(rows)") &&
    !publicSearch.includes("status: truckImportListings.status") &&
    !publicSearch.includes("invitedUserId: truckImportListings.invitedUserId") &&
    !publicSearch.includes("phone: truckImportListings.phone") &&
    !publicSearch.includes("externalId: truckImportListings.externalId") &&
    !publicSearch.includes("confidenceScore: truckImportListings.confidenceScore"),
  "Public claim search must be bounded, rate-limited, wildcard-safe, and contact-minimal.",
);
assert(
  truckClaimRoutes.includes(
    '"/api/truck-claims/request",\n    isAuthenticated,\n    claimReminderLimiter',
  ) &&
    reminderMutation.includes("reminderReservation") &&
    reminderMutation.includes("recoverFailedDelivery") &&
    reminderMutation.includes('userType: "customer"') &&
    reminderMutation.includes("buildFoodTruckClaimContinuationPath") &&
    reminderMutation.includes("continuationPath") &&
    reminderMutation.includes("!inviteUser.passwordHash") &&
    reminderMutation.includes("!inviteUser.emailVerified") &&
    reminderMutation.includes("sendVerificationInvite") &&
    reminderMutation.includes("sendSignInInvite") &&
    reminderMutation.includes("lt(truckImportListings.lastInviteSentAt") &&
    claimMutation.includes("db.transaction") &&
    claimMutation.includes("acquireFoodTruckIdentityLock") &&
    claimMutation.includes("normalizedFoodTruckImportIdentityPredicate") &&
    claimMutation.includes("siblingListings") &&
    claimMutation.includes(
      "inArray(restaurants.claimedFromImportId, siblingListingIds)",
    ) &&
    claimMutation.includes("normalizedFoodTruckRestaurantIdentityPredicate") &&
    claimMutation.includes("name: listing.name") &&
    claimMutation.includes("address: listing.address") &&
    claimMutation.includes("normalizeFoodTruckIdentityText") &&
    claimMutation.includes("food_truck_claim_identity_mismatch") &&
    claimMutation.includes("food_truck_identity_already_linked") &&
    claimMutation.includes("differentlyLinkedRestaurant") &&
    claimMutation.includes("food_truck_identity_ambiguous") &&
    claimMutation.includes("food_truck_identity_owned") &&
    claimMutation.includes('eq(truckImportListings.status, "unclaimed")') &&
    claimMutation.indexOf('status: "claim_processing"') <
      claimMutation.indexOf(".insert(restaurants)") &&
    claimMutation.indexOf('status: "claim_requested"') >
      claimMutation.indexOf(".insert(truckClaimRequests)") &&
    claimMutation.includes("req.body?.restaurantData?.acceptTerms !== true"),
  "Claim reminders require authenticated rate limits, and claims reserve ownership atomically behind the legal gate.",
);

const completeSetupStart = unifiedAuth.indexOf(
  '"/api/auth/complete-setup"',
);
const completePhoneSetupStart = unifiedAuth.indexOf(
  'app.post("/api/auth/complete-phone-setup"',
);
const completeSetupMutation = unifiedAuth.slice(
  completeSetupStart,
  completePhoneSetupStart,
);
assert(
  unifiedAuth.includes('scope: "auth:complete-account-setup"') &&
    unifiedAuth.includes("limit: 5") &&
    unifiedAuth.includes("15 * 60 * 1000") &&
    unifiedAuth.includes('key: (req) => String(req.ip || "unknown")') &&
    unifiedAuth.includes("hashAccountSetupPassword?:") &&
    unifiedAuth.includes("bcrypt.hash(password, 12)") &&
    completeSetupMutation.includes("completeAccountSetupLimiter") &&
    completeSetupMutation.includes("getAccountSetupTokenByTokenHash") &&
    completeSetupMutation.includes("hashAccountSetupPassword(password)") &&
    completeSetupMutation.indexOf("getAccountSetupTokenByTokenHash") <
      completeSetupMutation.indexOf("hashAccountSetupPassword(password)") &&
    completeSetupMutation.indexOf("hashAccountSetupPassword(password)") <
      completeSetupMutation.indexOf("completeAccountSetupTransaction"),
  "Account setup completion must be IP-limited and reject inactive tokens before its injectable production cost-12 password hash while retaining transactional authority.",
);
assert(
  signInContinuation.includes("normalizeSafeInternalPath") &&
    signInContinuation.includes("/login?redirect=") &&
    signInContinuation.includes("encodeURIComponent(safeContinuation)") &&
    signInContinuation.includes('"account"'),
  "Verified password users must receive an account-category sign-in link with only a safe exact continuation.",
);
assert(
  accountSetup.indexOf("createAccountSetupToken") <
    accountSetup.indexOf("sendAccountSetupEmail") &&
    accountSetup.includes("deleteAccountSetupToken(createdToken.id)") &&
    !accountSetup.includes("deleteUserSetupTokens(user.id)") &&
    unifiedAuth.includes("completeAccountSetupTransaction") &&
    unifiedAuth.includes("ACCOUNT_SETUP_ALREADY_COMPLETED_CODE") &&
    accountSetupCompletion.includes("db.transaction") &&
    accountSetupCompletion.includes("for update") &&
    accountSetupCompletion.includes("isNull(users.passwordHash)") &&
    accountSetupCompletion.indexOf(".update(users)") <
      accountSetupCompletion.indexOf(".delete(accountSetupTokens)"),
  "Setup delivery must preserve old tokens, delete only a failed new token, and atomically let one user-row-locked completion invalidate all tokens.",
);
// Run the actual page selector so sanitizer relocation cannot weaken this contract.
const postVerificationAst = ts.createSourceFile(
  "post-verification.tsx", postVerification, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);
const redirectPickers = postVerificationAst.statements
  .filter(ts.isFunctionDeclaration)
  .filter((statement) => statement.name?.text === "getBestRedirect");
assert.equal(redirectPickers.length, 1, "Post-verification must have one actual destination selector.");
let importedPolicyName: string | undefined;
for (const statement of postVerificationAst.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@shared/progressiveOnboarding") continue;
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) continue;
  for (const binding of bindings.elements) {
    if ((binding.propertyName || binding.name).text === "resolveProgressivePostVerificationDestination") {
      importedPolicyName = binding.name.text;
    }
  }
}
assert(importedPolicyName, "The actual page must bind the shared post-verification policy.");
const policySymbol = importedPolicyName;
const redirectPickerCode = ts.transpileModule(redirectPickers[0].getText(postVerificationAst), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function selectActualPostVerificationRedirect(params: URLSearchParams, stored: string | null): string {
  return runInNewContext(redirectPickerCode + "\ngetBestRedirect(params);", {
    [policySymbol]: resolveProgressivePostVerificationDestination,
    params,
    REDIRECT_STORAGE_KEY: "mealscout:post-verification-redirect",
    CANONICAL_DASHBOARD_ENTRY_PATH: "/dashboard",
    getStoredValue: (key: string) => {
      assert.equal(key, "mealscout:post-verification-redirect");
      return stored;
    },
  }, { timeout: 1000 });
}
assert.equal(selectActualPostVerificationRedirect(
  new URLSearchParams({ status: "check-email", redirect: "/scout" }), exactClaimContinuation,
), exactClaimContinuation, "Same-session check-email must preserve the exact saved claim.");
assert.equal(selectActualPostVerificationRedirect(
  new URLSearchParams({ verified: "1", redirect: exactClaimContinuation }), "/scout",
), exactClaimContinuation, "A fresh email must preserve its exact explicit claim.");
for (const reason of ["keep_draft", "contact", "restricted"]) {
  assert.equal(selectActualPostVerificationRedirect(
    new URLSearchParams({ status: "check-email", reason, redirect: exactClaimContinuation }), "/scout",
  ), exactClaimContinuation, "An explicit progressive return must preserve its exact claim.");
}
for (const context of ["status=check-email", "verified=1", "reason=keep_draft"]) {
  for (const unsafe of [
    "https://evil.example/steal", "//evil.example/steal",
    "/account-setup#kept", "/account-setup?token=#kept", "/account-setup?token=%20#kept",
  ]) {
    const params = new URLSearchParams(context);
    params.set("redirect", unsafe);
    assert.equal(selectActualPostVerificationRedirect(params, unsafe), "/dashboard",
      "The actual page must reject external or tokenless setup returns in either position.");
  }
}
const tokenizedSetupReturn = "/account-setup?token=opaque-server-token#kept";
assert.equal(selectActualPostVerificationRedirect(
  new URLSearchParams({ verified: "1", redirect: tokenizedSetupReturn }), "/scout",
), tokenizedSetupReturn, "A token-bearing internal return must retain its query and fragment.");
console.log("[PASS] Actual post-verification selector preserves exact claims and rejects unsafe/tokenless returns.");


assert(
  accountSetup.includes("buildSafeAccountSetupPath") &&
    accountSetup.includes("continuationPath") &&
    accountSetupPage.includes("normalizeSafeInternalPath(payload?.redirect)") &&
    postVerification.includes('params.set("redirect", redirectPath)') &&
    login.includes("normalizeSafeInternalPath(params.get(\"redirect\"))") &&
    unifiedAuth.includes("getSafeRedirectPath(req.body?.redirect)") &&
    unifiedAuth.includes("redirect: continuationPath"),
  "Setup invites and account completion must carry only a validated exact claim continuation.",
);
assert(
  !login.includes("FUNNEL_EVENTS.signupCompleted"),
  "A successful login/account handoff must not be counted as a completed truck profile.",
);
assert(
  login.includes("toSafeFunnelDestinationPath(") &&
    customerSignup.includes(
      "redirectPath: toSafeFunnelDestinationPath(businessRedirect)",
    ),
  "Auth handoff telemetry must keep only safe destination paths while navigation retains the full continuation.",
);
assert(
  unifiedAuth.includes(
    'return "/restaurant-signup?businessType=food_truck&intent=create&source=post-verification";',
  ) &&
    !unifiedAuth.includes(
      'return "/restaurant-signup?businessType=food_truck&source=post-verification&claim=1";',
    ),
  "A food-truck continuation without explicit claim intent must default to create.",
);
assert(
  copy.includes('signupButton: "Create Food Truck Account"') &&
    !copy.slice(copy.indexOf("routePresentation:"), copy.indexOf("unauth:")).includes("Step 2"),
  "Food-truck account copy must be specific and must not show an unexplained step number.",
);

type PrerenderHandler = (req: any, res: any, next: () => void) => void;
const prerenderHandlers = new Map<string, PrerenderHandler>();
registerAcquisitionPrerenderRoutes(
  {
    get(path: string, handler: PrerenderHandler) {
      prerenderHandlers.set(path, handler);
    },
  } as any,
  "https://www.mealscout.us",
);

const renderCrawlerPage = (path: string) => {
  let html = "";
  let nextCalled = false;
  const headers = new Map<string, string>();
  const handler = prerenderHandlers.get(path);
  assert(handler, `Missing acquisition prerender handler for ${path}.`);
  handler(
    {
      query: {},
      get(name: string) {
        return name.toLowerCase() === "user-agent" ? "Googlebot" : "";
      },
    },
    {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      send(value: string) {
        html = value;
      },
    },
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, false);
  assert.equal(headers.get("content-type"), "text/html; charset=utf-8");
  return html;
};

const truckCrawlerHtml = renderCrawlerPage("/for-food-trucks");
assert(truckCrawlerHtml.includes("<h1>Put your food truck where locals can find it</h1>"));
assert(truckCrawlerHtml.includes('rel="canonical" href="https://www.mealscout.us/for-food-trucks"'));
assert(truckCrawlerHtml.includes("businessType=food_truck&amp;intent=create"));
assert(truckCrawlerHtml.includes("claim-business?businessType=food_truck&amp;claim=1"));

const restaurantCrawlerHtml = renderCrawlerPage("/for-restaurants");
assert(restaurantCrawlerHtml.includes("<h1>Help local diners find your restaurant</h1>"));
assert(!restaurantCrawlerHtml.includes("Claim an Existing Truck"));

console.log("food-truck-signup-funnel.contract: PASS");
