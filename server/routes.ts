import type { Express } from "express";
import { createServer, type Server } from "http";
import Stripe from "stripe";
import {
  getHostByUserId,
  getEventAndHostForUser,
  getInterestEventAndHostForUser,
  userOwnsEvent,
} from "./services/hostOwnership";
import {
  computeAcceptedCount,
  shouldBlockAcceptance,
  buildCapacityFullError,
  computeFillRate,
} from "./services/interestDecision";
import { registerHostRoutes } from "./routes/hostRoutes";
import { registerOpenCallSeriesRoutes } from "./routes/openCallSeriesRoutes";
import { registerEventRoutes } from "./routes/eventRoutes";
import { registerDiscoveryRoutes } from "./routes/discoveryRoutes";
import { registerEventCoordinatorRoutes } from "./routes/eventCoordinatorRoutes";
import { registerAdminManagementRoutes } from "./routes/adminManagementRoutes";
import { registerGeoAdRoutes } from "./routes/geoAdRoutes";
import { registerBookingRoutes } from "./routes/bookingRoutes";
import { registerParkingCheckoutRoutes } from "./routes/parkingCheckoutRoutes";
import { registerSupplierMarketplaceRoutes } from "./routes/supplierMarketplaceRoutes";
import { registerSupplyScoutRoutes } from "./routes/supplyScoutRoutes";
import { registerScoutSurfaceRoutes } from "./routes/scoutSurfaceRoutes";
import { registerStaffRoutes } from "./staffRoutes";
import { registerModerationRoutes } from "./moderationRoutes";
import { validateRequiredEnvOnModuleLoad } from "./startup/envValidation";
import { setupUnifiedAuth } from "./unifiedAuth";
import { sendDealClaimedNotification } from "./emailNotifications";

// Validate environment at module load time
validateRequiredEnvOnModuleLoad();

import { logAudit } from "./auditLogger";
import { registerAuthAccountRoutes } from "./routes/authAccountRoutes";
import { registerAnalyticsRoutes } from "./routes/analyticsRoutes";
import { registerAwardsRoutes } from "./routes/awardsRoutes";
import { registerClaimRoutes } from "./routes/claimRoutes";
import { registerBusinessTeamRoutes } from "./routes/businessTeamRoutes";
import { registerDealManagementRoutes } from "./routes/dealManagementRoutes";
import { registerLocationDemandRoutes } from "./routes/locationDemandRoutes";
import { registerLocationUtilityRoutes } from "./routes/locationUtilityRoutes";
import { registerMediaRoutes } from "./routes/mediaRoutes";
import { registerDealDiscoveryRoutes } from "./routes/dealDiscoveryRoutes";
import { registerHostPayoutAdminRoutes } from "./routes/hostPayoutAdminRoutes";
import { registerGrowthRoutes } from "./routes/growthRoutes";
import { registerHostInterestRoutes } from "./routes/hostInterestRoutes";
import { registerPublicDiscoveryRoutes } from "./routes/publicDiscoveryRoutes";
import { registerNativeEcosystemLinks } from "./services/ecosystemPublicLinkRuntime";
import { registerPublicMapRoutes } from "./routes/publicMapRoutes";
import { registerRestaurantCoreRoutes } from "./routes/restaurantCoreRoutes";
import { registerRestaurantOperationsRoutes } from "./routes/restaurantOperationsRoutes";
import { registerProfileEvidenceReviewRoutes } from "./routes/profileEvidenceReviewRoutes";
import { registerRestaurantSignupRoutes } from "./routes/restaurantSignupRoutes";
import { registerPublicSearchRoutes } from "./routes/publicSearchRoutes";
import { registerPublicSeoLandingRoutes } from "./routes/publicSeoLandingRoutes";
import { registerSeoRoutes } from "./routes/seoRoutes";
import { registerSubscriptionRoutes } from "./routes/subscriptionRoutes";
import { registerRuntimeBootstrapRoutes } from "./routes/runtimeBootstrapRoutes";
import { registerStripeWebhookRoutes } from "./routes/parkingStripeWebhookRoutes";
import { registerTruckClaimRoutes } from "./routes/truckClaimRoutes";
import { registerMenuRoutes } from "./routes/menuRoutes";
import { registerPickupOrderRoutes } from "./routes/pickupOrderRoutes";
import { registerRestaurantPaymentRoutes } from "./routes/restaurantPaymentRoutes";
import { registerMerchantPromotionRoutes } from "./routes/merchantPromotionRoutes";
import { registerMerchantDeliveryRoutes } from "./routes/merchantDeliveryRoutes";
import { registerNotificationRoutes } from "./routes/notificationRoutes";
import { registerHiringRoutes } from "./routes/hiringRoutes";
import { registerAdminMarketHeatmapRoutes } from "./routes/adminMarketHeatmapRoutes";
import { registerSupportRoutes } from "./routes/supportRoutes";
import { registerRecommendationRoutes } from "./routes/recommendationRoutes";
import { registerDiscoveryObservatoryRoutes } from "./routes/discoveryObservatoryRoutes";
import { registerScoutcoinRoutes } from "./routes/scoutcoinRoutes";
import { registerParkingRoutePlanningRoutes } from "./routes/parkingRoutePlanningRoutes";
import { registerOwnerAiActionRoutes } from "./routes/ownerAiActionRoutes";
import { registerPublicProfileSourceCheckRoutes } from "./routes/publicProfileSourceCheckRoutes";
import {
  notifyNearbyDealSubscribers,
  notifyRestaurantFollowersOfDeal,
  notifyHostCapacityWarning,
  queueSocialPost,
  toNumeric,
} from "./routes/dealRouteDependencies";
import { createRouteAccessPolicyDependencies } from "./routes/accessPolicyDependencies";

// Optional Stripe integration
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const {
  ensureTrialForUser,
  validateProfileAnalyticsAccess,
  hasCompleteProfileAccess,
  filterDealsByBusinessAccess,
} = createRouteAccessPolicyDependencies(stripe);

export async function registerRoutes(app: Express): Promise<Server> {
  await setupUnifiedAuth(app);

  registerAuthAccountRoutes(app);
  registerNotificationRoutes(app);
  registerSupportRoutes(app);
  registerParkingRoutePlanningRoutes(app);
  registerOwnerAiActionRoutes(app);
  registerPublicProfileSourceCheckRoutes(app);

  registerLocationDemandRoutes(app);
  registerLocationUtilityRoutes(app, { hasCompleteProfileAccess });

  registerPublicMapRoutes(app);

  registerMediaRoutes(app);

  registerAnalyticsRoutes(app);
  registerDiscoveryObservatoryRoutes(app);
  registerAwardsRoutes(app);

  registerClaimRoutes(app, { sendDealClaimedNotification });
  registerBusinessTeamRoutes(app);

  registerDealManagementRoutes(app, {
    logAudit,
    notifyNearbyDealSubscribers,
    notifyRestaurantFollowersOfDeal,
    toNumeric,
    hasCompleteProfileAccess,
    queueSocialPost,
  });

  registerDealDiscoveryRoutes(app, {
    filterDealsByBusinessAccess,
    hasCompleteProfileAccess,
  });

  registerRestaurantOperationsRoutes(app, {
    validateProfileAnalyticsAccess,
    hasCompleteProfileAccess,
  });
  registerMerchantPromotionRoutes(app);
  registerMerchantDeliveryRoutes(app);
  registerProfileEvidenceReviewRoutes(app);

  registerRestaurantSignupRoutes(app, {
    ensureTrialForUser,
    queueSocialPost,
  });
  registerSubscriptionRoutes(app, {
    stripe,
  });
  registerTruckClaimRoutes(app);

  registerPublicDiscoveryRoutes(app);
  registerNativeEcosystemLinks(app);

  registerRestaurantCoreRoutes(app, { validateProfileAnalyticsAccess });

  registerPublicSearchRoutes(app);
  registerPublicSeoLandingRoutes(app);
  registerRecommendationRoutes(app);
  registerScoutcoinRoutes(app);
  registerScoutSurfaceRoutes(app);

  registerSeoRoutes(app);
  registerHostInterestRoutes(app, {
    getHostByUserId,
    getEventAndHostForUser,
    getInterestEventAndHostForUser,
    userOwnsEvent,
    computeAcceptedCount,
    shouldBlockAcceptance,
    buildCapacityFullError,
    computeFillRate,
  });

  // Host Profile & Events
  registerHostRoutes(app);

  // =====================================================================
  // EVENT SERIES (OPEN CALLS) ENDPOINTS
  // =====================================================================
  registerOpenCallSeriesRoutes(app);

  // =====================================================================
  // END EVENT SERIES ENDPOINTS
  // ====================================================================

  // Truck Discovery
  registerEventRoutes(app, { hasCompleteProfileAccess });
  registerDiscoveryRoutes(app);
  registerEventCoordinatorRoutes(app, { hasCompleteProfileAccess });

  // Booking Management
  registerParkingCheckoutRoutes(app, { stripe });
  registerBookingRoutes(app, { hasCompleteProfileAccess });

  // Supplier marketplace (suppliers + food truck pickup orders)
  registerSupplierMarketplaceRoutes(app);
  if (String(process.env.ENABLE_SUPPLY_SCOUT || "").toLowerCase() === "true") {
    registerSupplyScoutRoutes(app);
  }
  registerStripeWebhookRoutes(app, { notifyHostCapacityWarning });

  // Online menus + pickup ordering
  registerRestaurantPaymentRoutes(app, { stripe });
  registerMenuRoutes(app);
  registerPickupOrderRoutes(app);
  registerHiringRoutes(app, { hasCompleteProfileAccess });

  // Admin API endpoints
  registerAdminManagementRoutes(app);
  registerAdminMarketHeatmapRoutes(app);
  registerGeoAdRoutes(app);
  registerHostPayoutAdminRoutes(app);
  registerGrowthRoutes(app);
  
  // Moderation and community trust
  registerModerationRoutes(app);
  
  // Staff management and user creation endpoints
  registerStaffRoutes(app);

  // Public machine-readable signal endpoint for LISA source polling.
  app.get("/api/signals", (_req, res) => {
    res.json({
      source: "mealscout",
      generated_at: new Date().toISOString(),
      count: 1,
      signals: [
        {
          id: Date.now(),
          lane: "business",
          signal_kind: "source_heartbeat",
          confidence: 0.9,
          score: 58,
          impact_level: "low",
          trend: "neutral",
          velocity: "steady",
          action_hint: "mealscout source healthy",
          tags: ["mealscout", "heartbeat"],
          source_class: "source_api",
          observed_fact: "MealScout API heartbeat is healthy",
        },
      ],
    });
  });

  await registerRuntimeBootstrapRoutes(app);

  const httpServer = createServer(app);
  return httpServer;
}