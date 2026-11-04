import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canManageLockedRestaurantConnect,
  restaurantConnectAccountCreationIdempotencyKey,
} from "../server/utils/restaurantConnectOnboarding";
import { parseGoldenPlateAreaSelection } from "../server/utils/goldenPlateArea";
import {
  clearPickupCheckoutRecovery,
  readPickupCheckoutRecovery,
  writePickupCheckoutRecovery,
  type PickupCheckoutRecovery,
} from "../client/src/lib/pickupCheckoutRecovery";

const read = (path: string) => readFileSync(path, "utf8");
const initialConnectCreationKey =
  restaurantConnectAccountCreationIdempotencyKey({
    restaurantId: "restaurant-fixture",
    restaurantOwnerId: "owner-a",
    connectGeneration: 4,
  });
assert.equal(
  initialConnectCreationKey,
  restaurantConnectAccountCreationIdempotencyKey({
    restaurantId: "restaurant-fixture",
    restaurantOwnerId: "owner-a",
    connectGeneration: 4,
  }),
  "Connect account retries in one owner generation must keep a stable key",
);
const transferredOwnerConnectCreationKey =
  restaurantConnectAccountCreationIdempotencyKey({
    restaurantId: "restaurant-fixture",
    restaurantOwnerId: "owner-b",
    connectGeneration: 5,
  });
assert.notEqual(
  transferredOwnerConnectCreationKey,
  initialConnectCreationKey,
  "owner transfer must start a different Connect account-creation generation",
);
assert.notEqual(
  transferredOwnerConnectCreationKey,
  restaurantConnectAccountCreationIdempotencyKey({
    restaurantId: "restaurant-fixture",
    restaurantOwnerId: "owner-b",
    connectGeneration: 6,
  }),
  "Connect deauthorization must advance to a different account-creation key",
);
assert.equal(
  canManageLockedRestaurantConnect({
    restaurantOwnerId: "new-owner",
    requesterUserId: "former-owner",
    requesterIsInternalTeam: false,
  }),
  false,
  "a former owner must fail reauthorization when ownership changes before the row lock is acquired",
);
assert.equal(
  canManageLockedRestaurantConnect({
    restaurantOwnerId: "new-owner",
    requesterUserId: "new-owner",
    requesterIsInternalTeam: false,
  }),
  true,
  "the current owner must pass locked-row reauthorization",
);
assert.equal(
  canManageLockedRestaurantConnect({
    restaurantOwnerId: "new-owner",
    requesterUserId: "support-user",
    requesterIsInternalTeam: true,
  }),
  true,
  "the intentional internal-team support path must remain available",
);
assert.deepEqual(parseGoldenPlateAreaSelection("Winston-Salem"), {
  kind: "single",
  value: "winston-salem",
});
assert.deepEqual(parseGoldenPlateAreaSelection("Winston-Salem-NC"), {
  kind: "city_state",
  city: "winston-salem",
  state: "nc",
});
const checkoutRecoveryValues = new Map<string, string>();
const checkoutRecoveryStorage = {
  getItem: (key: string) => checkoutRecoveryValues.get(key) ?? null,
  setItem: (key: string, value: string) => {
    checkoutRecoveryValues.set(key, value);
  },
  removeItem: (key: string) => {
    checkoutRecoveryValues.delete(key);
  },
};
const checkoutRecoveryFixture: PickupCheckoutRecovery = {
  version: 1,
  restaurantId: "restaurant-fixture",
  checkoutRequestId: "00000000-0000-4000-8000-000000000001",
  customerAccessToken: "a".repeat(64),
  checkoutPayload: {
    restaurantId: "restaurant-fixture",
    menuId: "menu-fixture",
    customerName: "Test Customer",
    customerEmail: "customer@example.com",
    orderType: "pickup",
    checkoutRequestId: "00000000-0000-4000-8000-000000000001",
    customerAccessToken: "a".repeat(64),
    paymentMethod: "card",
    items: [{ menuItemId: "item-fixture", quantity: 1 }],
  },
  orderId: "order-fixture",
  clientSecret: "pi_fixture_secret_fixture",
  authoritativePaymentOrder: {
    merchantNameSnapshot: "Fixture Kitchen",
    pickupAddressSnapshot: "1 Test Way",
    pricesIncludeTax: true,
  },
  serverTotals: {
    subtotalCents: 1000,
    mealscoutFeeCents: 100,
    processingFeeCents: 63,
    platformFeeCents: 163,
    totalCents: 1163,
    feePaidByBusiness: false,
  },
  updatedAt: Date.now(),
};
writePickupCheckoutRecovery(checkoutRecoveryFixture, checkoutRecoveryStorage);
assert.deepEqual(
  readPickupCheckoutRecovery(
    checkoutRecoveryFixture.restaurantId,
    checkoutRecoveryStorage,
  ),
  checkoutRecoveryFixture,
  "reload recovery must restore the same checkout request, access token, order, and payment state",
);
clearPickupCheckoutRecovery(
  checkoutRecoveryFixture.restaurantId,
  checkoutRecoveryStorage,
);
assert.equal(
  readPickupCheckoutRecovery(
    checkoutRecoveryFixture.restaurantId,
    checkoutRecoveryStorage,
  ),
  null,
  "terminal checkout cleanup must remove recovery state",
);
const menuRoutes = read("server/routes/menuRoutes.ts");
const pickupRoutes = read("server/routes/pickupOrderRoutes.ts");
const pickupOrderIdentity = read(
  "server/services/pickupOrderIdentityService.ts",
);
const paymentRoutes = read("server/routes/restaurantPaymentRoutes.ts");
const awardsRoutes = read("server/routes/awardsRoutes.ts");
const awardCalculations = read("server/awardCalculations.ts");
const routeRegistry = read("server/routes.ts");
const webhookRoutes = read("server/routes/stripeWebhookRoutes.ts");
const notificationService = read(
  "server/services/pickupOrderNotificationService.ts",
);
const cancellationService = read(
  "server/services/pickupOrderCancellationService.ts",
);
const completedRefundService = read(
  "server/services/pickupOrderCompletedRefundService.ts",
);
const disputeService = read("server/services/pickupOrderDisputeService.ts");
const disputeTruth = read("server/services/pickupOrderDisputeTruth.ts");
const netSettlementPolicy = read(
  "server/services/pickupOrderNetSettlementPolicy.ts",
);
const payoutRecoveryPolicy = read(
  "server/services/pickupOrderPayoutRecoveryPolicy.ts",
);
const checkoutReplayPolicy = read(
  "server/services/pickupCheckoutReplayPolicy.ts",
);
const transferReversalService = read(
  "server/services/pickupOrderTransferReversalService.ts",
);
const paymentExpiryService = read(
  "server/services/pickupOrderPaymentExpiryService.ts",
);
const recurringJobs = read("server/bootstrap/registerRecurringJobs.ts");
const inventoryService = read("server/services/pickupInventoryService.ts");
const financialLock = read("server/utils/pickupOrderFinancialLock.ts");
const publicProfileMapper = read(
  "server/publicProfiles/toPublicRestaurantProfile.ts",
);
const publicListingMapper = read(
  "server/publicProfiles/toPublicRestaurantListing.ts",
);
const publicDiscoveryRoutes = read("server/routes/publicDiscoveryRoutes.ts");
const publicSearchRoutes = read("server/routes/publicSearchRoutes.ts");
const merchantDeliveryRoutes = read("server/routes/merchantDeliveryRoutes.ts");
const schema = read("shared/schema/legacy.ts");
const refundTruth = read("shared/pickupOrderFinancialTruth.ts");
const menuBuilder = read("client/src/pages/menu-builder.tsx");
const onlineMenu = read("client/src/pages/online-menu.tsx");
const checkout = read("client/src/pages/pickup-checkout.tsx");
const checkoutRecovery = read("client/src/lib/pickupCheckoutRecovery.ts");
const checkoutTruth = read("client/src/lib/pickupCheckoutTruth.ts");
const confirmation = read("client/src/pages/order-confirmation.tsx");
const ownerOrders = read("client/src/components/owner-orders-workspace.tsx");
const scout = read("client/src/pages/explore-preview-v2.tsx");
const scoutSceneCopy = read("client/src/features/scout/scoutSceneCopy.ts");
const orderContact = read("shared/orderContact.ts");
const restaurantCoreRoutes = read("server/routes/restaurantCoreRoutes.ts");
const restaurantSignupRoutes = read("server/routes/restaurantSignupRoutes.ts");
const truckClaimRoutes = read("server/routes/truckClaimRoutes.ts");
const truckImportAdminRoutes = read(
  "server/routes/admin/truckImportAdminRoutes.ts",
);
const restaurantRepository = read(
  "server/storage/restaurantsDealsRepository.ts",
);
const storageSource = read("server/storage.ts");
const userAdminRoutes = read("server/routes/admin/userAdminRoutes.ts");
const orderingAuthorityReset = read(
  "server/services/restaurantOrderingAuthorityReset.ts",
);
const ownerTransferSafety = read(
  "server/services/restaurantOwnerTransferSafety.ts",
);
const publicLocalMenuItemProjection = read(
  "server/services/publicLocalMenuItemProjection.ts",
);
const locationUtilityRoutes = read("server/routes/locationUtilityRoutes.ts");
const recommendationEngine = read("server/services/recommendationEngine.ts");
const actionRoutes = read("server/routes/actionRoutes.ts");
const dealDiscoveryRoutes = read("server/routes/dealDiscoveryRoutes.ts");
const publicDealProjection = read("server/services/publicDealProjection.ts");
const publicHostProximityProjection = read(
  "server/services/publicHostProximityProjection.ts",
);
const visitPanel = read(
  "client/src/components/public-profile/PlanYourVisitPanel.tsx",
);
const connectMigration = read("migrations/125_restaurant_stripe_connect.sql");
const snapshotMigration = read(
  "migrations/126_pickup_order_fulfillment_snapshot.sql",
);
const feeMigration = read("migrations/127_pickup_order_fee_breakdown.sql");
const prepTimeMigration = read(
  "migrations/128_pickup_order_prep_time_truth.sql",
);
const notificationRetryMigration = read(
  "migrations/129_order_notification_retry_attempts.sql",
);
const refundMigration = read(
  "migrations/130_pickup_order_refund_reconciliation.sql",
);
const directionsMigration = read(
  "migrations/131_pickup_order_directions_snapshot.sql",
);
const cohortMigration = read("migrations/132_pickup_order_contract_cohort.sql");
const inventoryProvenanceMigration = read(
  "migrations/133_pickup_order_inventory_reservation_provenance.sql",
);
const taxInclusiveMigration = read(
  "migrations/134_pickup_order_tax_inclusive_contract.sql",
);
const orderingApprovalMigration = read(
  "migrations/135_restaurant_ordering_approval.sql",
);
const disputeMigration = read(
  "migrations/136_pickup_order_dispute_reconciliation.sql",
);
const settlementIdentityMigration = read(
  "migrations/137_pickup_order_settlement_identity_snapshot.sql",
);
const acknowledgementMigration = read(
  "migrations/138_pickup_order_acknowledgement_deadline.sql",
);
const payoutRecoveryMigration = read(
  "migrations/139_pickup_order_payout_reversal_recovery.sql",
);
const orderingAuthorityVersionMigration = read(
  "migrations/140_restaurant_ordering_authority_version.sql",
);
const connectGenerationMigration = read(
  "migrations/141_restaurant_stripe_connect_generation.sql",
);

const checks: Array<[string, () => void]> = [
  [
    "Golden Plate areas preserve hyphenated cities and score every eligible candidate",
    () => {
      assert.match(
        awardsRoutes,
        /parseGoldenPlateAreaSelection\(req\.params\.area\)/,
      );
      assert.match(
        awardsRoutes,
        /selection\.kind === "city_state"[\s\S]*and\([\s\S]*restaurants\.city[\s\S]*restaurants\.state/,
      );
      const leaderboardRoute = awardsRoutes.slice(
        awardsRoutes.indexOf('"/api/awards/golden-plate/leaderboard/:area"'),
        awardsRoutes.indexOf(
          'app.get("/api/restaurants/:restaurantId/ranking-stats"',
        ),
      );
      assert.match(leaderboardRoute, /goldenPlateLeaderboardLimiter/);
      assert.match(
        leaderboardRoute,
        /GOLDEN_PLATE_LEADERBOARD_MAX_CANDIDATES \+ 1/,
      );
      assert.match(leaderboardRoute, /LEADERBOARD_AREA_TOO_BROAD/);
      assert.match(
        leaderboardRoute,
        /calculateRestaurantRankingScores\([\s\S]*publicCandidates\.map/,
      );
      assert.doesNotMatch(
        leaderboardRoute,
        /calculateRestaurantRankingScore\(/,
      );
      assert.match(
        leaderboardRoute,
        /Cache-Control", "no-store, max-age=0"/,
      );
      assert.doesNotMatch(
        leaderboardRoute,
        /public,\s*max-age|stale-while-revalidate/,
      );
      const batchScorer = awardCalculations.slice(
        awardCalculations.indexOf(
          "export async function calculateRestaurantRankingScores",
        ),
        awardCalculations.indexOf(
          "export async function awardGoldenPlatesForArea",
          awardCalculations.indexOf(
            "export async function calculateRestaurantRankingScores",
          ),
        ),
      );
      assert.equal(
        (batchScorer.match(/database\.execute\(/g) || []).length,
        1,
        "batch leaderboard scoring must use one database call regardless of candidate count",
      );
    },
  ],
  [
    "public restaurant search ranks and returns only projected trust fields",
    () => {
      const mainSearch = publicSearchRoutes.slice(
        publicSearchRoutes.indexOf(
          "export async function searchPublicRestaurantResults",
        ),
        publicSearchRoutes.indexOf(
          "export function registerPublicSearchRoutes",
        ),
      );
      const suggestions = publicSearchRoutes.slice(
        publicSearchRoutes.indexOf('app.get("/api/search/suggestions/:query"'),
        publicSearchRoutes.indexOf("const dealRows ="),
      );
      assert.match(mainSearch, /loadPublicRestaurantListingVisibility\(/);
      assert.match(mainSearch, /rankPublicRestaurantSearchRows\(/);
      assert.doesNotMatch(mainSearch, /desc\(restaurants\.isVerified\)/);
      assert.doesNotMatch(
        mainSearch,
        /lower\(coalesce\(\$\{restaurants\.address\}/,
      );
      assert.match(suggestions, /buildPublicRestaurantSearchSuggestions\(/);
      assert.doesNotMatch(
        suggestions,
        /lower\(coalesce\(\$\{restaurants\.address\}/,
      );
      const restaurantSearch = restaurantCoreRoutes.slice(
        restaurantCoreRoutes.indexOf('app.get("/api/restaurants/search"'),
        restaurantCoreRoutes.indexOf('app.get("/api/restaurants/public"'),
      );
      assert.match(
        restaurantSearch,
        /toPublicRestaurantListingArrayWithVisibility\(restaurants\)/,
      );
      assert.match(
        restaurantSearch,
        /filterProjectedRestaurantSearchRows\(/,
      );
      assert.ok(
        restaurantSearch.indexOf(
          "toPublicRestaurantListingArrayWithVisibility(restaurants)",
        ) < restaurantSearch.indexOf("filterProjectedRestaurantSearchRows("),
        "Secondary restaurant search must project visibility before text or proximity membership",
      );
      const restaurantPublic = restaurantCoreRoutes.slice(
        restaurantCoreRoutes.indexOf('app.get("/api/restaurants/public"'),
        restaurantCoreRoutes.indexOf('app.get("/api/restaurants/:id"'),
      );
      assert.ok(
        restaurantPublic.indexOf(
          "toPublicRestaurantListingArrayWithVisibility(activeRestaurants)",
        ) < restaurantPublic.indexOf("publicRestaurantDistanceKm("),
        "Public restaurant proximity must use projected coordinates",
      );
      const localItems = menuRoutes.slice(
        menuRoutes.indexOf('"/api/menus/local-items"'),
        menuRoutes.indexOf('"/api/menus/:restaurantId"'),
      );
      assert.match(localItems, /loadPublicRestaurantListingVisibility\(/);
      assert.match(localItems, /projectPublicLocalMenuItemRow\(/);
      assert.match(localItems, /__privateRankingScore: _privateRankingScore/);
      const localItemPublicRowStart =
        publicLocalMenuItemProjection.indexOf("publicRow: {");
      const localItemPublicRow = publicLocalMenuItemProjection.slice(
        localItemPublicRowStart,
        publicLocalMenuItemProjection.indexOf(
          "privateRankingScore:",
          localItemPublicRowStart,
        ),
      );
      assert.doesNotMatch(
        localItemPublicRow,
        /restaurantOwnerId|restaurantRawData|rankingScore/,
      );
    },
  ],
  [
    "all anonymous proximity and deal membership uses public location authority",
    () => {
      const nearbyRestaurants = restaurantCoreRoutes.slice(
        restaurantCoreRoutes.indexOf(
          'app.get("/api/restaurants/nearby/:lat/:lng"',
        ),
        restaurantCoreRoutes.indexOf("// Follow is no longer", 0),
      );
      assert.match(
        nearbyRestaurants,
        /toPublicRestaurantListingArrayWithVisibility\(/,
      );
      assert.match(
        nearbyRestaurants,
        /filterProjectedPublicNearbyRestaurantRows\(/,
      );
      assert.doesNotMatch(nearbyRestaurants, /getNearbyRestaurants\(/);

      const subscribedRestaurants = locationUtilityRoutes.slice(
        locationUtilityRoutes.indexOf(
          'app.get("/api/restaurants/subscribed/:lat/:lng"',
        ),
      );
      assert.match(
        subscribedRestaurants,
        /toPublicRestaurantListingArrayWithVisibility\(\s*canonicalPublicRows[\s\S]*filterProjectedPublicNearbyRestaurantRows\(\s*projectedPublicRows/,
      );
      assert.doesNotMatch(
        subscribedRestaurants,
        /storage\.getNearbyRestaurants\(/,
      );

      assert.match(
        recommendationEngine,
        /filterProjectedPublicNearbyRestaurantRows\(/,
      );
      assert.match(
        recommendationEngine,
        /resolvePublicHostProximityCoordinates\(/,
      );
      assert.doesNotMatch(
        recommendationEngine,
        /storage\.getNearbyRestaurants\(/,
      );
      assert.match(
        publicHostProximityProjection,
        /if \(!showAddress\) return null/,
      );

      assert.doesNotMatch(actionRoutes, /ilike\(restaurants\.address/);
      assert.match(
        actionRoutes,
        /loadPublicProfileVisibilityByUserIds\(/,
      );
      assert.match(
        actionRoutes,
        /resolvePublicHostProximityCoordinates\(/,
      );

      assert.doesNotMatch(dealDiscoveryRoutes, /storage\.getNearbyDeals\(/);
      assert.doesNotMatch(dealDiscoveryRoutes, /storage\.searchDeals\(/);
      assert.match(dealDiscoveryRoutes, /projectPublicDealRows\(/);
      assert.match(publicDealProjection, /toPublicRestaurantListing\(/);
      assert.match(publicDealProjection, /publicRestaurantDistanceKm\(/);
      assert.doesNotMatch(
        publicDealProjection,
        /\.\.\.deal\b|\.\.\.restaurant\b/,
      );
    },
  ],
  [
    "ordering authority changes serialize before checkout and first payout",
    () => {
      assert.match(schema, /orderingAuthorityVersion:/);
      assert.match(schema, /orderingAuthorityVersion: true/);
      assert.match(
        orderingAuthorityVersionMigration,
        /trigger_restaurant_ordering_authority_before_update/,
      );
      for (const trigger of [
        "trigger_owner_ordering_authority_after_update",
        "trigger_menu_ordering_authority",
        "trigger_menu_category_ordering_authority",
        "trigger_menu_item_ordering_authority",
        "trigger_menu_item_variant_ordering_authority",
        "trigger_menu_item_modifier_ordering_authority",
        "trigger_truck_manual_schedule_ordering_authority",
        "trigger_event_booking_ordering_authority",
        "trigger_event_ordering_authority",
        "trigger_event_series_ordering_authority",
        "trigger_host_ordering_authority",
      ]) {
        assert.match(orderingAuthorityVersionMigration, new RegExp(trigger));
      }
      const lockedCheckout = pickupRoutes.slice(
        pickupRoutes.indexOf("const [lockedSettlementRestaurant]"),
        pickupRoutes.indexOf("const authoritativeTotals ="),
      );
      assert.match(lockedCheckout, /\.for\("update"\)/);
      assert.match(lockedCheckout, /orderingAuthorityVersionSnapshot/);
      assert.match(lockedCheckout, /database: tx/);
      assert.match(lockedCheckout, /lockedReadiness\.orderingEnabled/);
      const webhookFirstPayout = webhookRoutes.slice(
        webhookRoutes.indexOf("const payoutMayNeedFirstSettlement"),
        webhookRoutes.indexOf("const payoutReady"),
      );
      assert.match(
        webhookFirstPayout,
        /\.for\("update", \{ of: restaurants \}\)/,
      );
      assert.match(webhookFirstPayout, /database: tx/);
      assert.ok(
        webhookFirstPayout.indexOf('.for("update", { of: restaurants })') <
          webhookFirstPayout.indexOf("stripe.transfers.create"),
        "Webhook must lock authority before a first merchant transfer",
      );
    },
  ],
  [
    "restaurant settlement state is durable",
    () => {
      for (const field of [
        "stripe_connect_account_id",
        "stripe_onboarding_completed",
        "stripe_charges_enabled",
        "stripe_payouts_enabled",
      ]) {
        assert.match(connectMigration, new RegExp(field));
      }
      assert.match(schema, /stripeConnectAccountId:/);
      assert.match(schema, /stripePayoutsEnabled:/);
    },
  ],
  [
    "public menu and order creation share one eligibility authority",
    () => {
      assert.match(menuRoutes, /export async function buildOrderingReadiness/);
      assert.match(
        pickupRoutes,
        /const readiness = await buildOrderingReadiness\(\s*body\.restaurantId,\s*body\.menuId,\s*\{ includeSettlementIdentity: true \},\s*\)/,
      );
      const readinessIndex = pickupRoutes.indexOf(
        "const readiness = await buildOrderingReadiness(",
      );
      assert.ok(readinessIndex >= 0);
      assert.ok(
        readinessIndex < pickupRoutes.indexOf("const [menu]", readinessIndex),
        "Eligibility must run before the order menu is loaded",
      );
      assert.ok(
        readinessIndex < pickupRoutes.indexOf("db.transaction", readinessIndex),
        "Eligibility must run before order or inventory writes",
      );
      assert.ok(
        readinessIndex <
          pickupRoutes.indexOf("stripe.paymentIntents.create", readinessIndex),
        "Eligibility must run before card authorization",
      );
    },
  ],
  [
    "eligibility fails closed on identity hours location and payment",
    () => {
      assert.match(menuRoutes, /isRestaurantOrderingAuthorityReady\(\{/);
      assert.match(
        menuRoutes,
        /ownerEmailVerified: restaurantRow\?\.ownerEmailVerified/,
      );
      assert.match(
        menuRoutes,
        /ownerIsDisabled: restaurantRow\?\.ownerIsDisabled/,
      );
      assert.match(
        menuRoutes,
        /orderingApprovedAt: restaurantRow\?\.orderingApprovedAt/,
      );
      assert.match(
        menuRoutes,
        /orderingApprovedByUserId: restaurantRow\?\.orderingApprovedByUserId/,
      );
      assert.match(menuRoutes, /blocking: openNow !== true/);
      assert.match(menuRoutes, /resolveFixedRestaurantPickupAddress\(\{/);
      assert.match(
        menuRoutes,
        /ownerPublicProfileSettings: users\.publicProfileSettings/,
      );
      assert.match(menuRoutes, /rawData: restaurants\.rawData/);
      assert.match(menuRoutes, /ok: paymentMethods\.card/);
      assert.match(menuRoutes, /cash: false/);
      assert.match(pickupRoutes, /code: "ORDERING_UNAVAILABLE"/);
      assert.match(pickupRoutes, /readiness\.paymentMethods\.card/);
    },
  ],
  [
    "ordering, payment, pricing, and carts are menu-specific",
    () => {
      assert.match(
        menuRoutes,
        /requestedMenuId \? eq\(menus\.id, requestedMenuId\) : undefined/,
      );
      assert.match(menuRoutes, /gte\(menuItems\.priceCents, 0\)/);
      assert.match(menuRoutes, /const menuReadiness = restaurantMenus\.map/);
      assert.match(
        menuRoutes,
        /orderingEnabled: Boolean\(orderingTruth\?\.orderingEnabled\)/,
      );
      assert.match(pickupRoutes, /body\.restaurantId,\s*body\.menuId/);
      assert.match(onlineMenu, /existingMenuId !== item\.menuId/);
      assert.match(onlineMenu, /cartHasMixedMenus/);
      assert.match(checkout, /cartMenuIds\.size === 1/);
      assert.match(checkout, /activeMenu\?\.paymentMethods\?\.card/);
      assert.match(checkout, /Choose one menu per order/);
    },
  ],
  [
    "inactive menu categories cannot be advertised or charged",
    () => {
      for (const source of [
        menuRoutes,
        publicDiscoveryRoutes,
        pickupOrderIdentity,
      ]) {
        assert.match(source, /leftJoin\(\s*menuCategories/);
        assert.match(
          source,
          /or\(\s*isNull\(menuItems\.categoryId\),\s*eq\(menuCategories\.isActive, true\)/,
        );
      }
      assert.match(webhookRoutes, /categoryActive: menuCategories\.isActive/);
      assert.match(webhookRoutes, /isMenuItemCategoryOrderable\(line\)/);
    },
  ],
  [
    "missing or depleted tracked inventory cannot be advertised or charged",
    () => {
      assert.match(menuRoutes, /gt\(menuItems\.inventoryQty, 0\)/);
      assert.match(pickupOrderIdentity, /gt\(menuItems\.inventoryQty, 0\)/);
      assert.match(publicDiscoveryRoutes, /isPublicMenuItemAvailable\(item\)/);
      assert.match(
        publicDiscoveryRoutes,
        /toPublicNonNegativeCents\(item\.priceCents\)/,
      );
      assert.match(onlineMenu, /hasOrderablePrice/);
      assert.match(menuRoutes, /isNull\(menuItems\.availableFrom\)/);
      assert.match(pickupOrderIdentity, /isNull\(menuItems\.availableTo\)/);
      assert.match(
        webhookRoutes,
        /!String\(line\.availableFrom \|\| ""\)\.trim\(\)/,
      );
    },
  ],
  [
    "owner-only Stripe Connect onboarding is registered",
    () => {
      assert.match(
        routeRegistry,
        /registerRestaurantPaymentRoutes\(app, \{ stripe \}\)/,
      );
      assert.match(paymentRoutes, /canManageBusinessFinancials/);
      assert.match(paymentRoutes, /stripe\.accounts\.create/);
      assert.match(paymentRoutes, /stripeConnectGeneration/);
      assert.match(paymentRoutes, /restaurantOwnerId: String\(lockedRestaurant\.ownerId\)/);
      assert.match(
        paymentRoutes,
        /db\.transaction[\s\S]*\.for\("update"\)[\s\S]*canManageLockedRestaurantConnect[\s\S]*stripe\.accounts\.create[\s\S]*idempotencyKey: createIdempotencyKey[\s\S]*tx[\s\S]*\.update\(restaurants\)/,
        "Connect account creation must reauthorize under the row lock, serialize assignment, and use a stable Stripe idempotency key",
      );
      assert.match(paymentRoutes, /stripe\.accountLinks\.create/);
      assert.match(paymentRoutes, /stripe\.accounts\.retrieve/);
      assert.match(paymentRoutes, /stripeConnectStatus === "revoked"/);
      assert.match(schema, /stripeConnectGeneration:/);
      assert.match(
        connectGenerationMigration,
        /NEW\.owner_id IS DISTINCT FROM OLD\.owner_id/,
      );
      assert.match(
        connectGenerationMigration,
        /NEW\.stripe_connect_status = 'revoked'/,
      );
      assert.match(menuBuilder, /Connect Stripe payouts/);
      assert.match(menuBuilder, /Refresh status/);
    },
  ],
  [
    "webhooks synchronize restaurant payout state and expose failures",
    () => {
      assert.match(
        webhookRoutes,
        /update\(restaurants\)[\s\S]*stripeConnectAccountId/,
      );
      assert.match(webhookRoutes, /payoutStatus: "failed"/);
      assert.match(webhookRoutes, /stripeConnectAccountId: null/);
      assert.match(webhookRoutes, /pickup-order:\$\{order\.id\}:transfer/);
      assert.match(
        webhookRoutes,
        /source_transaction:\s*sourceTransactionId/,
        "Merchant transfer must be funded by the exact successful pickup charge",
      );
      assert.match(pickupRoutes, /code: "PAYOUT_RECONCILIATION_REQUIRED"/);
      assert.match(pickupRoutes, /order\.payoutStatus !== "transferred"/);
      assert.match(ownerOrders, /cardSettlementBlocked/);
      assert.match(ownerOrders, /typeof selectedPrepMinutes !== "number"/);
      const pickupSucceeded = webhookRoutes.slice(
        webhookRoutes.indexOf('case "payment_intent.succeeded"'),
        webhookRoutes.indexOf("// Supplier marketplace order payment"),
      );
      const settlementIndex = pickupSucceeded.indexOf(
        'payoutStatus: "transferred"',
      );
      const confirmationIndex = pickupSucceeded.indexOf('status: "confirmed"');
      assert.ok(
        settlementIndex >= 0 && confirmationIndex > settlementIndex,
        "Card settlement must persist before pending order confirmation",
      );
      assert.match(pickupSucceeded, /reconciledConfirmedOrder/);
      assert.match(
        pickupSucceeded,
        /await sendPickupOrderConfirmedNotifications\(\s*notificationOrder,\s*\)/,
      );
    },
  ],
  [
    "payment settlement cancellation and owner transitions share one lock",
    () => {
      assert.match(
        financialLock,
        /return `pickup_order_financial:\$\{normalizedOrderId\}`/,
      );
      const webhookLockIndex = webhookRoutes.indexOf(
        "pickupOrderFinancialLockKey(candidate.id)",
      );
      const webhookRereadIndex = webhookRoutes.indexOf(
        ".where(eq(pickupOrders.id, candidate.id))",
        webhookLockIndex,
      );
      const webhookTransferIndex = webhookRoutes.indexOf(
        "await stripe.transfers.create(",
        webhookLockIndex,
      );
      assert.ok(
        webhookLockIndex >= 0 &&
          webhookRereadIndex > webhookLockIndex &&
          webhookTransferIndex > webhookRereadIndex,
        "Webhook must lock, re-read order state, then transfer",
      );
      const cancellationLockIndex = cancellationService.indexOf(
        "pickupOrderFinancialLockKey(input.orderId)",
      );
      const cancellationRereadIndex = cancellationService.indexOf(
        ".where(eq(pickupOrders.id, input.orderId))",
        cancellationLockIndex,
      );
      const ownerRefundIndex = cancellationService.indexOf(
        "await stripe.refunds.create(",
        cancellationLockIndex,
      );
      assert.ok(
        cancellationLockIndex >= 0 &&
          cancellationRereadIndex > cancellationLockIndex &&
          ownerRefundIndex > cancellationRereadIndex,
        "Cancellation service must lock, re-read order state, then refund",
      );
      assert.match(pickupRoutes, /pickupOrderFinancialLockKey\(orderId\)/);
    },
  ],
  [
    "refunds reconcile Stripe transfers instead of trusting local payout state",
    () => {
      assert.match(cancellationService, /reversePickupOrderTransfers\(\{/);
      assert.match(
        transferReversalService,
        /for \(const transferGroup of transferGroups\)/,
      );
      assert.match(transferReversalService, /stripe\.transfers\.list\(\{/);
      assert.match(transferReversalService, /starting_after: startingAfter/);
      assert.match(
        transferReversalService,
        /stripe\.transfers\.createReversal/,
      );
      assert.match(
        transferReversalService,
        /transfer\.metadata\?\.pickupOrderId/,
      );
      assert.match(
        cancellationService,
        /paymentIntentTransferGroup \|\| localTransferGroup/,
      );
      assert.doesNotMatch(
        cancellationService,
        /payoutStatus === "transferred"/,
      );
      const pendingCommitIndex = cancellationService.indexOf(
        "status: ORDER_STATUS.CANCELLATION_PENDING",
      );
      const firstTransactionEnd = cancellationService.indexOf(
        "if (request.outcome ===",
        pendingCommitIndex,
      );
      const stripeSideEffectIndex = cancellationService.indexOf(
        "stripe.paymentIntents.retrieve",
        pendingCommitIndex,
      );
      assert.ok(
        pendingCommitIndex >= 0 &&
          firstTransactionEnd > pendingCommitIndex &&
          stripeSideEffectIndex > firstTransactionEnd,
        "Durable cancellation_pending must commit before Stripe refund/reversal work",
      );
      assert.match(
        cancellationService,
        /eq\(pickupOrders\.status, ORDER_STATUS\.CANCELLATION_PENDING\)/,
      );
    },
  ],
  [
    "late payment rechecks exact ordering eligibility before settlement",
    () => {
      const pickupSucceeded = webhookRoutes.slice(
        webhookRoutes.indexOf('case "payment_intent.succeeded"'),
        webhookRoutes.indexOf("// Supplier marketplace order payment"),
      );
      const readinessIndex = pickupSucceeded.indexOf(
        "await buildOrderingReadiness(",
      );
      const transferIndex = pickupSucceeded.indexOf(
        "await stripe.transfers.create(",
      );
      assert.ok(
        readinessIndex >= 0 && transferIndex > readinessIndex,
        "Exact-menu readiness must be checked before merchant transfer",
      );
      assert.match(
        pickupSucceeded,
        /isPickupPaymentSuccessEventWithinWindow\(\{/,
      );
      assert.match(pickupSucceeded, /eventCreatedSeconds: event\.created/);
      assert.match(pickupSucceeded, /allItemsStillAvailable/);
      assert.match(
        pickupSucceeded,
        /isPickupOrderItemAvailableForExistingReservation/,
      );
      assert.match(pickupSucceeded, /existingReservedMenuItemIds: orderLines/);
      assert.match(pickupSucceeded, /inventoryReservedQuantity/);
      assert.match(
        menuRoutes,
        /eq\(menuItems\.inventoryAutoUnavailable, true\)/,
      );
      assert.match(pickupSucceeded, /pickupAddressSnapshot/);
      assert.match(pickupSucceeded, /status: "cancellation_pending"/);
      assert.match(pickupSucceeded, /isPickupPaymentIntentAmountBound/);
      assert.match(pickupSucceeded, /order\.pricesIncludeTax === true/);
      assert.match(
        pickupSucceeded,
        /requestAndFinalizeCardPickupOrderCancellation\(\{/,
      );
    },
  ],
  [
    "configured choices are required on both sides of checkout",
    () => {
      assert.match(pickupRoutes, /code: "ITEM_OPTION_REQUIRED"/);
      assert.match(pickupRoutes, /code: "ITEM_MODIFIER_REQUIRED"/);
      assert.match(pickupRoutes, /code: "TOO_MANY_ITEM_MODIFIERS"/);
      assert.match(onlineMenu, /disabled=\{missingRequiredModifier\}/);
      assert.match(onlineMenu, /Choose required options/);
    },
  ],
  [
    "checkout snapshots fulfillment and itemizes card-only fees",
    () => {
      assert.match(snapshotMigration, /merchant_name_snapshot/);
      assert.match(snapshotMigration, /pickup_address_snapshot/);
      assert.match(directionsMigration, /pickup_directions_url_snapshot/);
      assert.match(feeMigration, /mealscout_fee_cents/);
      assert.match(feeMigration, /processing_fee_cents/);
      assert.match(
        pickupRoutes,
        /paymentMethod === "card" \? PICKUP_ORDER_MEALSCOUT_FEE_CENTS : 0/,
      );
      assert.match(
        pickupRoutes,
        /merchantNameSnapshot: lockedReadiness\.restaurantName/,
      );
      assert.match(
        pickupRoutes,
        /pickupAddressSnapshot: lockedReadiness\.pickupAddressLabel/,
      );
      assert.match(
        pickupRoutes,
        /pickupDirectionsUrlSnapshot:[\s\S]*lockedReadiness\.pickupDirectionsUrl/,
      );
      assert.match(confirmation, /order\.pickupDirectionsUrlSnapshot/);
      assert.match(checkout, />MealScout fee</);
      assert.match(checkout, />Card processing</);
      assert.match(checkout, /Card fees[\s\S]*Calculated before payment/);
      assert.doesNotMatch(checkout, /MEALSCOUT_ORDER_FEE_CENTS/);
      assert.doesNotMatch(checkout, /estimateProcessingFeeCents/);
      assert.doesNotMatch(onlineMenu, /\$1\.00 MealScout fee/);
      assert.match(confirmation, />Card processing</);
      assert.match(prepTimeMigration, /prep_time_minutes DROP DEFAULT/);
      assert.match(pickupRoutes, /prepTimeMinutes: null/);
      assert.doesNotMatch(pickupRoutes, /prepTimeMinutes: 20/);
    },
  ],
  [
    "refund completion is durable and pending refunds stay nonterminal",
    () => {
      assert.match(refundMigration, /stripe_refund_id/);
      assert.match(refundMigration, /stripe_refund_status/);
      assert.match(refundMigration, /refund_attempt_count/);
      assert.match(schema, /stripeRefundStatus:/);
      assert.match(cancellationService, /classifyStripeRefundStatus/);
      assert.match(
        cancellationService,
        /summary\.succeededAmountCents === current\.totalCents/,
      );
      assert.match(cancellationService, /if \(!customerMadeWhole\)/);
      assert.match(cancellationService, /outcome: "pending"/);
      assert.match(webhookRoutes, /case "refund\.updated"/);
      assert.match(webhookRoutes, /case "refund\.failed"/);
      assert.match(webhookRoutes, /refundPaymentIntentId/);
      assert.match(webhookRoutes, /isPickupRefundFromOrder/);
      assert.match(pickupRoutes, /allowFailedRefundRetry:/);
      assert.match(
        cancellationService,
        /stripeRefundStatus: "reconciliation_required"/,
      );
      assert.match(
        cancellationService,
        /describePickupOrderReconciliationFailure\(error\)/,
      );
      assert.match(paymentExpiryService, /"reconciliation_required"/);
    },
  ],
  [
    "full-refund claims require authoritative aggregate cents",
    () => {
      assert.match(webhookRoutes, /summarizePickupOrderRefunds\(\{/);
      assert.match(
        webhookRoutes,
        /stripeRefundAmountCents:\s*refundSummary\.succeededAmountCents/,
      );
      assert.match(webhookRoutes, /derivePickupOrderAggregateRefundStatus\(\{/);
      assert.match(
        refundTruth,
        /pickupOrderSucceededRefundAmountCents\(order\) === totalCents/,
      );
      assert.match(confirmation, /isPickupOrderFullyRefunded\(order\)/);
      assert.match(ownerOrders, /isPickupOrderFullyRefunded\(order\)/);
      assert.doesNotMatch(
        confirmation,
        /stripeRefundStatus \|\| ""\)\.toLowerCase\(\) === "succeeded"/,
      );
    },
  ],
  [
    "customer refunds commit before independent payout recovery",
    () => {
      for (const field of [
        "payout_reversal_attempt_count",
        "payout_reversal_failure_reason",
        "payout_reversal_updated_at",
      ]) {
        assert.match(payoutRecoveryMigration, new RegExp(field));
      }
      const cancellationFlow = cancellationService.slice(
        cancellationService.indexOf(
          "export async function requestAndFinalizeCardPickupOrderCancellation",
        ),
      );
      const refundIndex = cancellationFlow.indexOf("stripe.refunds.create(");
      const cancelledIndex = cancellationFlow.indexOf(
        "status: ORDER_STATUS.CANCELLED",
        refundIndex,
      );
      const payoutRecoveryIndex = cancellationFlow.lastIndexOf(
        "recoverCancelledPayoutForResult",
      );
      assert.ok(
        refundIndex >= 0 &&
          cancelledIndex > refundIndex &&
          payoutRecoveryIndex > cancelledIndex,
        "Customer refund and cancelled truth must precede merchant payout recovery",
      );
      assert.match(
        payoutRecoveryPolicy,
        /return \(await recover\(\)\) \|\| order/,
      );
      assert.match(payoutRecoveryPolicy, /catch \(error\)[\s\S]*return order/);
      assert.match(paymentExpiryService, /kind: "payout_reversal"/);
      assert.match(
        paymentExpiryService,
        /reconcileCancelledPickupOrderPayoutReversal\(\{/,
      );
      assert.doesNotMatch(
        cancellationService,
        /if \(current\.payoutStatus === "reversed"\) return current/,
      );
      assert.match(
        cancellationService,
        /reversal\.currentMerchantNetCents !== 0/,
      );
      assert.match(
        paymentExpiryService,
        /eq\(pickupOrders\.payoutStatus, "reversed"\)[\s\S]*isNull\(pickupOrders\.payoutReversalUpdatedAt\)/,
      );
      assert.match(
        payoutRecoveryMigration,
        /payout_status <> 'reversed' OR payout_reversal_updated_at IS NULL/,
      );
    },
  ],
  [
    "refund and dispute events converge on one merchant net target",
    () => {
      assert.match(netSettlementPolicy, /refundCents \+ disputeCents/);
      assert.match(netSettlementPolicy, /Math\.min\(totalCents/);
      assert.match(
        completedRefundService,
        /pickupOrderCustomerFinancialLossCents\(\{/,
      );
      assert.match(
        completedRefundService,
        /stripeDisputeStatus: order\.stripeDisputeStatus/,
      );
      assert.match(
        completedRefundService,
        /completed-refund:\$\{latestRefund\.id\}:loss:\$\{customerFinancialLossCents\}/,
      );
      assert.match(disputeService, /summarizePickupOrderRefunds\(\{/);
      assert.match(disputeService, /reinstatePickupOrderDisputeTransfers\(\{/);
      assert.match(
        disputeService,
        /idempotencyScope: `dispute:\$\{input\.dispute\.id\}:net:\$\{customerFinancialLossCents\}`/,
      );
      assert.match(
        disputeService,
        /payoutStatus: pickupOrderReconciledPayoutStatus\(\{/,
      );
      assert.match(
        transferReversalService,
        /targetMerchantNetCents - currentMerchantNetCents/,
      );
    },
  ],
  [
    "partial disputes refund exactly the undisputed customer remainder",
    () => {
      assert.match(refundTruth, /pickupOrderDisputeRecoveryAmountCents/);
      assert.match(refundTruth, /pickupOrderRemainingCustomerRefundCents/);
      assert.match(
        cancellationService,
        /current\.totalCents - disputeRecoveryAmountCents/,
      );
      assert.match(
        cancellationService,
        /Number\(latestRefund\.amount\) !== remainingAmount/,
      );
      assert.match(
        cancellationService,
        /isPickupPaymentIntentOrderIdentityBound\(paymentIntent, current\)/,
      );
      assert.match(
        completedRefundService,
        /isPickupPaymentIntentOrderIdentityBound\(paymentIntent, order\)/,
      );
      assert.match(
        disputeService,
        /isPickupPaymentIntentOrderIdentityBound\(paymentIntent, current\)/,
      );
      assert.match(
        disputeService,
        /disputeIsTerminal && \(fulfillmentWasActive \|\| wasOnDisputeHold\)/,
      );
      assert.match(
        disputeService,
        /merchant transfer reconciliation failed; customer fulfillment\/refund state remains authoritative/,
      );
      assert.match(disputeService, /return failed \|\| recorded/);
      const disputeNextStatus = disputeService.slice(
        disputeService.indexOf("const nextStatus ="),
        disputeService.indexOf("const cancellationReason ="),
      );
      assert.doesNotMatch(disputeNextStatus, /ORDER_STATUS\.CANCELLED/);
    },
  ],
  [
    "late card success on a cancelled order enters refund reconciliation",
    () => {
      const cancelledBranch = webhookRoutes.slice(
        webhookRoutes.indexOf('if (statusBeforeWebhook === "cancelled")'),
        webhookRoutes.indexOf(
          "// A client secret can outlive",
          webhookRoutes.indexOf('if (statusBeforeWebhook === "cancelled")'),
        ),
      );
      assert.match(cancelledBranch, /paymentAmountMatches/);
      assert.match(cancelledBranch, /terminalCancellationBindingMatches/);
      assert.match(cancelledBranch, /cancellationRequired: true/);
      assert.match(
        webhookRoutes,
        /expectedStatuses: \["cancellation_pending", "cancelled"\]/,
      );
      assert.match(
        cancellationService,
        /input\.expectedStatuses\.includes\(ORDER_STATUS\.CANCELLED\)/,
      );
    },
  ],
  [
    "dispute webhooks reconcile Stripe current truth instead of stale payload state",
    () => {
      const retrieveIndex = webhookRoutes.indexOf(
        "retrieveAuthoritativePickupOrderDispute({",
      );
      const reconcileIndex = webhookRoutes.indexOf(
        "reconcilePickupOrderDispute({",
        retrieveIndex,
      );
      assert.ok(
        retrieveIndex >= 0 && reconcileIndex > retrieveIndex,
        "Dispute reconciliation must retrieve current Stripe truth first",
      );
      assert.match(disputeTruth, /input\.stripe\.disputes\.retrieve\(/);
      assert.match(
        disputeTruth,
        /authoritativePaymentIntentId !== webhookPaymentIntentId/,
      );
      assert.match(disputeTruth, /authoritativeAmount !== webhookAmount/);
      assert.match(disputeTruth, /authoritativeCurrency !== webhookCurrency/);
    },
  ],
  [
    "a stale dispute snapshot cannot move a terminal dispute backwards",
    () => {
      assert.match(
        netSettlementPolicy,
        /isTerminalPickupDisputeStatus\(storedStatus\)[\s\S]*?!isTerminalPickupDisputeStatus\(incomingStatus\)[\s\S]*?return storedStatus/,
      );
      const lockIndex = disputeService.indexOf("pg_advisory_xact_lock");
      const convergeIndex = disputeService.indexOf(
        "resolveConvergedPickupDisputeStatus({",
        lockIndex,
      );
      const phaseOneWriteIndex = disputeService.indexOf(
        "stripeDisputeStatus: effectiveDisputeStatus",
        convergeIndex,
      );
      assert.ok(
        lockIndex >= 0 && convergeIndex > lockIndex,
        "The stored-status convergence must be decided under the advisory lock",
      );
      assert.match(
        disputeService,
        /storedStatus: current\.stripeDisputeStatus/,
      );
      assert.ok(
        phaseOneWriteIndex > convergeIndex,
        "The phase-one write must record the converged dispute status",
      );
      const phaseTwo = disputeService.slice(
        disputeService.indexOf("const needsCompletedSettlementReconciliation"),
      );
      assert.match(
        phaseTwo,
        /stripeDisputeStatus: effectiveDisputeStatus,\s+stripeDisputeAmountCents: input\.dispute\.amount/,
      );
      assert.match(
        phaseTwo,
        /payoutStatus: pickupOrderReconciledPayoutStatus\(\{\s+totalCents: current\.totalCents,\s+succeededRefundAmountCents: refundSummary\.succeededAmountCents,\s+stripeDisputeStatus: effectiveDisputeStatus,/,
      );
      const disputeCandidates = paymentExpiryService.slice(
        paymentExpiryService.indexOf("const disputeReconciliationCandidates"),
        paymentExpiryService.indexOf("const candidates = ["),
      );
      assert.match(disputeCandidates, /"dispute_reversal_pending"/);
      assert.match(disputeCandidates, /"dispute_reinstatement_pending"/);
      assert.match(disputeCandidates, /"failed"/);
      assert.match(
        disputeCandidates,
        /"disputed"/,
        "Orders stuck in the disputed payout state must re-enter dispute reconciliation",
      );
    },
  ],
  [
    "pending checkout replay revalidates exact current authority",
    () => {
      const replayStart = pickupRoutes.indexOf(
        "const intent = await stripe.paymentIntents.retrieve(",
      );
      const settlementBindingIndex = pickupRoutes.indexOf(
        "!isPickupPaymentIntentSettlementBound(intent, existing)",
        replayStart,
      );
      const readinessIndex = pickupRoutes.indexOf(
        "revalidatePendingPickupCheckoutReplay(existing)",
        replayStart,
      );
      const secretIndex = pickupRoutes.indexOf(
        "clientSecret: intent.client_secret",
        replayStart,
      );
      assert.ok(
        replayStart >= 0 &&
          settlementBindingIndex > replayStart &&
          readinessIndex > settlementBindingIndex &&
          secretIndex > readinessIndex,
        "Replay must bind settlement and revalidate exact readiness before returning a client secret",
      );
      assert.match(checkoutReplayPolicy, /allItemsStillAvailable/);
      assert.match(checkoutReplayPolicy, /stripeConnectAccountIdSnapshot/);
      assert.match(pickupRoutes, /code: "ORDERING_CHANGED"/);
      assert.match(checkout, /toAuthoritativePaymentOrder\(data\.order\)/);
      assert.match(checkoutTruth, /order\.merchantNameSnapshot/);
      assert.match(checkoutTruth, /order\.pickupAddressSnapshot/);
      assert.match(checkout, /readPickupCheckoutRecovery\(restaurantId/);
      assert.match(checkout, /writePickupCheckoutRecovery\(\{/);
      assert.match(checkout, /clearPickupCheckoutRecovery\(restaurantId/);
      assert.match(checkoutRecovery, /window\.sessionStorage/);
      assert.match(checkoutRecovery, /checkoutRequestId/);
      assert.match(checkoutRecovery, /customerAccessToken/);
      assert.match(checkoutRecovery, /clientSecret/);
      assert.match(
        checkout,
        /reconcileRestoredCheckout[\s\S]*fetch\("\/api\/pickup-orders"[\s\S]*restoredCheckout\.checkoutPayload/,
      );
      assert.doesNotMatch(
        checkout,
        /useState<string \| null>\(\s*restoredCheckout\?\.clientSecret/,
      );
      assert.match(checkout, /TERMINAL_CHECKOUT_RECOVERY_CODES/);
      const paymentScreen = checkout.slice(
        checkout.indexOf("// If we have a clientSecret"),
        checkout.indexOf(
          "{hostileBrowser ?",
          checkout.indexOf("// If we have a clientSecret"),
        ),
      );
      assert.doesNotMatch(paymentScreen, /readiness\?\.restaurantName/);
    },
  ],
  [
    "ordering approval response deadline and settlement identity are durable",
    () => {
      assert.match(orderingApprovalMigration, /ordering_approved_at/);
      assert.match(disputeMigration, /stripe_dispute_status/);
      assert.match(settlementIdentityMigration, /merchant_owner_id_snapshot/);
      assert.match(
        settlementIdentityMigration,
        /stripe_connect_account_id_snapshot/,
      );
      assert.match(acknowledgementMigration, /pickup_acknowledgement_minutes/);
      assert.match(acknowledgementMigration, /merchant_acknowledgement_due_at/);
      assert.match(paymentRoutes, /pickupAcknowledgementMinutes/);
      assert.match(notificationService, /customerResponseWindow/);
      assert.match(ownerOrders, /Start preparation/);
      assert.match(paymentRoutes, /eq\(restaurants\.isVerified, true\)/);
      assert.match(paymentRoutes, /users\.emailVerified/);
      assert.match(paymentRoutes, /users\.isDisabled/);
      assert.match(
        storageSource,
        /isVerified: false,[\s\S]*buildRestaurantOrderingAuthorityRevocation\(\)/,
      );
      assert.match(orderingAuthorityReset, /orderingApprovedAt: null/);
      assert.match(orderingAuthorityReset, /orderingApprovalReviewNote: null/);
      assert.match(orderingAuthorityReset, /stripeConnectAccountId: null/);
      assert.match(orderingAuthorityReset, /stripeChargesEnabled: false/);
      assert.match(
        userAdminRoutes,
        /safety\.ownerChanged[\s\S]*\? buildRestaurantOwnerTransferReset\(\)[\s\S]*: \{\}/,
      );
      const ownerTransferRoute = userAdminRoutes.slice(
        userAdminRoutes.indexOf(
          '"/api/admin/business-users/:userId/attach-restaurant"',
        ),
        userAdminRoutes.indexOf(
          '"/api/admin/business-users/:userId/create-and-attach"',
        ),
      );
      const restaurantLockIndex = ownerTransferRoute.indexOf(
        "lockRestaurantForOwnerTransfer",
      );
      const ownerUpdateIndex = ownerTransferRoute.indexOf(
        ".update(restaurants)",
      );
      assert.ok(
        restaurantLockIndex >= 0 && ownerUpdateIndex > restaurantLockIndex,
        "Owner transfer must hold the checkout restaurant lock and reject nonterminal orders before changing ownership",
      );
      assert.match(
        ownerTransferSafety,
        /\.for\("update", \{ of: restaurants \}\)/,
      );
      assert.match(ownerTransferSafety, /notInArray\(pickupOrders\.status/);
      assert.match(truckClaimRoutes, /lockRestaurantForOwnerTransfer\(tx,/);
      assert.match(
        truckImportAdminRoutes,
        /lockRestaurantForOwnerTransfer\(tx,/,
      );
      assert.match(
        truckImportAdminRoutes,
        /inviteAction === "idempotent"[\s\S]*outcome: "unchanged"/,
      );
      assert.match(ownerTransferRoute, /ACTIVE_ORDER_HANDOFF_REQUIRED/);
      assert.match(
        userAdminRoutes,
        /updates\.isVerified === false[\s\S]*buildRestaurantOrderingAuthorityRevocation\(\)/,
      );
      assert.match(truckClaimRoutes, /buildRestaurantOwnerTransferReset\(\)/);
      assert.match(
        publicDiscoveryRoutes,
        /toPublicRestaurantListingWithVisibility\(row\)/,
      );
      const canonicalRestaurantTruth = publicDiscoveryRoutes.slice(
        publicDiscoveryRoutes.indexOf(
          'app.get("/api/public/canonical/:entity/:id"',
        ),
        publicDiscoveryRoutes.indexOf('if (entity === "event")'),
      );
      assert.match(canonicalRestaurantTruth, /verified: publicVerified/);
      assert.match(canonicalRestaurantTruth, /hasAddress: hasPublicAddress/);
      assert.doesNotMatch(
        canonicalRestaurantTruth,
        /verified: Boolean\(row\.isVerified\)/,
      );
      assert.match(publicProfileMapper, /Boolean\(row\.isVerified\)/);
      assert.match(publicListingMapper, /: Boolean\(isVerified\)/);
      assert.doesNotMatch(
        publicProfileMapper,
        /Boolean\(\s*row\.orderingApprovedAt && row\.orderingApprovedByUserId/,
      );
      assert.doesNotMatch(
        publicDiscoveryRoutes,
        /Evidence-backed ordering approval on MealScout/,
      );
    },
  ],
  [
    "customer status exposes financial truth and a concrete recovery path",
    () => {
      assert.match(confirmation, /Payment outcome/);
      assert.match(confirmation, /Full card refund recorded/);
      assert.match(confirmation, /not_required_payment_not_captured/);
      assert.match(confirmation, /order\.stripeRefundStatus/);
      assert.match(confirmation, /order\?\.stripeRefundAmountCents/);
      assert.match(confirmation, /isOrderFinancialOutcomeOpen\(order\)/);
      assert.match(confirmation, /support@mealscout\.us/);
      assert.match(
        confirmation,
        /MealScout order \$\{order\.id\} payment help/,
      );
    },
  ],
  [
    "merchant delivery remains explicitly unavailable",
    () => {
      assert.match(merchantDeliveryRoutes, /DELIVERY_ORDERING_UNAVAILABLE/);
      assert.match(merchantDeliveryRoutes, /enabled: false/);
      assert.doesNotMatch(checkout, /value="delivery"/);
    },
  ],
  [
    "abandoned card checkouts expire without leaking inventory",
    () => {
      assert.match(
        paymentExpiryService,
        /eq\(pickupOrders\.status, "pending"\)/,
      );
      assert.match(
        paymentExpiryService,
        /lt\(pickupOrders\.createdAt, cutoff\)/,
      );
      assert.match(
        paymentExpiryService,
        /requestAndFinalizeCardPickupOrderCancellation\(\{/,
      );
      assert.match(recurringJobs, /reconcileExpiredPickupOrderPayments/);
      assert.match(recurringJobs, /PICKUP_ORDER_PAYMENT_EXPIRY_ENABLED/);
      assert.match(
        cancellationService,
        /restoreTrackedInventoryForPickupOrderByOrderId\(tx, requested\.id\)/,
      );
      assert.match(inventoryService, /\.for\("update", \{ of: menuItems \}\)/);
      assert.match(paymentExpiryService, /expiredPendingCandidates/);
      assert.match(paymentExpiryService, /legacyPendingCandidates/);
      assert.match(paymentExpiryService, /legacyCancellationPendingCandidates/);
      assert.match(
        paymentExpiryService,
        /isNull\(pickupOrders\.orderingContractVersion\)/,
      );
      assert.match(paymentExpiryService, /unknownInventoryLineCount/);
      assert.match(recurringJobs, /legacy_inventory_audit=/);
      assert.match(recurringJobs, /legacy_cancellation_pending=/);
      assert.match(paymentExpiryService, /refundReconciliationCandidates/);
      assert.match(inventoryProvenanceMigration, /inventory_reserved_quantity/);
      assert.match(schema, /inventoryReservedQuantity:/);
      assert.match(
        inventoryService,
        /sum\(\$\{pickupOrderItems\.inventoryReservedQuantity\}\)/,
      );
      assert.match(
        inventoryService,
        /isPickupInventoryReservationRestorable\(candidate\)/,
      );
      assert.match(
        inventoryService,
        /isNull\(pickupOrderItems\.inventoryReservedQuantity\)/,
      );
    },
  ],
  [
    "failed card attempts stay pending for a later success or expiry",
    () => {
      const failedBranch = webhookRoutes.slice(
        webhookRoutes.indexOf("// Pickup order payment failure"),
        webhookRoutes.indexOf("// Supplier marketplace order payment failure"),
      );
      assert.match(
        failedBranch,
        /Keep the order and its[\s\S]*reservation pending/,
      );
      assert.doesNotMatch(failedBranch, /status: "cancelled"/);
      assert.doesNotMatch(
        failedBranch,
        /restoreTrackedInventoryForPickupOrderByOrderId/,
      );
    },
  ],
  [
    "guest orders remain recoverable",
    () => {
      assert.match(pickupRoutes, /code: "ORDER_CONTACT_REQUIRED"/);
      assert.match(pickupRoutes, /code: "ORDER_RECOVERY_REQUIRED"/);
      assert.match(pickupRoutes, /checkoutRequestId: body\.checkoutRequestId/);
      assert.match(
        pickupRoutes,
        /customerAccessTokenHash: hashCustomerAccessToken\(\s*body\.customerAccessToken!?,\s*\)/,
      );
      assert.match(checkout, /checkoutRequestId,\s*customerAccessToken,/);
      assert.match(
        checkout,
        /!contact\.email\.trim\(\) && !contact\.phone\.trim\(\)/,
      );
      assert.match(orderContact, /export function normalizeOrderContactPhone/);
      assert.match(pickupRoutes, /code: "INVALID_ORDER_PHONE"/);
      assert.match(checkout, /normalizeOrderContactPhone\(contact\.phone\)/);
      assert.match(notificationService, /if \(order\.customerPhone\)/);
      assert.match(notificationService, /sendSmsOnce\(\{/);
      assert.match(notificationService, /View status: \$\{statusUrl\}/);
      assert.match(
        notificationService,
        /buildPickupOrderStatusUrl\(order\.id\)/,
      );
      assert.match(
        notificationService,
        /eq\(orderNotifications\.status, "failed"\)/,
      );
      assert.match(notificationService, /NOTIFICATION_ATTEMPT_STALE_MS/);
      assert.match(notificationService, /retryPickupOrderNotifications/);
      assert.match(notificationService, /sendPickupOrderReadyNotifications/);
      assert.match(notificationService, /"ready",/);
      assert.match(notificationService, /missingClaimRows/);
      assert.match(notificationService, /notExists\(/);
      assert.match(
        notificationService,
        /lt\(orderNotifications\.attemptCount, 5\)/,
      );
      assert.match(
        notificationRetryMigration,
        /attempt_count INTEGER NOT NULL DEFAULT 0/,
      );
      assert.match(
        webhookRoutes,
        /order\.status === "confirmed" &&\s*payoutReady/,
      );
    },
  ],
  [
    "new-contract cohort gates automatic recovery and notification backfill",
    () => {
      assert.match(cohortMigration, /ordering_contract_version/);
      assert.match(schema, /orderingContractVersion:/);
      assert.match(
        pickupRoutes,
        /orderingContractVersion: PICKUP_ORDER_CONTRACT_VERSION/,
      );
      assert.match(
        paymentExpiryService,
        /pickupOrders\.orderingContractVersion/,
      );
      assert.match(
        notificationService,
        /pickupOrders\.orderingContractVersion/,
      );
      assert.match(pickupRoutes, /checkoutState: "status_only"/);
      assert.match(pickupRoutes, /existing\.status !== ORDER_STATUS\.PENDING/);
    },
  ],
  [
    "checkout only exposes supported fulfillment and bounded reservations",
    () => {
      assert.doesNotMatch(checkout, /value="dine_in"/);
      assert.doesNotMatch(checkout, /value="delivery"/);
      assert.doesNotMatch(checkout, /value="cash"/);
      assert.doesNotMatch(onlineMenu, /cash at pickup/i);
      assert.doesNotMatch(onlineMenu, /card or cash/i);
      assert.match(pickupRoutes, /code: "FULFILLMENT_MODE_UNAVAILABLE"/);
      assert.match(pickupRoutes, /code: "PAYMENT_METHOD_UNAVAILABLE"/);
      assert.match(menuRoutes, /ok: methods\.card/);
      assert.match(publicDiscoveryRoutes, /const deliveryEnabled = false/);
      assert.match(pickupRoutes, /MAX_PICKUP_ORDER_UNITS = 20/);
      assert.match(pickupRoutes, /scope: "pickup_orders_create"/);
      assert.match(pickupRoutes, /limit: 5/);
      assert.match(pickupRoutes, /payment_method_types: \["card"\]/);
      assert.match(pickupRoutes, /isPickupPaymentIntentCheckoutBound/);
      assert.match(checkout, /!stripePromise/);
    },
  ],
  [
    "public restaurant writes cannot mint ordering authority",
    () => {
      for (const field of [
        "isVerified",
        "stripeConnectAccountId",
        "stripeOnboardingCompleted",
        "stripeChargesEnabled",
        "stripePayoutsEnabled",
      ]) {
        assert.match(
          schema,
          new RegExp(`${field}: true`),
          `${field} must be omitted from public restaurant writes`,
        );
        assert.match(
          restaurantRepository,
          new RegExp(`"${field}"`),
          `${field} must be protected by the repository`,
        );
      }
      assert.match(restaurantCoreRoutes, /publicInsertRestaurantSchema\.parse/);
      assert.match(
        restaurantSignupRoutes,
        /publicInsertRestaurantSchema\.safeParse/,
      );
      assert.match(truckClaimRoutes, /publicInsertRestaurantSchema\.partial/);
    },
  ],
  [
    "pickup totals require explicit tax-inclusive pricing",
    () => {
      assert.match(taxInclusiveMigration, /prices_include_tax/);
      assert.match(menuRoutes, /id: "tax_pricing"/);
      assert.match(pickupRoutes, /code: "TAX_PRICING_NOT_CONFIRMED"/);
      assert.match(pickupRoutes, /pricesIncludeTax: true/);
      assert.match(menuBuilder, /Prices include applicable tax/);
      assert.match(checkout, /Included in item prices/);
      assert.match(confirmation, /Included in item prices/);
    },
  ],
  [
    "checkout is ASAP-only until scheduled readiness exists",
    () => {
      assert.match(pickupRoutes, /code: "SCHEDULED_ORDERING_UNAVAILABLE"/);
      const scheduledReject = pickupRoutes.indexOf(
        'code: "SCHEDULED_ORDERING_UNAVAILABLE"',
      );
      assert.ok(
        scheduledReject >= 0 &&
          scheduledReject <
            pickupRoutes.indexOf("buildOrderingReadiness", scheduledReject),
        "Scheduled orders must be rejected before eligibility and writes",
      );
    },
  ],
  [
    "Scout does not fabricate fixed restaurant open state",
    () => {
      const start = scout.indexOf("function NearbyRestaurantCard(");
      const end = scout.indexOf("function SavedRestaurantCard(", start);
      assert.ok(start >= 0 && end > start);
      const nearbyCard = scout.slice(start, end);
      assert.match(
        nearbyCard,
        /const restaurantOpenState = getRestaurantOpenState\(restaurant\)/,
      );
      assert.match(
        nearbyCard,
        /restaurantOpenState === "unknown"[\s\S]*\? undefined/,
      );
      assert.doesNotMatch(nearbyCard, /isOpen:\s*true/);
      assert.doesNotMatch(scoutSceneCopy, /Open now and worth trying near you/);
    },
  ],
  [
    "directions come from the server-owned safe CTA",
    () => {
      assert.match(
        visitPanel,
        /profile\.cta\.find\(\(action\) => action\.type === "map"\)/,
      );
      assert.doesNotMatch(
        visitPanel,
        /maps\.google\.com\/\?q=\$\{profile\.latitude\}/,
      );
    },
  ],
  [
    "disabled ordering is browse-only and confirmation copy is truthful",
    () => {
      assert.match(
        publicProfileMapper,
        /claimedProfile && row\?\.ordering\?\.enabled === true && orderingPath/,
      );
      assert.match(
        publicDiscoveryRoutes,
        /path: pickupEnabled \|\| deliveryEnabled \? orderingPath : null/,
      );
      assert.doesNotMatch(confirmation, /business accepted the order/i);
      assert.doesNotMatch(checkout, /business must accept the order/i);
    },
  ],
];

for (const [name, check] of checks) {
  try {
    check();
  } catch (error) {
    throw new Error(`Ordering truth contract failed: ${name}`, {
      cause: error,
    });
  }
}

console.log(
  `MealScout ordering truth contract: PASS (${checks.length}/${checks.length})`,
);
