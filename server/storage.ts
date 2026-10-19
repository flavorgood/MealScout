import {
  users,
  restaurants,
  deals,
  dealClaims,
  reviews,
  verificationRequests,
  dealViews,
  foodTruckSessions,
  foodTruckLocations,
  restaurantFavorites,
  restaurantFollows,
  restaurantUserRecommendations,
  restaurantRecommendations,
  locationRequests,
  truckInterests,
  hostLocationClaims,
  userAddresses,
  passwordResetTokens,
  phoneVerificationTokens,
  accountSetupTokens,
  emailVerificationTokens,
  dealFeedback,
  apiKeys,
  type User,
  type UpsertUser,
  type Restaurant,
  type InsertRestaurant,
  type Deal,
  type InsertDeal,
  type DealClaim,
  type InsertDealClaim,
  type Review,
  type InsertReview,
  type VerificationRequest,
  type InsertVerificationRequest,
  type DealView,
  type InsertDealView,
  type FoodTruckSession,
  type InsertFoodTruckSession,
  type FoodTruckLocation,
  type InsertFoodTruckLocation,
  type UpdateRestaurantMobileSettings,
  type RestaurantFavorite,
  type InsertRestaurantFavorite,
  type RestaurantFollow,
  type InsertRestaurantFollow,
  type RestaurantUserRecommendation,
  type InsertRestaurantUserRecommendation,
  type RestaurantRecommendation,
  type InsertRestaurantRecommendation,
  type LocationRequest,
  type InsertLocationRequest,
  type InsertTruckInterest,
  type HostLocationClaim,
  type InsertHostLocationClaim,
  type UserAddress,
  type InsertUserAddress,
  type PasswordResetToken,
  type InsertPasswordResetToken,
  type PhoneVerificationToken,
  type InsertPhoneVerificationToken,
  type AccountSetupToken,
  type InsertAccountSetupToken,
  type EmailVerificationToken,
  type InsertEmailVerificationToken,
  type DealFeedback,
  type InsertDealFeedback,
  type GoogleUserData,
  type EmailUserData,
  type FacebookUserData,
  type TradeScoutUserData,
  type UpdateRestaurantLocation,
  type OperatingHours,
  hosts,
  events,
  eventSeries,
  type Host,
  type InsertHost,
  parkingPassBlackoutDates,
  type ParkingPassBlackoutDate,
  type InsertParkingPassBlackoutDate,
  truckManualSchedules,
  type TruckManualSchedule,
  type InsertTruckManualSchedule,
  truckParkingReports,
  type TruckParkingReport,
  type InsertTruckParkingReport,
  type Event,
  type InsertEvent,
  type EventSeries,
  type InsertEventSeries,
  eventInterests,
  type EventInterest,
  type InsertEventInterest,
  hostReviews,
  type HostReview,
  type InsertHostReview,
  telemetryEvents,
  type InsertTelemetryEvent,
  lisaClaims,
  type LisaClaim,
  type InsertLisaClaim,
  type LisaClaimType,
  type LisaClaimSource,
  claims,
  type Claim,
  type InsertClaim,
} from "@shared/schema";
import { buildRestaurantOrderingAuthorityRevocation } from "./services/restaurantOrderingAuthorityReset";
import { PARKING_PASS_MEAL_WINDOWS } from "@shared/parkingPassSlots";
import {
  deriveTruckPresence,
  type TruckPresence,
} from "@shared/consumerEntity";
import { db, pool } from "./db";
import {
  eq,
  and,
  or,
  gte,
  lte,
  lt,
  sql,
  desc,
  asc,
  inArray,
  isNull,
  isNotNull,
  not,
  ne,
} from "drizzle-orm";
import bcrypt from "bcryptjs";
import { syncUserToBrevo } from "./brevoCrm";
import { ensureAffiliateTag } from "./affiliateTagService";
import { shouldAssignAffiliateTagForUserType } from "./roleAccess";
import {
  getBusinessAccessContext,
  hasBusinessPermissionForRestaurant,
} from "./services/businessTeamAccess";
import { forwardGeocode } from "./utils/geocoding";
import { isParkingPassPublicReady } from "./services/parkingPassQuality";
import { resolveCityTimeZoneSync } from "./services/cityTimeZone";
import { utcDateFromDateKey } from "./services/dateKeys";
import { isPublicBusinessVisible } from "./utils/publicBusinessVisibility";
import { broadcastLisaClaim } from "./websocket";
import { createAuthTokensRepository } from "./storage/authTokensRepository";
import { createHostsEventsRepository } from "./storage/hostsEventsRepository";
import { createRestaurantsDealsRepository } from "./storage/restaurantsDealsRepository";
import { createUsersRepository } from "./storage/usersRepository";
import { createPaymentsSubscriptionsRepository } from "./storage/paymentsSubscriptionsRepository";
import { createAnalyticsRepository } from "./storage/analyticsRepository";
import { createParkingPassRepository } from "./storage/parkingPassRepository";

// Interface for storage operations
export interface IStorage {
  // Host operations
  createHost(host: InsertHost): Promise<Host>;
  getHost(id: string): Promise<Host | undefined>;
  getHostByUserId(userId: string): Promise<Host | undefined>;
  ensureDraftParkingPassForHost(hostId: string): Promise<boolean>;
  syncParkingPassSeriesFromHost(hostId: string): Promise<string | null>;
  getHostsByUserId(userId: string): Promise<Host[]>;
  getHostsByIds(hostIds: string[]): Promise<Host[]>;
  syncHostFromUserAddress(
    userId: string,
    address: UserAddress,
    previousAddress?: UserAddress,
    options?: { force?: boolean },
  ): Promise<Host | null>;
  deleteHostForUserAddress(
    userId: string,
    address: UserAddress,
  ): Promise<boolean>;
  getParkingPassBlackoutDates(
    seriesId: string,
  ): Promise<ParkingPassBlackoutDate[]>;
  createParkingPassBlackoutDate(
    blackout: InsertParkingPassBlackoutDate,
  ): Promise<ParkingPassBlackoutDate>;
  deleteParkingPassBlackoutDate(seriesId: string, date: Date): Promise<void>;
  getAllHosts(): Promise<Host[]>;
  updateHostCoordinates(
    hostId: string,
    lat: number,
    lng: number,
  ): Promise<Host>;
  createEvent(event: InsertEvent): Promise<Event>;
  getEvent(id: string): Promise<Event | undefined>;
  getEventsByHost(
    hostId: string,
  ): Promise<(Event & { interests: EventInterest[] })[]>;
  getEventsOwnedByUser(
    userId: string,
  ): Promise<(Event & { interests: EventInterest[] })[]>;
  createEventInterest(interest: InsertEventInterest): Promise<EventInterest>;
  updateEventInterestStatus(id: string, status: string): Promise<EventInterest>;
  getEventInterest(id: string): Promise<EventInterest | undefined>;
  getEventInterestByTruckId(
    eventId: string,
    truckId: string,
  ): Promise<EventInterest | undefined>;
  getEventInterestsByEventId(
    eventId: string,
  ): Promise<(EventInterest & { truck: any })[]>;

  // Event Series (Open Calls)
  createEventSeries(series: InsertEventSeries): Promise<EventSeries>;
  getEventSeries(id: string): Promise<EventSeries | undefined>;
  getEventSeriesByHost(hostId: string): Promise<EventSeries[]>;
  getEventSeriesOwnedByUser(userId: string): Promise<EventSeries[]>;
  updateEventSeries(
    id: string,
    updates: Partial<InsertEventSeries>,
  ): Promise<EventSeries>;
  publishEventSeries(id: string): Promise<EventSeries>;
  getEventsBySeriesId(seriesId: string): Promise<Event[]>;

  // Telemetry
  createTelemetryEvent(event: InsertTelemetryEvent): Promise<void>;

  // Unified Claims (North Star)
  createUnifiedClaim(claim: InsertClaim): Promise<Claim>;

  // LISA Phase 4A: Claim Persistence (write-only fact recording)
  emitClaim(claim: {
    subjectType: string;
    subjectId: string;
    actorType?: string;
    actorId?: string;
    app: "mealscout" | "tradescout";
    claimType: LisaClaimType | string;
    claimValue: Record<string, any>;
    source: LisaClaimSource | string;
    confidence?: number;
  }): Promise<void>;

  getClaims(filters: {
    subjectType?: string;
    subjectId?: string;
    actorType?: string;
    actorId?: string;
    app?: "mealscout" | "tradescout";
    claimType?: LisaClaimType | string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<LisaClaim[]>;

  // User operations
  // (IMPORTANT) these user operations are mandatory for authentication.
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByPhone(phone: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  upsertUserByAuth(
    authType: "google" | "email" | "facebook" | "tradescout",
    userData:
      | GoogleUserData
      | EmailUserData
      | FacebookUserData
      | TradeScoutUserData,
    userType?: User["userType"],
    appContext?: "mealscout" | "tradescout",
  ): Promise<User>;
  updateUserStripeInfo(
    id: string,
    stripeCustomerId: string,
    stripeSubscriptionId: string,
    subscriptionBillingInterval?: string,
  ): Promise<User>;
  updateUser(
    id: string,
    updates: Partial<
      Pick<
        User,
        | "subscriptionBillingInterval"
        | "stripeCustomerId"
        | "stripeSubscriptionId"
        | "subscriptionSignupDate"
        | "trialStartedAt"
        | "trialEndsAt"
        | "trialUsed"
        | "emailVerified"
        | "firstName"
        | "lastName"
        | "phone"
        | "passwordHash"
        | "publicProfileSettings"
        | "accountSettings"
      >
    >,
  ): Promise<User>;

  // Restaurant operations
  createRestaurant(restaurant: InsertRestaurant): Promise<Restaurant>;
  getRestaurant(id: string): Promise<Restaurant | undefined>;
  getRestaurantsByOwner(ownerId: string): Promise<Restaurant[]>;
  updateRestaurant(
    id: string,
    restaurant: Partial<InsertRestaurant>,
    options?: { allowIdentityChange?: boolean },
  ): Promise<Restaurant>;
  getNearbyRestaurants(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<Restaurant[]>;
  getSubscribedRestaurants(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<Restaurant[]>;
  verifyRestaurantOwnership(
    restaurantId: string,
    userId: string,
    requiredPermission?:
      | "manageDeals"
      | "manageParkingPass"
      | "viewAnalytics"
      | "manageProfile",
  ): Promise<boolean>;
  createTruckManualSchedule(
    schedule: InsertTruckManualSchedule,
  ): Promise<TruckManualSchedule>;
  getTruckManualSchedules(truckId: string): Promise<TruckManualSchedule[]>;
  deleteTruckManualSchedule(
    scheduleId: string,
    truckId?: string,
  ): Promise<void>;
  createTruckParkingReport(
    report: InsertTruckParkingReport,
  ): Promise<TruckParkingReport>;
  getTruckParkingReports(
    truckId: string,
    options?: { startDate?: Date; endDate?: Date },
  ): Promise<TruckParkingReport[]>;

  // Deal operations
  createDeal(deal: InsertDeal): Promise<Deal>;
  getDeal(id: string): Promise<Deal | undefined>;
  getDealsByRestaurant(restaurantId: string): Promise<Deal[]>;
  getActiveDeals(): Promise<Deal[]>;
  getFilteredDeals(showLimitedTimeOnly?: boolean): Promise<Deal[]>;
  getNearbyDeals(lat: number, lng: number, radiusKm: number): Promise<Deal[]>;
  searchDeals(filters: {
    query?: string;
    cuisineType?: string;
    minPrice?: number;
    maxPrice?: number;
    latitude?: number;
    longitude?: number;
    radius?: number;
    sortBy?: string;
  }): Promise<Deal[]>;
  updateDeal(id: string, deal: Partial<InsertDeal>): Promise<Deal>;
  incrementDealUses(id: string): Promise<void>;
  deactivateUserDeals(userId: string): Promise<void>;
  deleteDeal(id: string): Promise<void>;
  duplicateDeal(id: string): Promise<Deal>;

  // Deal claim operations
  claimDeal(claim: InsertDealClaim): Promise<DealClaim>;
  claimDealAtomic(
    dealId: string,
    userId: string,
    perCustomerLimit: number,
  ): Promise<
    | { ok: true; claim: DealClaim }
    | { ok: false; reason: "already_claimed" | "sold_out" }
  >;
  getUserDealClaims(userId: string): Promise<DealClaim[]>;
  getUserDealClaimsWithDetails(userId: string): Promise<any[]>;
  getDealClaimsCount(dealId: string, userId?: string): Promise<number>;
  getRestaurantDealClaims(
    restaurantId: string,
    status?: string,
  ): Promise<any[]>;
  verifyRestaurantOwnershipByClaim(
    claimId: string,
    userId: string,
  ): Promise<boolean>;

  // Review operations
  createReview(review: InsertReview): Promise<Review>;
  getRestaurantReviews(restaurantId: string): Promise<Review[]>;

  // Admin operations
  ensureAdminExists(): Promise<void>;

  // Account setup invite
  createUserInvite(data: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    userType:
      | "customer"
      | "restaurant_owner"
      | "food_truck"
      | "host"
      | "event_coordinator"
      | "staff"
      | "admin"
      | "duper_admin"
      | "super_admin";
  }): Promise<User>;

  // Verification operations
  createVerificationRequest(
    verificationRequest: InsertVerificationRequest,
  ): Promise<VerificationRequest>;
  getVerificationRequestsByOwner(
    ownerId: string,
  ): Promise<VerificationRequest[]>;
  getVerificationRequests(): Promise<
    (VerificationRequest & {
      restaurant: {
        id: string;
        name: string;
        address: string;
        ownerId: string;
      };
    })[]
  >;
  approveVerificationRequest(id: string, reviewerId: string): Promise<void>;
  rejectVerificationRequest(
    id: string,
    reviewerId: string,
    reason: string,
  ): Promise<void>;
  setRestaurantVerified(
    restaurantId: string,
    isVerified: boolean,
  ): Promise<void>;
  hasPendingVerificationRequest(restaurantId: string): Promise<boolean>;

  // Deal view tracking operations
  recordDealView(view: InsertDealView): Promise<DealView>;
  getDealViewsCount(
    dealId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<number>;
  hasRecentDealView(
    dealId: string,
    userId?: string,
    sessionId?: string,
    timeWindowMs?: number,
  ): Promise<boolean>;

  // Deal claim revenue operations
  markClaimAsUsed(
    claimId: string,
    orderAmount?: number | null,
  ): Promise<DealClaim | null>;

  // Advanced analytics operations
  getRestaurantAnalyticsSummary(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<{
    totalViews: number;
    totalClaims: number;
    totalRevenue: number;
    conversionRate: number;
    topDeals: Array<{
      dealId: string;
      title: string;
      views: number;
      claims: number;
      revenue: number;
    }>;
  }>;

  getRestaurantAnalyticsTimeseries(
    restaurantId: string,
    dateRange: { start: Date; end: Date },
    interval: "day" | "week",
  ): Promise<
    Array<{
      date: string;
      views: number;
      claims: number;
      revenue: number;
    }>
  >;

  getRestaurantCustomerInsights(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<{
    repeatCustomers: number;
    averageOrderValue: number;
    peakHours: Array<{ hour: number; count: number }>;
    demographics: {
      ageGroups: Array<{ range: string; count: number }>;
      genderBreakdown: Array<{ gender: string; count: number }>;
    };
  }>;

  getRestaurantAnalyticsExport(
    restaurantId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<
    Array<{
      dealTitle: string;
      date: string;
      views: number;
      claims: number;
      revenue: number;
    }>
  >;

  // Food truck operations
  setRestaurantMobileSettings(
    restaurantId: string,
    settings: UpdateRestaurantMobileSettings,
  ): Promise<Restaurant>;
  updateRestaurantLocation(
    restaurantId: string,
    location: UpdateRestaurantLocation,
  ): Promise<Restaurant>;
  setRestaurantOperatingHours(
    restaurantId: string,
    operatingHours: OperatingHours,
  ): Promise<Restaurant>;
  isRestaurantOpenNow(restaurantId: string): Promise<boolean>;
  startTruckSession(
    restaurantId: string,
    deviceId: string,
    userId: string,
  ): Promise<FoodTruckSession>;
  endTruckSession(restaurantId: string, userId: string): Promise<void>;
  getActiveTruckSession(
    restaurantId: string,
  ): Promise<FoodTruckSession | undefined>;
  upsertLiveLocation(
    location: InsertFoodTruckLocation,
    options?: { liveUntilAt?: Date | null },
  ): Promise<FoodTruckLocation>;
  getLiveTrucksNearby(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<
    Array<
      Restaurant & {
        distance: number;
        distanceMiles: number;
        lat: number | null;
        lng: number | null;
        liveBroadcasting: boolean;
        locationSource: "live";
        sessionId?: string;
      }
    >
  >;
  getTruckLocationHistory(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<FoodTruckLocation[]>;
  hasRecentLocationUpdate(
    restaurantId: string,
    lat: number,
    lng: number,
    timeWindowMs?: number,
    distanceThreshold?: number,
  ): Promise<boolean>;

  // Restaurant favorites operations
  createRestaurantFavorite(favorite: {
    restaurantId: string;
    userId: string;
  }): Promise<any>;
  removeRestaurantFavorite(restaurantId: string, userId: string): Promise<void>;
  getUserRestaurantFavorites(userId: string): Promise<any[]>;
  getUserRestaurantFavoritesCount(userId: string): Promise<number>;
  createRestaurantFollow(follow: {
    restaurantId: string;
    userId: string;
  }): Promise<any>;
  getRestaurantFollowReceipt(
    restaurantId: string,
    userId: string,
  ): Promise<any | null>;
  removeRestaurantFollow(restaurantId: string, userId: string): Promise<void>;
  getUserRestaurantFollows(userId: string): Promise<any[]>;
  createRestaurantUserRecommendation(recommendation: {
    restaurantId: string;
    userId: string;
  }): Promise<any>;
  setRestaurantUserRecommendationQuickReview(
    id: string,
    scores: {
      food: number | null;
      value: number | null;
      speed: number | null;
      vibe: number | null;
    },
  ): Promise<void>;
  getUserRestaurantRecommendations(userId: string): Promise<any[]>;
  getRestaurantFavoritesAnalytics(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<{
    totalFavorites: number;
    favoritesTrend: Array<{ date: string; count: number }>;
    recentFavorites: Array<{ userId: string; favoritedAt: Date }>;
  }>;

  // Restaurant recommendations operations
  trackRestaurantRecommendation(recommendation: {
    restaurantId: string;
    userId?: string;
    sessionId: string;
    recommendationType: "homepage" | "search" | "nearby" | "personalized";
    recommendationContext?: string;
  }): Promise<any>;
  markRecommendationClicked(recommendationId: string): Promise<void>;
  getRestaurantRecommendationsAnalytics(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<{
    totalRecommendations: number;
    totalClicks: number;
    clickThroughRate: number;
    recommendationsByType: Array<{
      type: string;
      count: number;
      clicks: number;
    }>;
    recommendationsTrend: Array<{
      date: string;
      count: number;
      clicks: number;
    }>;
  }>;
  // Host location requests / truck interest
  createLocationRequest(
    request: InsertLocationRequest,
  ): Promise<LocationRequest>;
  getLocationRequestById(id: string): Promise<LocationRequest | undefined>;
  expireStaleLocationRequests(): Promise<number>;
  createTruckInterest(interest: InsertTruckInterest): Promise<{
    interestId: string;
    locationRequest: LocationRequest;
    interestCount: number;
    minInterestedTrucks: number;
    thresholdReached: boolean;
    thresholdJustReached: boolean;
  }>;
  getLocationDemandQueue(limit?: number): Promise<
    Array<
      LocationRequest & {
        interestCount: number;
        thresholdRemaining: number;
      }
    >
  >;
  getLocationDemandQueueByUser(
    userId: string,
    limit?: number,
  ): Promise<
    Array<
      LocationRequest & {
        interestCount: number;
        thresholdRemaining: number;
      }
    >
  >;
  createHostLocationClaim(
    claim: InsertHostLocationClaim,
  ): Promise<HostLocationClaim>;
  convertHostLocationClaim(
    claimId: string,
    hostId: string,
    claimingUserId: string,
  ): Promise<void>;

  // User address operations
  createUserAddress(address: InsertUserAddress): Promise<UserAddress>;
  getUserAddresses(userId: string): Promise<UserAddress[]>;
  getUserAddress(id: string): Promise<UserAddress | undefined>;
  updateUserAddress(
    id: string,
    address: Partial<InsertUserAddress>,
  ): Promise<UserAddress>;
  deleteUserAddress(id: string): Promise<void>;
  setDefaultAddress(userId: string, addressId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  // Password reset token operations
  createPasswordResetToken(
    tokenData: InsertPasswordResetToken,
  ): Promise<PasswordResetToken>;
  getPasswordResetToken(id: string): Promise<PasswordResetToken | undefined>;
  getPasswordResetTokenByTokenHash(
    tokenHash: string,
  ): Promise<PasswordResetToken | undefined>;
  markPasswordResetTokenUsed(id: string): Promise<PasswordResetToken>;
  deleteUserResetTokens(userId: string): Promise<void>;
  deleteExpiredResetTokens(): Promise<number>;

  // Phone verification tokens
  createPhoneVerificationToken(
    tokenData: InsertPhoneVerificationToken,
  ): Promise<PhoneVerificationToken>;
  getPhoneVerificationTokenByHash(
    phone: string,
    tokenHash: string,
  ): Promise<PhoneVerificationToken | undefined>;
  markPhoneVerificationTokenUsed(id: string): Promise<PhoneVerificationToken>;
  deletePhoneVerificationTokens(phone: string): Promise<void>;
  deleteExpiredPhoneVerificationTokens(): Promise<number>;

  // Account setup token operations
  createAccountSetupToken(
    tokenData: InsertAccountSetupToken,
  ): Promise<AccountSetupToken>;
  getAccountSetupToken(id: string): Promise<AccountSetupToken | undefined>;
  getAccountSetupTokenByTokenHash(
    tokenHash: string,
  ): Promise<AccountSetupToken | undefined>;
  markAccountSetupTokenUsed(id: string): Promise<AccountSetupToken>;
  deleteAccountSetupToken(id: string): Promise<void>;
  deleteUserSetupTokens(userId: string): Promise<void>;
  deleteExpiredSetupTokens(): Promise<number>;
  ensureDraftParkingPassesForHosts(): Promise<number>;

  // Email verification token operations
  createEmailVerificationToken(
    tokenData: InsertEmailVerificationToken,
  ): Promise<EmailVerificationToken>;
  getEmailVerificationTokenByTokenHash(
    tokenHash: string,
  ): Promise<EmailVerificationToken | undefined>;
  markEmailVerificationTokenUsed(id: string): Promise<EmailVerificationToken>;

  // API Key operations
  getActiveApiKeys(): Promise<any[]>;
  updateApiKeyLastUsed(keyId: string): Promise<void>;

  // Deal feedback operations
  createDealFeedback(feedback: InsertDealFeedback): Promise<DealFeedback>;
  getDealFeedback(dealId: string): Promise<DealFeedback[]>;
  getUserDealFeedback(userId: string): Promise<DealFeedback[]>;
  getDealFeedbackStats(dealId: string): Promise<{
    totalFeedback: number;
  }>;

  // Stripe lookup operations
  getUserByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<User | undefined>;
  getUserByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<User | undefined>;

  // Admin user operations
  getAllUsers(): Promise<User[]>;
  updateUserStatus(userId: string, isActive: boolean): Promise<void>;
  updateUserType(
    userId: string,
    userType:
      | "customer"
      | "restaurant_owner"
      | "food_truck"
      | "host"
      | "event_coordinator"
      | "staff"
      | "admin"
      | "duper_admin"
      | "super_admin",
  ): Promise<User>;
  deleteUser(userId: string): Promise<void>;
  createUserManually(userData: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    userType: string;
    tempPassword: string;
  }): Promise<User>;
  createRestaurantForUser(restaurantData: {
    userId: string;
    name: string;
    address: string;
    cuisineType: string;
  }): Promise<Restaurant>;

  // Host operations
  createHost(host: InsertHost): Promise<Host>;
  getHost(id: string): Promise<Host | undefined>;
  getHostByUserId(userId: string): Promise<Host | undefined>;
  createEvent(event: InsertEvent): Promise<Event>;
  getEventsByHost(
    hostId: string,
  ): Promise<(Event & { interests: EventInterest[] })[]>;
  getAllUpcomingEvents(): Promise<
    (Event & { host: Host; series?: EventSeries | null })[]
  >;
  createEventInterest(interest: InsertEventInterest): Promise<EventInterest>;
  getEventInterestByTruckId(
    eventId: string,
    truckId: string,
  ): Promise<EventInterest | undefined>;
  getEventInterestsByEventId(
    eventId: string,
  ): Promise<(EventInterest & { truck: any })[]>;
  // Map surfacing
  getOpenLocationRequests(): Promise<LocationRequest[]>;
}

export class DatabaseStorage implements IStorage {
  private readonly authTokensRepository = createAuthTokensRepository();
  private readonly hostsEventsRepository = createHostsEventsRepository();
  private readonly restaurantsDealsRepository =
    createRestaurantsDealsRepository({
      ensureCityExists: async (name: string, state: string | null) =>
        this.ensureCityExists(name, state),
    });
  private readonly usersRepository = createUsersRepository();
  private readonly paymentsSubscriptionsRepository =
    createPaymentsSubscriptionsRepository();
  private readonly analyticsRepository = createAnalyticsRepository();
  private readonly parkingPassRepository = createParkingPassRepository({
    getHost: (id: string) => this.getHost(id),
    getAllHosts: () => this.getAllHosts(),
  });
  private userTableInfoPromise: Promise<{
    schema: string;
    columns: Set<string>;
  }> | null = null;
  private hostTableInfoPromise: Promise<{
    schema: string;
    columns: Set<string>;
  }> | null = null;
  private eventTableInfoPromise: Promise<{
    schema: string;
    columns: Set<string>;
  }> | null = null;
  private eventSeriesTableInfoPromise: Promise<{
    schema: string;
    columns: Set<string>;
  }> | null = null;

  private async getUserTableInfo(): Promise<{
    schema: string;
    columns: Set<string>;
  }> {
    if (this.userTableInfoPromise) return this.userTableInfoPromise;
    // Never allow this to reject; admin + auth flows should degrade gracefully under schema drift.
    this.userTableInfoPromise = (async () => {
      try {
        if (!pool) {
          return { schema: "public", columns: new Set<string>() };
        }

        const schemaRes = await pool.query(
          `
            select table_schema
            from information_schema.tables
            where table_name = 'users'
            order by case when table_schema = 'public' then 0 else 1 end
            limit 1
          `,
        );
        const schema =
          String(schemaRes.rows?.[0]?.table_schema || "").trim() || "public";

        const colsRes = await pool.query(
          `
            select column_name
            from information_schema.columns
            where table_schema = $1 and table_name = 'users'
          `,
          [schema],
        );
        const columns = new Set<string>(
          (colsRes.rows || [])
            .map((row: any) => String(row.column_name || "").trim())
            .filter(Boolean),
        );
        return { schema, columns };
      } catch (error) {
        console.warn(
          "getUserTableInfo failed; using safe user projection:",
          error,
        );
        return { schema: "public", columns: new Set<string>() };
      }
    })();
    return this.userTableInfoPromise;
  }

  private async getHostTableInfo(): Promise<{
    schema: string;
    columns: Set<string>;
  }> {
    if (this.hostTableInfoPromise) return this.hostTableInfoPromise;
    // Never allow this to reject: if information_schema isn't accessible (or any other
    // transient DB issue), fall back to a minimal, safe projection instead of 500'ing.
    this.hostTableInfoPromise = (async () => {
      try {
        if (!pool) {
          return { schema: "public", columns: new Set<string>() };
        }

        const schemaRes = await pool.query(
          `
            select table_schema
            from information_schema.tables
            where table_name = 'hosts'
            order by case when table_schema = 'public' then 0 else 1 end
            limit 1
          `,
        );
        const schema =
          String(schemaRes.rows?.[0]?.table_schema || "").trim() || "public";

        const colsRes = await pool.query(
          `
            select column_name
            from information_schema.columns
            where table_schema = $1 and table_name = 'hosts'
          `,
          [schema],
        );
        const columns = new Set<string>(
          (colsRes.rows || [])
            .map((row: any) => String(row.column_name || "").trim())
            .filter(Boolean),
        );
        return { schema, columns };
      } catch (error) {
        console.warn(
          "getHostTableInfo failed; using safe host projection:",
          error,
        );
        return { schema: "public", columns: new Set<string>() };
      }
    })();
    return this.hostTableInfoPromise;
  }

  private async getEventTableInfo(): Promise<{
    schema: string;
    columns: Set<string>;
  }> {
    if (this.eventTableInfoPromise) return this.eventTableInfoPromise;
    this.eventTableInfoPromise = (async () => {
      try {
        if (!pool) {
          return { schema: "public", columns: new Set<string>() };
        }

        const schemaRes = await pool.query(
          `
            select table_schema
            from information_schema.tables
            where table_name = 'events'
            order by case when table_schema = 'public' then 0 else 1 end
            limit 1
          `,
        );
        const schema =
          String(schemaRes.rows?.[0]?.table_schema || "").trim() || "public";

        const colsRes = await pool.query(
          `
            select column_name
            from information_schema.columns
            where table_schema = $1 and table_name = 'events'
          `,
          [schema],
        );
        const columns = new Set<string>(
          (colsRes.rows || [])
            .map((row: any) => String(row.column_name || "").trim())
            .filter(Boolean),
        );
        return { schema, columns };
      } catch (error) {
        console.warn(
          "getEventTableInfo failed; using safe event projection:",
          error,
        );
        return { schema: "public", columns: new Set<string>() };
      }
    })();
    return this.eventTableInfoPromise;
  }

  private async getEventSeriesTableInfo(): Promise<{
    schema: string;
    columns: Set<string>;
  }> {
    if (this.eventSeriesTableInfoPromise)
      return this.eventSeriesTableInfoPromise;
    this.eventSeriesTableInfoPromise = (async () => {
      try {
        if (!pool) {
          return { schema: "public", columns: new Set<string>() };
        }

        const schemaRes = await pool.query(
          `
            select table_schema
            from information_schema.tables
            where table_name = 'event_series'
            order by case when table_schema = 'public' then 0 else 1 end
            limit 1
          `,
        );
        const schema =
          String(schemaRes.rows?.[0]?.table_schema || "").trim() || "public";

        const colsRes = await pool.query(
          `
            select column_name
            from information_schema.columns
            where table_schema = $1 and table_name = 'event_series'
          `,
          [schema],
        );
        const columns = new Set<string>(
          (colsRes.rows || [])
            .map((row: any) => String(row.column_name || "").trim())
            .filter(Boolean),
        );
        return { schema, columns };
      } catch (error) {
        console.warn(
          "getEventSeriesTableInfo failed; using safe event_series projection:",
          error,
        );
        return { schema: "public", columns: new Set<string>() };
      }
    })();
    return this.eventSeriesTableInfoPromise;
  }

  private async selectEventSeriesSafe(
    whereSql: string,
    params: any[],
  ): Promise<any[]> {
    if (!pool) return [];
    const { schema, columns } = await this.getEventSeriesTableInfo();
    const has = (col: string) => columns.size === 0 || columns.has(col);
    const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

    // If we cannot confirm required columns exist, bail out safely.
    if (columns.size > 0 && (!columns.has("id") || !columns.has("host_id"))) {
      return [];
    }

    const select = [
      `${q("id")} as "id"`,
      `${q("host_id")} as "hostId"`,
      `${has("series_type") ? `${q("series_type")} as "seriesType"` : `null as "seriesType"`}`,
      `${has("name") ? `${q("name")} as "name"` : `null as "name"`}`,
      `${has("description") ? `${q("description")} as "description"` : `null as "description"`}`,
      `${has("status") ? `${q("status")} as "status"` : `null as "status"`}`,
      `${has("published_at") ? `${q("published_at")} as "publishedAt"` : `null as "publishedAt"`}`,
      `${has("default_start_time") ? `${q("default_start_time")} as "defaultStartTime"` : `null as "defaultStartTime"`}`,
      `${has("default_end_time") ? `${q("default_end_time")} as "defaultEndTime"` : `null as "defaultEndTime"`}`,
      `${has("default_max_trucks") ? `${q("default_max_trucks")} as "defaultMaxTrucks"` : `null as "defaultMaxTrucks"`}`,
      `${has("default_hard_cap_enabled") ? `${q("default_hard_cap_enabled")} as "defaultHardCapEnabled"` : `null as "defaultHardCapEnabled"`}`,
      `${has("parking_pass_days_of_week") ? `${q("parking_pass_days_of_week")} as "parkingPassDaysOfWeek"` : `null as "parkingPassDaysOfWeek"`}`,
      `${has("default_breakfast_price_cents") ? `${q("default_breakfast_price_cents")} as "defaultBreakfastPriceCents"` : `null as "defaultBreakfastPriceCents"`}`,
      `${has("default_lunch_price_cents") ? `${q("default_lunch_price_cents")} as "defaultLunchPriceCents"` : `null as "defaultLunchPriceCents"`}`,
      `${has("default_dinner_price_cents") ? `${q("default_dinner_price_cents")} as "defaultDinnerPriceCents"` : `null as "defaultDinnerPriceCents"`}`,
      `${has("default_daily_price_cents") ? `${q("default_daily_price_cents")} as "defaultDailyPriceCents"` : `null as "defaultDailyPriceCents"`}`,
      `${has("default_weekly_price_cents") ? `${q("default_weekly_price_cents")} as "defaultWeeklyPriceCents"` : `null as "defaultWeeklyPriceCents"`}`,
      `${has("default_monthly_price_cents") ? `${q("default_monthly_price_cents")} as "defaultMonthlyPriceCents"` : `null as "defaultMonthlyPriceCents"`}`,
      `${has("default_host_price_cents") ? `${q("default_host_price_cents")} as "defaultHostPriceCents"` : `null as "defaultHostPriceCents"`}`,
      `${has("updated_at") ? `${q("updated_at")} as "updatedAt"` : `null as "updatedAt"`}`,
    ];

    const sqlText = `select ${select.join(", ")} from ${q(schema)}.${q("event_series")} ${whereSql}`;
    const result = await pool.query(sqlText, params);
    return result.rows || [];
  }

  private async selectUsersSafe(
    whereSql: string,
    params: any[],
  ): Promise<any[]> {
    if (!pool) return [];
    const { schema, columns } = await this.getUserTableInfo();
    const has = (col: string) => columns.size === 0 || columns.has(col);
    const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

    if (columns.size > 0 && !columns.has("id")) return [];

    const select = [
      `${q("id")} as "id"`,
      `${has("user_type") ? `${q("user_type")} as "userType"` : `'customer' as "userType"`}`,
      `${has("email") ? `${q("email")} as "email"` : `null as "email"`}`,
      `${has("first_name") ? `${q("first_name")} as "firstName"` : `null as "firstName"`}`,
      `${has("last_name") ? `${q("last_name")} as "lastName"` : `null as "lastName"`}`,
      `${has("phone") ? `${q("phone")} as "phone"` : `null as "phone"`}`,
      `${has("password_hash") ? `${q("password_hash")} as "passwordHash"` : `null as "passwordHash"`}`,
      `${has("email_verified") ? `${q("email_verified")} as "emailVerified"` : `false as "emailVerified"`}`,
      `${has("must_reset_password") ? `${q("must_reset_password")} as "mustResetPassword"` : `false as "mustResetPassword"`}`,
      `${has("is_disabled") ? `${q("is_disabled")} as "isDisabled"` : `false as "isDisabled"`}`,
      `${has("is_active") ? `${q("is_active")} as "isActive"` : `null as "isActive"`}`,
      `${has("profile_image_url") ? `${q("profile_image_url")} as "profileImageUrl"` : `null as "profileImageUrl"`}`,
      `${has("affiliate_tag") ? `${q("affiliate_tag")} as "affiliateTag"` : `null as "affiliateTag"`}`,
      `${has("affiliate_percent") ? `${q("affiliate_percent")} as "affiliatePercent"` : `null as "affiliatePercent"`}`,
      `${has("affiliate_closer_user_id") ? `${q("affiliate_closer_user_id")} as "affiliateCloserUserId"` : `null as "affiliateCloserUserId"`}`,
      `${has("affiliate_booker_user_id") ? `${q("affiliate_booker_user_id")} as "affiliateBookerUserId"` : `null as "affiliateBookerUserId"`}`,
      `${has("affiliate_closer_percent") ? `${q("affiliate_closer_percent")} as "affiliateCloserPercent"` : `null as "affiliateCloserPercent"`}`,
      `${has("affiliate_booker_percent") ? `${q("affiliate_booker_percent")} as "affiliateBookerPercent"` : `null as "affiliateBookerPercent"`}`,
      `${has("stripe_customer_id") ? `${q("stripe_customer_id")} as "stripeCustomerId"` : `null as "stripeCustomerId"`}`,
      `${has("stripe_subscription_id") ? `${q("stripe_subscription_id")} as "stripeSubscriptionId"` : `null as "stripeSubscriptionId"`}`,
      `${has("subscription_billing_interval") ? `${q("subscription_billing_interval")} as "subscriptionBillingInterval"` : `null as "subscriptionBillingInterval"`}`,
      `${has("subscription_signup_date") ? `${q("subscription_signup_date")} as "subscriptionSignupDate"` : `null as "subscriptionSignupDate"`}`,
      `${has("trial_started_at") ? `${q("trial_started_at")} as "trialStartedAt"` : `null as "trialStartedAt"`}`,
      `${has("trial_ends_at") ? `${q("trial_ends_at")} as "trialEndsAt"` : `null as "trialEndsAt"`}`,
      `${has("trial_used") ? `${q("trial_used")} as "trialUsed"` : `false as "trialUsed"`}`,
      `${has("app_context") ? `${q("app_context")} as "appContext"` : `null as "appContext"`}`,
      `${has("public_profile_settings") ? `${q("public_profile_settings")} as "publicProfileSettings"` : `null as "publicProfileSettings"`}`,
      `${has("account_settings") ? `${q("account_settings")} as "accountSettings"` : `null as "accountSettings"`}`,
      `${has("created_at") ? `${q("created_at")} as "createdAt"` : `null as "createdAt"`}`,
      `${has("updated_at") ? `${q("updated_at")} as "updatedAt"` : `null as "updatedAt"`}`,
    ];

    const sqlText = `select ${select.join(", ")} from ${q(schema)}.${q("users")} ${whereSql}`;
    const result = await pool.query(sqlText, params);
    return result.rows || [];
  }

  async getParkingPassSeriesSafe() {
    return this.parkingPassRepository.getParkingPassSeriesSafe();
  }

  private async selectUpcomingEventsSafe(fromDate: Date): Promise<any[]> {
    if (!pool) return [];
    const { schema, columns } = await this.getEventTableInfo();

    const has = (col: string) => columns.has(col);
    const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
    const select = [
      `${q("id")} as "id"`,
      `${q("host_id")} as "hostId"`,
      `${has("coordinator_user_id") ? `${q("coordinator_user_id")} as "coordinatorUserId"` : `null as "coordinatorUserId"`}`,
      `${has("series_id") ? `${q("series_id")} as "seriesId"` : `null as "seriesId"`}`,
      `${has("name") ? `${q("name")} as "name"` : `null as "name"`}`,
      `${has("description") ? `${q("description")} as "description"` : `null as "description"`}`,
      `${has("event_type") ? `${q("event_type")} as "eventType"` : `'event' as "eventType"`}`,
      `${q("date")} as "date"`,
      `${has("start_time") ? `${q("start_time")} as "startTime"` : `'00:00' as "startTime"`}`,
      `${has("end_time") ? `${q("end_time")} as "endTime"` : `'00:00' as "endTime"`}`,
      `${has("max_trucks") ? `${q("max_trucks")} as "maxTrucks"` : `1 as "maxTrucks"`}`,
      `${has("status") ? `${q("status")} as "status"` : `'open' as "status"`}`,
      `${has("booked_restaurant_id") ? `${q("booked_restaurant_id")} as "bookedRestaurantId"` : `null as "bookedRestaurantId"`}`,
      `${has("hard_cap_enabled") ? `${q("hard_cap_enabled")} as "hardCapEnabled"` : `false as "hardCapEnabled"`}`,
      `${has("host_price_cents") ? `${q("host_price_cents")} as "hostPriceCents"` : `null as "hostPriceCents"`}`,
      `${has("breakfast_price_cents") ? `${q("breakfast_price_cents")} as "breakfastPriceCents"` : `null as "breakfastPriceCents"`}`,
      `${has("lunch_price_cents") ? `${q("lunch_price_cents")} as "lunchPriceCents"` : `null as "lunchPriceCents"`}`,
      `${has("dinner_price_cents") ? `${q("dinner_price_cents")} as "dinnerPriceCents"` : `null as "dinnerPriceCents"`}`,
      `${has("daily_price_cents") ? `${q("daily_price_cents")} as "dailyPriceCents"` : `null as "dailyPriceCents"`}`,
      `${has("weekly_price_cents") ? `${q("weekly_price_cents")} as "weeklyPriceCents"` : `null as "weeklyPriceCents"`}`,
      `${has("monthly_price_cents") ? `${q("monthly_price_cents")} as "monthlyPriceCents"` : `null as "monthlyPriceCents"`}`,
      `${has("requires_payment") ? `${q("requires_payment")} as "requiresPayment"` : `false as "requiresPayment"`}`,
      `${has("stripe_product_id") ? `${q("stripe_product_id")} as "stripeProductId"` : `null as "stripeProductId"`}`,
      `${has("stripe_price_id") ? `${q("stripe_price_id")} as "stripePriceId"` : `null as "stripePriceId"`}`,
      `${has("unbooked_notification_sent_at") ? `${q("unbooked_notification_sent_at")} as "unbookedNotificationSentAt"` : `null as "unbookedNotificationSentAt"`}`,
      `${has("created_at") ? `${q("created_at")} as "createdAt"` : `null as "createdAt"`}`,
      `${has("updated_at") ? `${q("updated_at")} as "updatedAt"` : `null as "updatedAt"`}`,
    ];

    const whereStatus = has("status")
      ? ` and coalesce(${q("status")}::text, 'open') <> 'cancelled'`
      : "";
    const sqlText = `
      select ${select.join(", ")}
      from ${q(schema)}.${q("events")}
      where ${q("date")} >= $1
      ${whereStatus}
      order by ${q("date")} asc
    `;
    const result = await pool.query(sqlText, [fromDate]);
    return result.rows || [];
  }

  private hasEventEnded(event: any): boolean {
    const eventDate = event?.date ? new Date(event.date) : null;
    if (!eventDate || !Number.isFinite(eventDate.getTime())) return false;

    const endTime = String(event?.endTime || "").trim();
    const match = endTime.match(/^(\d{1,2}):(\d{2})/);
    if (match) {
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (Number.isFinite(hour) && Number.isFinite(minute)) {
        eventDate.setHours(hour, minute, 0, 0);
      }
    } else {
      eventDate.setHours(23, 59, 59, 999);
    }

    return eventDate.getTime() < Date.now();
  }

  private async selectHostsSafe(
    whereSql: string,
    params: any[],
  ): Promise<any[]> {
    if (!pool) return [];
    const { schema, columns } = await this.getHostTableInfo();

    const has = (col: string) => columns.has(col);
    const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
    const select = [
      `${q("id")} as "id"`,
      `${q("user_id")} as "userId"`,
      `${q("business_name")} as "businessName"`,
      `${q("address")} as "address"`,
      `${has("city") ? `${q("city")} as "city"` : `null as "city"`}`,
      `${has("state") ? `${q("state")} as "state"` : `null as "state"`}`,
      `${has("latitude") ? `${q("latitude")} as "latitude"` : `null as "latitude"`}`,
      `${has("longitude") ? `${q("longitude")} as "longitude"` : `null as "longitude"`}`,
      `${
        has("location_type")
          ? `${q("location_type")} as "locationType"`
          : `'other' as "locationType"`
      }`,
      `${
        has("expected_foot_traffic")
          ? `${q("expected_foot_traffic")} as "expectedFootTraffic"`
          : `null as "expectedFootTraffic"`
      }`,
      `${has("amenities") ? `${q("amenities")} as "amenities"` : `null as "amenities"`}`,
      `${has("contact_phone") ? `${q("contact_phone")} as "contactPhone"` : `null as "contactPhone"`}`,
      `${has("notes") ? `${q("notes")} as "notes"` : `null as "notes"`}`,
      `${has("is_verified") ? `${q("is_verified")} as "isVerified"` : `false as "isVerified"`}`,
      `${has("admin_created") ? `${q("admin_created")} as "adminCreated"` : `false as "adminCreated"`}`,
      `${has("spot_count") ? `${q("spot_count")} as "spotCount"` : `1 as "spotCount"`}`,
      `${has("parking_pass_breakfast_price_cents") ? `${q("parking_pass_breakfast_price_cents")} as "parkingPassBreakfastPriceCents"` : `0 as "parkingPassBreakfastPriceCents"`}`,
      `${has("parking_pass_lunch_price_cents") ? `${q("parking_pass_lunch_price_cents")} as "parkingPassLunchPriceCents"` : `0 as "parkingPassLunchPriceCents"`}`,
      `${has("parking_pass_dinner_price_cents") ? `${q("parking_pass_dinner_price_cents")} as "parkingPassDinnerPriceCents"` : `0 as "parkingPassDinnerPriceCents"`}`,
      `${has("parking_pass_daily_price_cents") ? `${q("parking_pass_daily_price_cents")} as "parkingPassDailyPriceCents"` : `0 as "parkingPassDailyPriceCents"`}`,
      `${has("parking_pass_weekly_price_cents") ? `${q("parking_pass_weekly_price_cents")} as "parkingPassWeeklyPriceCents"` : `0 as "parkingPassWeeklyPriceCents"`}`,
      `${has("parking_pass_monthly_price_cents") ? `${q("parking_pass_monthly_price_cents")} as "parkingPassMonthlyPriceCents"` : `0 as "parkingPassMonthlyPriceCents"`}`,
      `${has("parking_pass_start_time") ? `${q("parking_pass_start_time")} as "parkingPassStartTime"` : `null as "parkingPassStartTime"`}`,
      `${has("parking_pass_end_time") ? `${q("parking_pass_end_time")} as "parkingPassEndTime"` : `null as "parkingPassEndTime"`}`,
      `${has("parking_pass_days_of_week") ? `${q("parking_pass_days_of_week")} as "parkingPassDaysOfWeek"` : `null as "parkingPassDaysOfWeek"`}`,
      `${has("stripe_connect_account_id") ? `${q("stripe_connect_account_id")} as "stripeConnectAccountId"` : `null as "stripeConnectAccountId"`}`,
      `${has("stripe_connect_status") ? `${q("stripe_connect_status")} as "stripeConnectStatus"` : `null as "stripeConnectStatus"`}`,
      `${has("stripe_onboarding_completed") ? `${q("stripe_onboarding_completed")} as "stripeOnboardingCompleted"` : `false as "stripeOnboardingCompleted"`}`,
      `${has("stripe_charges_enabled") ? `${q("stripe_charges_enabled")} as "stripeChargesEnabled"` : `false as "stripeChargesEnabled"`}`,
      `${has("stripe_payouts_enabled") ? `${q("stripe_payouts_enabled")} as "stripePayoutsEnabled"` : `false as "stripePayoutsEnabled"`}`,
      `${has("spot_image_url") ? `${q("spot_image_url")} as "spotImageUrl"` : `null as "spotImageUrl"`}`,
      `${has("created_at") ? `${q("created_at")} as "createdAt"` : `null as "createdAt"`}`,
      `${has("updated_at") ? `${q("updated_at")} as "updatedAt"` : `null as "updatedAt"`}`,
    ];

    const rawWhereSql = String(whereSql || "");
    const limitMatch = rawWhereSql.match(/\s+limit\s+\d+\s*$/i);
    const limitSql = limitMatch ? limitMatch[0] : "";
    const whereWithoutLimit = limitMatch
      ? rawWhereSql.slice(0, limitMatch.index).trimEnd()
      : rawWhereSql;
    const orderBy = has("created_at")
      ? ` order by ${q("created_at")} desc`
      : "";
    const sqlText = `select ${select.join(", ")} from ${q(schema)}.${q("hosts")} ${whereWithoutLimit}${orderBy}${limitSql}`;
    const result = await pool.query(sqlText, params);
    return result.rows || [];
  }

  private shouldAssignAffiliateTag(userType?: string | null) {
    return shouldAssignAffiliateTagForUserType(userType);
  }

  async syncParkingPassSeriesFromHost(hostId: string): Promise<string | null> {
    return this.parkingPassRepository.syncParkingPassSeriesFromHost(hostId);
  }

  async ensureDraftParkingPassesForHosts(): Promise<number> {
    return this.parkingPassRepository.ensureDraftParkingPassesForHosts();
  }

  // Host operations
  async createHost(host: InsertHost): Promise<Host> {
    const [newHost] = await db.insert(hosts).values(host).returning();
    try {
      if (newHost.city) {
        await this.ensureCityExists(newHost.city, newHost.state || null);
      }
    } catch (e) {
      console.warn("ensureCityExists failed for host", e);
    }

    // Invariant: if a host has an address, they must have a draft Parking Pass series ready to complete.
    try {
      if (newHost.address) {
        await this.ensureDraftParkingPassForHost(newHost.id);
      }
    } catch (e) {
      console.warn("ensureDraftParkingPassForHost failed for host", e);
    }
    return newHost;
  }

  async ensureDraftParkingPassForHost(hostId: string): Promise<boolean> {
    return this.parkingPassRepository.ensureDraftParkingPassForHost(hostId);
  }

  async getHost(id: string): Promise<Host | undefined> {
    try {
      const rows = await this.selectHostsSafe(`where "id" = $1 limit 1`, [id]);
      return (rows[0] as any) || undefined;
    } catch (error) {
      console.warn("getHost safe projection failed, falling back:", error);
      try {
        const [host] = await db.select().from(hosts).where(eq(hosts.id, id));
        return host;
      } catch (fallbackError) {
        console.warn("getHost fallback failed:", fallbackError);
        return undefined;
      }
    }
  }

  async getHostByUserId(userId: string): Promise<Host | undefined> {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return undefined;
    try {
      const rows = await this.selectHostsSafe(`where "user_id" = $1 limit 1`, [
        normalizedUserId,
      ]);
      return (rows[0] as any) || undefined;
    } catch (error) {
      console.warn(
        "getHostByUserId safe projection failed, falling back:",
        error,
      );
      try {
        const [host] = await db
          .select()
          .from(hosts)
          .where(eq(hosts.userId, normalizedUserId));
        return host;
      } catch (fallbackError) {
        console.warn("getHostByUserId fallback failed:", fallbackError);
        return undefined;
      }
    }
  }

  async getHostsByUserId(userId: string): Promise<Host[]> {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return [];
    try {
      return (await this.selectHostsSafe(`where "user_id" = $1`, [
        normalizedUserId,
      ])) as any;
    } catch (error) {
      console.warn(
        "getHostsByUserId safe projection failed, falling back:",
        error,
      );
      try {
        return await db
          .select()
          .from(hosts)
          .where(eq(hosts.userId, normalizedUserId))
          .orderBy(desc(hosts.createdAt));
      } catch (fallbackError) {
        console.warn("getHostsByUserId fallback failed:", fallbackError);
        return [];
      }
    }
  }

  async getHostsByIds(hostIds: string[]): Promise<Host[]> {
    const ids = Array.from(
      new Set(
        (hostIds || []).map((id) => String(id || "").trim()).filter(Boolean),
      ),
    );
    if (ids.length === 0) return [];
    try {
      return (await this.selectHostsSafe(`where "id" = any($1::text[])`, [
        ids,
      ])) as any;
    } catch {
      return await db.select().from(hosts).where(inArray(hosts.id, ids));
    }
  }

  private normalizeHostValue(value?: string | null): string {
    return (value ?? "").trim().toLowerCase();
  }

  private buildHostLocationKey(
    address?: string | null,
    city?: string | null,
    state?: string | null,
  ): string {
    return [
      this.normalizeHostValue(address),
      this.normalizeHostValue(city),
      this.normalizeHostValue(state),
    ].join("|");
  }

  async syncHostFromUserAddress(
    userId: string,
    address: UserAddress,
    previousAddress?: UserAddress,
    options?: { force?: boolean },
  ): Promise<Host | null> {
    const force = options?.force ?? false;
    const [user] = await db
      .select({ userType: users.userType })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const hostList = await this.getHostsByUserId(userId);
    if (!force && hostList.length === 0 && user?.userType !== "host") {
      return null;
    }

    const nextKey = this.buildHostLocationKey(
      address.address,
      address.city,
      address.state,
    );
    const previousKey = previousAddress
      ? this.buildHostLocationKey(
          previousAddress.address,
          previousAddress.city,
          previousAddress.state,
        )
      : null;
    const matchKey = previousKey ?? nextKey;
    const matched = hostList.find(
      (host) =>
        this.buildHostLocationKey(host.address, host.city, host.state) ===
        matchKey,
    );

    const normalizeCoord = (value?: string | null) =>
      value === null || value === undefined ? null : String(value);

    const rawLat = normalizeCoord(address.latitude);
    const rawLng = normalizeCoord(address.longitude);
    const latNum = rawLat === null ? null : Number(rawLat);
    const lngNum = rawLng === null ? null : Number(rawLng);
    const hasValidManualCoords =
      latNum !== null &&
      lngNum !== null &&
      Number.isFinite(latNum) &&
      Number.isFinite(lngNum);

    const geocodeAddress = [address.address, address.city, address.state]
      .filter(Boolean)
      .join(", ");

    const kickOffGeocode = (hostId: string) => {
      if (!geocodeAddress) return;
      // Best-effort: avoid blocking the request path on external geocoding.
      void (async () => {
        const coords = await forwardGeocode(geocodeAddress).catch(() => null);
        if (!coords) return;
        await db
          .update(hosts)
          .set({
            latitude: coords.lat.toString(),
            longitude: coords.lng.toString(),
            updatedAt: new Date(),
          })
          .where(eq(hosts.id, hostId));
      })();
    };

    if (matched) {
      const updates: Partial<typeof hosts.$inferInsert> & { updatedAt: Date } =
        {
          address: address.address,
          city: address.city,
          state: address.state,
          updatedAt: new Date(),
        };
      if (hasValidManualCoords) {
        updates.latitude = latNum!.toString();
        updates.longitude = lngNum!.toString();
      }
      if (matched.adminCreated && address.label) {
        updates.businessName = address.label;
      }
      const [updated] = await db
        .update(hosts)
        .set(updates)
        .where(eq(hosts.id, matched.id))
        .returning();
      if (!hasValidManualCoords && (!matched.latitude || !matched.longitude)) {
        kickOffGeocode(matched.id);
      }
      try {
        if (updated?.address) {
          await this.ensureDraftParkingPassForHost(updated.id);
        }
      } catch (e) {
        console.warn(
          "ensureDraftParkingPassForHost failed for updated host",
          e,
        );
      }
      return updated ?? matched;
    }

    const [created] = await db
      .insert(hosts)
      .values({
        userId,
        businessName: address.label || "Host location",
        address: address.address,
        city: address.city,
        state: address.state || null,
        latitude: hasValidManualCoords ? latNum!.toString() : null,
        longitude: hasValidManualCoords ? lngNum!.toString() : null,
        locationType: "other",
        expectedFootTraffic: null,
        amenities: null,
        contactPhone: null,
        notes: null,
        adminCreated: true,
        spotCount: 1,
        updatedAt: new Date(),
      })
      .returning();
    if (
      created &&
      !hasValidManualCoords &&
      (!created.latitude || !created.longitude)
    ) {
      kickOffGeocode(created.id);
    }
    try {
      if (created?.address) {
        await this.ensureDraftParkingPassForHost(created.id);
      }
    } catch (e) {
      console.warn("ensureDraftParkingPassForHost failed for created host", e);
    }
    return created ?? null;
  }

  async deleteHostForUserAddress(
    userId: string,
    address: UserAddress,
  ): Promise<boolean> {
    const hostList = await this.getHostsByUserId(userId);
    if (hostList.length === 0) return false;
    const key = this.buildHostLocationKey(
      address.address,
      address.city,
      address.state,
    );
    const matched = hostList.find(
      (host) =>
        host.adminCreated &&
        this.buildHostLocationKey(host.address, host.city, host.state) === key,
    );
    if (!matched) return false;
    await db.delete(hosts).where(eq(hosts.id, matched.id));
    return true;
  }

  async getAllHosts(): Promise<Host[]> {
    try {
      return (await this.selectHostsSafe("", [])) as any;
    } catch {
      return await db.select().from(hosts).orderBy(desc(hosts.createdAt));
    }
  }

  async updateHostCoordinates(
    hostId: string,
    lat: number,
    lng: number,
  ): Promise<Host> {
    const [updated] = await db
      .update(hosts)
      .set({
        latitude: lat.toString(),
        longitude: lng.toString(),
        updatedAt: new Date(),
      })
      .where(eq(hosts.id, hostId))
      .returning();
    return updated;
  }

  async getParkingPassBlackoutDates(
    seriesId: string,
  ): Promise<ParkingPassBlackoutDate[]> {
    return this.parkingPassRepository.getParkingPassBlackoutDates(seriesId);
  }

  async createParkingPassBlackoutDate(
    blackout: InsertParkingPassBlackoutDate,
  ): Promise<ParkingPassBlackoutDate> {
    return this.parkingPassRepository.createParkingPassBlackoutDate(blackout);
  }

  async deleteParkingPassBlackoutDate(
    seriesId: string,
    date: Date,
  ): Promise<void> {
    return this.parkingPassRepository.deleteParkingPassBlackoutDate(
      seriesId,
      date,
    );
  }

  async createEvent(event: InsertEvent): Promise<Event> {
    return this.hostsEventsRepository.createEvent(event);
  }

  async getEvent(id: string): Promise<Event | undefined> {
    return this.hostsEventsRepository.getEvent(id);
  }

  async getEventsByHost(
    hostId: string,
  ): Promise<(Event & { interests: EventInterest[] })[]> {
    return this.hostsEventsRepository.getEventsByHost(hostId);
  }

  async getEventsOwnedByUser(
    userId: string,
  ): Promise<(Event & { interests: EventInterest[] })[]> {
    return this.hostsEventsRepository.getEventsOwnedByUser(userId);
  }

  async getAllUpcomingEvents(): Promise<
    (Event & { host: Host; series?: EventSeries | null })[]
  > {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Use a schema-safe projection so older DBs missing newer events columns
    // (for example `coordinator_user_id`) do not break map/discovery feeds.
    const eventRows = (await this.selectUpcomingEventsSafe(today)).filter(
      (event: any) => !this.hasEventEnded(event),
    );

    const hostIds = Array.from(
      new Set<string>(
        eventRows
          .map((row: any) => String(row.hostId || "").trim())
          .filter(Boolean),
      ),
    );
    const hostRows = await this.getHostsByIds(hostIds);
    const hostById = new Map<string, Host>(
      (hostRows || []).map((host) => [host.id, host]),
    );
    const stubHost = (id: string): Host =>
      ({
        id,
        userId: "",
        businessName: "Host location",
        address: null,
        city: null,
        state: null,
        latitude: null,
        longitude: null,
        locationType: "other",
        expectedFootTraffic: null,
        amenities: null,
        contactPhone: null,
        notes: null,
        isVerified: false,
        adminCreated: false,
        spotCount: 1,
        stripeConnectAccountId: null,
        stripeConnectStatus: null,
        stripeOnboardingCompleted: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        spotImageUrl: null,
        createdAt: null as any,
        updatedAt: null as any,
      }) as any;

    return eventRows.map((event: any) => ({
      ...(event as any),
      host:
        hostById.get(String(event.hostId || "")) ??
        stubHost(String(event.hostId || "")),
      series: null,
    })) as any;
  }

  async createEventInterest(
    interest: InsertEventInterest,
  ): Promise<EventInterest> {
    return this.hostsEventsRepository.createEventInterest(interest);
  }

  async updateEventInterestStatus(
    id: string,
    status: string,
  ): Promise<EventInterest> {
    return this.hostsEventsRepository.updateEventInterestStatus(id, status);
  }

  async getEventInterest(id: string): Promise<EventInterest | undefined> {
    return this.hostsEventsRepository.getEventInterest(id);
  }

  async getEventInterestByTruckId(
    eventId: string,
    truckId: string,
  ): Promise<EventInterest | undefined> {
    return this.hostsEventsRepository.getEventInterestByTruckId(
      eventId,
      truckId,
    );
  }

  async getOpenLocationRequests(): Promise<LocationRequest[]> {
    await this.expireStaleLocationRequests();
    return await db
      .select()
      .from(locationRequests)
      .where(
        and(
          eq(locationRequests.status, "open"),
          ne(locationRequests.demandStatus, "claimed"),
        ),
      )
      .orderBy(desc(locationRequests.createdAt));
  }

  async getEventInterestsByEventId(
    eventId: string,
  ): Promise<(EventInterest & { truck: any })[]> {
    return this.hostsEventsRepository.getEventInterestsByEventId(eventId);
  }

  // Event Series (Open Calls)
  async createEventSeries(series: InsertEventSeries): Promise<EventSeries> {
    return this.hostsEventsRepository.createEventSeries(series);
  }

  async getEventSeries(id: string): Promise<EventSeries | undefined> {
    return this.hostsEventsRepository.getEventSeries(id);
  }

  async getEventSeriesByHost(hostId: string): Promise<EventSeries[]> {
    return this.hostsEventsRepository.getEventSeriesByHost(hostId);
  }

  async getEventSeriesOwnedByUser(userId: string): Promise<EventSeries[]> {
    return this.hostsEventsRepository.getEventSeriesOwnedByUser(userId);
  }

  async updateEventSeries(
    id: string,
    updates: Partial<InsertEventSeries>,
  ): Promise<EventSeries> {
    return this.hostsEventsRepository.updateEventSeries(id, updates);
  }

  async publishEventSeries(id: string): Promise<EventSeries> {
    return this.hostsEventsRepository.publishEventSeries(id);
  }

  async getEventsBySeriesId(seriesId: string): Promise<Event[]> {
    return this.hostsEventsRepository.getEventsBySeriesId(seriesId);
  }

  async createTelemetryEvent(event: InsertTelemetryEvent): Promise<void> {
    await db.insert(telemetryEvents).values(event);
  }

  // Stripe helpers
  async updateUserStripeCustomerId(
    userId: string,
    customerId: string,
  ): Promise<void> {
    return this.paymentsSubscriptionsRepository.updateUserStripeCustomerId(
      userId,
      customerId,
    );
  }

  async updateUserStripeInfo(
    id: string,
    stripeCustomerId: string,
    stripeSubscriptionId: string,
    subscriptionBillingInterval?: string,
  ): Promise<User> {
    return this.paymentsSubscriptionsRepository.updateUserStripeInfo(
      id,
      stripeCustomerId,
      stripeSubscriptionId,
      subscriptionBillingInterval,
    );
  }

  async updateUser(
    id: string,
    updates: Partial<
      Pick<
        User,
        | "subscriptionBillingInterval"
        | "stripeCustomerId"
        | "stripeSubscriptionId"
        | "passwordHash"
        | "subscriptionSignupDate"
        | "trialStartedAt"
        | "trialEndsAt"
        | "trialUsed"
        | "emailVerified"
        | "firstName"
        | "lastName"
        | "phone"
        | "email"
        | "postalCode"
        | "birthYear"
        | "gender"
        | "isActive"
        | "publicProfileSettings"
        | "accountSettings"
      >
    >,
  ): Promise<User> {
    return this.usersRepository.updateUser(id, updates);
  }

  // User operations
  // (IMPORTANT) these user operations are mandatory for authentication.
  async getUser(id: string): Promise<User | undefined> {
    return this.usersRepository.getUser(id);
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    return this.usersRepository.upsertUser(userData);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return this.usersRepository.getUserByEmail(email);
  }

  async getUserByPhone(phone: string): Promise<User | undefined> {
    return this.usersRepository.getUserByPhone(phone);
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.usersRepository.getUserById(id);
  }

  async updateUserType(
    id: string,
    userType:
      | "customer"
      | "restaurant_owner"
      | "food_truck"
      | "host"
      | "event_coordinator"
      | "staff"
      | "admin"
      | "duper_admin"
      | "super_admin",
  ): Promise<User> {
    return this.usersRepository.updateUserType(id, userType);
  }

  async getUserByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<User | undefined> {
    return this.paymentsSubscriptionsRepository.getUserByStripeCustomerId(
      stripeCustomerId,
    );
  }

  async getUserByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<User | undefined> {
    return this.paymentsSubscriptionsRepository.getUserByStripeSubscriptionId(
      stripeSubscriptionId,
    );
  }

  async upsertUserByAuth(
    authType: "google" | "email" | "facebook" | "tradescout",
    userData:
      | GoogleUserData
      | EmailUserData
      | FacebookUserData
      | TradeScoutUserData,
    userType: User["userType"] = "customer",
    appContext: "mealscout" | "tradescout" = "mealscout",
  ): Promise<User> {
    return this.usersRepository.upsertUserByAuth(
      authType,
      userData,
      userType,
      appContext,
    );
  }

  async createRestaurant(restaurant: InsertRestaurant): Promise<Restaurant> {
    return this.restaurantsDealsRepository.createRestaurant(restaurant);
  }

  async ensureCityExists(name: string, state: string | null): Promise<void> {
    const { cities } = await import("@shared/schema");
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    try {
      await db
        .insert(cities)
        .values({ name, slug, state: state || null })
        .onConflictDoNothing();
    } catch (e) {
      // ignore duplicates
    }
  }

  async getRestaurant(id: string): Promise<Restaurant | undefined> {
    return this.restaurantsDealsRepository.getRestaurant(id);
  }

  async getRestaurantsByOwner(ownerId: string): Promise<Restaurant[]> {
    return this.restaurantsDealsRepository.getRestaurantsByOwner(ownerId);
  }

  async updateRestaurant(
    id: string,
    restaurant: Partial<InsertRestaurant>,
    options?: { allowIdentityChange?: boolean },
  ): Promise<Restaurant> {
    return this.restaurantsDealsRepository.updateRestaurant(id, restaurant, options);
  }

  async getAllRestaurants(): Promise<Restaurant[]> {
    return this.restaurantsDealsRepository.getAllRestaurants();
  }

  async getNearbyRestaurants(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<Restaurant[]> {
    return this.restaurantsDealsRepository.getNearbyRestaurants(
      lat,
      lng,
      radiusKm,
    );
  }

  async getSubscribedRestaurants(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<Restaurant[]> {
    return this.restaurantsDealsRepository.getSubscribedRestaurants(
      lat,
      lng,
      radiusKm,
    );
  }

  async verifyRestaurantOwnership(
    restaurantId: string,
    userId: string,
    requiredPermission?:
      | "manageDeals"
      | "manageParkingPass"
      | "viewAnalytics"
      | "manageProfile",
  ): Promise<boolean> {
    return this.restaurantsDealsRepository.verifyRestaurantOwnership(
      restaurantId,
      userId,
      requiredPermission,
    );
  }

  async createTruckManualSchedule(
    schedule: InsertTruckManualSchedule,
  ): Promise<TruckManualSchedule> {
    const now = new Date();
    const [created] = await db
      .insert(truckManualSchedules)
      .values({
        ...schedule,
        lastConfirmedAt: now,
        updatedAt: now,
      })
      .returning();
    return created;
  }

  async getTruckManualSchedules(
    truckId: string,
  ): Promise<TruckManualSchedule[]> {
    return await db
      .select()
      .from(truckManualSchedules)
      .where(eq(truckManualSchedules.truckId, truckId))
      .orderBy(asc(truckManualSchedules.date));
  }

  async deleteTruckManualSchedule(
    scheduleId: string,
    truckId?: string,
  ): Promise<void> {
    const whereClause = truckId
      ? and(
          eq(truckManualSchedules.id, scheduleId),
          eq(truckManualSchedules.truckId, truckId),
        )
      : eq(truckManualSchedules.id, scheduleId);

    await db.delete(truckManualSchedules).where(whereClause);
  }

  async createTruckParkingReport(
    report: InsertTruckParkingReport,
  ): Promise<TruckParkingReport> {
    const updatedAt = new Date();
    const values = { ...report, updatedAt };

    if (report.bookingId) {
      const existing = await db
        .select({ id: truckParkingReports.id })
        .from(truckParkingReports)
        .where(eq(truckParkingReports.bookingId, report.bookingId))
        .limit(1);
      if (existing.length > 0) {
        const [updated] = await db
          .update(truckParkingReports)
          .set(values)
          .where(eq(truckParkingReports.id, existing[0].id))
          .returning();
        return updated;
      }
    }

    if (report.manualScheduleId) {
      const existing = await db
        .select({ id: truckParkingReports.id })
        .from(truckParkingReports)
        .where(
          eq(truckParkingReports.manualScheduleId, report.manualScheduleId),
        )
        .limit(1);
      if (existing.length > 0) {
        const [updated] = await db
          .update(truckParkingReports)
          .set(values)
          .where(eq(truckParkingReports.id, existing[0].id))
          .returning();
        return updated;
      }
    }

    const [created] = await db
      .insert(truckParkingReports)
      .values(values)
      .returning();
    return created;
  }

  async getTruckParkingReports(
    truckId: string,
    options?: { startDate?: Date; endDate?: Date },
  ): Promise<TruckParkingReport[]> {
    const whereClauses = [eq(truckParkingReports.truckId, truckId)];
    if (options?.startDate) {
      whereClauses.push(gte(truckParkingReports.date, options.startDate));
    }
    if (options?.endDate) {
      whereClauses.push(lte(truckParkingReports.date, options.endDate));
    }
    return await db
      .select()
      .from(truckParkingReports)
      .where(and(...whereClauses))
      .orderBy(desc(truckParkingReports.date));
  }

  // Deal operations
  async createDeal(deal: InsertDeal): Promise<Deal> {
    return this.restaurantsDealsRepository.createDeal(deal);
  }

  async getDeal(id: string): Promise<Deal | undefined> {
    return this.restaurantsDealsRepository.getDeal(id);
  }

  async getDealsByRestaurant(restaurantId: string): Promise<Deal[]> {
    return this.restaurantsDealsRepository.getDealsByRestaurant(restaurantId);
  }

  async updateDeal(id: string, updates: Partial<InsertDeal>): Promise<Deal> {
    return this.restaurantsDealsRepository.updateDeal(id, updates);
  }

  async deleteDeal(id: string): Promise<void> {
    return this.restaurantsDealsRepository.deleteDeal(id);
  }

  async duplicateDeal(id: string): Promise<Deal> {
    return this.restaurantsDealsRepository.duplicateDeal(id);
  }

  async getAllDeals(): Promise<Deal[]> {
    return this.restaurantsDealsRepository.getAllDeals();
  }

  async getActiveDeals(): Promise<Deal[]> {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

    const activeDealsResult = await db
      .select()
      .from(deals)
      .where(
        and(
          eq(deals.isActive, true),
          lte(deals.startDate, now),
          gte(deals.endDate, now),
          // Time window logic: handles normal hours, overnight hours, and 24/7
          sql`(
            -- 24/7 deals (always active)
            (${deals.startTime} = '00:00' AND ${deals.endTime} = '23:59')
            OR
            -- Normal time window (startTime <= endTime)
            (${deals.startTime} <= ${deals.endTime} AND ${deals.startTime} <= ${currentTime} AND ${currentTime} <= ${deals.endTime})
            OR
            -- Overnight time window (startTime > endTime)
            (${deals.startTime} > ${deals.endTime} AND (${currentTime} >= ${deals.startTime} OR ${currentTime} <= ${deals.endTime}))
          )`,
        ),
      )
      .orderBy(desc(deals.createdAt))
      .limit(50); // Limit results for better performance

    // Filter by restaurant operating hours
    return await this.filterDealsByOperatingHours(activeDealsResult);
  }

  async getFilteredDeals(
    showLimitedTimeOnly: boolean = false,
  ): Promise<Deal[]> {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

    let dealsQuery;

    if (showLimitedTimeOnly) {
      // Show only deals with specific time restrictions (not 24/7)
      dealsQuery = await db
        .select()
        .from(deals)
        .where(
          and(
            eq(deals.isActive, true),
            lte(deals.startDate, now),
            gte(deals.endDate, now),
            // Time window logic: handles normal hours and overnight hours (excludes 24/7)
            sql`(
              -- Normal time window (startTime <= endTime)
              (${deals.startTime} <= ${deals.endTime} AND ${deals.startTime} <= ${currentTime} AND ${currentTime} <= ${deals.endTime})
              OR
              -- Overnight time window (startTime > endTime)
              (${deals.startTime} > ${deals.endTime} AND (${currentTime} >= ${deals.startTime} OR ${currentTime} <= ${deals.endTime}))
            )`,
            // Exclude 24/7 deals - be more robust in detection
            sql`NOT (
              (${deals.startTime} = '00:00' AND ${deals.endTime} = '23:59')
              OR (${deals.startTime} = '00:00' AND ${deals.endTime} = '24:00')
              OR (${deals.startTime} = ${deals.endTime})
            )`,
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(200); // Increase limit to get more deals for randomization
    } else {
      // Show all currently active deals (includes time-of-day filtering)
      dealsQuery = await db
        .select()
        .from(deals)
        .where(
          and(
            eq(deals.isActive, true),
            lte(deals.startDate, now),
            gte(deals.endDate, now),
            // Apply the same time window logic as getActiveDeals
            sql`(
              -- 24/7 deals (always active)
              (${deals.startTime} = '00:00' AND ${deals.endTime} = '23:59')
              OR
              -- Normal time window (startTime <= endTime)
              (${deals.startTime} <= ${deals.endTime} AND ${deals.startTime} <= ${currentTime} AND ${currentTime} <= ${deals.endTime})
              OR
              -- Overnight time window (startTime > endTime)
              (${deals.startTime} > ${deals.endTime} AND (${currentTime} >= ${deals.startTime} OR ${currentTime} <= ${deals.endTime}))
            )`,
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(200); // Increase limit to get more deals for randomization
    }

    // Filter by restaurant operating hours
    const filteredDeals = await this.filterDealsByOperatingHours(dealsQuery);

    // Group deals by restaurant and randomly select one deal per restaurant
    return this.randomizeDealsPerRestaurant(filteredDeals);
  }

  // New method to randomly select one deal per restaurant for diverse feed display
  private randomizeDealsPerRestaurant(deals: Deal[]): Deal[] {
    const dealsByRestaurant: { [restaurantId: string]: Deal[] } = {};

    // Group deals by restaurant
    for (const deal of deals) {
      const restaurantId = deal.restaurantId;
      if (!dealsByRestaurant[restaurantId]) {
        dealsByRestaurant[restaurantId] = [];
      }
      dealsByRestaurant[restaurantId].push(deal);
    }

    // Randomly select one deal per restaurant
    const randomizedDeals: Deal[] = [];
    for (const restaurantId in dealsByRestaurant) {
      const restaurantDeals = dealsByRestaurant[restaurantId];
      const randomIndex = Math.floor(Math.random() * restaurantDeals.length);
      randomizedDeals.push(restaurantDeals[randomIndex]);
    }

    // Shuffle the final array to randomize restaurant order too
    for (let i = randomizedDeals.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [randomizedDeals[i], randomizedDeals[j]] = [
        randomizedDeals[j],
        randomizedDeals[i],
      ];
    }

    return randomizedDeals.slice(0, 50); // Limit to 50 restaurants max
  }

  // Admin specific methods
  async getAdminStats(): Promise<any> {
    const [
      activeUsers,
      totalRestaurants,
      totalRestaurantOwners,
      totalDeals,
      activeDeals,
      totalClaims,
      todayClaims,
      newUsersToday,
    ] = await Promise.all([
      db
        .select({ userType: users.userType })
        .from(users)
        .where(or(eq(users.isDisabled, false), isNull(users.isDisabled))),
      db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(restaurants)
        .where(
          and(
            eq(restaurants.isActive, true),
            or(
              eq(restaurants.isFoodTruck, false),
              isNull(restaurants.isFoodTruck),
            ),
          ),
        ),
      db
        .select({
          count: sql<number>`cast(count(distinct ${restaurants.ownerId}) as integer)`,
        })
        .from(restaurants)
        .where(
          and(
            eq(restaurants.isActive, true),
            isNotNull(restaurants.ownerId),
            or(
              eq(restaurants.isFoodTruck, false),
              isNull(restaurants.isFoodTruck),
            ),
          ),
        ),
      db.select({ count: sql<number>`cast(count(*) as integer)` }).from(deals),
      db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(deals)
        .where(eq(deals.isActive, true)),
      db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(dealClaims),
      db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(dealClaims)
        .where(
          gte(dealClaims.claimedAt, new Date(new Date().setHours(0, 0, 0, 0))),
        ),
      db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(users)
        .where(gte(users.createdAt, new Date(new Date().setHours(0, 0, 0, 0)))),
    ]);

    const memberCounts = activeUsers.reduce(
      (
        acc: {
          customer: number;
          restaurantOwner: number;
          foodTruck: number;
          host: number;
          eventCoordinator: number;
          staff: number;
          admin: number;
          duperAdmin: number;
          superAdmin: number;
          other: number;
        },
        user: typeof users.$inferSelect,
      ) => {
        const role = user.userType || "customer";
        switch (role) {
          case "customer":
            acc.customer += 1;
            break;
          case "restaurant_owner":
            acc.restaurantOwner += 1;
            break;
          case "food_truck":
            acc.foodTruck += 1;
            break;
          case "host":
            acc.host += 1;
            break;
          case "event_coordinator":
            acc.eventCoordinator += 1;
            break;
          case "staff":
            acc.staff += 1;
            break;
          case "admin":
            acc.admin += 1;
            break;
          case "duper_admin":
            acc.duperAdmin += 1;
            break;
          case "super_admin":
            acc.superAdmin += 1;
            break;
          default:
            acc.other += 1;
        }
        return acc;
      },
      {
        customer: 0,
        restaurantOwner: 0,
        foodTruck: 0,
        host: 0,
        eventCoordinator: 0,
        staff: 0,
        admin: 0,
        duperAdmin: 0,
        superAdmin: 0,
        other: 0,
      },
    );

    const totalUsersCount = activeUsers.length;
    const memberCountsTotal =
      memberCounts.customer +
      memberCounts.restaurantOwner +
      memberCounts.foodTruck +
      memberCounts.host +
      memberCounts.eventCoordinator +
      memberCounts.staff +
      memberCounts.admin +
      memberCounts.duperAdmin +
      memberCounts.superAdmin +
      memberCounts.other;

    // Approximate gross revenue from redeemed deal claims
    const revenueResult = await db
      .select({
        sum: sql<number>`coalesce(cast(sum(${dealClaims.orderAmount}) as numeric), 0)`,
      })
      .from(dealClaims)
      .where(eq(dealClaims.isUsed, true));

    const revenue = revenueResult[0]?.sum || 0;

    return {
      totalUsers: totalUsersCount,
      totalRestaurants: totalRestaurants[0]?.count || 0,
      totalRestaurantProfiles: totalRestaurants[0]?.count || 0,
      totalRestaurantOwners: totalRestaurantOwners[0]?.count || 0,
      memberCountsTotal,
      unclassifiedUsers: Math.max(0, totalUsersCount - memberCountsTotal),
      totalDeals: totalDeals[0]?.count || 0,
      activeDeals: activeDeals[0]?.count || 0,
      totalClaims: totalClaims[0]?.count || 0,
      todayClaims: todayClaims[0]?.count || 0,
      newUsersToday: newUsersToday[0]?.count || 0,
      revenue,
      memberCounts,
    };
  }

  async getPendingRestaurants(): Promise<Restaurant[]> {
    return await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.isActive, false))
      .orderBy(desc(restaurants.createdAt));
  }

  async approveRestaurant(restaurantId: string): Promise<void> {
    await db
      .update(restaurants)
      .set({ isActive: true })
      .where(eq(restaurants.id, restaurantId));
  }

  async deleteRestaurant(restaurantId: string): Promise<void> {
    await db.delete(restaurants).where(eq(restaurants.id, restaurantId));
  }

  async getAllUsers(): Promise<User[]> {
    return this.usersRepository.getAllUsers();
  }

  async updateUserStatus(userId: string, isActive: boolean): Promise<void> {
    return this.usersRepository.updateUserStatus(userId, isActive);
  }

  async createUserManually(userData: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    userType: string;
    tempPassword: string;
  }): Promise<User> {
    return this.usersRepository.createUserManually(userData);
  }

  async createUserInvite(data: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    userType:
      | "customer"
      | "restaurant_owner"
      | "food_truck"
      | "host"
      | "event_coordinator"
      | "staff"
      | "admin"
      | "duper_admin"
      | "super_admin";
  }): Promise<User> {
    return this.usersRepository.createUserInvite(data);
  }

  async createRestaurantForUser(restaurantData: {
    userId: string;
    name: string;
    address: string;
    cuisineType: string;
  }): Promise<Restaurant> {
    const [restaurant] = await db
      .insert(restaurants)
      .values({
        ownerId: restaurantData.userId,
        name: restaurantData.name,
        address: restaurantData.address,
        cuisineType: restaurantData.cuisineType,
        isActive: true,
        isVerified: true, // Admin-created restaurants are pre-verified
      })
      .returning();

    return restaurant;
  }

  async getAllDealsWithRestaurants(): Promise<any[]> {
    return await db
      .select({
        id: deals.id,
        title: deals.title,
        discountValue: deals.discountValue,
        isActive: deals.isActive,
        restaurant: {
          id: restaurants.id,
          name: restaurants.name,
        },
      })
      .from(deals)
      .leftJoin(restaurants, eq(deals.restaurantId, restaurants.id))
      .orderBy(desc(deals.createdAt));
  }

  async getNearbyDeals(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<any[]> {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5);

    const dealsQuery = await db
      .select({
        id: deals.id,
        restaurantId: deals.restaurantId,
        title: deals.title,
        description: deals.description,
        dealType: deals.dealType,
        discountValue: deals.discountValue,
        minOrderAmount: deals.minOrderAmount,
        imageUrl: deals.imageUrl,
        startDate: deals.startDate,
        endDate: deals.endDate,
        startTime: deals.startTime,
        endTime: deals.endTime,
        totalUsesLimit: deals.totalUsesLimit,
        perCustomerLimit: deals.perCustomerLimit,
        currentUses: deals.currentUses,
        isActive: deals.isActive,
        createdAt: deals.createdAt,
        updatedAt: deals.updatedAt,
        restaurant: {
          name: restaurants.name,
          cuisineType: restaurants.cuisineType,
          phone: restaurants.phone,
          latitude: restaurants.latitude,
          longitude: restaurants.longitude,
          isFoodTruck: restaurants.isFoodTruck,
          mobileOnline: restaurants.mobileOnline,
          currentLatitude: restaurants.currentLatitude,
          currentLongitude: restaurants.currentLongitude,
          lastBroadcastAt: restaurants.lastBroadcastAt,
        },
        distance: sql<number>`
          (6371 * acos(
            cos(radians(${lat})) *
            cos(radians(${restaurants.latitude})) *
            cos(radians(${restaurants.longitude}) - radians(${lng})) +
            sin(radians(${lat})) *
            sin(radians(${restaurants.latitude}))
          ))
        `.as("distance"),
      })
      .from(deals)
      .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
      .where(
        and(
          eq(deals.isActive, true),
          eq(restaurants.isActive, true),
          lte(deals.startDate, now),
          gte(deals.endDate, now),
          // Time window logic: handles normal hours, overnight hours, and 24/7
          sql`(
            -- 24/7 deals (always active)
            (${deals.startTime} = '00:00' AND ${deals.endTime} = '23:59')
            OR
            -- Normal time window (startTime <= endTime)
            (${deals.startTime} <= ${deals.endTime} AND ${deals.startTime} <= ${currentTime} AND ${currentTime} <= ${deals.endTime})
            OR
            -- Overnight time window (startTime > endTime)
            (${deals.startTime} > ${deals.endTime} AND (${currentTime} >= ${deals.startTime} OR ${currentTime} <= ${deals.endTime}))
          )`,
          sql`
            (6371 * acos(
              cos(radians(${lat})) *
              cos(radians(${restaurants.latitude})) *
              cos(radians(${restaurants.longitude}) - radians(${lng})) +
              sin(radians(${lat})) *
              sin(radians(${restaurants.latitude}))
            )) <= ${radiusKm}
          `,
        ),
      )
      .orderBy(sql`distance ASC, RANDOM()`);

    // Filter by restaurant operating hours
    return await this.filterDealsByOperatingHours(dealsQuery);
  }

  async incrementDealUses(id: string): Promise<void> {
    await db
      .update(deals)
      .set({
        currentUses: sql`${deals.currentUses} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(deals.id, id));
  }

  async deactivateUserDeals(userId: string): Promise<void> {
    // First get all restaurants owned by the user
    const userRestaurants = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.ownerId, userId));

    // Deactivate all deals for those restaurants
    if (userRestaurants.length > 0) {
      const restaurantIds = userRestaurants.map((r: any) => r.id);
      await db
        .update(deals)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(inArray(deals.restaurantId, restaurantIds));
    }
  }

  async searchDeals(filters: {
    query?: string;
    cuisineType?: string;
    minPrice?: number;
    maxPrice?: number;
    latitude?: number;
    longitude?: number;
    radius?: number;
    sortBy?: string;
  }): Promise<any[]> {
    // Start with active deals (which includes time filtering and operating hours filtering)
    let dealsResult = await this.getActiveDeals();

    // Convert to any[] type for additional filtering
    let searchResults: any[] = dealsResult.map((deal) => ({
      ...deal,
      // We'll need restaurant data for filtering, so let's fetch it
      restaurantData: null,
    }));

    // If we have filters that need restaurant data, fetch it
    const needsRestaurantData =
      filters.query ||
      filters.cuisineType ||
      (filters.latitude && filters.longitude && filters.radius);

    if (needsRestaurantData && searchResults.length > 0) {
      // Get unique restaurant IDs
      const restaurantIds = Array.from(
        new Set(searchResults.map((deal) => deal.restaurantId)),
      );

      // Fetch restaurant data
      const restaurantData = await db
        .select({
          id: restaurants.id,
          name: restaurants.name,
          address: restaurants.address,
          latitude: restaurants.latitude,
          longitude: restaurants.longitude,
          cuisineType: restaurants.cuisineType,
          isVerified: restaurants.isVerified,
        })
        .from(restaurants)
        .where(inArray(restaurants.id, restaurantIds));

      // Create restaurant lookup map
      const restaurantMap = new Map(restaurantData.map((r: any) => [r.id, r]));

      // Add restaurant data to results
      searchResults = searchResults.map((deal) => ({
        ...deal,
        restaurantData: restaurantMap.get(deal.restaurantId),
      }));
    }

    // Apply search filters
    if (filters.query && filters.query.trim()) {
      const searchTerm = filters.query.trim().toLowerCase();
      searchResults = searchResults.filter(
        (deal) =>
          deal.title.toLowerCase().includes(searchTerm) ||
          deal.description.toLowerCase().includes(searchTerm) ||
          deal.restaurantData?.name?.toLowerCase().includes(searchTerm) ||
          deal.restaurantData?.cuisineType?.toLowerCase().includes(searchTerm),
      );
    }

    // Apply cuisine type filter
    if (filters.cuisineType && filters.cuisineType.trim()) {
      const cuisineFilter = filters.cuisineType.toLowerCase();
      searchResults = searchResults.filter((deal) =>
        deal.restaurantData?.cuisineType?.toLowerCase().includes(cuisineFilter),
      );
    }

    // Apply price range filters
    if (filters.minPrice !== undefined) {
      searchResults = searchResults.filter(
        (deal) => deal.discountedPrice >= filters.minPrice!,
      );
    }
    if (filters.maxPrice !== undefined) {
      searchResults = searchResults.filter(
        (deal) => deal.discountedPrice <= filters.maxPrice!,
      );
    }

    // Apply location filtering if coordinates provided
    if (filters.latitude && filters.longitude && filters.radius) {
      searchResults = searchResults.filter((deal) => {
        const lat1 = filters.latitude!;
        const lng1 = filters.longitude!;
        const lat2 = parseFloat(deal.restaurantData?.latitude || "0");
        const lng2 = parseFloat(deal.restaurantData?.longitude || "0");

        if (lat2 === 0 || lng2 === 0) return false;

        // Calculate distance using Haversine formula
        const R = 6371; // Earth's radius in kilometers
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLng = ((lng2 - lng1) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        return distance <= filters.radius!;
      });
    }

    // Apply sorting
    if (filters.sortBy === "price-low") {
      searchResults.sort((a, b) => a.discountedPrice - b.discountedPrice);
    } else if (filters.sortBy === "price-high") {
      searchResults.sort((a, b) => b.discountedPrice - a.discountedPrice);
    } else if (filters.sortBy === "discount") {
      searchResults.sort(
        (a, b) => (b.discountPercentage || 0) - (a.discountPercentage || 0),
      );
    } else if (filters.sortBy === "date") {
      searchResults.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    } else {
      // Default relevance sort (verified restaurants first, then by creation date)
      searchResults.sort((a, b) => {
        const aVerified = a.restaurantData?.isVerified ? 1 : 0;
        const bVerified = b.restaurantData?.isVerified ? 1 : 0;
        if (aVerified !== bVerified) return bVerified - aVerified;
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      });
    }

    // Limit results for performance and remove restaurantData before returning
    const finalResults = searchResults.slice(0, 100).map((deal) => {
      const { restaurantData, ...dealWithoutRestaurantData } = deal;
      return dealWithoutRestaurantData;
    });

    return finalResults;
  }

  // Deal claim operations
  async claimDeal(claim: InsertDealClaim): Promise<DealClaim> {
    const [newClaim] = await db.insert(dealClaims).values(claim).returning();
    return newClaim;
  }

  // Claiming a deal previously read currentUses/totalUsesLimit and the
  // per-user claim count, then separately inserted the claim and
  // incremented currentUses -- two concurrent claims near the cap could
  // both pass the check before either write landed, overselling a
  // limited deal. This does the limit check and the increment as a
  // single conditional UPDATE inside a transaction, so only as many
  // claims as the deal's totalUsesLimit actually allows can ever
  // succeed, regardless of concurrent requests.
  async claimDealAtomic(
    dealId: string,
    userId: string,
    perCustomerLimit: number,
  ): Promise<
    | { ok: true; claim: DealClaim }
    | { ok: false; reason: "already_claimed" | "sold_out" }
  > {
    return await db.transaction(async (tx: any) => {
      const [existingCountRow] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(dealClaims)
        .where(and(eq(dealClaims.dealId, dealId), eq(dealClaims.userId, userId)));
      if (Number(existingCountRow?.count || 0) >= perCustomerLimit) {
        return { ok: false, reason: "already_claimed" as const };
      }

      const [reserved] = await tx
        .update(deals)
        .set({
          currentUses: sql`${deals.currentUses} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deals.id, dealId),
            or(
              isNull(deals.totalUsesLimit),
              lt(deals.currentUses, deals.totalUsesLimit),
            ),
          ),
        )
        .returning({ id: deals.id });

      if (!reserved) {
        return { ok: false, reason: "sold_out" as const };
      }

      const [newClaim] = await tx
        .insert(dealClaims)
        .values({ dealId, userId })
        .returning();
      return { ok: true, claim: newClaim };
    });
  }

  async getUserDealClaims(userId: string): Promise<DealClaim[]> {
    return await db
      .select()
      .from(dealClaims)
      .where(eq(dealClaims.userId, userId))
      .orderBy(desc(dealClaims.claimedAt));
  }

  async getUserDealClaimsWithDetails(userId: string): Promise<any[]> {
    return await db
      .select({
        id: dealClaims.id,
        dealId: dealClaims.dealId,
        claimedAt: dealClaims.claimedAt,
        usedAt: dealClaims.usedAt,
        isUsed: dealClaims.isUsed,
        orderAmount: dealClaims.orderAmount,
        dealTitle: deals.title,
        dealType: deals.dealType,
        discountValue: deals.discountValue,
        restaurantId: deals.restaurantId,
        restaurantName: restaurants.name,
      })
      .from(dealClaims)
      .innerJoin(deals, eq(dealClaims.dealId, deals.id))
      .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
      .where(eq(dealClaims.userId, userId))
      .orderBy(desc(dealClaims.claimedAt));
  }

  async getDealClaimsCount(dealId: string, userId?: string): Promise<number> {
    const conditions = [eq(dealClaims.dealId, dealId)];
    if (userId) {
      conditions.push(eq(dealClaims.userId, userId));
    }

    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(dealClaims)
      .where(and(...conditions));

    return result.count;
  }

  async getRestaurantDealClaims(
    restaurantId: string,
    status?: string,
  ): Promise<any[]> {
    const conditions = [eq(deals.restaurantId, restaurantId)];

    if (status === "pending") {
      conditions.push(isNull(dealClaims.usedAt));
    } else if (status === "used") {
      conditions.push(isNotNull(dealClaims.usedAt));
    }

    return await db
      .select({
        claimId: dealClaims.id,
        dealId: dealClaims.dealId,
        userId: dealClaims.userId,
        claimedAt: dealClaims.claimedAt,
        usedAt: dealClaims.usedAt,
        orderAmount: dealClaims.orderAmount,
        dealTitle: deals.title,
        userName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
        userEmail: users.email,
      })
      .from(dealClaims)
      .innerJoin(deals, eq(dealClaims.dealId, deals.id))
      .innerJoin(users, eq(dealClaims.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(dealClaims.claimedAt));
  }

  // Review operations
  async createReview(review: InsertReview): Promise<Review> {
    const [newReview] = await db.insert(reviews).values(review).returning();
    return newReview;
  }

  async getRestaurantReviews(restaurantId: string): Promise<any[]> {
    return await db
      .select({
        id: reviews.id,
        restaurantId: reviews.restaurantId,
        userId: reviews.userId,
        rating: reviews.rating,
        reviewText: reviews.comment,
        createdAt: reviews.createdAt,
        user: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(reviews)
      .leftJoin(users, eq(reviews.userId, users.id))
      .where(
        and(
          eq(reviews.restaurantId, restaurantId),
          or(eq(users.isDisabled, false), isNull(users.id)),
        ),
      )
      .orderBy(desc(reviews.createdAt));
  }

  // Admin operations
  async ensureAdminExists(): Promise<void> {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const syncExistingAdminPassword =
      String(process.env.ADMIN_PASSWORD_SYNC_ON_STARTUP || "").toLowerCase() ===
      "true";

    if (!adminEmail || !adminPassword) {
      console.log(
        "âš ï¸  Admin credentials not configured - skipping admin creation",
      );
      return;
    }

    try {
      // Check if admin already exists
      const existingAdmin = await this.getUserByEmail(adminEmail);

      if (existingAdmin) {
        console.log("âœ… Admin account already exists");
        // If an admin exists but the configured ADMIN_PASSWORD does not match,
        // update the stored hash to eliminate password drift between env and DB
        if (existingAdmin.passwordHash) {
          const matches = await bcrypt.compare(
            adminPassword,
            existingAdmin.passwordHash,
          );
          if (!matches) {
            if (syncExistingAdminPassword) {
              console.log(
                "ðŸ”„ Admin password sync explicitly enabled â€“ updating hash",
              );
              const newHash = await bcrypt.hash(adminPassword, 12);
              await db
                .update(users)
                .set({ passwordHash: newHash, userType: "super_admin" })
                .where(eq(users.id, existingAdmin.id));
              console.log("âœ… Admin password updated to match environment");
            } else {
              console.warn(
                "[admin] Stored password differs from ADMIN_PASSWORD; startup sync is disabled. Set ADMIN_PASSWORD_SYNC_ON_STARTUP=true only for an intentional one-time rotation.",
              );
              if (existingAdmin.userType !== "super_admin") {
                await db
                  .update(users)
                  .set({ userType: "super_admin" })
                  .where(eq(users.id, existingAdmin.id));
                console.log("âœ… Admin upgraded to super_admin");
              }
            }
          } else if (existingAdmin.userType !== "super_admin") {
            // Ensure the admin is super_admin
            await db
              .update(users)
              .set({ userType: "super_admin" })
              .where(eq(users.id, existingAdmin.id));
            console.log("âœ… Admin upgraded to super_admin");
          }
        } else {
          // If no password hash exists, set it now
          const newHash = await bcrypt.hash(adminPassword, 12);
          await db
            .update(users)
            .set({ passwordHash: newHash, userType: "super_admin" })
            .where(eq(users.id, existingAdmin.id));
          console.log("âœ… Admin password initialized from environment");
        }

        // Ensure env-configured admin can log in even if email providers are
        // not set up locally (login requires emailVerified).
        if (!existingAdmin.emailVerified) {
          await db
            .update(users)
            .set({ emailVerified: true })
            .where(eq(users.id, existingAdmin.id));
        }
        return;
      }

      // Hash the password
      const passwordHash = await bcrypt.hash(adminPassword, 12);

      // Create admin user
      const created = await this.upsertUserByAuth(
        "email",
        {
          email: adminEmail,
          firstName: "Admin",
          lastName: "User",
          phone: "+1 (555) 000-0000",
          passwordHash,
        },
        "admin",
      );

      await db
        .update(users)
        .set({ userType: "super_admin", emailVerified: true })
        .where(eq(users.id, created.id));

      console.log("âœ… Super Admin account created successfully");
    } catch (error) {
      console.error("âŒ Failed to create admin account:", error);
    }
  }

  // Seed data for development and testing
  async seedDevelopmentData(): Promise<void> {
    try {
      const seedEnabled =
        process.env.NODE_ENV === "development" &&
        String(process.env.SEED_DEV_DATA || "").toLowerCase() === "true";
      if (!seedEnabled) {
        console.log(
          "[seed] Skipping development seed. Set SEED_DEV_DATA=true (and NODE_ENV=development) to enable.",
        );
        return;
      }
      // Check if data already exists
      const existingRestaurants = await db.select().from(restaurants).limit(1);
      if (existingRestaurants.length > 0) {
        console.log("âœ… Seed data already exists");
        return;
      }

      console.log("ðŸŒ± Seeding development data...");

      // Create sample restaurant owners
      const owner1 = await this.upsertUserByAuth(
        "email",
        {
          email: "owner1@example.com",
          firstName: "Mario",
          lastName: "Rossi",
          phone: "+1 (985) 555-0001",
          passwordHash: await bcrypt.hash("password123", 10),
        },
        "restaurant_owner",
      );

      const owner2 = await this.upsertUserByAuth(
        "email",
        {
          email: "owner2@example.com",
          firstName: "Luigi",
          lastName: "Verde",
          phone: "+1 (985) 555-0002",
          passwordHash: await bcrypt.hash("password123", 10),
        },
        "restaurant_owner",
      );

      const owner3 = await this.upsertUserByAuth(
        "email",
        {
          email: "owner3@example.com",
          firstName: "Giuseppe",
          lastName: "Bianchi",
          phone: "+1 (985) 555-0003",
          passwordHash: await bcrypt.hash("password123", 10),
        },
        "restaurant_owner",
      );

      // Create sample customer
      const customer1 = await this.upsertUserByAuth(
        "email",
        {
          email: "customer@example.com",
          firstName: "John",
          lastName: "Doe",
          phone: "+1 (985) 555-0100",
          passwordHash: await bcrypt.hash("password123", 10),
        },
        "customer",
      );

      // Create additional owners for geographic diversity
      const owner4 = await this.upsertUserByAuth(
        "email",
        {
          email: "owner4@example.com",
          firstName: "Maria",
          lastName: "Garcia",
          phone: "+1 (985) 555-0004",
          passwordHash: await bcrypt.hash("password123", 10),
        },
        "restaurant_owner",
      );

      const owner5 = await this.upsertUserByAuth(
        "email",
        {
          email: "owner5@example.com",
          firstName: "David",
          lastName: "Chen",
          phone: "+1 (985) 555-0005",
          passwordHash: await bcrypt.hash("password123", 10),
        },
        "restaurant_owner",
      );

      const owner6 = await this.upsertUserByAuth(
        "email",
        {
          email: "owner6@example.com",
          firstName: "Sarah",
          lastName: "Johnson",
          phone: "+1 (985) 555-0006",
          passwordHash: await bcrypt.hash("password123", 10),
        },
        "restaurant_owner",
      );

      // Create restaurants across different US cities for testing

      // Hammond, LA (Local area)
      const restaurant1 = await this.createRestaurant({
        name: "CafÃ© du Monde Hammond",
        address: "315 W Thomas St, Hammond, LA 70401",
        city: "Hammond",
        state: "LA",
        phone: "+1 (985) 345-2233",
        cuisineType: "Cajun",
        latitude: "30.5047",
        longitude: "-90.4612",
        ownerId: owner1.id,
      });

      const restaurant2 = await this.createRestaurant({
        name: "Red Lobster Hammond",
        address: "1535 W Thomas St, Hammond, LA 70401",
        city: "Hammond",
        state: "LA",
        phone: "+1 (985) 419-1235",
        cuisineType: "Seafood",
        latitude: "30.5125",
        longitude: "-90.4897",
        ownerId: owner2.id,
      });

      // New York City
      const restaurant3 = await this.createRestaurant({
        name: "Joe's Pizza NYC",
        address: "7 Carmine St, New York, NY 10014",
        city: "New York",
        state: "NY",
        phone: "+1 (212) 366-1182",
        cuisineType: "Italian",
        latitude: "40.7303",
        longitude: "-74.0033",
        ownerId: owner3.id,
      });

      const restaurant4 = await this.createRestaurant({
        name: "Katz's Delicatessen",
        address: "205 E Houston St, New York, NY 10002",
        city: "New York",
        state: "NY",
        phone: "+1 (212) 254-2246",
        cuisineType: "Jewish",
        latitude: "40.7222",
        longitude: "-73.9876",
        ownerId: owner4.id,
      });

      // Los Angeles
      const restaurant5 = await this.createRestaurant({
        name: "In-N-Out Burger",
        address: "7009 Sunset Blvd, Hollywood, CA 90028",
        city: "Los Angeles",
        state: "CA",
        phone: "+1 (800) 786-1000",
        cuisineType: "American",
        latitude: "34.0985",
        longitude: "-118.3431",
        ownerId: owner5.id,
      });

      const restaurant6 = await this.createRestaurant({
        name: "Guelaguetza",
        address: "3014 W Olympic Blvd, Los Angeles, CA 90006",
        city: "Los Angeles",
        state: "CA",
        phone: "+1 (213) 427-0608",
        cuisineType: "Mexican",
        latitude: "34.0579",
        longitude: "-118.2951",
        ownerId: owner6.id,
      });

      // Chicago
      const restaurant7 = await this.createRestaurant({
        name: "Lou Malnati's Pizzeria",
        address: "439 N Wells St, Chicago, IL 60654",
        city: "Chicago",
        state: "IL",
        phone: "+1 (312) 828-9800",
        cuisineType: "Italian",
        latitude: "41.8906",
        longitude: "-87.6342",
        ownerId: owner1.id,
      });

      const restaurant8 = await this.createRestaurant({
        name: "Al's Beef",
        address: "1079 W Taylor St, Chicago, IL 60607",
        city: "Chicago",
        state: "IL",
        phone: "+1 (312) 226-4017",
        cuisineType: "American",
        latitude: "41.8690",
        longitude: "-87.6544",
        ownerId: owner2.id,
      });

      // Houston
      const restaurant9 = await this.createRestaurant({
        name: "The Original Ninfa's",
        address: "2704 Navigation Blvd, Houston, TX 77003",
        city: "Houston",
        state: "TX",
        phone: "+1 (713) 228-1175",
        cuisineType: "Mexican",
        latitude: "29.7469",
        longitude: "-95.3352",
        ownerId: owner3.id,
      });

      const restaurant10 = await this.createRestaurant({
        name: "Franklin Barbecue",
        address: "900 E 11th St, Austin, TX 78702",
        city: "Austin",
        state: "TX",
        phone: "+1 (512) 653-1187",
        cuisineType: "BBQ",
        latitude: "30.2669",
        longitude: "-97.7318",
        ownerId: owner4.id,
      });

      // Miami
      const restaurant11 = await this.createRestaurant({
        name: "Versailles Restaurant",
        address: "3555 SW 8th St, Miami, FL 33135",
        city: "Miami",
        state: "FL",
        phone: "+1 (305) 444-0240",
        cuisineType: "Cuban",
        latitude: "25.7654",
        longitude: "-80.2534",
        ownerId: owner5.id,
      });

      // Seattle
      const restaurant12 = await this.createRestaurant({
        name: "Pike Place Chowder",
        address: "1530 Post Alley, Seattle, WA 98101",
        city: "Seattle",
        state: "WA",
        phone: "+1 (206) 267-2537",
        cuisineType: "Seafood",
        latitude: "47.6089",
        longitude: "-122.3403",
        ownerId: owner6.id,
      });

      // Food trucks in different cities
      const foodTruck1 = await this.createRestaurant({
        name: "Louisiana Po-Boy Express",
        address: "Mobile - Hammond & Ponchatoula area",
        city: "Hammond",
        state: "LA",
        phone: "+1 (985) 662-7823",
        cuisineType: "Cajun",
        isFoodTruck: true,
        latitude: "30.5123",
        longitude: "-90.4567",
        ownerId: owner1.id,
      });

      const foodTruck2 = await this.createRestaurant({
        name: "The Halal Guys NYC",
        address: "Mobile - Manhattan area",
        city: "New York",
        state: "NY",
        phone: "+1 (347) 527-1505",
        cuisineType: "Middle Eastern",
        isFoodTruck: true,
        latitude: "40.7589",
        longitude: "-73.9851",
        ownerId: owner2.id,
      });

      const foodTruck3 = await this.createRestaurant({
        name: "Kogi BBQ Truck",
        address: "Mobile - Los Angeles area",
        city: "Los Angeles",
        state: "CA",
        phone: "+1 (323) 582-8889",
        cuisineType: "Korean",
        isFoodTruck: true,
        latitude: "34.0522",
        longitude: "-118.2437",
        ownerId: owner3.id,
      });

      // Create diverse deals across different cities and cuisines

      // Hammond, LA deals
      const deal1 = await this.createDeal({
        restaurantId: restaurant1.id,
        title: "Free Beignets with Coffee Purchase",
        description:
          "Get 3 fresh, hot beignets absolutely free when you purchase any coffee or cafÃ© au lait. Served with powdered sugar!",
        dealType: "percentage",
        discountValue: "100.00",
        minOrderAmount: "3.50",
        imageUrl:
          "https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        startTime: "06:00",
        endTime: "11:00",
        totalUsesLimit: 200,
        perCustomerLimit: 1,
        isActive: true,
      });

      const deal2 = await this.createDeal({
        restaurantId: restaurant2.id,
        title: "$5 Off Endless Shrimp",
        description:
          "Save $5 on our famous Endless Shrimp special! Choose from over 30 different shrimp preparations.",
        dealType: "fixed",
        discountValue: "5.00",
        minOrderAmount: "19.99",
        imageUrl:
          "https://images.unsplash.com/photo-1565680018434-b513d5e5fd47?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        startTime: "15:00",
        endTime: "21:00",
        totalUsesLimit: 100,
        perCustomerLimit: 1,
        isActive: true,
      });

      // NYC deals
      const deal3 = await this.createDeal({
        restaurantId: restaurant3.id,
        title: "Buy 1 Get 1 Half Off Pizza Slices",
        description:
          "Get the second pizza slice at 50% off! Valid on our famous NYC-style thin crust slices.",
        dealType: "percentage",
        discountValue: "25.00",
        minOrderAmount: "6.00",
        imageUrl:
          "https://images.unsplash.com/photo-1565299624946-b28f40a0ca4b?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000),
        startTime: "11:00",
        endTime: "23:00",
        totalUsesLimit: 150,
        perCustomerLimit: 2,
        isActive: true,
      });

      const deal4 = await this.createDeal({
        restaurantId: restaurant4.id,
        title: "Free Pickle with Pastrami Sandwich",
        description:
          "Get a complimentary full sour pickle with any pastrami sandwich order. A NYC classic!",
        dealType: "percentage",
        discountValue: "100.00",
        minOrderAmount: "18.00",
        imageUrl:
          "https://images.unsplash.com/photo-1567129937968-cdad8f07e2f8?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        startTime: "08:00",
        endTime: "22:00",
        totalUsesLimit: 300,
        perCustomerLimit: 1,
        isActive: true,
      });

      // LA deals
      const deal5 = await this.createDeal({
        restaurantId: restaurant5.id,
        title: "Animal Style Fries Upgrade",
        description:
          "Free upgrade to Animal Style fries with any Double-Double burger purchase!",
        dealType: "fixed",
        discountValue: "2.50",
        minOrderAmount: "8.00",
        imageUrl:
          "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        startTime: "10:30",
        endTime: "01:00",
        totalUsesLimit: 200,
        perCustomerLimit: 1,
        isActive: true,
      });

      const deal6 = await this.createDeal({
        restaurantId: restaurant6.id,
        title: "Free Mole Tasting",
        description:
          "Try our seven traditional moles with any entree order over $20. Discover authentic Oaxacan flavors!",
        dealType: "percentage",
        discountValue: "100.00",
        minOrderAmount: "20.00",
        imageUrl:
          "https://images.unsplash.com/photo-1565299507177-b0ac66763828?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        startTime: "17:00",
        endTime: "22:00",
        totalUsesLimit: 75,
        perCustomerLimit: 1,
        isActive: true,
      });

      // Chicago deals
      const deal7 = await this.createDeal({
        restaurantId: restaurant7.id,
        title: "20% Off Deep Dish Pizza",
        description:
          "Save 20% on our famous Chicago deep dish pizza! Made with our signature buttery crust.",
        dealType: "percentage",
        discountValue: "20.00",
        minOrderAmount: "25.00",
        imageUrl:
          "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        startTime: "11:00",
        endTime: "23:00",
        totalUsesLimit: 100,
        perCustomerLimit: 2,
        isActive: true,
      });

      const deal8 = await this.createDeal({
        restaurantId: restaurant8.id,
        title: "Free Hot Peppers with Italian Beef",
        description:
          "Get a side of our spicy giardiniera hot peppers free with any Italian beef sandwich!",
        dealType: "percentage",
        discountValue: "100.00",
        minOrderAmount: "12.00",
        imageUrl:
          "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        startTime: "10:00",
        endTime: "22:00",
        totalUsesLimit: 250,
        perCustomerLimit: 1,
        isActive: true,
      });

      // Texas deals
      const deal9 = await this.createDeal({
        restaurantId: restaurant9.id,
        title: "Happy Hour Margaritas",
        description:
          "$3 off our famous frozen margaritas during happy hour! Made with fresh lime juice.",
        dealType: "fixed",
        discountValue: "3.00",
        minOrderAmount: "8.00",
        imageUrl:
          "https://images.unsplash.com/photo-1551538827-9c037cb4f32a?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        startTime: "15:00",
        endTime: "18:00",
        totalUsesLimit: 500,
        perCustomerLimit: 2,
        isActive: true,
      });

      const deal10 = await this.createDeal({
        restaurantId: restaurant10.id,
        title: "Free Sauce with Brisket Plate",
        description:
          "Choose a complimentary sauce (Espresso BBQ, Hot, or Regular) with any brisket plate order.",
        dealType: "percentage",
        discountValue: "100.00",
        minOrderAmount: "16.00",
        imageUrl:
          "https://images.unsplash.com/photo-1544025162-d76694265947?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        startTime: "11:00",
        endTime: "21:00",
        totalUsesLimit: 200,
        perCustomerLimit: 1,
        isActive: true,
      });

      // Miami deal
      const deal11 = await this.createDeal({
        restaurantId: restaurant11.id,
        title: "Free Cuban Coffee with Breakfast",
        description:
          "Complimentary cafÃ© cubano with any breakfast order before 11 AM.",
        dealType: "percentage",
        discountValue: "100.00",
        minOrderAmount: "12.00",
        imageUrl:
          "https://images.unsplash.com/photo-1512481844049-fce44975de78?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        startTime: "07:00",
        endTime: "11:00",
        totalUsesLimit: 150,
        perCustomerLimit: 1,
        isActive: true,
      });

      // Seattle deal
      const deal12 = await this.createDeal({
        restaurantId: restaurant12.id,
        title: "25% Off Clam Chowder Friday",
        description:
          "Every Friday, save 25% on our award-winning New England clam chowder!",
        dealType: "percentage",
        discountValue: "25.00",
        minOrderAmount: "8.00",
        imageUrl:
          "https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        startTime: "11:00",
        endTime: "21:00",
        totalUsesLimit: 100,
        perCustomerLimit: 1,
        isActive: true,
      });

      // Food truck deals
      const deal13 = await this.createDeal({
        restaurantId: foodTruck1.id,
        title: "Buy 2 Po-Boys, Get 1 Free",
        description:
          "Purchase any two po-boys and get a third one free! Choose from our authentic New Orleans-style shrimp, oyster, or roast beef po-boys.",
        dealType: "percentage",
        discountValue: "33.00",
        minOrderAmount: "16.00",
        imageUrl:
          "https://images.unsplash.com/photo-1619096252214-ef06c45683e3?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000),
        startTime: "11:00",
        endTime: "19:00",
        totalUsesLimit: 75,
        perCustomerLimit: 1,
        isActive: true,
      });

      const deal14 = await this.createDeal({
        restaurantId: foodTruck2.id,
        title: "Free White Sauce with Combo",
        description:
          "Get our famous white sauce free with any combo platter! The secret recipe that made us famous.",
        dealType: "percentage",
        discountValue: "100.00",
        minOrderAmount: "10.00",
        imageUrl:
          "https://images.unsplash.com/photo-1529006557810-274b9b2fc783?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        startTime: "11:00",
        endTime: "23:00",
        totalUsesLimit: 200,
        perCustomerLimit: 1,
        isActive: true,
      });

      const deal15 = await this.createDeal({
        restaurantId: foodTruck3.id,
        title: "$2 Off Korean BBQ Tacos",
        description:
          "Save $2 on our fusion Korean BBQ tacos! Marinated bulgogi with Korean spices in warm tortillas.",
        dealType: "fixed",
        discountValue: "2.00",
        minOrderAmount: "8.00",
        imageUrl:
          "https://images.unsplash.com/photo-1565299585323-38174c4a6303?w=500",
        startDate: new Date(),
        endDate: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000),
        startTime: "11:30",
        endTime: "22:00",
        totalUsesLimit: 100,
        perCustomerLimit: 2,
        isActive: true,
      });

      // Create sample reviews across different cities
      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant1.id,
        rating: 0,
        comment:
          "Best beignets in Hammond! Just like being in New Orleans. The coffee is strong and perfect with the powdered sugar treats.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant2.id,
        rating: 0,
        comment:
          "Great seafood as always! The endless shrimp deal is amazing - so many varieties to try. Service was quick and friendly.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant3.id,
        rating: 0,
        comment:
          "Authentic NYC pizza! Thin crust perfection. The deal makes it even better - great value in the city.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant4.id,
        rating: 0,
        comment:
          "Iconic NYC deli! The pastrami sandwich is legendary. Worth the wait and every penny. A true New York experience.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant5.id,
        rating: 0,
        comment:
          "Classic LA burger joint! Fresh ingredients and the Animal Style fries are addictive. Great California vibes.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant6.id,
        rating: 0,
        comment:
          "Incredible authentic Oaxacan food! The mole varieties are amazing. Each one tells a story of traditional flavors.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant7.id,
        rating: 0,
        comment:
          "Best deep dish in Chicago! The crust is buttery perfection and loaded with cheese. A Chicago must-have!",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant8.id,
        rating: 0,
        comment:
          "True Chicago Italian beef! Messy but delicious. The juice and hot peppers make it perfect. Pure Chicago tradition.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant9.id,
        rating: 0,
        comment:
          "Great Tex-Mex in Houston! The margaritas are strong and the fajitas sizzle. Happy hour deals are fantastic.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant10.id,
        rating: 0,
        comment:
          "BBQ perfection in Austin! The brisket melts in your mouth. Worth the line - Texas BBQ at its finest.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant11.id,
        rating: 0,
        comment:
          "Authentic Cuban food in Miami! The cafÃ© cubano is perfect and the breakfast is hearty. Real Cuban flavors.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: restaurant12.id,
        rating: 0,
        comment:
          "Amazing chowder in Seattle! Creamy, rich, and full of fresh clams. Perfect for the Pacific Northwest weather.",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: foodTruck1.id,
        rating: 0,
        comment:
          "Best po-boys outside of New Orleans! The shrimp po-boy is massive and perfectly seasoned. Worth finding wherever they are!",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: foodTruck2.id,
        rating: 0,
        comment:
          "NYC street food legend! The white sauce is incredible and the chicken is perfectly seasoned. Late night favorite!",
      });

      await this.createReview({
        userId: customer1.id,
        restaurantId: foodTruck3.id,
        rating: 0,
        comment:
          "Fusion done right in LA! Korean BBQ tacos are unique and delicious. Great mix of flavors and cultures.",
      });

      // Start food truck sessions for demo
      await this.startTruckSession(foodTruck1.id, "demo-device-123", owner1.id);
      await this.startTruckSession(foodTruck2.id, "demo-device-456", owner2.id);
      await this.startTruckSession(foodTruck3.id, "demo-device-789", owner3.id);

      console.log("âœ… Development seed data created successfully");
      console.log("ðŸ“Š Created:");
      console.log("   - 6 restaurant owners (password: password123)");
      console.log(
        "   - 1 customer (customer@example.com, password: password123)",
      );
      console.log(
        "   - 15 restaurants across 8+ US cities (Hammond, NYC, LA, Chicago, Houston, Austin, Miami, Seattle)",
      );
      console.log("   - 3 food trucks in different cities");
      console.log("   - 15 diverse deals with regional cuisine specialties");
      console.log("   - 15 authentic location-specific reviews");
      console.log("   - 3 active food truck sessions");
    } catch (error) {
      console.error("âŒ Failed to seed development data:", error);
    }
  }

  // Verification operations
  async createVerificationRequest(
    verificationRequest: InsertVerificationRequest,
  ): Promise<VerificationRequest> {
    const [newRequest] = await db
      .insert(verificationRequests)
      .values(verificationRequest)
      .returning();
    return newRequest;
  }

  async getVerificationRequestsByOwner(
    ownerId: string,
  ): Promise<VerificationRequest[]> {
    return await db
      .select({
        id: verificationRequests.id,
        restaurantId: verificationRequests.restaurantId,
        status: verificationRequests.status,
        documents: verificationRequests.documents,
        submittedAt: verificationRequests.submittedAt,
        reviewedAt: verificationRequests.reviewedAt,
        reviewerId: verificationRequests.reviewerId,
        rejectionReason: verificationRequests.rejectionReason,
        createdAt: verificationRequests.createdAt,
        updatedAt: verificationRequests.updatedAt,
      })
      .from(verificationRequests)
      .innerJoin(
        restaurants,
        eq(verificationRequests.restaurantId, restaurants.id),
      )
      .where(eq(restaurants.ownerId, ownerId))
      .orderBy(desc(verificationRequests.createdAt));
  }

  async getVerificationRequests(): Promise<
    (VerificationRequest & {
      restaurant: {
        id: string;
        name: string;
        address: string;
        ownerId: string;
      };
    })[]
  > {
    return await db
      .select({
        id: verificationRequests.id,
        restaurantId: verificationRequests.restaurantId,
        status: verificationRequests.status,
        documents: verificationRequests.documents,
        submittedAt: verificationRequests.submittedAt,
        reviewedAt: verificationRequests.reviewedAt,
        reviewerId: verificationRequests.reviewerId,
        rejectionReason: verificationRequests.rejectionReason,
        createdAt: verificationRequests.createdAt,
        updatedAt: verificationRequests.updatedAt,
        restaurant: {
          id: restaurants.id,
          name: restaurants.name,
          address: restaurants.address,
          ownerId: restaurants.ownerId,
        },
      })
      .from(verificationRequests)
      .innerJoin(
        restaurants,
        eq(verificationRequests.restaurantId, restaurants.id),
      )
      .orderBy(desc(verificationRequests.submittedAt));
  }

  async approveVerificationRequest(
    id: string,
    reviewerId: string,
  ): Promise<void> {
    // Start transaction to update both tables
    await db.transaction(async (tx: any) => {
      // Update verification request status
      const [request] = await tx
        .update(verificationRequests)
        .set({
          status: "approved",
          reviewedAt: new Date(),
          reviewerId,
          updatedAt: new Date(),
        })
        .where(eq(verificationRequests.id, id))
        .returning({
          id: verificationRequests.id,
          restaurantId: verificationRequests.restaurantId,
        });

      if (!request) {
        throw new Error("Verification request not found");
      }

      // Set restaurant as verified
      await tx
        .update(restaurants)
        .set({
          isVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(restaurants.id, request.restaurantId));
    });
  }

  async rejectVerificationRequest(
    id: string,
    reviewerId: string,
    reason: string,
  ): Promise<void> {
    // Start transaction to update both tables atomically
    await db.transaction(async (tx: any) => {
      // Update verification request status
      const [request] = await tx
        .update(verificationRequests)
        .set({
          status: "rejected",
          reviewedAt: new Date(),
          reviewerId,
          rejectionReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(verificationRequests.id, id))
        .returning({
          id: verificationRequests.id,
          restaurantId: verificationRequests.restaurantId,
        });

      if (!request) {
        throw new Error("Verification request not found");
      }

      // Ensure restaurant remains unverified on rejection
      await tx
        .update(restaurants)
        .set({
          isVerified: false,
          ...buildRestaurantOrderingAuthorityRevocation(),
          updatedAt: new Date(),
        })
        .where(eq(restaurants.id, request.restaurantId));
    });
  }

  async setRestaurantVerified(
    restaurantId: string,
    isVerified: boolean,
  ): Promise<void> {
    await db
      .update(restaurants)
      .set({
        isVerified,
        ...(!isVerified ? buildRestaurantOrderingAuthorityRevocation() : {}),
        updatedAt: new Date(),
      })
      .where(eq(restaurants.id, restaurantId));
  }

  async hasPendingVerificationRequest(restaurantId: string): Promise<boolean> {
    const [request] = await db
      .select()
      .from(verificationRequests)
      .where(
        and(
          eq(verificationRequests.restaurantId, restaurantId),
          eq(verificationRequests.status, "pending"),
        ),
      )
      .limit(1);
    return !!request;
  }

  // Deal view tracking operations
  async recordDealView(view: InsertDealView): Promise<DealView> {
    return this.analyticsRepository.recordDealView(view);
  }

  async getDealViewsCount(
    dealId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<number> {
    return this.analyticsRepository.getDealViewsCount(dealId, dateRange);
  }

  async hasRecentDealView(
    dealId: string,
    userId?: string,
    sessionId?: string,
    timeWindowMs: number = 3600000,
  ): Promise<boolean> {
    return this.analyticsRepository.hasRecentDealView(
      dealId,
      userId,
      sessionId,
      timeWindowMs,
    );
  }

  // Deal claim revenue operations
  async markClaimAsUsed(
    claimId: string,
    orderAmount?: number | null,
  ): Promise<DealClaim | null> {
    return this.analyticsRepository.markClaimAsUsed(claimId, orderAmount);
  }

  async verifyRestaurantOwnershipByClaim(
    claimId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await db
      .select({
        ownerId: restaurants.ownerId,
        restaurantId: deals.restaurantId,
      })
      .from(dealClaims)
      .innerJoin(deals, eq(dealClaims.dealId, deals.id))
      .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
      .where(eq(dealClaims.id, claimId))
      .limit(1);

    if (result.length === 0) return false;
    const row = result[0];
    if (row.ownerId === userId) return true;
    return hasBusinessPermissionForRestaurant(
      userId,
      row.restaurantId,
      "manageDeals",
    );
  }

  // Advanced analytics operations
  async getRestaurantAnalyticsSummary(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ) {
    return this.analyticsRepository.getRestaurantAnalyticsSummary(
      restaurantId,
      dateRange,
    );
  }

  async getRestaurantAnalyticsTimeseries(
    restaurantId: string,
    dateRange: { start: Date; end: Date },
    interval: "day" | "week",
  ) {
    return this.analyticsRepository.getRestaurantAnalyticsTimeseries(
      restaurantId,
      dateRange,
      interval,
    );
  }

  async getRestaurantCustomerInsights(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ) {
    return this.analyticsRepository.getRestaurantCustomerInsights(
      restaurantId,
      dateRange,
    );
  }

  async getRestaurantAnalyticsExport(
    restaurantId: string,
    dateRange: { start: Date; end: Date },
  ) {
    return this.analyticsRepository.getRestaurantAnalyticsExport(
      restaurantId,
      dateRange,
    );
  }

  // Food truck operations
  async setRestaurantMobileSettings(
    restaurantId: string,
    settings: UpdateRestaurantMobileSettings,
  ): Promise<Restaurant> {
    const updateData: any = {
      ...settings,
      updatedAt: new Date(),
    };
    if (settings.mobileOnline === false) {
      updateData.liveUntilAt = null;
    } else if (settings.mobileOnline === true) {
      updateData.liveUntilAt = new Date(Date.now() + 240 * 60_000);
    }

    const [restaurant] = await db
      .update(restaurants)
      .set(updateData)
      .where(eq(restaurants.id, restaurantId))
      .returning();
    return restaurant;
  }

  async updateRestaurantLocation(
    restaurantId: string,
    location: UpdateRestaurantLocation,
  ): Promise<Restaurant> {
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(restaurants)
        .where(eq(restaurants.id, restaurantId)).for("update");
      if (!existing) throw new Error("Restaurant not found");
      const rawData = existing.rawData && typeof existing.rawData === "object"
        ? existing.rawData as Record<string, any> : {};
      const profileLocations = rawData.profileLocations && typeof rawData.profileLocations === "object"
        ? rawData.profileLocations : {};
      const isTruck = existing.isFoodTruck === true || existing.businessType === "food_truck";
      const updateData: any = {
        latitude: location.latitude.toString(),
        longitude: location.longitude.toString(),
        updatedAt: new Date(),
      };
      // A saved pin is an owner-confirmed operating location, not a live broadcast.
      // Keep any administrative address as private evidence; never label it pickup.
      if (isTruck) {
        updateData.address = location.address || "";
        updateData.rawData = {
          ...rawData,
          profileLocations: {
            ...profileLocations,
            businessAdminAddress: profileLocations.businessAdminAddress || existing.address || null,
            addressKind: "operating_location",
            customerFacingLocationSource: "owner_confirmed_operating_location",
            operatingLocationSource: "owner_confirmed_operating_location",
            savedLocationSource: location.source || "unknown",
            savedLocationAccuracy: location.accuracy ?? null,
          },
        };
      } else if (location.address !== undefined) {
        updateData.address = location.address;
      }
      if (location.city) updateData.city = location.city;
      if (location.state) updateData.state = location.state;
      const [restaurant] = await tx.update(restaurants).set(updateData)
        .where(eq(restaurants.id, restaurantId)).returning();
      return restaurant;
    });
  }

  async setRestaurantOperatingHours(
    restaurantId: string,
    operatingHours: OperatingHours,
  ): Promise<Restaurant> {
    const [restaurant] = await db
      .update(restaurants)
      .set({
        operatingHours: operatingHours as any, // JSONB field
        updatedAt: new Date(),
      })
      .where(eq(restaurants.id, restaurantId))
      .returning();
    return restaurant;
  }

  async isRestaurantOpenNow(restaurantId: string): Promise<boolean> {
    const restaurant = await this.getRestaurant(restaurantId);
    if (!restaurant || !restaurant.operatingHours) {
      return true; // Default to open if no hours set
    }

    const now = new Date();
    const currentDay = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
      now.getDay()
    ];
    const currentTime = now.getHours() * 60 + now.getMinutes(); // Convert to minutes

    const todayHours = (restaurant.operatingHours as any)?.[currentDay];
    if (!todayHours || !Array.isArray(todayHours) || todayHours.length === 0) {
      return false; // Closed if no hours for today
    }

    // Check if current time falls within any of today's time slots
    for (const timeSlot of todayHours) {
      const [openHours, openMinutes] = timeSlot.open.split(":").map(Number);
      const [closeHours, closeMinutes] = timeSlot.close.split(":").map(Number);
      const openTime = openHours * 60 + openMinutes;
      const closeTime = closeHours * 60 + closeMinutes;

      // Handle overnight hours (close time is next day)
      if (closeTime < openTime) {
        // Overnight hours: open until midnight OR after midnight until close
        if (currentTime >= openTime || currentTime < closeTime) {
          return true;
        }
      } else {
        // Regular hours: within the same day
        if (currentTime >= openTime && currentTime < closeTime) {
          return true;
        }
      }
    }

    return false; // Not within any time slot
  }

  // Helper method to filter deals by restaurant operating hours
  private async filterDealsByOperatingHours(deals: any[]): Promise<any[]> {
    if (deals.length === 0) return deals;

    // Get unique restaurant IDs to batch check operating hours
    const restaurantIds = Array.from(
      new Set(deals.map((deal) => deal.restaurantId)),
    ).filter((id) => id != null);

    // Return early if no valid restaurant IDs
    if (restaurantIds.length === 0) return deals;

    // Batch fetch restaurants with operating hours
    const restaurantsWithHours = await db
      .select({
        id: restaurants.id,
        operatingHours: restaurants.operatingHours,
      })
      .from(restaurants)
      .where(inArray(restaurants.id, restaurantIds));

    // Create a map for quick lookup
    const restaurantHoursMap = new Map(
      restaurantsWithHours.map((r: any) => [r.id, r.operatingHours]),
    );

    // Filter deals where restaurants are currently open
    const now = new Date();
    const currentDay = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
      now.getDay()
    ];
    const currentTime = now.getHours() * 60 + now.getMinutes();

    return deals.filter((deal) => {
      const operatingHours = restaurantHoursMap.get(deal.restaurantId);

      // Default to open if no hours set
      if (!operatingHours) return true;

      const todayHours = (operatingHours as any)?.[currentDay];
      if (
        !todayHours ||
        !Array.isArray(todayHours) ||
        todayHours.length === 0
      ) {
        return false; // Closed if no hours for today
      }

      // Check if current time falls within any of today's time slots
      for (const timeSlot of todayHours) {
        const [openHours, openMinutes] = timeSlot.open.split(":").map(Number);
        const [closeHours, closeMinutes] = timeSlot.close
          .split(":")
          .map(Number);
        const openTime = openHours * 60 + openMinutes;
        const closeTime = closeHours * 60 + closeMinutes;

        // Handle overnight hours (close time is next day)
        if (closeTime < openTime) {
          if (currentTime >= openTime || currentTime < closeTime) {
            return true;
          }
        } else {
          // Regular hours: within the same day
          if (currentTime >= openTime && currentTime < closeTime) {
            return true;
          }
        }
      }

      return false; // Not within any time slot
    });
  }

  async startTruckSession(
    restaurantId: string,
    deviceId: string,
    userId: string,
  ): Promise<FoodTruckSession> {
    // End any existing active session first
    await db
      .update(foodTruckSessions)
      .set({
        isActive: false,
        endedAt: new Date(),
      })
      .where(
        and(
          eq(foodTruckSessions.restaurantId, restaurantId),
          eq(foodTruckSessions.isActive, true),
        ),
      );

    // Start new session
    const [session] = await db
      .insert(foodTruckSessions)
      .values({
        restaurantId,
        deviceId,
        startedByUserId: userId,
      })
      .returning();

    // Session creation alone is not proof of a fresh GPS position. The atomic
    // location write enables sharing only after its current pin is persisted.
    return session;
  }

  async endTruckSession(restaurantId: string, userId: string): Promise<void> {
    await db
      .update(foodTruckSessions)
      .set({
        isActive: false,
        endedAt: new Date(),
      })
      .where(
        and(
          eq(foodTruckSessions.restaurantId, restaurantId),
          eq(foodTruckSessions.startedByUserId, userId),
          eq(foodTruckSessions.isActive, true),
        ),
      );

    // Update restaurant mobile status
    await db
      .update(restaurants)
      .set({
        mobileOnline: false,
        liveUntilAt: null,
        updatedAt: new Date(),
      })
      .where(eq(restaurants.id, restaurantId));
  }

  async getActiveTruckSession(
    restaurantId: string,
  ): Promise<FoodTruckSession | undefined> {
    const [session] = await db
      .select()
      .from(foodTruckSessions)
      .where(
        and(
          eq(foodTruckSessions.restaurantId, restaurantId),
          eq(foodTruckSessions.isActive, true),
        ),
      )
      .orderBy(desc(foodTruckSessions.startedAt))
      .limit(1);
    return session;
  }

  async hasRecentLocationUpdate(
    restaurantId: string,
    lat: number,
    lng: number,
    timeWindowMs: number = 10000, // 10 seconds
    distanceThreshold: number = 10, // 10 meters
  ): Promise<boolean> {
    const cutoffTime = new Date(Date.now() - timeWindowMs);

    const [recentLocation] = await db
      .select({
        latitude: foodTruckLocations.latitude,
        longitude: foodTruckLocations.longitude,
      })
      .from(foodTruckLocations)
      .where(
        and(
          eq(foodTruckLocations.restaurantId, restaurantId),
          gte(foodTruckLocations.recordedAt, cutoffTime),
        ),
      )
      .orderBy(desc(foodTruckLocations.recordedAt))
      .limit(1);

    if (!recentLocation) return false;

    // Calculate distance using Haversine formula (simplified for short distances)
    const latDiff = Math.abs(parseFloat(recentLocation.latitude) - lat);
    const lngDiff = Math.abs(parseFloat(recentLocation.longitude) - lng);
    const distanceM = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111320; // Rough conversion to meters

    return distanceM < distanceThreshold;
  }

  async upsertLiveLocation(
    location: InsertFoodTruckLocation,
    options?: { liveUntilAt?: Date | null },
  ): Promise<FoodTruckLocation> {
    const source = location.source;
    if (source !== "gps") {
      throw new Error("Live sharing requires device GPS. Confirm a manual service stop instead.");
    }
    return db.transaction(async (tx) => {
      // Serialize updates for one truck and commit history + current pin together.
      const [restaurant] = await tx.select({ id: restaurants.id }).from(restaurants)
        .where(eq(restaurants.id, location.restaurantId)).for("update");
      if (!restaurant) throw new Error("Restaurant not found");
      const now = new Date();
      const [recent] = await tx.select().from(foodTruckLocations)
        .where(and(eq(foodTruckLocations.restaurantId, location.restaurantId),
          gte(foodTruckLocations.recordedAt, new Date(now.getTime() - 10000))))
        .orderBy(desc(foodTruckLocations.recordedAt)).limit(1);
      const duplicate = recent && Math.hypot(Number(recent.latitude) - location.latitude,
        Number(recent.longitude) - location.longitude) * 111320 < 10;
      const [activeSession] = await tx.select().from(foodTruckSessions)
        .where(and(eq(foodTruckSessions.restaurantId, location.restaurantId),
          eq(foodTruckSessions.isActive, true))).limit(1);
      const values = {
        restaurantId: location.restaurantId,
        latitude: location.latitude.toString(),
        longitude: location.longitude.toString(),
        sessionId: activeSession?.id,
        source,
        accuracy: location.accuracy === undefined ? null : location.accuracy.toString(),
        heading: location.heading === undefined ? null : location.heading.toString(),
        speed: location.speed === undefined ? null : location.speed.toString(),
        recordedAt: now,
      };
      const [accepted] = duplicate
        ? await tx.update(foodTruckLocations).set(values).where(eq(foodTruckLocations.id, recent.id)).returning()
        : await tx.insert(foodTruckLocations).values(values).returning();
      await tx.update(restaurants).set({
        currentLatitude: location.latitude.toString(),
        currentLongitude: location.longitude.toString(),
        mobileOnline: true,
        lastBroadcastAt: now,
        liveUntilAt: options?.liveUntilAt !== undefined ? options.liveUntilAt
          : new Date(now.getTime() + 240 * 60_000),
        updatedAt: now,
      }).where(eq(restaurants.id, location.restaurantId));
      return accepted;
    });
  }

  async getLiveTrucksNearby(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<
    Array<
      Restaurant & {
        distance: number;
        distanceMiles: number;
        lat: number | null;
        lng: number | null;
        liveBroadcasting: boolean;
        locationSource: "live";
        sessionId?: string;
      }
    >
  > {
    const staleMinutesRaw = Number(process.env.LIVE_TRUCK_STALE_MINUTES || 240);
    const staleMinutes = Number.isFinite(staleMinutesRaw)
      ? Math.min(240, Math.max(5, staleMinutesRaw))
      : 240;
    const freshnessMs = staleMinutes * 60_000;

    // Simple query first - just return food trucks with valid locations
    const results = await db
      .select({
        id: restaurants.id,
        ownerId: restaurants.ownerId,
        name: restaurants.name,
        address: restaurants.address,
        phone: restaurants.phone,
        businessType: restaurants.businessType,
        cuisineType: restaurants.cuisineType,
        promoCode: restaurants.promoCode,
        latitude: restaurants.latitude,
        longitude: restaurants.longitude,
        isFoodTruck: restaurants.isFoodTruck,
        mobileOnline: restaurants.mobileOnline,
        currentLatitude: restaurants.currentLatitude,
        currentLongitude: restaurants.currentLongitude,
        lastBroadcastAt: restaurants.lastBroadcastAt,
        liveUntilAt: restaurants.liveUntilAt,
        gpsAccuracy: sql<string | null>`(select accuracy from food_truck_locations where restaurant_id = ${restaurants.id} order by recorded_at desc limit 1)`,
        liveLocationSource: sql<string>`coalesce((select source from food_truck_locations where restaurant_id = ${restaurants.id} order by recorded_at desc limit 1), 'unknown')`,
        operatingHours: restaurants.operatingHours,
        isActive: restaurants.isActive,
        isVerified: restaurants.isVerified,
        createdAt: restaurants.createdAt,
        updatedAt: restaurants.updatedAt,
        logoUrl: restaurants.logoUrl,
        coverImageUrl: restaurants.coverImageUrl,
        city: restaurants.city,
        state: restaurants.state,
        description: restaurants.description,
        sessionId: foodTruckSessions.id,
      })
      .from(restaurants)
      .leftJoin(
        foodTruckSessions,
        and(
          eq(restaurants.id, foodTruckSessions.restaurantId),
          eq(foodTruckSessions.isActive, true),
        ),
      )
      .where(
        and(
          eq(restaurants.isFoodTruck, true),
          eq(restaurants.mobileOnline, true),
          eq(restaurants.isActive, true),
          sql`current_latitude IS NOT NULL`,
          sql`current_longitude IS NOT NULL`,
        ),
      );
    const visibleResults = results.filter((truck: any) =>
      isPublicBusinessVisible(truck),
    );
    const freshResults = visibleResults
      .map((truck: any): { truck: any; presence: TruckPresence } => ({
        truck,
        presence: deriveTruckPresence(
          {
            mobileOnline: truck.mobileOnline,
            currentLatitude: truck.currentLatitude,
            currentLongitude: truck.currentLongitude,
            lastBroadcastAt: truck.lastBroadcastAt,
            liveUntilAt: truck.liveUntilAt,
            locationSource: truck.liveLocationSource || "unknown",
            gpsAccuracy: truck.gpsAccuracy,
          },
          { freshnessMs },
        ),
      }))
      .filter(
        ({ presence }: { truck: any; presence: TruckPresence }) =>
          presence.broadcastState === "live",
      );

    // Calculate distance in JavaScript for now (simpler than complex SQL)
    const trucksWithDistance = freshResults.map(
      ({ truck, presence }: { truck: any; presence: TruckPresence }) => {
        const truckLat = presence.location!.latitude;
        const truckLng = presence.location!.longitude;

        // Haversine formula for distance calculation
        const R = 6371; // Earth's radius in kilometers
        const dLat = ((truckLat - lat) * Math.PI) / 180;
        const dLng = ((truckLng - lng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((lat * Math.PI) / 180) *
            Math.cos((truckLat * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        return {
          ...truck,
          distance,
          distanceMiles: distance * 0.621371,
          lat: truckLat,
          lng: truckLng,
          liveBroadcasting: true,
          locationSource: "live" as const,
          sessionId: truck.sessionId || undefined,
        };
      },
    );

    // Filter by radius and sort by distance
    return trucksWithDistance
      .filter((truck: any) => truck.distance <= radiusKm)
      .sort((a: any, b: any) => a.distance - b.distance);
  }

  async getTruckLocationHistory(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<FoodTruckLocation[]> {
    const conditions = [eq(foodTruckLocations.restaurantId, restaurantId)];

    if (dateRange) {
      conditions.push(gte(foodTruckLocations.recordedAt, dateRange.start));
      conditions.push(lte(foodTruckLocations.recordedAt, dateRange.end));
    }

    const locations = await db
      .select()
      .from(foodTruckLocations)
      .where(and(...conditions))
      .orderBy(desc(foodTruckLocations.recordedAt))
      .limit(1000); // Reasonable limit to prevent huge responses

    return locations;
  }
  // Restaurant favorites operations
  async createRestaurantFavorite(favorite: {
    restaurantId: string;
    userId: string;
  }): Promise<RestaurantFavorite> {
    const [result] = await db
      .insert(restaurantFavorites)
      .values(favorite)
      .returning();
    return result;
  }

  async removeRestaurantFavorite(
    restaurantId: string,
    userId: string,
  ): Promise<void> {
    await db
      .delete(restaurantFavorites)
      .where(
        and(
          eq(restaurantFavorites.restaurantId, restaurantId),
          eq(restaurantFavorites.userId, userId),
        ),
      );
  }

  async getUserRestaurantFavorites(
    userId: string,
  ): Promise<(RestaurantFavorite & { restaurant: Restaurant })[]> {
    const result = await db
      .select({
        id: restaurantFavorites.id,
        restaurantId: restaurantFavorites.restaurantId,
        userId: restaurantFavorites.userId,
        favoritedAt: restaurantFavorites.favoritedAt,
        createdAt: restaurantFavorites.createdAt,
        restaurant: restaurants,
      })
      .from(restaurantFavorites)
      .innerJoin(
        restaurants,
        eq(restaurantFavorites.restaurantId, restaurants.id),
      )
      .where(eq(restaurantFavorites.userId, userId))
      .orderBy(desc(restaurantFavorites.favoritedAt));

    return result;
  }

  async getUserRestaurantFavoritesCount(userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(restaurantFavorites)
      .where(eq(restaurantFavorites.userId, userId));
    return result[0]?.count ?? 0;
  }

  async createRestaurantFollow(follow: {
    restaurantId: string;
    userId: string;
  }): Promise<RestaurantFollow> {
    const [result] = await db
      .insert(restaurantFollows)
      .values(follow)
      .returning();
    return result;
  }

  async getRestaurantFollowReceipt(
    restaurantId: string,
    userId: string,
  ): Promise<RestaurantFollow | null> {
    const [result] = await db
      .select()
      .from(restaurantFollows)
      .where(
        and(
          eq(restaurantFollows.restaurantId, restaurantId),
          eq(restaurantFollows.userId, userId),
        ),
      )
      .limit(1);
    return result || null;
  }

  async removeRestaurantFollow(
    restaurantId: string,
    userId: string,
  ): Promise<void> {
    await db
      .delete(restaurantFollows)
      .where(
        and(
          eq(restaurantFollows.restaurantId, restaurantId),
          eq(restaurantFollows.userId, userId),
        ),
      );
  }

  async getUserRestaurantFollows(
    userId: string,
  ): Promise<(RestaurantFollow & { restaurant: Restaurant })[]> {
    const result = await db
      .select({
        id: restaurantFollows.id,
        restaurantId: restaurantFollows.restaurantId,
        userId: restaurantFollows.userId,
        followedAt: restaurantFollows.followedAt,
        createdAt: restaurantFollows.createdAt,
        restaurant: restaurants,
      })
      .from(restaurantFollows)
      .innerJoin(
        restaurants,
        eq(restaurantFollows.restaurantId, restaurants.id),
      )
      .where(eq(restaurantFollows.userId, userId))
      .orderBy(desc(restaurantFollows.followedAt));

    return result;
  }

  async createRestaurantUserRecommendation(recommendation: {
    restaurantId: string;
    userId: string;
  }): Promise<RestaurantUserRecommendation> {
    const [result] = await db
      .insert(restaurantUserRecommendations)
      .values(recommendation)
      .returning();
    return result;
  }

  async setRestaurantUserRecommendationQuickReview(
    id: string,
    scores: {
      food: number | null;
      value: number | null;
      speed: number | null;
      vibe: number | null;
    },
  ): Promise<void> {
    await db
      .update(restaurantUserRecommendations)
      .set({
        foodScore: scores.food,
        valueScore: scores.value,
        speedScore: scores.speed,
        vibeScore: scores.vibe,
      })
      .where(eq(restaurantUserRecommendations.id, id));
  }

  async getUserRestaurantRecommendations(
    userId: string,
  ): Promise<(RestaurantUserRecommendation & { restaurant: Restaurant })[]> {
    const result = await db
      .select({
        id: restaurantUserRecommendations.id,
        restaurantId: restaurantUserRecommendations.restaurantId,
        userId: restaurantUserRecommendations.userId,
        recommendedAt: restaurantUserRecommendations.recommendedAt,
        createdAt: restaurantUserRecommendations.createdAt,
        restaurant: restaurants,
      })
      .from(restaurantUserRecommendations)
      .innerJoin(
        restaurants,
        eq(restaurantUserRecommendations.restaurantId, restaurants.id),
      )
      .where(eq(restaurantUserRecommendations.userId, userId))
      .orderBy(desc(restaurantUserRecommendations.recommendedAt));

    return result;
  }

  async getRestaurantFavoritesAnalytics(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ) {
    return this.analyticsRepository.getRestaurantFavoritesAnalytics(
      restaurantId,
      dateRange,
    );
  }

  // Restaurant recommendations operations
  async trackRestaurantRecommendation(recommendation: {
    restaurantId: string;
    userId?: string;
    sessionId: string;
    recommendationType: "homepage" | "search" | "nearby" | "personalized";
    recommendationContext?: string;
  }): Promise<RestaurantRecommendation> {
    return this.analyticsRepository.trackRestaurantRecommendation(
      recommendation,
    );
  }

  async markRecommendationClicked(recommendationId: string): Promise<void> {
    return this.analyticsRepository.markRecommendationClicked(recommendationId);
  }

  async getRestaurantRecommendationsAnalytics(
    restaurantId: string,
    dateRange?: { start: Date; end: Date },
  ) {
    return this.analyticsRepository.getRestaurantRecommendationsAnalytics(
      restaurantId,
      dateRange,
    );
  }

  // Host location request operations
  async createLocationRequest(
    request: InsertLocationRequest,
  ): Promise<LocationRequest> {
    const payload = {
      ...request,
      status: "open",
      demandStatus: "collecting",
      minInterestedTrucks: Math.max(
        1,
        Math.min(20, Number(request.minInterestedTrucks ?? 3) || 3),
      ),
      notes: request.notes?.trim() || null,
    };

    await this.expireStaleLocationRequests();

    const [created] = await db
      .insert(locationRequests)
      .values(payload)
      .returning();

    return created;
  }

  async getLocationRequestById(
    id: string,
  ): Promise<LocationRequest | undefined> {
    const [request] = await db
      .select()
      .from(locationRequests)
      .where(eq(locationRequests.id, id));
    return request;
  }

  async expireStaleLocationRequests(): Promise<number> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await db
      .update(locationRequests)
      .set({ status: "expired" })
      .where(
        and(
          eq(locationRequests.status, "open"),
          lte(locationRequests.createdAt, cutoff),
        ),
      );
    return result.rowCount || 0;
  }

  async createTruckInterest(interest: InsertTruckInterest): Promise<{
    interestId: string;
    locationRequest: LocationRequest;
    interestCount: number;
    minInterestedTrucks: number;
    thresholdReached: boolean;
    thresholdJustReached: boolean;
  }> {
    await this.expireStaleLocationRequests();

    const locationRequest = await this.getLocationRequestById(
      interest.locationRequestId,
    );
    if (!locationRequest) {
      throw new Error("Location request not found");
    }
    if (locationRequest.status !== "open") {
      throw new Error("Location request is not open");
    }

    try {
      return await db.transaction(async (tx: any) => {
        const [created] = await tx
          .insert(truckInterests)
          .values({
            ...interest,
            message: interest.message?.trim() || null,
          })
          .returning({ id: truckInterests.id });

        const [countRow] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(truckInterests)
          .where(
            eq(truckInterests.locationRequestId, interest.locationRequestId),
          );
        const interestCount = Number(countRow?.count ?? 0);
        const minInterestedTrucks = Math.max(
          1,
          Number(locationRequest.minInterestedTrucks ?? 3) || 3,
        );
        const thresholdReached = interestCount >= minInterestedTrucks;
        const thresholdJustReached =
          thresholdReached &&
          !locationRequest.thresholdReachedAt &&
          locationRequest.demandStatus !== "threshold_met";

        if (thresholdReached) {
          await tx
            .update(locationRequests)
            .set({
              demandStatus: "threshold_met",
              thresholdReachedAt:
                locationRequest.thresholdReachedAt || new Date(),
            })
            .where(
              and(
                eq(locationRequests.id, interest.locationRequestId),
                eq(locationRequests.status, "open"),
              ),
            );
        }

        const [updatedLocation] = await tx
          .select()
          .from(locationRequests)
          .where(eq(locationRequests.id, interest.locationRequestId));

        return {
          interestId: created.id,
          locationRequest: updatedLocation || locationRequest,
          interestCount,
          minInterestedTrucks,
          thresholdReached,
          thresholdJustReached,
        };
      });
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new Error("Truck already interested");
      }
      throw error;
    }
  }

  async getLocationDemandQueue(limit = 100): Promise<
    Array<
      LocationRequest & {
        interestCount: number;
        thresholdRemaining: number;
      }
    >
  > {
    await this.expireStaleLocationRequests();

    const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
    const rows = await db
      .select({
        request: locationRequests,
        interestCount: sql<number>`count(${truckInterests.id})`,
      })
      .from(locationRequests)
      .leftJoin(
        truckInterests,
        eq(truckInterests.locationRequestId, locationRequests.id),
      )
      .where(
        and(
          eq(locationRequests.status, "open"),
          or(
            eq(locationRequests.demandStatus, "collecting"),
            eq(locationRequests.demandStatus, "threshold_met"),
          ),
        ),
      )
      .groupBy(locationRequests.id)
      .orderBy(
        desc(locationRequests.thresholdReachedAt),
        desc(sql`count(${truckInterests.id})`),
        desc(locationRequests.createdAt),
      )
      .limit(safeLimit);

    return rows.map((row: (typeof rows)[number]) => {
      const interestCount = Number(row.interestCount ?? 0);
      const minInterestedTrucks = Math.max(
        1,
        Number(row.request.minInterestedTrucks ?? 3) || 3,
      );
      return {
        ...row.request,
        interestCount,
        thresholdRemaining: Math.max(0, minInterestedTrucks - interestCount),
      };
    });
  }

  async getLocationDemandQueueByUser(
    userId: string,
    limit = 100,
  ): Promise<
    Array<
      LocationRequest & {
        interestCount: number;
        thresholdRemaining: number;
      }
    >
  > {
    await this.expireStaleLocationRequests();
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return [];

    const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
    const rows = await db
      .select({
        request: locationRequests,
        interestCount: sql<number>`count(${truckInterests.id})`,
      })
      .from(locationRequests)
      .leftJoin(
        truckInterests,
        eq(truckInterests.locationRequestId, locationRequests.id),
      )
      .where(eq(locationRequests.postedByUserId, normalizedUserId))
      .groupBy(locationRequests.id)
      .orderBy(
        desc(locationRequests.thresholdReachedAt),
        desc(sql`count(${truckInterests.id})`),
        desc(locationRequests.createdAt),
      )
      .limit(safeLimit);

    return rows.map((row: (typeof rows)[number]) => {
      const interestCount = Number(row.interestCount ?? 0);
      const minInterestedTrucks = Math.max(
        1,
        Number(row.request.minInterestedTrucks ?? 3) || 3,
      );
      return {
        ...row.request,
        interestCount,
        thresholdRemaining: Math.max(0, minInterestedTrucks - interestCount),
      };
    });
  }

  async createHostLocationClaim(
    claim: InsertHostLocationClaim,
  ): Promise<HostLocationClaim> {
    const [created] = await db
      .insert(hostLocationClaims)
      .values({
        ...claim,
        message: claim.message?.trim() || null,
      })
      .returning();

    await db
      .update(locationRequests)
      .set({ demandStatus: "claimed" })
      .where(
        and(
          eq(locationRequests.id, claim.locationRequestId),
          eq(locationRequests.status, "open"),
        ),
      );

    return created;
  }

  async convertHostLocationClaim(
    claimId: string,
    hostId: string,
    claimingUserId: string,
  ): Promise<void> {
    await db.transaction(async (tx: any) => {
      const [claim] = await tx
        .select()
        .from(hostLocationClaims)
        .where(
          and(
            eq(hostLocationClaims.id, claimId),
            eq(hostLocationClaims.claimedByUserId, claimingUserId),
          ),
        );
      if (!claim) {
        throw new Error("Host location claim not found");
      }

      await tx
        .update(hostLocationClaims)
        .set({
          status: "converted",
          hostId,
          resolvedAt: new Date(),
        })
        .where(eq(hostLocationClaims.id, claimId));

      await tx
        .update(locationRequests)
        .set({
          status: "fulfilled",
          demandStatus: "fulfilled",
        })
        .where(eq(locationRequests.id, claim.locationRequestId));
    });
  }

  // User address operations
  async createUserAddress(address: InsertUserAddress): Promise<UserAddress> {
    const addressData: any = { ...address };

    // Convert numeric latitude/longitude to strings if present
    if (typeof addressData.latitude === "number") {
      addressData.latitude = addressData.latitude.toString();
    }
    if (typeof addressData.longitude === "number") {
      addressData.longitude = addressData.longitude.toString();
    }

    const [createdAddress] = await db
      .insert(userAddresses)
      .values([addressData])
      .returning();
    return createdAddress;
  }

  async getUserAddresses(userId: string): Promise<UserAddress[]> {
    return await db
      .select()
      .from(userAddresses)
      .where(eq(userAddresses.userId, userId))
      .orderBy(desc(userAddresses.isDefault), asc(userAddresses.createdAt));
  }

  async getUserAddress(id: string): Promise<UserAddress | undefined> {
    const [address] = await db
      .select()
      .from(userAddresses)
      .where(eq(userAddresses.id, id));
    return address;
  }

  async updateUserAddress(
    id: string,
    address: Partial<InsertUserAddress>,
  ): Promise<UserAddress> {
    const updateData: any = {
      ...address,
      updatedAt: new Date(),
    };

    // Convert numeric latitude/longitude to strings if present
    if (typeof updateData.latitude === "number") {
      updateData.latitude = updateData.latitude.toString();
    }
    if (typeof updateData.longitude === "number") {
      updateData.longitude = updateData.longitude.toString();
    }

    const [updatedAddress] = await db
      .update(userAddresses)
      .set(updateData)
      .where(eq(userAddresses.id, id))
      .returning();
    return updatedAddress;
  }

  async deleteUserAddress(id: string): Promise<void> {
    await db.delete(userAddresses).where(eq(userAddresses.id, id));
  }

  async setDefaultAddress(userId: string, addressId: string): Promise<void> {
    // Use transaction to prevent race conditions where multiple addresses could be set as default
    await db.transaction(async (tx: any) => {
      // First, unset all default addresses for the user
      await tx
        .update(userAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(userAddresses.userId, userId));

      // Then set the specified address as default
      await tx
        .update(userAddresses)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(
          and(
            eq(userAddresses.id, addressId),
            eq(userAddresses.userId, userId),
          ),
        );
    });
  }

  async deleteUser(userId: string): Promise<void> {
    // Protect super admin email from being deleted
    const SUPER_ADMIN_EMAIL =
      process.env.ADMIN_EMAIL || "info.mealscout@gmail.com";
    const user = await this.getUser(userId);
    if (user?.email === SUPER_ADMIN_EMAIL) {
      throw new Error("Cannot delete super admin account");
    }

    const deletedEmail = `deleted+${userId}@mealscout.invalid`;
    await db
      .update(users)
      .set({
        isDisabled: true,
        email: deletedEmail,
        firstName: null,
        lastName: null,
        phone: null,
        passwordHash: null,
        facebookId: null,
        facebookAccessToken: null,
        googleId: null,
        googleAccessToken: null,
        tradescoutId: null,
        profileImageUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  // Password reset token operations
  async createPasswordResetToken(
    tokenData: InsertPasswordResetToken,
  ): Promise<PasswordResetToken> {
    return this.authTokensRepository.createPasswordResetToken(tokenData);
  }

  async getPasswordResetToken(
    id: string,
  ): Promise<PasswordResetToken | undefined> {
    return this.authTokensRepository.getPasswordResetToken(id);
  }

  async getPasswordResetTokenByTokenHash(
    tokenHash: string,
  ): Promise<PasswordResetToken | undefined> {
    return this.authTokensRepository.getPasswordResetTokenByTokenHash(
      tokenHash,
    );
  }

  async markPasswordResetTokenUsed(id: string): Promise<PasswordResetToken> {
    return this.authTokensRepository.markPasswordResetTokenUsed(id);
  }

  async deleteUserResetTokens(userId: string): Promise<void> {
    return this.authTokensRepository.deleteUserResetTokens(userId);
  }

  async deleteExpiredResetTokens(): Promise<number> {
    return this.authTokensRepository.deleteExpiredResetTokens();
  }

  async createPhoneVerificationToken(
    tokenData: InsertPhoneVerificationToken,
  ): Promise<PhoneVerificationToken> {
    return this.authTokensRepository.createPhoneVerificationToken(tokenData);
  }

  async getPhoneVerificationTokenByHash(
    phone: string,
    tokenHash: string,
  ): Promise<PhoneVerificationToken | undefined> {
    return this.authTokensRepository.getPhoneVerificationTokenByHash(
      phone,
      tokenHash,
    );
  }

  async markPhoneVerificationTokenUsed(
    id: string,
  ): Promise<PhoneVerificationToken> {
    return this.authTokensRepository.markPhoneVerificationTokenUsed(id);
  }

  async deletePhoneVerificationTokens(phone: string): Promise<void> {
    return this.authTokensRepository.deletePhoneVerificationTokens(phone);
  }

  async deleteExpiredPhoneVerificationTokens(): Promise<number> {
    return this.authTokensRepository.deleteExpiredPhoneVerificationTokens();
  }

  // Account setup token operations
  async createAccountSetupToken(
    tokenData: InsertAccountSetupToken,
  ): Promise<AccountSetupToken> {
    return this.authTokensRepository.createAccountSetupToken(tokenData);
  }

  async getAccountSetupToken(
    id: string,
  ): Promise<AccountSetupToken | undefined> {
    return this.authTokensRepository.getAccountSetupToken(id);
  }

  async getAccountSetupTokenByTokenHash(
    tokenHash: string,
  ): Promise<AccountSetupToken | undefined> {
    return this.authTokensRepository.getAccountSetupTokenByTokenHash(tokenHash);
  }

  async markAccountSetupTokenUsed(id: string): Promise<AccountSetupToken> {
    return this.authTokensRepository.markAccountSetupTokenUsed(id);
  }

  async deleteAccountSetupToken(id: string): Promise<void> {
    return this.authTokensRepository.deleteAccountSetupToken(id);
  }

  async deleteUserSetupTokens(userId: string): Promise<void> {
    return this.authTokensRepository.deleteUserSetupTokens(userId);
  }

  async deleteExpiredSetupTokens(): Promise<number> {
    return this.authTokensRepository.deleteExpiredSetupTokens();
  }

  // Email verification token operations
  async createEmailVerificationToken(
    tokenData: InsertEmailVerificationToken,
  ): Promise<EmailVerificationToken> {
    return this.authTokensRepository.createEmailVerificationToken(tokenData);
  }

  async getEmailVerificationTokenByTokenHash(
    tokenHash: string,
  ): Promise<EmailVerificationToken | undefined> {
    return this.authTokensRepository.getEmailVerificationTokenByTokenHash(
      tokenHash,
    );
  }

  async markEmailVerificationTokenUsed(
    id: string,
  ): Promise<EmailVerificationToken> {
    return this.authTokensRepository.markEmailVerificationTokenUsed(id);
  }

  // API Key operations
  async getActiveApiKeys(): Promise<any[]> {
    return this.authTokensRepository.getActiveApiKeys();
  }

  async updateApiKeyLastUsed(keyId: string): Promise<void> {
    return this.authTokensRepository.updateApiKeyLastUsed(keyId);
  }

  // Deal feedback operations
  async createDealFeedback(
    feedback: InsertDealFeedback,
  ): Promise<DealFeedback> {
    const [createdFeedback] = await db
      .insert(dealFeedback)
      .values(feedback)
      .returning();
    return createdFeedback;
  }

  async getDealFeedback(dealId: string): Promise<DealFeedback[]> {
    return await db
      .select()
      .from(dealFeedback)
      .where(eq(dealFeedback.dealId, dealId))
      .orderBy(desc(dealFeedback.createdAt));
  }

  async getUserDealFeedback(userId: string): Promise<DealFeedback[]> {
    return await db
      .select()
      .from(dealFeedback)
      .where(eq(dealFeedback.userId, userId))
      .orderBy(desc(dealFeedback.createdAt));
  }

  async getDealFeedbackStats(dealId: string): Promise<{
    totalFeedback: number;
  }> {
    const feedback = await db
      .select()
      .from(dealFeedback)
      .where(eq(dealFeedback.dealId, dealId));

    const totalFeedback = feedback.length;

    return {
      totalFeedback,
    };
  }

  // ============================================
  // Staff Management Functions
  // ============================================

  async getUsersByRole(role: string): Promise<User[]> {
    return await db
      .select()
      .from(users)
      .where(eq(users.userType, role))
      .orderBy(desc(users.createdAt));
  }

  async createUserWithPassword(data: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    userType: "customer" | "restaurant_owner";
    passwordHash: string;
    mustResetPassword: boolean;
  }): Promise<{ userId: string }> {
    const [user] = await db
      .insert(users)
      .values({
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        userType: data.userType,
        passwordHash: data.passwordHash,
        mustResetPassword: data.mustResetPassword,
        emailVerified: false,
      })
      .returning();

    void syncUserToBrevo(user).catch(() => {});
    return { userId: user.id };
  }

  async updateUserPassword(
    userId: string,
    passwordHash: string,
    mustResetPassword: boolean,
  ): Promise<void> {
    await db
      .update(users)
      .set({
        passwordHash,
        mustResetPassword,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async disableUser(userId: string): Promise<void> {
    // Protect super admin email from being disabled
    const SUPER_ADMIN_EMAIL =
      process.env.ADMIN_EMAIL || "info.mealscout@gmail.com";
    const user = await this.getUser(userId);
    if (user?.email === SUPER_ADMIN_EMAIL) {
      throw new Error("Cannot disable super admin account");
    }

    await db
      .update(users)
      .set({
        isDisabled: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async enableUser(userId: string): Promise<void> {
    await db
      .update(users)
      .set({
        isDisabled: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  // ============================================
  // LISA Phase 4A: Claim Persistence
  // ============================================

  /**
   * emitClaim - Write-only fact recording
   *
   * Records an immutable observation about what happened in the system.
   * NO scoring, NO ranking, NO automation.
   *
   * Claims are facts, not conclusions.
   * Claims never mutate authority or user state.
   */
  async emitClaim(claim: {
    subjectType: string;
    subjectId: string;
    actorType?: string;
    actorId?: string;
    app: "mealscout" | "tradescout";
    claimType: LisaClaimType | string;
    claimValue: Record<string, any>;
    source: LisaClaimSource | string;
    confidence?: number;
  }): Promise<void> {
    try {
      const inserted = await db
        .insert(lisaClaims)
        .values({
          subjectType: claim.subjectType,
          subjectId: claim.subjectId,
          actorType: claim.actorType || null,
          actorId: claim.actorId || null,
          app: claim.app,
          claimType: claim.claimType,
          claimValue: claim.claimValue,
          source: claim.source,
          confidence: claim.confidence?.toString() || "1.0",
        })
        .returning();

      const emitted = inserted[0];

      if (emitted) {
        broadcastLisaClaim({
          id: emitted.id,
          app: emitted.app,
          source: emitted.source,
          claimType: emitted.claimType,
          subjectType: emitted.subjectType,
          subjectId: emitted.subjectId,
          actorType: emitted.actorType,
          actorId: emitted.actorId,
          claimValue: (emitted.claimValue ?? {}) as Record<string, unknown>,
          confidence: emitted.confidence,
          createdAt: emitted.createdAt,
        });
      }

      console.log("âœ… LISA claim emitted:", {
        claimType: claim.claimType,
        app: claim.app,
        subjectType: claim.subjectType,
        subjectId: claim.subjectId,
      });
    } catch (error) {
      // Claim recording failures should NOT block business operations
      console.error("âŒ LISA claim emission failed (non-blocking):", error);
    }
  }

  /**
   * getClaims - Read-only claim retrieval
   *
   * Filters claims by subject, actor, app, type, or time window.
   * Used for debugging and future deterministic resolution (Phase 4B+).
   *
   * NOT used for runtime decision-making yet.
   */
  async getClaims(filters: {
    subjectType?: string;
    subjectId?: string;
    actorType?: string;
    actorId?: string;
    app?: "mealscout" | "tradescout";
    claimType?: LisaClaimType | string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<LisaClaim[]> {
    let query = db.select().from(lisaClaims);

    const conditions = [];

    if (filters.subjectType) {
      conditions.push(eq(lisaClaims.subjectType, filters.subjectType));
    }
    if (filters.subjectId) {
      conditions.push(eq(lisaClaims.subjectId, filters.subjectId));
    }
    if (filters.actorType) {
      conditions.push(eq(lisaClaims.actorType, filters.actorType));
    }
    if (filters.actorId) {
      conditions.push(eq(lisaClaims.actorId, filters.actorId));
    }
    if (filters.app) {
      conditions.push(eq(lisaClaims.app, filters.app));
    }
    if (filters.claimType) {
      conditions.push(eq(lisaClaims.claimType, filters.claimType));
    }
    if (filters.startDate) {
      conditions.push(gte(lisaClaims.createdAt, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(lisaClaims.createdAt, filters.endDate));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    query = query.orderBy(desc(lisaClaims.createdAt)) as any;

    if (filters.limit) {
      query = query.limit(filters.limit) as any;
    }

    return await query;
  }

  // ============================================
  // Unified Claims (North Star)
  // ============================================
  async createUnifiedClaim(claim: InsertClaim): Promise<Claim> {
    const [newClaim] = await db
      .insert(claims)
      .values({
        ...claim,
        claimData: claim.claimData ?? {},
        metadata: claim.metadata ?? {},
      })
      .returning();
    return newClaim;
  }
}

export const storage = new DatabaseStorage();
