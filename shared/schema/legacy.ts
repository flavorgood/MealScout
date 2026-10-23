import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
  text,
  decimal,
  integer,
  boolean,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
export { cities, ORDER_STATUS, sessions, type OrderStatus } from "./core";

import { cities, sessions } from "./core";

// User storage table supporting multiple authentication methods
export const users: any = pgTable(
  "users",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userType: varchar("user_type").notNull().default("customer"), // 'customer' | 'restaurant_owner' | 'food_truck' | 'supplier' | 'host' | 'event_coordinator' | 'staff' | 'admin' | 'duper_admin' | 'super_admin'
    // TradeScout SSO linkage (for unified accounts between TradeScout and MealScout)
    tradescoutId: varchar("tradescout_id").unique(),
    // Facebook authentication (for regular users)
    facebookId: varchar("facebook_id").unique(),
    facebookAccessToken: text("facebook_access_token"),
    // Google authentication (for all users)
    googleId: varchar("google_id").unique(),
    googleAccessToken: text("google_access_token"),
    // Email/password authentication (for all users)
    passwordHash: text("password_hash"),
    emailVerified: boolean("email_verified").default(false),
    // Staff-created account flags
    mustResetPassword: boolean("must_reset_password").default(false),
    isDisabled: boolean("is_disabled").default(false),
    // Common fields
    email: varchar("email").unique(),
    firstName: varchar("first_name"),
    lastName: varchar("last_name"),
    phone: varchar("phone"),
    profileImageUrl: varchar("profile_image_url"),
    affiliateTag: varchar("affiliate_tag"),
    affiliatePercent: integer("affiliate_percent").default(5),
    affiliateCloserUserId: varchar("affiliate_closer_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    affiliateCloserPercent: integer("affiliate_closer_percent"),
    affiliateBookerUserId: varchar("affiliate_booker_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    affiliateBookerPercent: integer("affiliate_booker_percent"),
    stripeCustomerId: varchar("stripe_customer_id"),
    stripeSubscriptionId: varchar("stripe_subscription_id"),
    subscriptionBillingInterval: varchar("subscription_billing_interval"), // 'month' | '3-month' | 'year'
    subscriptionSignupDate: timestamp("subscription_signup_date"), // Track when user first subscribed for price lock-in
    trialStartedAt: timestamp("trial_started_at"),
    trialEndsAt: timestamp("trial_ends_at"),
    trialUsed: boolean("trial_used").default(false),
    // Optional demographics for aggregated analytics insights (privacy-conscious)
    birthYear: integer("birth_year"),
    gender: varchar("gender"), // 'male' | 'female' | 'other' | 'prefer_not_to_say'
    postalCode: varchar("postal_code"),
    // Golden Fork Award for influential food reviewers
    hasGoldenFork: boolean("has_golden_fork").default(false),
    goldenForkEarnedAt: timestamp("golden_fork_earned_at"),
    reviewCount: integer("review_count").default(0),
    recommendationCount: integer("recommendation_count").default(0),
    influenceScore: integer("influence_score").default(0), // Calculated from reviews, recommendations, favorites
    // Reporter reputation for moderation system
    reporterReputationScore: integer("reporter_reputation_score").default(100),
    flaggedCount: integer("flagged_count").default(0),
    upheldAgainstCount: integer("upheld_against_count").default(0),
    falseFlagCount: integer("false_flag_count").default(0),
    // App context for multi-platform shared auth (TradeScout + MealScout)
    appContext: varchar("app_context").default("mealscout"), // 'mealscout' | 'tradescout' | 'both'
    publicProfileSettings: jsonb("public_profile_settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    accountSettings: jsonb("account_settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_users_affiliate_tag").on(table.affiliateTag),
    unique("uq_users_affiliate_tag").on(table.affiliateTag),
  ],
);

// Security audit log table for all critical actions
export const securityAuditLog = pgTable(
  "security_audit_log",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id"),
    action: varchar("action").notNull(),
    resourceType: varchar("resource_type"),
    resourceId: varchar("resource_id"),
    ip: varchar("ip"),
    userAgent: varchar("user_agent"),
    timestamp: timestamp("timestamp").defaultNow(),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("idx_security_audit_user").on(table.userId),
    index("idx_security_audit_action").on(table.action),
    index("idx_security_audit_resource").on(
      table.resourceType,
      table.resourceId,
    ),
    index("idx_security_audit_time").on(table.timestamp),
  ],
);

// Incidents table for SOC-lite workflow
export const incidents = pgTable(
  "incidents",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ruleId: varchar("rule_id").notNull(),
    severity: varchar("severity").notNull(), // 'low' | 'medium' | 'high' | 'critical'
    status: varchar("status").notNull().default("new"), // 'new' | 'acknowledged' | 'resolved' | 'closed'
    userId: varchar("user_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedBy: varchar("acknowledged_by"),
    resolvedAt: timestamp("resolved_at"),
    resolvedBy: varchar("resolved_by"),
    closedAt: timestamp("closed_at"),
    closedBy: varchar("closed_by"),
    signatureHash: varchar("signature_hash"), // Cryptographic signature for tamper detection
  },
  (table) => [
    index("idx_incidents_status").on(table.status),
    index("idx_incidents_severity").on(table.severity),
    index("idx_incidents_rule").on(table.ruleId),
    index("idx_incidents_created").on(table.createdAt),
  ],
);

// On-call rotation schedule
export const oncallRotation = pgTable(
  "oncall_rotation",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id),
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date").notNull(),
    isPrimary: boolean("is_primary").default(true),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [index("idx_oncall_dates").on(table.startDate, table.endDate)],
);

export const restaurants = pgTable("restaurants", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id")
    .notNull()
    .references(() => users.id),
  name: varchar("name").notNull(),
  address: text("address").notNull(),
  phone: varchar("phone"),
  businessType: varchar("business_type").notNull().default("restaurant"), // 'restaurant' | 'bar' | 'food_truck'
  cuisineType: varchar("cuisine_type"),
  promoCode: varchar("promo_code"), // For tracking beta access and special offers
  claimedFromImportId: varchar("claimed_from_import_id"),
  latitude: decimal("latitude", { precision: 10, scale: 8 }),
  longitude: decimal("longitude", { precision: 11, scale: 8 }),
  countyFips: varchar("county_fips"),
  countyName: varchar("county_name"),
  geoEnrichedAt: timestamp("geo_enriched_at"),
  // Food truck specific fields
  isFoodTruck: boolean("is_food_truck").default(false),
  mobileOnline: boolean("mobile_online").default(false),
  currentLatitude: decimal("current_latitude", { precision: 10, scale: 8 }),
  currentLongitude: decimal("current_longitude", { precision: 11, scale: 8 }),
  lastBroadcastAt: timestamp("last_broadcast_at"),
  liveUntilAt: timestamp("live_until_at"),
  // Operating hours as JSONB: { mon: [{ open: "HH:MM", close: "HH:MM" }], tue: [...], ... }
  operatingHours: jsonb("operating_hours"),
  isActive: boolean("is_active").default(true),
  isVerified: boolean("is_verified").default(false),
  insuranceVerified: boolean("insurance_verified").default(false),
  insuranceVerifiedAt: timestamp("insurance_verified_at"),
  insuranceExpiresAt: timestamp("insurance_expires_at"),
  insuranceVerifiedByUserId: varchar("insurance_verified_by_user_id").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  // Image uploads
  logoUrl: varchar("logo_url"),
  coverImageUrl: varchar("cover_image_url"),
  city: varchar("city"),
  state: varchar("state"),
  // Business profile information (for customer-facing display and LLM crawling)
  description: text("description"), // About the business
  websiteUrl: varchar("website_url"), // Business website
  instagramUrl: varchar("instagram_url"), // Instagram profile
  facebookPageUrl: varchar("facebook_page_url"), // Facebook business page
  xUrl: varchar("x_url"), // X profile
  socialAutopostSettings: jsonb("social_autopost_settings"),
  rawData: jsonb("raw_data"),
  amenities: jsonb("amenities"), // { parking: boolean, wifi: boolean, outdoor_seating: boolean, etc }
  // Golden Plate Award for top-performing restaurants (awarded every 90 days)
  hasGoldenPlate: boolean("has_golden_plate").default(false),
  goldenPlateEarnedAt: timestamp("golden_plate_earned_at"),
  goldenPlateCount: integer("golden_plate_count").default(0), // Total times awarded (permanent record)
  rankingScore: integer("ranking_score").default(0), // Calculated from recommendations, favorites, reviews, deal usage
  // Legacy pricing audit fields. They no longer control profile access.
  lockedPriceCents: integer("locked_price_cents"), // Price is stored, never recalculated
  priceLockDate: timestamp("price_lock_date"), // When the price lock was applied
  priceLockReason: varchar("price_lock_reason"), // 'early_rollout' or other reason
  // Owner's manual pick for the one dish spotlighted on discovery cards.
  // Overrides the automatic top-recommended-dish ranking when set; null
  // falls through to that ranking, then to the first available menu item.
  featuredMenuItemId: varchar("featured_menu_item_id"),
  // Stripe Connect settlement for native restaurant ordering. Card checkout
  // remains unavailable until the owner finishes onboarding and Stripe marks
  // both charges and payouts ready.
  stripeConnectAccountId: varchar("stripe_connect_account_id"),
  stripeConnectStatus: varchar("stripe_connect_status")
    .notNull()
    .default("pending"),
  stripeOnboardingCompleted: boolean("stripe_onboarding_completed")
    .notNull()
    .default(false),
  stripeChargesEnabled: boolean("stripe_charges_enabled")
    .notNull()
    .default(false),
  stripePayoutsEnabled: boolean("stripe_payouts_enabled")
    .notNull()
    .default(false),
  // Durable generation for Connect account creation. It advances on owner
  // transfer and deauthorization so Stripe retries cannot reattach an account
  // from an earlier owner or connection lifecycle.
  stripeConnectGeneration: integer("stripe_connect_generation")
    .notNull()
    .default(0),
  // Native ordering requires a separate evidence-backed approval. Generic
  // profile verification (including VAC-lite) must never unlock checkout.
  orderingApprovedAt: timestamp("ordering_approved_at"),
  orderingApprovedByUserId: varchar("ordering_approved_by_user_id").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  orderingApprovalEvidenceUrl: text("ordering_approval_evidence_url"),
  orderingApprovalReviewNote: text("ordering_approval_review_note"),
  pickupAcknowledgementMinutes: integer("pickup_acknowledgement_minutes"),
  // Monotonic database-triggered revision for every row that can change
  // ordering eligibility. Checkout and webhook payout lock this row before
  // re-reading readiness so a stale preflight cannot authorize a write.
  orderingAuthorityVersion: integer("ordering_authority_version")
    .notNull()
    .default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const merchantDeliverySettings = pgTable(
  "merchant_delivery_settings",
  {
    restaurantId: varchar("restaurant_id")
      .primaryKey()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    feeCents: integer("fee_cents").notNull().default(0),
    minimumOrderCents: integer("minimum_order_cents").notNull().default(0),
    estimatedMinutes: integer("estimated_minutes").notNull().default(45),
    maxConcurrentOrders: integer("max_concurrent_orders").notNull().default(5),
    postalCodes: jsonb("postal_codes").notNull().default(sql`'[]'::jsonb`),
    deliveryHours: jsonb("delivery_hours").notNull().default(sql`'{}'::jsonb`),
    instructions: text("instructions"),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_merchant_delivery_enabled").on(table.enabled)],
);

export const businessStaffInvites = pgTable(
  "business_staff_invites",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: varchar("email"),
    tokenHash: varchar("token_hash").notNull(),
    permissions: jsonb("permissions")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar("status").notNull().default("pending"), // pending | accepted | revoked | expired
    expiresAt: timestamp("expires_at"),
    acceptedByUserId: varchar("accepted_by_user_id").references(
      () => users.id,
      {
        onDelete: "set null",
      },
    ),
    acceptedAt: timestamp("accepted_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_business_staff_invites_restaurant").on(table.restaurantId),
    index("idx_business_staff_invites_status").on(table.status),
    unique("uq_business_staff_invites_token_hash").on(table.tokenHash),
  ],
);

export const businessStaffMemberships = pgTable(
  "business_staff_memberships",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitedByUserId: varchar("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissions: jsonb("permissions")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar("status").notNull().default("active"), // active | revoked
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_business_staff_memberships_restaurant").on(table.restaurantId),
    index("idx_business_staff_memberships_user").on(table.userId),
    index("idx_business_staff_memberships_status").on(table.status),
    unique("uq_business_staff_memberships_restaurant_user").on(
      table.restaurantId,
      table.userId,
    ),
  ],
);

export const truckImportBatches = pgTable(
  "truck_import_batches",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    source: varchar("source"),
    fileName: varchar("file_name"),
    uploadedBy: varchar("uploaded_by").references(() => users.id),
    totalRows: integer("total_rows").default(0),
    importedRows: integer("imported_rows").default(0),
    skippedRows: integer("skipped_rows").default(0),
    purgedAt: timestamp("purged_at"),
    purgedBy: varchar("purged_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_truck_import_batches_created").on(table.createdAt)],
);

export const truckImportListings = pgTable(
  "truck_import_listings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    batchId: varchar("batch_id").references(() => truckImportBatches.id, {
      onDelete: "set null",
    }),
    source: varchar("source"),
    externalId: varchar("external_id"),
    email: varchar("email"),
    name: varchar("name").notNull(),
    address: text("address").notNull(),
    city: varchar("city"),
    state: varchar("state"),
    phone: varchar("phone"),
    cuisineType: varchar("cuisine_type"),
    websiteUrl: varchar("website_url"),
    instagramUrl: varchar("instagram_url"),
    facebookPageUrl: varchar("facebook_page_url"),
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),
    countyFips: varchar("county_fips"),
    countyName: varchar("county_name"),
    geoEnrichedAt: timestamp("geo_enriched_at"),
    confidenceScore: integer("confidence_score").default(0),
    status: varchar("status").notNull().default("unclaimed"), // 'unclaimed' | 'claim_requested' | 'claimed' | 'rejected' | 'duplicate'
    invitedUserId: varchar("invited_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastInviteSentAt: timestamp("last_invite_sent_at"),
    rawData: jsonb("raw_data"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_truck_import_external").on(table.externalId),
    index("idx_truck_import_status").on(table.status),
    index("idx_truck_import_state").on(table.state),
    index("idx_truck_import_batch").on(table.batchId),
  ],
);

export const truckClaimRequests = pgTable(
  "truck_claim_requests",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    listingId: varchar("listing_id")
      .notNull()
      .references(() => truckImportListings.id),
    restaurantId: varchar("restaurant_id").references(() => restaurants.id),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id),
    status: varchar("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
    submittedAt: timestamp("submitted_at").defaultNow(),
    reviewedAt: timestamp("reviewed_at"),
    reviewerId: varchar("reviewer_id").references(() => users.id),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_truck_claim_listing").on(table.listingId),
    index("idx_truck_claim_status").on(table.status),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessName: varchar("business_name").notNull(),
    address: text("address"),
    city: varchar("city"),
    state: varchar("state"),
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),
    countyFips: varchar("county_fips"),
    countyName: varchar("county_name"),
    geoEnrichedAt: timestamp("geo_enriched_at"),
    websiteUrl: text("website_url"),
    logoUrl: text("logo_url"),
    contactPhone: varchar("contact_phone"),
    contactEmail: varchar("contact_email"),
    isActive: boolean("is_active").default(true),
    stripeConnectAccountId: varchar("stripe_connect_account_id"),
    stripeConnectStatus: varchar("stripe_connect_status").default("pending"),
    stripeOnboardingCompleted: boolean("stripe_onboarding_completed").default(
      false,
    ),
    stripeChargesEnabled: boolean("stripe_charges_enabled").default(false),
    stripePayoutsEnabled: boolean("stripe_payouts_enabled").default(false),
    onlinePaymentsEnabled: boolean("online_payments_enabled")
      .notNull()
      .default(false),
    onlinePaymentsAllowAch: boolean("online_payments_allow_ach")
      .notNull()
      .default(true),
    onlinePaymentsAllowCard: boolean("online_payments_allow_card")
      .notNull()
      .default(true),
    onlinePaymentsMinOrderCents: integer("online_payments_min_order_cents")
      .notNull()
      .default(0),
    onlinePaymentsNotes: text("online_payments_notes"),
    offersDelivery: boolean("offers_delivery").notNull().default(false),
    deliveryRadiusMiles: integer("delivery_radius_miles"),
    deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
    deliveryMinOrderCents: integer("delivery_min_order_cents")
      .notNull()
      .default(0),
    deliveryNotes: text("delivery_notes"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    unique("uq_suppliers_user").on(table.userId),
    index("idx_suppliers_active").on(table.isActive),
    index("idx_suppliers_stripe_account").on(table.stripeConnectAccountId),
  ],
);

export const publicBusinessSlugOwnerships = pgTable(
  "public_business_slug_ownerships",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slug: varchar("slug", { length: 100 }).notNull(),
    entityType: varchar("entity_type").notNull(),
    entityId: varchar("entity_id").notNull(),
    preferredSlug: varchar("preferred_slug", { length: 100 }),
    sourceName: varchar("source_name"),
    assignmentStatus: varchar("assignment_status").notNull().default("assigned"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    unique("uq_public_business_slug_ownerships_slug").on(table.slug),
    unique("uq_public_business_slug_ownerships_entity").on(
      table.entityType,
      table.entityId,
    ),
    index("idx_public_business_slug_ownerships_entity").on(
      table.entityType,
      table.entityId,
    ),
  ],
);

export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    supplierId: varchar("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    description: text("description"),
    sku: varchar("sku"),
    priceCents: integer("price_cents").notNull().default(0),
    unitLabel: varchar("unit_label"),
    imageUrl: text("image_url"),
    isActive: boolean("is_active").default(true),
    deliveryEligible: boolean("delivery_eligible").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supplier_products_supplier").on(table.supplierId),
    index("idx_supplier_products_active").on(table.isActive),
    index("idx_supplier_products_delivery_eligible").on(table.deliveryEligible),
  ],
);

export const supplierRequests = pgTable(
  "supplier_requests",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    supplierId: varchar("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    buyerUserId: varchar("buyer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    buyerRestaurantId: varchar("buyer_restaurant_id").references(
      () => restaurants.id,
      { onDelete: "restrict" },
    ),
    status: varchar("status").notNull().default("submitted"), // 'submitted' | 'accepted' | 'declined' | 'cancelled'
    requestedFulfillment: varchar("requested_fulfillment")
      .notNull()
      .default("pickup"), // 'pickup'
    paymentPreference: varchar("payment_preference")
      .notNull()
      .default("offsite"), // 'offsite' | 'in_person'
    note: text("note"),
    deliveryAddress: text("delivery_address"),
    deliveryCity: varchar("delivery_city"),
    deliveryState: varchar("delivery_state"),
    deliveryPostalCode: varchar("delivery_postal_code"),
    deliveryInstructions: text("delivery_instructions"),
    deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
    deliveryStatus: varchar("delivery_status").notNull().default("pending"), // 'pending' | 'accepted' | 'out_for_delivery' | 'delivered' | 'cancelled'
    deliveryScheduledFor: timestamp("delivery_scheduled_for"),
    acceptedAt: timestamp("accepted_at"),
    acceptedBy: varchar("accepted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    declinedAt: timestamp("declined_at"),
    declinedBy: varchar("declined_by").references(() => users.id, {
      onDelete: "set null",
    }),
    declineReason: text("decline_reason"),
    orderId: varchar("order_id").references(() => supplierOrders.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supplier_requests_supplier").on(table.supplierId),
    index("idx_supplier_requests_buyer").on(table.buyerRestaurantId),
    index("idx_supplier_requests_buyer_user").on(table.buyerUserId),
    index("idx_supplier_requests_status").on(table.status),
    index("idx_supplier_requests_fulfillment").on(table.requestedFulfillment),
    index("idx_supplier_requests_delivery_status").on(table.deliveryStatus),
  ],
);

export const supplierRequestItems = pgTable(
  "supplier_request_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    requestId: varchar("request_id")
      .notNull()
      .references(() => supplierRequests.id, { onDelete: "cascade" }),
    productId: varchar("product_id").references(() => supplierProducts.id, {
      onDelete: "set null",
    }),
    itemName: varchar("item_name"),
    quantity: integer("quantity").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_supplier_request_items_request").on(table.requestId)],
);

export const supplierOrders = pgTable(
  "supplier_orders",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    supplierId: varchar("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    buyerUserId: varchar("buyer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    truckRestaurantId: varchar("truck_restaurant_id").references(
      () => restaurants.id,
      { onDelete: "restrict" },
    ),
    status: varchar("status").notNull().default("submitted"), // 'submitted' | 'ready' | 'completed' | 'cancelled'
    paymentMethod: varchar("payment_method").notNull().default("offsite"), // 'stripe' | 'offsite'
    paymentStatus: varchar("payment_status").notNull().default("unpaid"), // 'unpaid' | 'paid' | 'offsite'
    requestedFulfillment: varchar("requested_fulfillment")
      .notNull()
      .default("pickup"), // 'pickup' | 'delivery'
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
    platformFeeCents: integer("platform_fee_cents").notNull().default(0),
    stripeFeeEstimateCents: integer("stripe_fee_estimate_cents")
      .notNull()
      .default(0),
    totalCents: integer("total_cents").notNull().default(0),
    stripePaymentIntentId: varchar("stripe_payment_intent_id"),
    stripeChargeAmountCents: integer("stripe_charge_amount_cents")
      .notNull()
      .default(0),
    stripeApplicationFeeCents: integer("stripe_application_fee_cents")
      .notNull()
      .default(0),
    stripeTransferAmountCents: integer("stripe_transfer_amount_cents")
      .notNull()
      .default(0),
    buyerDiscountCents: integer("buyer_discount_cents").notNull().default(0),
    buyerPaymentMethod: varchar("buyer_payment_method"),
    pickupNote: text("pickup_note"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supplier_orders_supplier").on(table.supplierId),
    index("idx_supplier_orders_truck").on(table.truckRestaurantId),
    index("idx_supplier_orders_buyer_user").on(table.buyerUserId),
    index("idx_supplier_orders_status").on(table.status),
    index("idx_supplier_orders_fulfillment").on(table.requestedFulfillment),
  ],
);

export const supplierOrderItems = pgTable(
  "supplier_order_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orderId: varchar("order_id")
      .notNull()
      .references(() => supplierOrders.id, { onDelete: "cascade" }),
    productId: varchar("product_id")
      .notNull()
      .references(() => supplierProducts.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    lineTotalCents: integer("line_total_cents").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_supplier_order_items_order").on(table.orderId)],
);

export const supplyDemands = pgTable(
  "supply_demands",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    buyerRestaurantId: varchar("buyer_restaurant_id").references(
      () => restaurants.id,
      {
        onDelete: "set null",
      },
    ),
    itemKey: varchar("item_key").notNull(),
    itemName: varchar("item_name").notNull(),
    quantity: integer("quantity"),
    buyerCity: varchar("buyer_city"),
    buyerState: varchar("buyer_state"),
    buyerLatitude: decimal("buyer_latitude", { precision: 10, scale: 8 }),
    buyerLongitude: decimal("buyer_longitude", { precision: 11, scale: 8 }),
    source: varchar("source").notNull().default("manual"), // 'manual' | 'request' | 'import'
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_demands_item_key").on(table.itemKey),
    index("idx_supply_demands_buyer").on(table.buyerRestaurantId),
    index("idx_supply_demands_created_at").on(table.createdAt),
  ],
);

export const supplyDemandNotifications = pgTable(
  "supply_demand_notifications",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    supplierId: varchar("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    itemKey: varchar("item_key").notNull(),
    lastNotifiedAt: timestamp("last_notified_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uq_supply_demand_notifications_supplier_item").on(
      table.supplierId,
      table.itemKey,
    ),
    index("idx_supply_demand_notifications_last_notified").on(
      table.lastNotifiedAt,
    ),
  ],
);

export const supplyReceipts = pgTable(
  "supply_receipts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    uploadedByUserId: varchar("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    buyerRestaurantId: varchar("buyer_restaurant_id").references(
      () => restaurants.id,
      {
        onDelete: "set null",
      },
    ),
    supplierId: varchar("supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    merchantName: varchar("merchant_name"),
    merchantAddress: text("merchant_address"),
    merchantCity: varchar("merchant_city"),
    merchantState: varchar("merchant_state"),
    purchasedAt: timestamp("purchased_at"),
    totalCents: integer("total_cents"),
    currency: varchar("currency").notNull().default("usd"),
    cloudinaryPublicId: varchar("cloudinary_public_id"),
    receiptImageUrl: text("receipt_image_url").notNull(),
    status: varchar("status").notNull().default("uploaded"), // 'uploaded' | 'needs_review' | 'processed'
    rawText: text("raw_text"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_receipts_uploaded_by").on(table.uploadedByUserId),
    index("idx_supply_receipts_buyer").on(table.buyerRestaurantId),
    index("idx_supply_receipts_supplier").on(table.supplierId),
    index("idx_supply_receipts_purchased_at").on(table.purchasedAt),
  ],
);

export const supplyReceiptItems = pgTable(
  "supply_receipt_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    receiptId: varchar("receipt_id")
      .notNull()
      .references(() => supplyReceipts.id, { onDelete: "cascade" }),
    itemKey: varchar("item_key").notNull(),
    itemName: varchar("item_name").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents"),
    lineTotalCents: integer("line_total_cents"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_receipt_items_receipt").on(table.receiptId),
    index("idx_supply_receipt_items_item_key").on(table.itemKey),
    index("idx_supply_receipt_items_unit_price").on(table.unitPriceCents),
  ],
);

export const supplyStores = pgTable(
  "supply_stores",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: varchar("type").notNull().default("retailer"), // 'retailer' | 'wholesaler' | 'distributor' | 'supplier'
    name: varchar("name").notNull(),
    websiteUrl: text("website_url"),
    phone: varchar("phone"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    unique("uq_supply_stores_name").on(table.name),
    index("idx_supply_stores_active").on(table.isActive),
  ],
);

export const supplyStoreLocations = pgTable(
  "supply_store_locations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storeId: varchar("store_id")
      .notNull()
      .references(() => supplyStores.id, { onDelete: "cascade" }),
    address: text("address"),
    city: varchar("city"),
    state: varchar("state"),
    postalCode: varchar("postal_code"),
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),
    countyFips: varchar("county_fips"),
    countyName: varchar("county_name"),
    geoEnrichedAt: timestamp("geo_enriched_at"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_store_locations_store").on(table.storeId),
    index("idx_supply_store_locations_state").on(table.state),
  ],
);

export const supplyItems = pgTable(
  "supply_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    itemKey: varchar("item_key").notNull(),
    canonicalName: varchar("canonical_name").notNull(),
    category: varchar("category"),
    defaultUnit: varchar("default_unit"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    unique("uq_supply_items_key").on(table.itemKey),
    index("idx_supply_items_canonical").on(table.canonicalName),
  ],
);

export const supplyItemAliases = pgTable(
  "supply_item_aliases",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    itemId: varchar("item_id")
      .notNull()
      .references(() => supplyItems.id, { onDelete: "cascade" }),
    aliasKey: varchar("alias_key").notNull(),
    alias: varchar("alias").notNull(),
    source: varchar("source").notNull().default("manual"), // 'manual' | 'supplier' | 'barcode'
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_item_aliases_item").on(table.itemId),
    index("idx_supply_item_aliases_alias_key").on(table.aliasKey),
  ],
);

export const supplyPrices = pgTable(
  "supply_prices",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storeId: varchar("store_id")
      .notNull()
      .references(() => supplyStores.id, { onDelete: "cascade" }),
    storeLocationId: varchar("store_location_id").references(
      () => supplyStoreLocations.id,
      {
        onDelete: "set null",
      },
    ),
    itemId: varchar("item_id")
      .notNull()
      .references(() => supplyItems.id, { onDelete: "cascade" }),
    sku: varchar("sku"),
    unitLabel: varchar("unit_label"),
    unitPriceCents: integer("unit_price_cents").notNull(),
    currency: varchar("currency").notNull().default("usd"),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
    source: varchar("source").notNull().default("manual"), // 'manual' | 'import' | 'supplier'
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_prices_store").on(table.storeId),
    index("idx_supply_prices_item").on(table.itemId),
    index("idx_supply_prices_observed").on(table.observedAt),
  ],
);

export const supplyPriceWatches = pgTable(
  "supply_price_watches",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    buyerRestaurantId: varchar("buyer_restaurant_id").references(
      () => restaurants.id,
      {
        onDelete: "set null",
      },
    ),
    itemKey: varchar("item_key").notNull(),
    itemName: varchar("item_name").notNull(),
    targetPriceCents: integer("target_price_cents"),
    maxRadiusMiles: integer("max_radius_miles").notNull().default(25),
    isActive: boolean("is_active").notNull().default(true),
    lastTriggeredAt: timestamp("last_triggered_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_price_watches_user").on(table.userId),
    index("idx_supply_price_watches_item_key").on(table.itemKey),
    index("idx_supply_price_watches_active").on(table.isActive),
  ],
);

export const supplyPriceAlerts = pgTable(
  "supply_price_alerts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    watchId: varchar("watch_id").references(() => supplyPriceWatches.id, {
      onDelete: "set null",
    }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    buyerRestaurantId: varchar("buyer_restaurant_id").references(
      () => restaurants.id,
      {
        onDelete: "set null",
      },
    ),
    itemKey: varchar("item_key").notNull(),
    itemName: varchar("item_name").notNull(),
    alertType: varchar("alert_type").notNull().default("price_target_hit"),
    message: text("message").notNull(),
    observedPriceCents: integer("observed_price_cents"),
    baselinePriceCents: integer("baseline_price_cents"),
    observedAt: timestamp("observed_at"),
    storeId: varchar("store_id").references(() => supplyStores.id, {
      onDelete: "set null",
    }),
    storeLocationId: varchar("store_location_id").references(
      () => supplyStoreLocations.id,
      {
        onDelete: "set null",
      },
    ),
    storeName: varchar("store_name"),
    storeCity: varchar("store_city"),
    storeState: varchar("store_state"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_price_alerts_user_created").on(
      table.userId,
      table.createdAt,
    ),
    index("idx_supply_price_alerts_watch").on(table.watchId),
    index("idx_supply_price_alerts_item_key").on(table.itemKey),
  ],
);

export const supplyPriceDailySnapshots = pgTable(
  "supply_price_daily_snapshots",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    itemKey: varchar("item_key").notNull(),
    itemName: varchar("item_name").notNull(),
    areaKey: varchar("area_key").notNull(),
    snapshotDay: varchar("snapshot_day").notNull(), // YYYY-MM-DD
    minPriceCents: integer("min_price_cents"),
    medianPriceCents: integer("median_price_cents"),
    maxPriceCents: integer("max_price_cents"),
    sampleCount: integer("sample_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    unique("uq_supply_price_daily_snapshots_item_area_day").on(
      table.itemKey,
      table.areaKey,
      table.snapshotDay,
    ),
    index("idx_supply_price_daily_snapshots_item_day").on(
      table.itemKey,
      table.snapshotDay,
    ),
  ],
);

export const supplyShoppingLists = pgTable(
  "supply_shopping_lists",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerUserId: varchar("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    buyerRestaurantId: varchar("buyer_restaurant_id").references(
      () => restaurants.id,
      {
        onDelete: "set null",
      },
    ),
    name: varchar("name").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_shopping_lists_owner").on(table.ownerUserId),
    index("idx_supply_shopping_lists_buyer").on(table.buyerRestaurantId),
  ],
);

export const supplyShoppingListItems = pgTable(
  "supply_shopping_list_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    listId: varchar("list_id")
      .notNull()
      .references(() => supplyShoppingLists.id, { onDelete: "cascade" }),
    itemId: varchar("item_id").references(() => supplyItems.id, {
      onDelete: "set null",
    }),
    rawName: varchar("raw_name").notNull(),
    quantity: decimal("quantity", { precision: 10, scale: 2 })
      .notNull()
      .default("1"),
    unit: varchar("unit"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_supply_shopping_list_items_list").on(table.listId),
    index("idx_supply_shopping_list_items_item").on(table.itemId),
  ],
);

export const supplyScoutPreferences = pgTable(
  "supply_scout_preferences",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hubLabel: varchar("hub_label"),
    hubLatitude: decimal("hub_latitude", { precision: 10, scale: 8 }),
    hubLongitude: decimal("hub_longitude", { precision: 11, scale: 8 }),
    maxRadiusMiles: integer("max_radius_miles").notNull().default(25),
    costPerStopCents: integer("cost_per_stop_cents").notNull().default(800),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [unique("uq_supply_scout_preferences_user").on(table.userId)],
);

export const supplyBarcodeMappings = pgTable(
  "supply_barcode_mappings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    barcode: varchar("barcode").notNull(),
    itemId: varchar("item_id").references(() => supplyItems.id, {
      onDelete: "set null",
    }),
    alias: varchar("alias"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [unique("uq_supply_barcode_mappings_barcode").on(table.barcode)],
);

export const supplyOrderPreferences = pgTable(
  "supply_order_preferences",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    maxStops: integer("max_stops").notNull().default(2),
    maxRadiusMiles: integer("max_radius_miles").notNull().default(20),
    // Legacy fixed cost-per-stop (kept for backwards compatibility).
    costPerStopCents: integer("cost_per_stop_cents").notNull().default(0),
    // Preferred: minutes + cost-per-minute (for adaptive "local averages" modeling).
    stopMinutes: integer("stop_minutes").notNull().default(10),
    costPerMinuteCents: integer("cost_per_minute_cents").notNull().default(0),
    pingSuppliers: boolean("ping_suppliers").notNull().default(true),
    allowSubstitutions: boolean("allow_substitutions").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [unique("uq_supply_order_preferences_user").on(table.userId)],
);

export const deals = pgTable("deals", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id")
    .notNull()
    .references(() => restaurants.id),
  title: varchar("title").notNull(),
  description: text("description").notNull(),
  dealType: varchar("deal_type").notNull(), // 'percentage' or 'fixed'
  discountValue: decimal("discount_value", {
    precision: 5,
    scale: 2,
  }).notNull(),
  minOrderAmount: decimal("min_order_amount", { precision: 8, scale: 2 }),
  imageUrl: varchar("image_url").notNull(), // Required image for all deals
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"), // Nullable for ongoing deals
  startTime: varchar("start_time"), // Nullable if available during business hours
  endTime: varchar("end_time"), // Nullable if available during business hours
  availableDuringBusinessHours: boolean(
    "available_during_business_hours",
  ).default(false), // Use restaurant operating hours
  isOngoing: boolean("is_ongoing").default(false), // No expiration date
  totalUsesLimit: integer("total_uses_limit"),
  perCustomerLimit: integer("per_customer_limit").default(1),
  currentUses: integer("current_uses").default(0),
  facebookPageUrl: varchar("facebook_page_url"),
  isActive: boolean("is_active").default(true),
  isAiGenerated: boolean("is_ai_generated").default(false), // Mark AI-generated sample deals for beta testing
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const dealClaims = pgTable(
  "deal_claims",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    dealId: varchar("deal_id")
      .notNull()
      .references(() => deals.id),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id),
    claimedAt: timestamp("claimed_at").defaultNow(),
    usedAt: timestamp("used_at"),
    isUsed: boolean("is_used").default(false),
    orderAmount: decimal("order_amount", { precision: 10, scale: 2 }), // For revenue tracking
  },
  (table) => [
    index("IDX_deal_claims_deal_used").on(table.dealId, table.usedAt),
    index("IDX_deal_claims_deal_status").on(table.dealId, table.isUsed),
    index("IDX_deal_claims_user_claimed").on(table.userId, table.claimedAt),
  ],
);

export const reviews = pgTable("reviews", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id")
    .notNull()
    .references(() => restaurants.id),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const verificationRequests = pgTable("verification_requests", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  restaurantId: varchar("restaurant_id")
    .notNull()
    .references(() => restaurants.id),
  status: varchar("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
  documents: text("documents").array(), // Array of base64 data URLs or file paths
  licenseNumber: varchar("license_number"),
  submittedAt: timestamp("submitted_at").defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  reviewerId: varchar("reviewer_id").references(() => users.id),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Deal views table for tracking impressions and analytics
export const dealViews = pgTable(
  "deal_views",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    dealId: varchar("deal_id")
      .notNull()
      .references(() => deals.id),
    userId: varchar("user_id").references(() => users.id), // Nullable for anonymous views
    sessionId: varchar("session_id").notNull(), // Track anonymous sessions
    viewedAt: timestamp("viewed_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_deal_views_deal_viewed").on(table.dealId, table.viewedAt),
    index("IDX_deal_views_user_deal").on(table.userId, table.dealId),
    index("IDX_deal_views_session").on(table.sessionId),
  ],
);

// Restaurant favorites tracking
export const restaurantFavorites = pgTable(
  "restaurant_favorites",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id),
    favoritedAt: timestamp("favorited_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_restaurant_favorites_restaurant").on(
      table.restaurantId,
      table.favoritedAt.desc(),
    ),
    index("IDX_restaurant_favorites_user").on(
      table.userId,
      table.favoritedAt.desc(),
    ),
    index("IDX_restaurant_favorites_unique").on(
      table.restaurantId,
      table.userId,
    ),
  ],
);

// Restaurant follows tracking
export const restaurantFollows = pgTable(
  "restaurant_follows",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followedAt: timestamp("followed_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_restaurant_follows_restaurant").on(
      table.restaurantId,
      table.followedAt.desc(),
    ),
    index("IDX_restaurant_follows_user").on(
      table.userId,
      table.followedAt.desc(),
    ),
    index("IDX_restaurant_follows_unique").on(table.restaurantId, table.userId),
  ],
);

// Restaurant user recommendations (manual user recommends; one per restaurant)
export const restaurantUserRecommendations = pgTable(
  "restaurant_user_recommendations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Structured quick-review signals (1-100 each) - not a public star
    // rating. Nullable: most recommends are a bare tap with no context.
    foodScore: integer("food_score"),
    valueScore: integer("value_score"),
    speedScore: integer("speed_score"),
    vibeScore: integer("vibe_score"),
    // Durable idempotency marker for the optional contextual submission.
    // A bare recommend can later receive exactly one context payload.
    contextReviewId: varchar("context_review_id").references(() => reviews.id, {
      onDelete: "set null",
    }),
    contextSubmittedAt: timestamp("context_submitted_at"),
    contextPayloadFingerprint: varchar("context_payload_fingerprint", {
      length: 64,
    }),
    recommendedAt: timestamp("recommended_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_restaurant_user_recommendations_restaurant").on(
      table.restaurantId,
      table.recommendedAt.desc(),
    ),
    index("IDX_restaurant_user_recommendations_user").on(
      table.userId,
      table.recommendedAt.desc(),
    ),
    uniqueIndex("IDX_restaurant_user_recommendations_unique").on(
      table.restaurantId,
      table.userId,
    ),
    uniqueIndex("idx_restaurant_recommendations_context_review")
      .on(table.contextReviewId)
      .where(sql`${table.contextReviewId} is not null`),
  ],
);

// Restaurant recommendations tracking - when a restaurant appears in recommendation feeds
export const restaurantRecommendations = pgTable(
  "restaurant_recommendations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    userId: varchar("user_id").references(() => users.id), // Nullable for anonymous users
    sessionId: varchar("session_id").notNull(), // Track anonymous sessions
    recommendationType: varchar("recommendation_type").notNull(), // 'homepage' | 'search' | 'nearby' | 'personalized'
    recommendationContext: text("recommendation_context"), // Additional context like search query, location, etc.
    isClicked: boolean("is_clicked").default(false),
    clickedAt: timestamp("clicked_at"),
    showedAt: timestamp("showed_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_restaurant_recommendations_restaurant").on(
      table.restaurantId,
      table.showedAt.desc(),
    ),
    index("IDX_restaurant_recommendations_user").on(
      table.userId,
      table.showedAt.desc(),
    ),
    index("IDX_restaurant_recommendations_session").on(table.sessionId),
    index("IDX_restaurant_recommendations_type").on(
      table.recommendationType,
      table.showedAt.desc(),
    ),
    index("IDX_restaurant_recommendations_clicked").on(
      table.isClicked,
      table.clickedAt,
    ),
  ],
);

// Food truck session management
export const foodTruckSessions = pgTable(
  "food_truck_sessions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    startedAt: timestamp("started_at").defaultNow(),
    endedAt: timestamp("ended_at"),
    deviceId: varchar("device_id").notNull(),
    startedByUserId: varchar("started_by_user_id")
      .notNull()
      .references(() => users.id),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_food_truck_sessions_restaurant").on(table.restaurantId),
    index("IDX_food_truck_sessions_active").on(table.isActive, table.startedAt),
  ],
);

// Food truck location history for tracking and analytics
export const foodTruckLocations = pgTable(
  "food_truck_locations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    sessionId: varchar("session_id").references(() => foodTruckSessions.id),
    latitude: decimal("latitude", { precision: 10, scale: 8 }).notNull(),
    longitude: decimal("longitude", { precision: 11, scale: 8 }).notNull(),
    heading: decimal("heading", { precision: 5, scale: 2 }), // 0-360 degrees
    speed: decimal("speed", { precision: 5, scale: 2 }), // km/h
    accuracy: decimal("accuracy", { precision: 8, scale: 2 }), // meters
    source: varchar("source").default("gps"), // 'gps' | 'network' | 'manual'
    recordedAt: timestamp("recorded_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_food_truck_locations_restaurant_time").on(
      table.restaurantId,
      table.recordedAt.desc(),
    ),
    index("IDX_food_truck_locations_time").on(table.recordedAt.desc()),
    index("IDX_food_truck_locations_geo").on(
      table.restaurantId,
      table.latitude,
      table.longitude,
    ),
    index("IDX_food_truck_locations_session").on(table.sessionId),
  ],
);

// User addresses for saved locations
export const userAddresses = pgTable(
  "user_addresses",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type").notNull(), // 'home' | 'work' | 'other'
    label: varchar("label").notNull(),
    address: text("address").notNull(),
    city: varchar("city").notNull(),
    state: varchar("state"),
    postalCode: varchar("postal_code"),
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),
    countyFips: varchar("county_fips"),
    countyName: varchar("county_name"),
    geoEnrichedAt: timestamp("geo_enriched_at"),
    spotImageUrl: text("spot_image_url"),
    isDefault: boolean("is_default").default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("IDX_user_addresses_user").on(table.userId, table.createdAt.desc()),
    index("IDX_user_addresses_type").on(table.userId, table.type),
    index("IDX_user_addresses_default").on(table.userId, table.isDefault),
  ],
);

// Password reset tokens for secure password reset functionality
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(), // Store hashed token for security
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"), // Nullable - set when token is used
    requestIp: varchar("request_ip"), // Track IP for security auditing
    userAgent: varchar("user_agent"), // Track user agent for security auditing
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_password_reset_tokens_user").on(
      table.userId,
      table.createdAt.desc(),
    ),
    index("IDX_password_reset_tokens_token").on(table.tokenHash),
    index("IDX_password_reset_tokens_expires").on(table.expiresAt),
    index("IDX_password_reset_tokens_used").on(table.usedAt),
  ],
);

// Phone verification tokens for SMS-based signup verification
export const phoneVerificationTokens = pgTable(
  "phone_verification_tokens",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    phone: varchar("phone").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    requestIp: varchar("request_ip"),
    userAgent: varchar("user_agent"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_phone_verification_phone").on(table.phone, table.createdAt),
    index("idx_phone_verification_expires").on(table.expiresAt),
  ],
);

// Account setup tokens for new user onboarding (email-based flow)
export const accountSetupTokens = pgTable(
  "account_setup_tokens",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(), // Store hashed token for security
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"), // Nullable - set when token is used
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }), // Staff/admin who created the account
    requestIp: varchar("request_ip"), // Track IP for security auditing
    userAgent: varchar("user_agent"), // Track user agent for security auditing
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_account_setup_tokens_user").on(
      table.userId,
      table.createdAt.desc(),
    ),
    index("IDX_account_setup_tokens_token").on(table.tokenHash),
    index("IDX_account_setup_tokens_expires").on(table.expiresAt),
    index("IDX_account_setup_tokens_used").on(table.usedAt),
  ],
);

// Deal feedback for ratings and suggestions
export const dealFeedback = pgTable(
  "deal_feedback",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    dealId: varchar("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "set null",
    }), // Nullable for anonymous feedback
    rating: integer("rating").notNull(), // 1-5 stars
    feedbackType: varchar("feedback_type").notNull(), // 'rating' | 'suggestion' | 'issue'
    comment: text("comment"), // Optional feedback comment
    isHelpful: boolean("is_helpful"), // Did the deal work as expected?
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_deal_feedback_deal").on(table.dealId, table.createdAt.desc()),
    index("IDX_deal_feedback_user").on(table.userId, table.createdAt.desc()),
    index("IDX_deal_feedback_rating").on(table.dealId, table.rating),
    index("IDX_deal_feedback_type").on(table.feedbackType),
  ],
);

// API Keys for service-to-service authentication
export const apiKeys = pgTable(
  "api_keys",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    restaurantId: varchar("restaurant_id").references(() => restaurants.id, {
      onDelete: "cascade",
    }),
    name: varchar("name").notNull(), // 'POS Integration', 'Live Location Service', etc.
    keyHash: text("key_hash").notNull(), // bcrypt hashed (never store plaintext)
    keyPrefix: varchar("key_prefix", { length: 8 }), // First 8 chars for display (e.g., 'sk_live_abc123')
    scope: varchar("scope").notNull(), // 'read', 'write', 'admin'
    purpose: varchar("purpose").notNull().default("general"),
    isActive: boolean("is_active").default(true),
    revokedAt: timestamp("revoked_at"),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"), // Optional - null means no expiration
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("IDX_api_keys_user").on(table.userId, table.isActive),
    index("IDX_api_keys_restaurant").on(table.restaurantId, table.isActive),
    index("IDX_api_keys_prefix").on(table.keyPrefix),
    index("IDX_api_keys_active").on(table.isActive, table.expiresAt),
  ],
);

// Quota tiers for API clients (Bronze, Silver, Gold, etc.)
export const clientQuotas = pgTable(
  "client_quotas",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tier: varchar("tier", { length: 20 }).notNull().default("bronze"), // 'bronze' | 'silver' | 'gold' | 'custom'
    rateLimitPerHour: integer("rate_limit_per_hour").notNull().default(60),
    monthlyRequestLimit: integer("monthly_request_limit")
      .notNull()
      .default(1000),
    lastBillingCycle: timestamp("last_billing_cycle").defaultNow(),
    currentMonthlyUsage: integer("current_monthly_usage").default(0),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    unique("uq_client_quotas_user").on(table.userId),
    index("idx_client_quotas_user").on(table.userId),
    index("idx_client_quotas_tier").on(table.tier),
  ],
);

// High-performance rate limit counters for distributed environments
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    scope: varchar("scope").notNull(),
    identityKey: varchar("identity_key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_rate_limit_counters_updated_at").on(table.updatedAt),
    primaryKey({
      columns: [table.scope, table.identityKey, table.windowStart],
    }),
  ],
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  restaurants: many(restaurants),
  dealClaims: many(dealClaims),
  reviews: many(reviews),
  dealViews: many(dealViews),
  restaurantFavorites: many(restaurantFavorites),
  restaurantFollows: many(restaurantFollows),
  restaurantUserRecommendations: many(restaurantUserRecommendations),
  restaurantRecommendations: many(restaurantRecommendations),
  addresses: many(userAddresses),
  passwordResetTokens: many(passwordResetTokens),
  accountSetupTokens: many(accountSetupTokens),
  emailVerificationTokens: many(emailVerificationTokens),
  apiKeys: many(apiKeys),
  clientQuotas: many(clientQuotas),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const clientQuotasRelations = relations(clientQuotas, ({ one }) => ({
  user: one(users, {
    fields: [clientQuotas.userId],
    references: [users.id],
  }),
}));

// Video Stories - 15 second recommendations and ads
export const videoStories = pgTable(
  "video_stories",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    restaurantId: varchar("restaurant_id").references(() => restaurants.id, {
      onDelete: "set null",
    }), // Nullable for personal reviews
    title: varchar("title").notNull(),
    description: text("description"),
    // Video metadata
    duration: integer("duration").notNull(), // seconds (10-15)
    videoUrl: text("video_url").notNull(), // Cloudinary URL
    thumbnailUrl: text("thumbnail_url"),
    // Status tracking
    status: varchar("status").notNull().default("processing"), // 'processing' | 'ready' | 'failed' | 'expired'
    // Engagement metrics
    viewCount: integer("view_count").default(0),
    likeCount: integer("like_count").default(0),
    commentCount: integer("comment_count").default(0),
    shareCount: integer("share_count").default(0),
    impressionCount: integer("impression_count").default(0), // Times shown in feed
    engagementScore: decimal("engagement_score", {
      precision: 5,
      scale: 2,
    }).default("0.00"), // Like ratio
    // Tags & search
    hashtags: text("hashtags").array().default([]), // ['#pizza', '#foodie']
    cuisine: varchar("cuisine"), // inherited from restaurant
    // Transcript for SEO/LLMO
    transcript: text("transcript"), // Full text transcript of video (auto-generated or manual)
    transcriptLanguage: varchar("transcript_language").default("en"), // Language code
    transcriptSource: varchar("transcript_source"), // 'auto' | 'manual' | 'edited'
    // Expiration & featured
    createdAt: timestamp("created_at").defaultNow(),
    expiresAt: timestamp("expires_at").default(sql`NOW() + INTERVAL '7 days'`), // 7-day expiration
    deletedAt: timestamp("deleted_at"), // soft delete
    // Featured video system
    isFeatured: boolean("is_featured").default(false), // Currently in restaurant's featured slot
    featuredSlotNumber: integer("featured_slot_number"), // 1, 2, or 3
    featuredStartedAt: timestamp("featured_started_at"), // When featured
    featuredEndedAt: timestamp("featured_ended_at"), // When removed from featured
    // Moderation
    isApproved: boolean("is_approved").default(true),
    flagCount: integer("flag_count").default(0),
  },
  (table) => [
    index("IDX_video_stories_user").on(table.userId, table.createdAt.desc()),
    index("IDX_video_stories_restaurant").on(
      table.restaurantId,
      table.createdAt.desc(),
    ),
    index("IDX_video_stories_expires").on(table.expiresAt),
    index("IDX_video_stories_status").on(table.status),
    index("IDX_video_stories_deleted").on(table.deletedAt),
    index("IDX_video_stories_featured").on(
      table.isFeatured,
      table.featuredSlotNumber,
    ),
  ],
);

// Story Likes (favorites)
export const storyLikes = pgTable(
  "story_likes",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storyId: varchar("story_id")
      .notNull()
      .references(() => videoStories.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_story_likes_story").on(table.storyId, table.createdAt.desc()),
    index("IDX_story_likes_user").on(table.userId, table.createdAt.desc()),
    index("IDX_story_likes_unique").on(table.storyId, table.userId),
  ],
);

// Story Comments
export const storyComments: any = pgTable(
  "story_comments",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storyId: varchar("story_id")
      .notNull()
      .references(() => videoStories.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentCommentId: varchar("parent_comment_id").references(
      (): any => storyComments.id,
      { onDelete: "cascade" },
    ), // for replies
    text: text("text").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    // Moderation
    isApproved: boolean("is_approved").default(true),
  },
  (table) => [
    index("IDX_story_comments_story").on(table.storyId, table.createdAt.desc()),
    index("IDX_story_comments_user").on(table.userId, table.createdAt.desc()),
    index("IDX_story_comments_parent").on(table.parentCommentId),
  ],
);

// Story Views (for analytics)
export const storyViews = pgTable(
  "story_views",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storyId: varchar("story_id")
      .notNull()
      .references(() => videoStories.id, { onDelete: "cascade" }),
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "cascade",
    }), // nullable for anonymous
    viewedAt: timestamp("viewed_at").defaultNow(),
    watchDuration: integer("watch_duration"), // seconds watched
  },
  (table) => [
    index("IDX_story_views_story").on(table.storyId, table.viewedAt.desc()),
    index("IDX_story_views_user").on(table.userId, table.viewedAt.desc()),
  ],
);

// Reviewer Levels (denormalized for performance)
export const userReviewerLevels = pgTable("user_reviewer_levels", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  level: integer("level").default(1), // 1-6
  totalFavorites: integer("total_favorites").default(0),
  totalStories: integer("total_stories").default(0),
  topStoryFavorites: integer("top_story_favorites").default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Video Story Reports - Community moderation system
export const videoStoryReports = pgTable(
  "video_story_reports",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storyId: varchar("story_id")
      .notNull()
      .references(() => videoStories.id, { onDelete: "cascade" }),
    reportedByUserId: varchar("reported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: varchar("reason").notNull(), // 'inappropriate' | 'spam' | 'misleading' | 'offensive' | 'other'
    description: text("description"),
    status: varchar("status").notNull().default("pending"), // 'pending' | 'reviewed' | 'action_taken' | 'dismissed'
    reviewedByAdminId: varchar("reviewed_by_admin_id").references(
      () => users.id,
    ),
    reviewedAt: timestamp("reviewed_at"),
    adminNotes: text("admin_notes"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("IDX_video_reports_story").on(table.storyId, table.createdAt.desc()),
    index("IDX_video_reports_user").on(table.reportedByUserId),
    index("IDX_video_reports_status").on(table.status),
  ],
);

// Feed Ads - House ads and affiliate placements in feed
export const feedAds = pgTable(
  "feed_ads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: varchar("title").notNull(),
    mediaUrl: text("media_url"), // image or video
    targetUrl: text("target_url").notNull(),
    ctaText: varchar("cta_text").default("Learn more"),
    isHouseAd: boolean("is_house_ad").default(false), // our own ads
    isAffiliate: boolean("is_affiliate").default(false),
    affiliateName: varchar("affiliate_name"),
    priority: integer("priority").default(0), // higher shows first
    insertionFrequency: integer("insertion_frequency").default(5), // every N items
    startAt: timestamp("start_at"),
    endAt: timestamp("end_at"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_feed_ads_active").on(table.isActive, table.startAt, table.endAt),
    index("idx_feed_ads_priority").on(table.priority),
  ],
);

// Geo Ads - Location-based onsite campaigns (map/home/deals)
export const geoAds = pgTable(
  "geo_ads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name").notNull(),
    status: varchar("status").notNull().default("draft"),
    placements: jsonb("placements")
      .notNull()
      .default(sql`'[]'::jsonb`),
    title: varchar("title").notNull(),
    body: text("body"),
    mediaUrl: text("media_url"),
    targetUrl: text("target_url").notNull(),
    ctaText: varchar("cta_text").default("Learn more"),
    pinLat: decimal("pin_lat", { precision: 10, scale: 8 }),
    pinLng: decimal("pin_lng", { precision: 11, scale: 8 }),
    geofenceLat: decimal("geofence_lat", { precision: 10, scale: 8 }).notNull(),
    geofenceLng: decimal("geofence_lng", { precision: 11, scale: 8 }).notNull(),
    geofenceRadiusM: integer("geofence_radius_m").notNull().default(1000),
    targetUserTypes: jsonb("target_user_types"),
    minDailyFootTraffic: integer("min_daily_foot_traffic"),
    maxDailyFootTraffic: integer("max_daily_foot_traffic"),
    priority: integer("priority").default(0),
    startAt: timestamp("start_at"),
    endAt: timestamp("end_at"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_geo_ads_status").on(table.status),
    index("idx_geo_ads_schedule").on(table.startAt, table.endAt),
    index("idx_geo_ads_priority").on(table.priority),
    index("idx_geo_ads_geofence").on(table.geofenceLat, table.geofenceLng),
  ],
);

export const geoAdEvents = pgTable(
  "geo_ad_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    adId: varchar("ad_id")
      .notNull()
      .references(() => geoAds.id, { onDelete: "cascade" }),
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    visitorId: varchar("visitor_id"),
    eventType: varchar("event_type").notNull(), // 'impression' | 'click'
    placement: varchar("placement").notNull(), // 'map' | 'home' | 'deals'
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_geo_ad_events_ad").on(table.adId),
    index("idx_geo_ad_events_type").on(table.eventType),
    index("idx_geo_ad_events_created").on(table.createdAt),
    index("idx_geo_ad_events_placement").on(table.placement),
  ],
);

export const geoLocationPings = pgTable(
  "geo_location_pings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    visitorId: varchar("visitor_id"),
    userType: varchar("user_type"),
    lat: decimal("lat", { precision: 10, scale: 8 }).notNull(),
    lng: decimal("lng", { precision: 11, scale: 8 }).notNull(),
    source: varchar("source"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_geo_location_pings_created").on(table.createdAt),
    index("idx_geo_location_pings_coords").on(table.lat, table.lng),
    index("idx_geo_location_pings_visitor").on(table.visitorId),
  ],
);

// Story Awards (for golden forks, etc.)
export const storyAwards = pgTable(
  "story_awards",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storyId: varchar("story_id")
      .notNull()
      .references(() => videoStories.id, { onDelete: "cascade" }),
    awardType: varchar("award_type").notNull(), // 'bronze_fork' | 'silver_fork' | 'gold_fork' | 'platinum_fork'
    awardedAt: timestamp("awarded_at").defaultNow(),
  },
  (table) => [
    index("IDX_story_awards_story").on(table.storyId),
    index("IDX_story_awards_type").on(table.awardType),
    index("IDX_story_awards_date").on(table.awardedAt.desc()),
  ],
);

// Relations
export const videoStoriesRelations = relations(
  videoStories,
  ({ one, many }) => ({
    user: one(users, {
      fields: [videoStories.userId],
      references: [users.id],
    }),
    restaurant: one(restaurants, {
      fields: [videoStories.restaurantId],
      references: [restaurants.id],
    }),
    likes: many(storyLikes),
    comments: many(storyComments),
    views: many(storyViews),
    awards: many(storyAwards),
  }),
);

export const storyLikesRelations = relations(storyLikes, ({ one }) => ({
  story: one(videoStories, {
    fields: [storyLikes.storyId],
    references: [videoStories.id],
  }),
  user: one(users, {
    fields: [storyLikes.userId],
    references: [users.id],
  }),
}));

export const storyCommentsRelations = relations(
  storyComments,
  ({ one, many }) => {
    return {
      story: one(videoStories, {
        fields: [storyComments.storyId],
        references: [videoStories.id],
      }),
      user: one(users, {
        fields: [storyComments.userId],
        references: [users.id],
      }),
      parentComment: one(storyComments, {
        fields: [storyComments.parentCommentId],
        references: [storyComments.id],
      }),
      replies: many(storyComments),
    };
  },
);

export const storyViewsRelations = relations(storyViews, ({ one }) => ({
  story: one(videoStories, {
    fields: [storyViews.storyId],
    references: [videoStories.id],
  }),
  user: one(users, {
    fields: [storyViews.userId],
    references: [users.id],
  }),
}));

export const storyAwardsRelations = relations(storyAwards, ({ one }) => ({
  story: one(videoStories, {
    fields: [storyAwards.storyId],
    references: [videoStories.id],
  }),
}));

export const userReviewerLevelsRelations = relations(
  userReviewerLevels,
  ({ one }) => ({
    user: one(users, {
      fields: [userReviewerLevels.userId],
      references: [users.id],
    }),
  }),
);

export const restaurantsRelations = relations(restaurants, ({ one, many }) => ({
  owner: one(users, {
    fields: [restaurants.ownerId],
    references: [users.id],
  }),
  deals: many(deals),
  reviews: many(reviews),
  verificationRequests: many(verificationRequests),
  foodTruckSessions: many(foodTruckSessions),
  foodTruckLocations: many(foodTruckLocations),
  favorites: many(restaurantFavorites),
  follows: many(restaurantFollows),
  userRecommendations: many(restaurantUserRecommendations),
  recommendations: many(restaurantRecommendations),
  manualSchedules: many(truckManualSchedules),
}));

export const dealsRelations = relations(deals, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [deals.restaurantId],
    references: [restaurants.id],
  }),
  claims: many(dealClaims),
  views: many(dealViews),
  feedback: many(dealFeedback),
}));

export const dealClaimsRelations = relations(dealClaims, ({ one }) => ({
  deal: one(deals, {
    fields: [dealClaims.dealId],
    references: [deals.id],
  }),
  user: one(users, {
    fields: [dealClaims.userId],
    references: [users.id],
  }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [reviews.restaurantId],
    references: [restaurants.id],
  }),
  user: one(users, {
    fields: [reviews.userId],
    references: [users.id],
  }),
}));

export const verificationRequestsRelations = relations(
  verificationRequests,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [verificationRequests.restaurantId],
      references: [restaurants.id],
    }),
    reviewer: one(users, {
      fields: [verificationRequests.reviewerId],
      references: [users.id],
    }),
  }),
);

export const dealViewsRelations = relations(dealViews, ({ one }) => ({
  deal: one(deals, {
    fields: [dealViews.dealId],
    references: [deals.id],
  }),
  user: one(users, {
    fields: [dealViews.userId],
    references: [users.id],
  }),
}));

export const foodTruckSessionsRelations = relations(
  foodTruckSessions,
  ({ one, many }) => ({
    restaurant: one(restaurants, {
      fields: [foodTruckSessions.restaurantId],
      references: [restaurants.id],
    }),
    startedByUser: one(users, {
      fields: [foodTruckSessions.startedByUserId],
      references: [users.id],
    }),
    locations: many(foodTruckLocations),
  }),
);

export const foodTruckLocationsRelations = relations(
  foodTruckLocations,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [foodTruckLocations.restaurantId],
      references: [restaurants.id],
    }),
    session: one(foodTruckSessions, {
      fields: [foodTruckLocations.sessionId],
      references: [foodTruckSessions.id],
    }),
  }),
);

export const restaurantFavoritesRelations = relations(
  restaurantFavorites,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [restaurantFavorites.restaurantId],
      references: [restaurants.id],
    }),
    user: one(users, {
      fields: [restaurantFavorites.userId],
      references: [users.id],
    }),
  }),
);

export const restaurantFollowsRelations = relations(
  restaurantFollows,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [restaurantFollows.restaurantId],
      references: [restaurants.id],
    }),
    user: one(users, {
      fields: [restaurantFollows.userId],
      references: [users.id],
    }),
  }),
);

export const restaurantUserRecommendationsRelations = relations(
  restaurantUserRecommendations,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [restaurantUserRecommendations.restaurantId],
      references: [restaurants.id],
    }),
    user: one(users, {
      fields: [restaurantUserRecommendations.userId],
      references: [users.id],
    }),
  }),
);

export const restaurantRecommendationsRelations = relations(
  restaurantRecommendations,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [restaurantRecommendations.restaurantId],
      references: [restaurants.id],
    }),
    user: one(users, {
      fields: [restaurantRecommendations.userId],
      references: [users.id],
    }),
  }),
);

export const userAddressesRelations = relations(userAddresses, ({ one }) => ({
  user: one(users, {
    fields: [userAddresses.userId],
    references: [users.id],
  }),
}));

export const passwordResetTokensRelations = relations(
  passwordResetTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [passwordResetTokens.userId],
      references: [users.id],
    }),
  }),
);

export const accountSetupTokensRelations = relations(
  accountSetupTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [accountSetupTokens.userId],
      references: [users.id],
    }),
    createdBy: one(users, {
      fields: [accountSetupTokens.createdByUserId],
      references: [users.id],
    }),
  }),
);

export const dealFeedbackRelations = relations(dealFeedback, ({ one }) => ({
  deal: one(deals, {
    fields: [dealFeedback.dealId],
    references: [deals.id],
  }),
  user: one(users, {
    fields: [dealFeedback.userId],
    references: [users.id],
  }),
}));

// Operating hours schema - supports multiple open/close periods per day
export const operatingHoursTimeSlotSchema = z
  .object({
    open: z
      .string()
      .regex(
        /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
        "Time must be in HH:MM format",
      ),
    close: z
      .string()
      .regex(
        /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/,
        "Time must be in HH:MM format",
      ),
  })
  .refine((slot) => {
    const [openHours, openMinutes] = slot.open.split(":").map(Number);
    const [closeHours, closeMinutes] = slot.close.split(":").map(Number);
    const openTime = openHours * 60 + openMinutes;
    const closeTime = closeHours * 60 + closeMinutes;

    // Allow closing time to be earlier than opening time (overnight operation)
    return openTime !== closeTime;
  }, "Open and close times cannot be the same");

export const operatingHoursSchema = z.object({
  mon: z
    .array(operatingHoursTimeSlotSchema)
    .max(3, "Maximum 3 time slots per day")
    .optional(),
  tue: z
    .array(operatingHoursTimeSlotSchema)
    .max(3, "Maximum 3 time slots per day")
    .optional(),
  wed: z
    .array(operatingHoursTimeSlotSchema)
    .max(3, "Maximum 3 time slots per day")
    .optional(),
  thu: z
    .array(operatingHoursTimeSlotSchema)
    .max(3, "Maximum 3 time slots per day")
    .optional(),
  fri: z
    .array(operatingHoursTimeSlotSchema)
    .max(3, "Maximum 3 time slots per day")
    .optional(),
  sat: z
    .array(operatingHoursTimeSlotSchema)
    .max(3, "Maximum 3 time slots per day")
    .optional(),
  sun: z
    .array(operatingHoursTimeSlotSchema)
    .max(3, "Maximum 3 time slots per day")
    .optional(),
});

export const updateRestaurantLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  mobileOnline: z.boolean().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

export const updateRestaurantOperatingHoursSchema = z.object({
  operatingHours: operatingHoursSchema,
});

// Insert schemas
export const insertRestaurantSchema = createInsertSchema(restaurants)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    operatingHours: operatingHoursSchema.optional(),
    description: z.string().max(500).optional().nullable(),
    websiteUrl: z.string().url().optional().nullable().or(z.literal("")),
    instagramUrl: z.string().url().optional().nullable().or(z.literal("")),
    facebookPageUrl: z.string().url().optional().nullable().or(z.literal("")),
    xUrl: z.string().url().optional().nullable().or(z.literal("")),
    socialAutopostSettings: z.record(z.any()).optional().nullable(),
    amenities: z
      .object({
        parking: z.boolean().optional(),
        wifi: z.boolean().optional(),
        outdoor_seating: z.boolean().optional(),
      })
      .optional()
      .nullable(),
    city: z.string().min(1, "City is required"),
    state: z.string().min(2, "State is required"),
  });

// Public owner/signup/claim writes may describe the business, but they may not
// mint ownership, verification, moderation, import provenance, awards, live
// state, pricing locks, or Stripe settlement authority.
export const publicInsertRestaurantSchema = insertRestaurantSchema.omit({
  ownerId: true,
  claimedFromImportId: true,
  countyFips: true,
  countyName: true,
  geoEnrichedAt: true,
  isFoodTruck: true,
  mobileOnline: true,
  currentLatitude: true,
  currentLongitude: true,
  lastBroadcastAt: true,
  liveUntilAt: true,
  isActive: true,
  isVerified: true,
  insuranceVerified: true,
  insuranceVerifiedAt: true,
  insuranceExpiresAt: true,
  insuranceVerifiedByUserId: true,
  rawData: true,
  hasGoldenPlate: true,
  goldenPlateEarnedAt: true,
  goldenPlateCount: true,
  rankingScore: true,
  lockedPriceCents: true,
  priceLockDate: true,
  priceLockReason: true,
  stripeConnectAccountId: true,
  stripeConnectStatus: true,
  stripeOnboardingCompleted: true,
  stripeChargesEnabled: true,
  stripePayoutsEnabled: true,
  orderingApprovedAt: true,
  orderingApprovedByUserId: true,
  orderingApprovalEvidenceUrl: true,
  orderingApprovalReviewNote: true,
  pickupAcknowledgementMinutes: true,
  orderingAuthorityVersion: true,
});

export const insertDealSchema = createInsertSchema(deals)
  .omit({
    id: true,
    currentUses: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    imageUrl: z.string().min(1, "Deal image is required"),
    endDate: z.date().optional().nullable(),
    startTime: z.string().optional().nullable(),
    endTime: z.string().optional().nullable(),
  })
  .refine(
    (data) => {
      // If not ongoing, endDate is required
      if (!data.isOngoing && !data.endDate) {
        return false;
      }
      return true;
    },
    {
      message: "End date is required for non-ongoing deals",
      path: ["endDate"],
    },
  )
  .refine(
    (data) => {
      // If not available during business hours, times are required
      if (
        !data.availableDuringBusinessHours &&
        (!data.startTime || !data.endTime)
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        "Start and end times are required unless available during business hours",
      path: ["startTime"],
    },
  );

export const insertDealClaimSchema = createInsertSchema(dealClaims).omit({
  id: true,
  claimedAt: true,
  usedAt: true,
  isUsed: true,
  orderAmount: true,
});

export const insertDealViewSchema = createInsertSchema(dealViews).omit({
  id: true,
  viewedAt: true,
  createdAt: true,
});

export const insertReviewSchema = createInsertSchema(reviews).omit({
  id: true,
  createdAt: true,
});

export const insertVerificationRequestSchema = createInsertSchema(
  verificationRequests,
)
  .omit({
    id: true,
    submittedAt: true,
    reviewedAt: true,
    reviewerId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    documents: z
      .array(z.string().url())
      .min(1, "At least one document is required")
      .max(5, "Maximum 5 documents allowed")
      .refine(
        (docs) => docs.every((doc) => doc.startsWith("data:")),
        "Documents must be valid base64 data URLs",
      ),
  });

export const insertFoodTruckSessionSchema = createInsertSchema(
  foodTruckSessions,
).omit({
  id: true,
  startedAt: true,
  endedAt: true,
  isActive: true,
  createdAt: true,
});

export const insertFoodTruckLocationSchema = createInsertSchema(
  foodTruckLocations,
)
  .omit({
    id: true,
    recordedAt: true,
    createdAt: true,
  })
  .extend({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    heading: z.number().min(0).max(360).optional(),
    speed: z.number().min(0).max(200).optional(), // Max 200 km/h
    accuracy: z.number().min(0).max(10000).optional(), // Max 10km accuracy
  });

export const updateRestaurantMobileSettingsSchema = z.object({
  isFoodTruck: z.boolean().optional(),
  mobileOnline: z.boolean().optional(),
});

export const insertRestaurantFavoriteSchema = createInsertSchema(
  restaurantFavorites,
).omit({
  id: true,
  favoritedAt: true,
  createdAt: true,
});

export const insertRestaurantFollowSchema = createInsertSchema(
  restaurantFollows,
).omit({
  id: true,
  followedAt: true,
  createdAt: true,
});

export const insertRestaurantUserRecommendationSchema = createInsertSchema(
  restaurantUserRecommendations,
).omit({
  id: true,
  recommendedAt: true,
  createdAt: true,
});

export const insertBusinessStaffInviteSchema = createInsertSchema(
  businessStaffInvites,
).omit({
  id: true,
  tokenHash: true,
  status: true,
  acceptedByUserId: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBusinessStaffMembershipSchema = createInsertSchema(
  businessStaffMemberships,
).omit({
  id: true,
  status: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRestaurantRecommendationSchema = createInsertSchema(
  restaurantRecommendations,
)
  .omit({
    id: true,
    showedAt: true,
    createdAt: true,
  })
  .extend({
    recommendationType: z.enum([
      "homepage",
      "search",
      "nearby",
      "personalized",
    ]),
  });

export const insertUserAddressSchema = createInsertSchema(userAddresses)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    type: z.enum(["home", "work", "other"]),
    label: z
      .string()
      .min(1, "Label is required")
      .max(50, "Label must be less than 50 characters"),
    address: z
      .string()
      .min(1, "Address is required")
      .max(500, "Address must be less than 500 characters"),
    city: z
      .string()
      .min(1, "City is required")
      .max(100, "City must be less than 100 characters"),
    state: z
      .string()
      .max(50, "State must be less than 50 characters")
      .optional(),
    postalCode: z
      .string()
      .max(20, "Postal code must be less than 20 characters")
      .optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  });

export const insertPasswordResetTokenSchema = createInsertSchema(
  passwordResetTokens,
)
  .omit({
    id: true,
    usedAt: true,
    createdAt: true,
  })
  .extend({
    tokenHash: z.string().min(1, "Token hash is required"),
    expiresAt: z
      .date()
      .refine((date) => date > new Date(), "Expiry date must be in the future"),
    requestIp: z.string().ip().optional(),
    userAgent: z
      .string()
      .max(500, "User agent must be less than 500 characters")
      .optional(),
  });

export const insertPhoneVerificationTokenSchema = createInsertSchema(
  phoneVerificationTokens,
)
  .omit({
    id: true,
    usedAt: true,
    createdAt: true,
  })
  .extend({
    phone: z.string().min(10, "Phone number is required"),
    tokenHash: z.string().min(1, "Token hash is required"),
    expiresAt: z
      .date()
      .refine((date) => date > new Date(), "Expiry date must be in the future"),
    requestIp: z.string().optional(),
    userAgent: z
      .string()
      .max(500, "User agent must be less than 500 characters")
      .optional(),
  });

export const insertAccountSetupTokenSchema = createInsertSchema(
  accountSetupTokens,
)
  .omit({
    id: true,
    usedAt: true,
    createdAt: true,
  })
  .extend({
    tokenHash: z.string().min(1, "Token hash is required"),
    expiresAt: z
      .date()
      .refine((date) => date > new Date(), "Expiry date must be in the future"),
    requestIp: z.string().ip().optional(),
    userAgent: z
      .string()
      .max(500, "User agent must be less than 500 characters")
      .optional(),
  });

export const insertDealFeedbackSchema = createInsertSchema(dealFeedback)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    rating: z
      .number()
      .int()
      .min(0, "Rating must be at least 0")
      .max(5, "Rating must be at most 5"),
    feedbackType: z.enum(["worked", "suggestion", "issue"]),
    comment: z
      .string()
      .max(500, "Comment must be less than 500 characters")
      .optional()
      .nullable(),
    isHelpful: z.boolean().optional().nullable(),
  });

// Video Stories insert schemas
export const insertVideoStorySchema = createInsertSchema(videoStories)
  .omit({
    id: true,
    viewCount: true,
    likeCount: true,
    commentCount: true,
    shareCount: true,
    createdAt: true,
    expiresAt: true,
    deletedAt: true,
    flagCount: true,
  })
  .extend({
    title: z
      .string()
      .min(1, "Title is required")
      .max(100, "Title must be less than 100 characters"),
    description: z
      .string()
      .max(500, "Description must be less than 500 characters")
      .optional()
      .nullable(),
    duration: z
      .number()
      .int()
      .min(10, "Duration must be at least 10 seconds")
      .max(15, "Duration must not exceed 15 seconds"),
    videoUrl: z.string().url("Video URL must be a valid URL"),
    thumbnailUrl: z
      .string()
      .url("Thumbnail URL must be a valid URL")
      .optional()
      .nullable(),
    cuisine: z
      .string()
      .max(50, "Cuisine must be less than 50 characters")
      .optional()
      .nullable(),
    hashtags: z
      .array(z.string().regex(/^#/, "Hashtags must start with #"))
      .max(10, "Maximum 10 hashtags allowed")
      .optional(),
  });

export const insertStoryLikeSchema = createInsertSchema(storyLikes).omit({
  id: true,
  createdAt: true,
});

export const insertStoryCommentSchema = createInsertSchema(storyComments)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    text: z
      .string()
      .min(1, "Comment text is required")
      .max(500, "Comment must be less than 500 characters"),
  });

export const insertStoryViewSchema = createInsertSchema(storyViews)
  .omit({
    id: true,
    viewedAt: true,
  })
  .extend({
    watchDuration: z.number().int().min(0).optional(),
  });

export const insertStoryAwardSchema = createInsertSchema(storyAwards)
  .omit({
    id: true,
    awardedAt: true,
  })
  .extend({
    awardType: z.enum([
      "bronze_fork",
      "silver_fork",
      "gold_fork",
      "platinum_fork",
    ]),
  });

// Types
export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;

// User-specific data types
export type FacebookUserData = {
  facebookId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
  facebookAccessToken?: string | null;
};

export type GoogleUserData = {
  googleId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
  googleAccessToken?: string | null;
};

export type TradeScoutUserData = {
  tradescoutId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  roles?: string[] | null;
};

export type EmailUserData = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  passwordHash: string;
};
export type InsertRestaurant = z.infer<typeof insertRestaurantSchema>;
export type Restaurant = typeof restaurants.$inferSelect;
export type TruckImportBatch = typeof truckImportBatches.$inferSelect;
export type TruckImportListing = typeof truckImportListings.$inferSelect;
export type TruckClaimRequest = typeof truckClaimRequests.$inferSelect;

// Live location state (computed server-side, exposed to client)
export type LocationState = "green" | "amber" | "hidden";

// Extended restaurant with live location state
export type RestaurantWithLocation = Restaurant & {
  location_state?: LocationState;
  last_confirmed_at?: Date | null;
};

export type InsertDeal = z.infer<typeof insertDealSchema>;
export type Deal = typeof deals.$inferSelect;
export type InsertDealClaim = z.infer<typeof insertDealClaimSchema>;
export type DealClaim = typeof dealClaims.$inferSelect;

export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Review = typeof reviews.$inferSelect;

export type InsertVerificationRequest = z.infer<
  typeof insertVerificationRequestSchema
>;
export type VerificationRequest = typeof verificationRequests.$inferSelect;

export type InsertDealView = z.infer<typeof insertDealViewSchema>;
export type DealView = typeof dealViews.$inferSelect;

export type InsertFoodTruckSession = z.infer<
  typeof insertFoodTruckSessionSchema
>;
export type FoodTruckSession = typeof foodTruckSessions.$inferSelect;

export type InsertFoodTruckLocation = z.infer<
  typeof insertFoodTruckLocationSchema
>;
export type FoodTruckLocation = typeof foodTruckLocations.$inferSelect;

export type UpdateRestaurantMobileSettings = z.infer<
  typeof updateRestaurantMobileSettingsSchema
>;

export type InsertRestaurantFavorite = z.infer<
  typeof insertRestaurantFavoriteSchema
>;
export type RestaurantFavorite = typeof restaurantFavorites.$inferSelect;

export type InsertRestaurantFollow = z.infer<
  typeof insertRestaurantFollowSchema
>;
export type RestaurantFollow = typeof restaurantFollows.$inferSelect;

export type InsertRestaurantUserRecommendation = z.infer<
  typeof insertRestaurantUserRecommendationSchema
>;
export type RestaurantUserRecommendation =
  typeof restaurantUserRecommendations.$inferSelect;
export type InsertMenuItemRecommendation = z.infer<
  typeof insertMenuItemRecommendationSchema
>;
export type MenuItemRecommendation = typeof menuItemRecommendations.$inferSelect;
export type InsertMenuItemPhoto = z.infer<typeof insertMenuItemPhotoSchema>;
export type MenuItemPhoto = typeof menuItemPhotos.$inferSelect;

export type InsertBusinessStaffInvite = z.infer<
  typeof insertBusinessStaffInviteSchema
>;
export type BusinessStaffInvite = typeof businessStaffInvites.$inferSelect;

export type InsertBusinessStaffMembership = z.infer<
  typeof insertBusinessStaffMembershipSchema
>;
export type BusinessStaffMembership =
  typeof businessStaffMemberships.$inferSelect;

export type InsertRestaurantRecommendation = z.infer<
  typeof insertRestaurantRecommendationSchema
>;
export type RestaurantRecommendation =
  typeof restaurantRecommendations.$inferSelect;

export type InsertUserAddress = z.infer<typeof insertUserAddressSchema>;
export type UserAddress = typeof userAddresses.$inferSelect;

export type InsertPasswordResetToken = z.infer<
  typeof insertPasswordResetTokenSchema
>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPhoneVerificationToken = z.infer<
  typeof insertPhoneVerificationTokenSchema
>;
export type PhoneVerificationToken =
  typeof phoneVerificationTokens.$inferSelect;

export type InsertAccountSetupToken = z.infer<
  typeof insertAccountSetupTokenSchema
>;
export type AccountSetupToken = typeof accountSetupTokens.$inferSelect;

export type InsertDealFeedback = z.infer<typeof insertDealFeedbackSchema>;
export type DealFeedback = typeof dealFeedback.$inferSelect;

// Video Stories types
export type InsertVideoStory = z.infer<typeof insertVideoStorySchema>;
export type VideoStory = typeof videoStories.$inferSelect;

export type InsertStoryLike = z.infer<typeof insertStoryLikeSchema>;
export type StoryLike = typeof storyLikes.$inferSelect;

export type InsertStoryComment = z.infer<typeof insertStoryCommentSchema>;
export type StoryComment = typeof storyComments.$inferSelect;

export type InsertStoryView = z.infer<typeof insertStoryViewSchema>;
export type StoryView = typeof storyViews.$inferSelect;

export type InsertStoryAward = z.infer<typeof insertStoryAwardSchema>;
export type StoryAward = typeof storyAwards.$inferSelect;

export type UserReviewerLevel = typeof userReviewerLevels.$inferSelect;

// Support tickets for user help requests
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subject: varchar("subject").notNull(),
    description: text("description").notNull(),
    category: varchar("category").notNull(), // 'bug' | 'feature' | 'payment' | 'account' | 'other'
    priority: varchar("priority").default("normal"), // 'low' | 'normal' | 'high' | 'critical'
    status: varchar("status").default("open"), // 'open' | 'in-progress' | 'resolved' | 'closed'
    adminNotes: text("admin_notes"),
    assignedToAdminId: varchar("assigned_to_admin_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`now()`),
    resolvedAt: timestamp("resolved_at"),
    resolvedByAdminId: varchar("resolved_by_admin_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    index("idx_support_tickets_user_id").on(table.userId),
    index("idx_support_tickets_status").on(table.status),
    index("idx_support_tickets_created_at").on(table.createdAt),
  ],
);

// Moderation events for tracking content flags, abuse, policy violations
export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventType: varchar("event_type").notNull(), // 'deal_flagged' | 'review_flagged' | 'user_reported' | 'content_removed' | 'user_warned' | 'user_suspended'
    severity: varchar("severity").notNull().default("medium"), // 'low' | 'medium' | 'high' | 'critical'
    reportedUserId: varchar("reported_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    reportedResourceType: varchar("reported_resource_type"), // 'deal' | 'review' | 'user' | 'comment'
    reportedResourceId: varchar("reported_resource_id"),
    reporterUserId: varchar("reporter_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: varchar("reason").notNull(),
    description: text("description"),
    metadata: jsonb("metadata"), // Additional context
    status: varchar("status").default("open"), // 'open' | 'under-review' | 'dismissed' | 'action-taken'
    actionTaken: varchar("action_taken"), // 'none' | 'warning' | 'content-removed' | 'suspension' | 'ban'
    reviewedByAdminId: varchar("reviewed_by_admin_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`now()`),
    reviewedAt: timestamp("reviewed_at"),
  },
  (table) => [
    index("idx_moderation_events_status").on(table.status),
    index("idx_moderation_events_severity").on(table.severity),
    index("idx_moderation_events_created_at").on(table.createdAt),
    index("idx_moderation_events_reported_user").on(table.reportedUserId),
  ],
);

// Affiliate tracking for user-generated referrals
export const affiliateLinks = pgTable(
  "affiliate_links",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    affiliateUserId: varchar("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code: varchar("code").notNull().unique(), // Short unique code like "UX72A91"
    resourceType: varchar("resource_type").notNull(), // 'deal' | 'restaurant' | 'page' | 'collection' | 'search'
    resourceId: varchar("resource_id"), // Optional - the thing being shared
    sourceUrl: text("source_url").notNull(), // Original URL they shared from
    fullUrl: text("full_url").notNull(), // Full URL with ref param
    clickCount: integer("click_count").default(0),
    conversions: integer("conversions").default(0), // Number of signups attributed
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_affiliate_links_user").on(table.affiliateUserId),
    index("idx_affiliate_links_code").on(table.code),
    index("idx_affiliate_links_created").on(table.createdAt),
  ],
);

// Track affiliate clicks and conversions
export const affiliateClicks = pgTable(
  "affiliate_clicks",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    affiliateLinkId: varchar("affiliate_link_id")
      .notNull()
      .references(() => affiliateLinks.id, { onDelete: "cascade" }),
    visitorIp: varchar("visitor_ip"),
    visitorUserAgent: text("visitor_user_agent"),
    referrerSource: varchar("referrer_source"), // 'organic' | 'direct' | 'referrer_url'
    clickedAt: timestamp("clicked_at").defaultNow(),
    convertedAt: timestamp("converted_at"), // Null until they signup
    restaurantSignupId: varchar("restaurant_signup_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    sessionId: varchar("session_id"), // First-click attribution
  },
  (table) => [
    index("idx_affiliate_clicks_link").on(table.affiliateLinkId),
    index("idx_affiliate_clicks_session").on(table.sessionId),
    index("idx_affiliate_clicks_created").on(table.clickedAt),
  ],
);

// Commission tracking - monthly record of earnings
export const affiliateCommissions = pgTable(
  "affiliate_commissions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    affiliateUserId: varchar("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    restaurantUserId: varchar("restaurant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    affiliateLinkId: varchar("affiliate_link_id").references(
      () => affiliateLinks.id,
      { onDelete: "set null" },
    ),
    commissionAmount: decimal("commission_amount", {
      precision: 10,
      scale: 2,
    }).notNull(), // Dollar amount earned
    commissionPercent: integer("commission_percent").notNull(), // e.g., 10 for 10%
    basedOn: varchar("based_on").notNull(), // 'restaurant_subscription' | 'subscription_value'
    subscriptionValue: decimal("subscription_value", {
      precision: 10,
      scale: 2,
    }), // What restaurant paid
    billingCycle: varchar("billing_cycle").notNull(), // 'month' | '3-month' | 'year'
    forMonth: varchar("for_month").notNull(), // YYYY-MM for which month this commission is for
    status: varchar("status").notNull().default("pending"), // 'pending' | 'paid' | 'rejected'
    paidAt: timestamp("paid_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_commissions_affiliate").on(table.affiliateUserId),
    index("idx_commissions_restaurant").on(table.restaurantUserId),
    index("idx_commissions_status").on(table.status),
    index("idx_commissions_month").on(table.forMonth),
  ],
);

// Affiliate wallet - tracks balance, credits, and cash outs
export const affiliateWallet = pgTable(
  "affiliate_wallet",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    totalEarned: decimal("total_earned", { precision: 12, scale: 2 }).default(
      "0",
    ),
    availableBalance: decimal("available_balance", {
      precision: 12,
      scale: 2,
    }).default("0"),
    pendingCommissions: decimal("pending_commissions", {
      precision: 12,
      scale: 2,
    }).default("0"),
    totalWithdrawn: decimal("total_withdrawn", {
      precision: 12,
      scale: 2,
    }).default("0"),
    totalSpent: decimal("total_spent", { precision: 12, scale: 2 }).default(
      "0",
    ),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_wallet_user").on(table.userId)],
);

// Withdrawal requests / Cash out requests
export const affiliateWithdrawals = pgTable(
  "affiliate_withdrawals",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    method: varchar("method").notNull(), // 'paypal' | 'ach' | 'other'
    status: varchar("status").notNull().default("pending"), // 'pending' | 'processing' | 'completed' | 'failed'
    methodDetails: jsonb("method_details"), // Bank account, PayPal email, etc
    creditLedgerId: varchar("credit_ledger_id").references(
      () => creditLedger.id,
      { onDelete: "set null" },
    ),
    approvedAt: timestamp("approved_at"),
    approvedBy: varchar("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    paidAt: timestamp("paid_at"),
    rejectedAt: timestamp("rejected_at"),
    requestedAt: timestamp("requested_at").defaultNow(),
    processedAt: timestamp("processed_at"),
    notes: text("notes"),
  },
  (table) => [
    index("idx_withdrawals_user").on(table.userId),
    index("idx_withdrawals_status").on(table.status),
    index("idx_withdrawals_created").on(table.requestedAt),
  ],
);

// Location Requests: businesses hosting food trucks
export const locationRequests = pgTable(
  "location_requests",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    postedByUserId: varchar("posted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessName: varchar("business_name").notNull(),
    address: text("address").notNull(),
    locationType: varchar("location_type").notNull(), // 'office' | 'bar' | 'brewery' | 'other'
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),
    preferredDates: jsonb("preferred_dates").notNull(), // string[] of ISO dates
    expectedFootTraffic: integer("expected_foot_traffic").notNull(),
    minInterestedTrucks: integer("min_interested_trucks").notNull().default(3),
    demandStatus: varchar("demand_status").notNull().default("collecting"), // 'collecting' | 'threshold_met' | 'claimed' | 'expired' | 'fulfilled'
    thresholdReachedAt: timestamp("threshold_reached_at"),
    notes: text("notes"),
    status: varchar("status").notNull().default("open"), // 'open' | 'fulfilled' | 'expired'
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_location_requests_user").on(table.postedByUserId),
    index("idx_location_requests_status").on(table.status),
    index("idx_location_requests_demand_status").on(table.demandStatus),
    index("idx_location_requests_created").on(table.createdAt),
  ],
);

// Truck Interest: food trucks expressing interest in a location request
export const truckInterests = pgTable(
  "truck_interests",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationRequestId: varchar("location_request_id")
      .notNull()
      .references(() => locationRequests.id, { onDelete: "cascade" }),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    message: text("message"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_truck_interests_request").on(table.locationRequestId),
    index("idx_truck_interests_restaurant").on(table.restaurantId),
    index("idx_truck_interests_created").on(table.createdAt),
    unique("uq_truck_interests_request_restaurant").on(
      table.locationRequestId,
      table.restaurantId,
    ),
  ],
);

// Host Location Claims: hosts claiming demand-backed locations
export const hostLocationClaims = pgTable(
  "host_location_claims",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationRequestId: varchar("location_request_id")
      .notNull()
      .references(() => locationRequests.id, { onDelete: "cascade" }),
    claimedByUserId: varchar("claimed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hostId: varchar("host_id"),
    status: varchar("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected' | 'converted'
    message: text("message"),
    createdAt: timestamp("created_at").defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => [
    index("idx_host_location_claims_request").on(table.locationRequestId),
    index("idx_host_location_claims_user").on(table.claimedByUserId),
    index("idx_host_location_claims_status").on(table.status),
    unique("uq_host_location_claims_active_request_user").on(
      table.locationRequestId,
      table.claimedByUserId,
    ),
  ],
);

// Hosts: Persistent profiles for businesses hosting food trucks
export const hosts = pgTable(
  "hosts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessName: varchar("business_name").notNull(),
    address: text("address").notNull(),
    city: varchar("city"),
    state: varchar("state"),
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),
    locationType: varchar("location_type").notNull(), // 'office' | 'bar' | 'brewery' | 'other'
    expectedFootTraffic: integer("expected_foot_traffic"),
    amenities: jsonb("amenities"), // { power: boolean, wifi: boolean, seating: boolean, etc }
    websiteUrl: text("website_url"),
    instagramUrl: text("instagram_url"),
    facebookPageUrl: text("facebook_page_url"),
    xUrl: text("x_url"),
    logoUrl: text("logo_url"),
    coverImageUrl: text("cover_image_url"),
    contactPhone: varchar("contact_phone"),
    notes: text("notes"),
    isVerified: boolean("is_verified").default(false),
    adminCreated: boolean("admin_created").default(false),
    spotCount: integer("spot_count").notNull().default(1),

    // Parking Pass pricing defaults (simple model: host address + any price => bookable).
    // These are synced into the host's parking_pass series as an implementation detail.
    parkingPassBreakfastPriceCents: integer(
      "parking_pass_breakfast_price_cents",
    )
      .notNull()
      .default(0),
    parkingPassLunchPriceCents: integer("parking_pass_lunch_price_cents")
      .notNull()
      .default(0),
    parkingPassDinnerPriceCents: integer("parking_pass_dinner_price_cents")
      .notNull()
      .default(0),
    parkingPassDailyPriceCents: integer("parking_pass_daily_price_cents")
      .notNull()
      .default(0),
    parkingPassWeeklyPriceCents: integer("parking_pass_weekly_price_cents")
      .notNull()
      .default(0),
    parkingPassMonthlyPriceCents: integer("parking_pass_monthly_price_cents")
      .notNull()
      .default(0),
    parkingPassStartTime: varchar("parking_pass_start_time"),
    parkingPassEndTime: varchar("parking_pass_end_time"),
    parkingPassDaysOfWeek: jsonb("parking_pass_days_of_week")
      .notNull()
      .default(sql`'[]'::jsonb`),

    // Stripe Connect for receiving payments
    stripeConnectAccountId: varchar("stripe_connect_account_id"),
    stripeConnectStatus: varchar("stripe_connect_status").default("pending"),
    stripeOnboardingCompleted: boolean("stripe_onboarding_completed").default(
      false,
    ),
    stripeChargesEnabled: boolean("stripe_charges_enabled").default(false),
    stripePayoutsEnabled: boolean("stripe_payouts_enabled").default(false),
    spotImageUrl: text("spot_image_url"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_hosts_user").on(table.userId),
    index("idx_hosts_verified").on(table.isVerified),
    index("idx_hosts_location").on(table.latitude, table.longitude),
    index("idx_hosts_stripe_account").on(table.stripeConnectAccountId),
  ],
);

// Track every link shared by a user (for affiliate analytics)
export const affiliateShareEvents = pgTable(
  "affiliate_share_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    affiliateUserId: varchar("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceType: varchar("resource_type").notNull(),
    resourceId: varchar("resource_id"),
    destinationUrl: text("destination_url").notNull(),
    shareMethod: varchar("share_method"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_affiliate_share_user").on(table.affiliateUserId),
    index("idx_affiliate_share_created").on(table.createdAt),
  ],
);

// Email verification tokens for new accounts
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    requestIp: varchar("request_ip"),
    userAgent: varchar("user_agent"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_email_verification_user").on(table.userId, table.createdAt),
    index("idx_email_verification_token").on(table.tokenHash),
    index("idx_email_verification_expires").on(table.expiresAt),
    index("idx_email_verification_used").on(table.usedAt),
  ],
);

export const parkingPassBlackoutDates = pgTable(
  "parking_pass_blackout_dates",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    seriesId: varchar("series_id")
      .notNull()
      .references(() => eventSeries.id, { onDelete: "cascade" }),
    date: timestamp("date").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_pass_blackout_series").on(table.seriesId),
    index("idx_pass_blackout_date").on(table.date),
    unique("uq_pass_blackout_date").on(table.seriesId, table.date),
  ],
);

// Events: Specific slots created by hosts for food trucks
// Event Series: Multi-day or recurring event configurations (Open Calls)
export const eventSeries = pgTable(
  "event_series",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: varchar("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    coordinatorUserId: varchar("coordinator_user_id").references(
      () => users.id,
      {
        onDelete: "set null",
      },
    ),
    name: varchar("name").notNull(), // e.g. "Summer Market Series"
    description: text("description"),
    timezone: varchar("timezone").notNull().default("America/New_York"), // IANA timezone
    recurrenceRule: text("recurrence_rule"), // RFC5545 RRULE or simplified pattern
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date").notNull(),
    // Defaults applied to generated occurrences
    defaultStartTime: varchar("default_start_time").notNull(), // HH:MM
    defaultEndTime: varchar("default_end_time").notNull(), // HH:MM
    defaultMaxTrucks: integer("default_max_trucks").notNull().default(1),
    defaultHardCapEnabled: boolean("default_hard_cap_enabled").default(false),
    // Series type: used to virtualize Parking Pass listings without materializing occurrences.
    seriesType: varchar("series_type").notNull().default("event"), // 'event' | 'open_call' | 'parking_pass'
    // Parking Pass: days of week as JSON array of numbers (0=Sun..6=Sat).
    parkingPassDaysOfWeek: jsonb("parking_pass_days_of_week")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Parking Pass: default pricing used for virtual occurrences.
    defaultBreakfastPriceCents: integer("default_breakfast_price_cents")
      .notNull()
      .default(0),
    defaultLunchPriceCents: integer("default_lunch_price_cents")
      .notNull()
      .default(0),
    defaultDinnerPriceCents: integer("default_dinner_price_cents")
      .notNull()
      .default(0),
    defaultDailyPriceCents: integer("default_daily_price_cents")
      .notNull()
      .default(0),
    defaultWeeklyPriceCents: integer("default_weekly_price_cents")
      .notNull()
      .default(0),
    defaultMonthlyPriceCents: integer("default_monthly_price_cents")
      .notNull()
      .default(0),
    defaultHostPriceCents: integer("default_host_price_cents")
      .notNull()
      .default(0),
    status: varchar("status").notNull().default("draft"), // 'draft' | 'published' | 'closed'
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_event_series_host").on(table.hostId),
    index("idx_event_series_coordinator_user").on(table.coordinatorUserId),
    index("idx_event_series_status").on(table.status),
    index("idx_event_series_dates").on(table.startDate, table.endDate),
  ],
);

export const events = pgTable(
  "events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: varchar("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    coordinatorUserId: varchar("coordinator_user_id").references(
      () => users.id,
      {
        onDelete: "set null",
      },
    ),
    seriesId: varchar("series_id").references(() => eventSeries.id, {
      onDelete: "set null",
    }), // Open Calls: FK to parent series
    name: varchar("name"), // e.g. "Friday Lunch"
    description: text("description"),
    eventType: varchar("event_type").notNull().default("event"),
    date: timestamp("date").notNull(),
    startTime: varchar("start_time").notNull(), // HH:MM
    endTime: varchar("end_time").notNull(), // HH:MM
    maxTrucks: integer("max_trucks").notNull().default(1),
    status: varchar("status").notNull().default("open"), // 'open' | 'booked' | 'cancelled' | 'completed'
    bookedRestaurantId: varchar("booked_restaurant_id").references(
      () => restaurants.id,
      { onDelete: "set null" },
    ),
    // Capacity Guard v2.2
    hardCapEnabled: boolean("hard_cap_enabled").default(false),
    // Pricing for Parking Pass
    hostPriceCents: integer("host_price_cents"), // Host sets this, NULL = free
    breakfastPriceCents: integer("breakfast_price_cents"),
    lunchPriceCents: integer("lunch_price_cents"),
    dinnerPriceCents: integer("dinner_price_cents"),
    dailyPriceCents: integer("daily_price_cents"),
    weeklyPriceCents: integer("weekly_price_cents"),
    monthlyPriceCents: integer("monthly_price_cents"),
    requiresPayment: boolean("requires_payment").default(false),
    stripeProductId: varchar("stripe_product_id"),
    stripePriceId: varchar("stripe_price_id"),
    unbookedNotificationSentAt: timestamp("unbooked_notification_sent_at"),
    lastConfirmedAt: timestamp("last_confirmed_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_events_host").on(table.hostId),
    index("idx_events_coordinator_user").on(table.coordinatorUserId),
    index("idx_events_series").on(table.seriesId),
    index("idx_events_date").on(table.date),
    index("idx_events_status").on(table.status),
    index("idx_events_type").on(table.eventType),
    index("idx_events_booked_restaurant").on(table.bookedRestaurantId),
    index("idx_events_requires_payment").on(table.requiresPayment),
    index("idx_events_last_confirmed").on(table.lastConfirmedAt),
  ],
);

// Event Interests: Trucks expressing interest in specific events
export const eventInterests = pgTable(
  "event_interests",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventId: varchar("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    truckId: varchar("truck_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    message: varchar("message", { length: 200 }), // Optional intro
    status: varchar("status").notNull().default("pending"), // 'pending' | 'accepted' | 'declined'
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_event_interests_event").on(table.eventId),
    index("idx_event_interests_truck").on(table.truckId),
    unique("uq_event_interests_event_truck").on(table.eventId, table.truckId),
  ],
);

// Host Location Reviews: Food trucks can review host locations
export const hostReviews = pgTable(
  "host_reviews",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: varchar("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    truckId: varchar("truck_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }), // Food truck owner
    rating: integer("rating").notNull(), // 1-5 stars
    comment: text("comment"),
    // Specific feedback categories
    trafficRating: integer("traffic_rating"), // 1-5, how busy was the location
    amenitiesRating: integer("amenities_rating"), // 1-5, power, wifi, etc.
    hostCommunicationRating: integer("host_communication_rating"), // 1-5
    wouldReturnAgain: boolean("would_return_again").default(true),
    // Admin moderation
    isApproved: boolean("is_approved").default(true),
    flaggedReason: text("flagged_reason"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_host_reviews_host").on(table.hostId),
    index("idx_host_reviews_truck").on(table.truckId),
    index("idx_host_reviews_user").on(table.userId),
    index("idx_host_reviews_rating").on(table.rating),
    index("idx_host_reviews_approved").on(table.isApproved),
    // Ensure one review per truck per host location
    unique("uq_host_reviews_host_truck").on(table.hostId, table.truckId),
  ],
);

// Event Bookings: Parking Pass payments with host pricing + $10 MealScout fee
export const eventBookings = pgTable(
  "event_bookings",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventId: varchar("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    truckId: varchar("truck_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    hostId: varchar("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    // Pricing (locked at booking time so changes don't affect existing bookings)
    hostPriceCents: integer("host_price_cents").notNull(), // What host set
    platformFeeCents: integer("platform_fee_cents").notNull().default(1000), // Always $10
    slotType: varchar("slot_type"),
    totalCents: integer("total_cents").notNull(), // host_price + platform_fee (what truck pays)
    // Payment status
    status: varchar("status").notNull().default("pending"), // 'pending' | 'confirmed' | 'cancelled' | 'refunded'
    stripePaymentIntentId: varchar("stripe_payment_intent_id"),
    stripePaymentStatus: varchar("stripe_payment_status"), // 'pending' | 'succeeded' | 'failed'
    paidAt: timestamp("paid_at"),
    // Stripe Connect (splits payment between platform and host)
    stripeApplicationFeeAmount: integer(
      "stripe_application_fee_amount",
    ).default(1000), // Always $10 to platform
    stripeTransferDestination: varchar("stripe_transfer_destination"), // Host's Stripe Connect account ID
    // Refunds
    refundStatus: varchar("refund_status").default("none"), // 'none' | 'partial' | 'full'
    refundAmountCents: integer("refund_amount_cents"),
    refundedAt: timestamp("refunded_at"),
    refundReason: text("refund_reason"),
    // Metadata
    spotNumber: integer("spot_number"),
    bookingConfirmedAt: timestamp("booking_confirmed_at"),
    cancelledAt: timestamp("cancelled_at"),
    cancellationReason: text("cancellation_reason"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_bookings_event").on(table.eventId),
    index("idx_bookings_truck").on(table.truckId),
    index("idx_bookings_host").on(table.hostId),
    index("idx_bookings_status").on(table.status),
    index("idx_bookings_payment_intent").on(table.stripePaymentIntentId),
    index("idx_bookings_created").on(table.createdAt),
    // One booking per truck per event
    uniqueIndex("uq_bookings_event_truck_active").on(table.eventId, table.truckId)
      .where(sql`${table.status} IN ('pending', 'confirmed')`),
  ],
);

// Manual schedule entries for food trucks (non-MealScout spots)
export const truckManualSchedules = pgTable(
  "truck_manual_schedules",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    truckId: varchar("truck_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    date: timestamp("date").notNull(),
    startTime: varchar("start_time"),
    endTime: varchar("end_time"),
    locationName: varchar("location_name"),
    address: varchar("address"),
    city: varchar("city"),
    state: varchar("state"),
    notes: text("notes"),
    isPublic: boolean("is_public").default(true),
    status: varchar("status").default("open"),
    scheduleType: varchar("schedule_type"),
    timezone: varchar("timezone"),
    sourceType: varchar("source_type"),
    sourceArtifact: varchar("source_artifact"),
    sourceConfidence: varchar("source_confidence"),
    ownerSubmittedEquivalent: boolean("owner_submitted_equivalent").default(false),
    recurring: boolean("recurring").default(false),
    expiresAt: timestamp("expires_at"),
    geocodeStatus: varchar("geocode_status"),
    mapEligible: boolean("map_eligible").default(true),
    liveFeedEligible: boolean("live_feed_eligible").default(true),
    lastConfirmedAt: timestamp("last_confirmed_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_truck_manual_schedule_truck").on(table.truckId, table.date),
    index("idx_truck_manual_schedule_last_confirmed").on(table.lastConfirmedAt),
    index("idx_truck_manual_schedule_status").on(table.truckId, table.status, table.date),
    index("idx_truck_manual_schedule_expires").on(table.expiresAt),
  ],
);

// Daily parking reports for food trucks (Parking Pass + manual stops)
export const truckParkingReports = pgTable(
  "truck_parking_reports",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    truckId: varchar("truck_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    date: timestamp("date").notNull(),
    sourceType: varchar("source_type").notNull().default("booking"),
    bookingId: varchar("booking_id").references(() => eventBookings.id, {
      onDelete: "set null",
    }),
    manualScheduleId: varchar("manual_schedule_id").references(
      () => truckManualSchedules.id,
      { onDelete: "set null" },
    ),
    hostId: varchar("host_id").references(() => hosts.id, {
      onDelete: "set null",
    }),
    locationName: varchar("location_name"),
    address: varchar("address"),
    city: varchar("city"),
    state: varchar("state"),
    rating: integer("rating"),
    arrivalCleanliness: integer("arrival_cleanliness"),
    customersServed: integer("customers_served"),
    salesCents: integer("sales_cents"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_truck_parking_reports_truck").on(table.truckId, table.date),
    index("idx_truck_parking_reports_date").on(table.date),
    index("idx_truck_parking_reports_booking").on(table.bookingId),
    index("idx_truck_parking_reports_manual").on(table.manualScheduleId),
    unique("uq_truck_parking_reports_booking").on(table.bookingId),
    unique("uq_truck_parking_reports_manual").on(table.manualScheduleId),
  ],
);

// PHASE 1: Referral tracking - "who brought who"
export const referrals = pgTable(
  "referrals",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    affiliateUserId: varchar("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referredRestaurantId: varchar("referred_restaurant_id").references(
      () => restaurants.id,
      { onDelete: "set null" },
    ),
    clickedAt: timestamp("clicked_at").notNull(),
    signedUpAt: timestamp("signed_up_at"),
    activatedAt: timestamp("activated_at"),
    commissionEligibleAt: timestamp("commission_eligible_at"),
    status: varchar("status").notNull().default("clicked"), // 'clicked' | 'signed_up' | 'activated' | 'paid'
  },
  (table) => [
    index("idx_referrals_affiliate").on(table.affiliateUserId),
    index("idx_referrals_restaurant").on(table.referredRestaurantId),
    index("idx_referrals_status").on(table.status),
    index("idx_referrals_clicked").on(table.clickedAt),
  ],
);

// PHASE 1: Referral click tracking - records every click on an affiliate link
export const referralClicks = pgTable(
  "referral_clicks",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    affiliateUserId: varchar("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    userAgent: text("user_agent"),
    ip: varchar("ip"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_referral_clicks_affiliate").on(table.affiliateUserId),
    index("idx_referral_clicks_created").on(table.createdAt),
  ],
);

// PHASE 3: Commission ledger - tracks all commissions earned
export const affiliateCommissionLedger = pgTable(
  "affiliate_commission_ledger",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    affiliateUserId: varchar("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referralId: varchar("referral_id").references(() => referrals.id, {
      onDelete: "set null",
    }),
    restaurantId: varchar("restaurant_id").references(() => restaurants.id, {
      onDelete: "set null",
    }),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    commissionPercent: integer("commission_percent"),
    sourceAmountCents: integer("source_amount_cents"),
    commissionSource: varchar("commission_source").notNull(), // 'subscription_payment' | 'restaurant_signup' etc
    stripeInvoiceId: varchar("stripe_invoice_id"), // For referencing the invoice that triggered this
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_commission_ledger_affiliate").on(table.affiliateUserId),
    index("idx_commission_ledger_referral").on(table.referralId),
    index("idx_commission_ledger_created").on(table.createdAt),
  ],
);

// PHASE 4: Credit ledger - tracks user credits (balance never stored, derived from SUM)
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(), // Positive or negative
    sourceType: varchar("source_type").notNull(), // 'commission' | 'redemption' | 'adjustment' etc
    sourceId: varchar("source_id"), // ID of the commission, redemption, etc
    redeemedAt: timestamp("redeemed_at"), // NULL if unused
    redeemedFor: varchar("redeemed_for"), // 'restaurant' | 'cash_payout' etc when redeemed
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_credit_ledger_user").on(table.userId),
    index("idx_credit_ledger_source").on(table.sourceType),
    index("idx_credit_ledger_redeemed").on(table.redeemedAt),
  ],
);

// Host earnings ledger - immutable financial entries for paid parking pass bookings
export const hostEarningsLedger = pgTable(
  "host_earnings_ledger",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: varchar("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    bookingId: varchar("booking_id").references(() => eventBookings.id, {
      onDelete: "set null",
    }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id"),
    entryType: varchar("entry_type").notNull(), // 'booking_earned' | 'refund' | 'adjustment' | 'payout'
    sourceType: varchar("source_type")
      .notNull()
      .default("parking_pass_booking"),
    amountCents: integer("amount_cents").notNull(), // positive or negative
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_host_earnings_host").on(table.hostId),
    index("idx_host_earnings_booking").on(table.bookingId),
    index("idx_host_earnings_intent").on(table.stripePaymentIntentId),
    index("idx_host_earnings_created").on(table.createdAt),
    unique("uq_host_earnings_booking_entry").on(
      table.bookingId,
      table.entryType,
    ),
  ],
);

// Host payout requests - request/approval workflow for cash out
export const hostPayoutRequests = pgTable(
  "host_payout_requests",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: varchar("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    status: varchar("status").notNull().default("pending"), // 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled'
    notes: text("notes"),
    reviewedByUserId: varchar("reviewed_by_user_id").references(
      () => users.id,
      {
        onDelete: "set null",
      },
    ),
    reviewedAt: timestamp("reviewed_at"),
    paidAt: timestamp("paid_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_host_payout_requests_host").on(table.hostId),
    index("idx_host_payout_requests_user").on(table.userId),
    index("idx_host_payout_requests_status").on(table.status),
    index("idx_host_payout_requests_created").on(table.createdAt),
  ],
);

// PHASE 5: User payout preferences
export const userPayoutPreferences = pgTable(
  "user_payout_preferences",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    method: varchar("method").notNull().default("credit"), // 'credit' | 'paypal' | 'ach' | 'other'
    methodDetails: jsonb("method_details"), // { paypalEmail, achRouting, achAccount, achName, notes }
    stripeConnectedId: varchar("stripe_connected_id"), // Legacy Stripe Connect payouts (optional)
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_payout_prefs_user").on(table.userId)],
);

// PHASE R1: Restaurant credit redemptions - tracks when users spend credits at restaurants
export const restaurantCreditRedemptions = pgTable(
  "restaurant_credit_redemptions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    creditAmount: decimal("credit_amount", {
      precision: 10,
      scale: 2,
    }).notNull(),
    orderReference: varchar("order_reference"), // Optional: "Order #12345" or similar
    notes: text("notes"), // Optional: details about the redemption
    redeemedAt: timestamp("redeemed_at").defaultNow(),
    settlementStatus: varchar("settlement_status").notNull().default("pending"), // 'pending' | 'queued' | 'paid'
    settlementBatchId: varchar("settlement_batch_id"), // Links to restaurantSettlementBatch
    disputeUntil: timestamp("dispute_until").defaultNow(), // 7-day dispute window starts at creation
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_redemptions_restaurant").on(table.restaurantId),
    index("idx_redemptions_user").on(table.userId),
    index("idx_redemptions_status").on(table.settlementStatus),
    index("idx_redemptions_batch").on(table.settlementBatchId),
    index("idx_redemptions_created").on(table.createdAt),
  ],
);

// PHASE R2 (preview): Restaurant settlement batches - groups redemptions for payout
export const restaurantSettlementBatch = pgTable(
  "restaurant_settlement_batch",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    batchId: varchar("batch_id").notNull().unique(), // Human-readable: "BATCH-2025-01-06-001"
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    totalAmount: decimal("total_amount", { precision: 12, scale: 2 }).notNull(),
    transactionCount: integer("transaction_count").notNull().default(0),
    payoutDate: timestamp("payout_date"),
    status: varchar("status").notNull().default("queued"), // 'queued' | 'processing' | 'paid'
    stripePayoutId: varchar("stripe_payout_id"), // Stripe payout ID for tracking
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_batch_id").on(table.batchId),
    index("idx_batch_status").on(table.status),
    index("idx_batch_period").on(table.periodStart, table.periodEnd),
  ],
);

// Community restaurant submissions (for empty counties)
export const restaurantSubmissions = pgTable(
  "restaurant_submissions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    submittedByUserId: varchar("submitted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    restaurantName: varchar("restaurant_name").notNull(),
    address: text("address"),
    website: varchar("website"),
    phoneNumber: varchar("phone_number"),
    category: varchar("category"), // 'pizza' | 'burger' | 'chinese', etc
    county: varchar("county"),
    state: varchar("state"),
    countyFips: varchar("county_fips"),
    countyName: varchar("county_name"),
    geoEnrichedAt: timestamp("geo_enriched_at"),
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),
    description: text("description"), // Why they like it
    photoUrl: varchar("photo_url"),
    status: varchar("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected' | 'converted'
    approvedAt: timestamp("approved_at"),
    convertedToRestaurantId: varchar("converted_to_restaurant_id").references(
      () => restaurants.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_submissions_status").on(table.status),
    index("idx_submissions_county").on(table.county),
    index("idx_submissions_created").on(table.createdAt),
  ],
);

// Award History - Track Golden Plate awards given every 90 days
export const awardHistory = pgTable(
  "award_history",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    awardType: varchar("award_type").notNull(), // 'golden_plate' | 'golden_fork'
    recipientId: varchar("recipient_id").notNull(), // User ID or Restaurant ID
    recipientType: varchar("recipient_type").notNull(), // 'user' | 'restaurant'
    awardPeriodStart: timestamp("award_period_start").notNull(),
    awardPeriodEnd: timestamp("award_period_end").notNull(),
    rankingScore: integer("ranking_score").notNull(),
    rankPosition: integer("rank_position"), // Their position in rankings when awarded
    geographicArea: varchar("geographic_area"), // County/city for Golden Plate
    metadata: jsonb("metadata"), // Additional award context
    awardedAt: timestamp("awarded_at").defaultNow(),
  },
  (table) => [
    index("idx_award_recipient").on(table.recipientId, table.recipientType),
    index("idx_award_type").on(table.awardType),
    index("idx_award_period").on(table.awardPeriodStart, table.awardPeriodEnd),
    index("idx_award_area").on(table.geographicArea),
  ],
);

// Image uploads - Track all uploaded images for restaurants and users
export const imageUploads = pgTable(
  "image_uploads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    uploadedByUserId: varchar("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
    imageType: varchar("image_type").notNull(), // 'restaurant_logo' | 'restaurant_cover' | 'deal' | 'user_profile'
    entityId: varchar("entity_id"), // ID of restaurant, deal, or user
    entityType: varchar("entity_type"), // 'restaurant' | 'deal' | 'user'
    cloudinaryPublicId: varchar("cloudinary_public_id"), // For Cloudinary
    cloudinaryUrl: varchar("cloudinary_url").notNull(),
    thumbnailUrl: varchar("thumbnail_url"),
    width: integer("width"),
    height: integer("height"),
    fileSize: integer("file_size"), // bytes
    mimeType: varchar("mime_type"),
    uploadedAt: timestamp("uploaded_at").defaultNow(),
  },
  (table) => [
    index("idx_image_entity").on(table.entityId, table.entityType),
    index("idx_image_uploader").on(table.uploadedByUserId),
    index("idx_image_type").on(table.imageType),
  ],
);

// Featured Video Slots - Fair rotation of restaurant's featured videos (3 slots max)
export const featuredVideoSlots = pgTable(
  "featured_video_slots",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    slotNumber: integer("slot_number").notNull(), // 1, 2, or 3
    currentVideoId: varchar("current_video_id").references(
      () => videoStories.id,
      { onDelete: "set null" },
    ),
    cycleStartDate: timestamp("cycle_start_date").defaultNow(),
    cycleEndDate: timestamp("cycle_end_date").default(
      sql`NOW() + INTERVAL '1 day'`,
    ), // 24hr rotation
    previousVideoIds: text("previous_video_ids").array().default([]), // Last 5 videos for variety
    engagementScore: decimal("engagement_score", {
      precision: 5,
      scale: 2,
    }).default("0.00"), // Score for cycling algorithm
    impressions: integer("impressions").default(0), // Times shown
    clicks: integer("clicks").default(0), // Clicks to story details
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_featured_restaurant").on(table.restaurantId, table.slotNumber),
    index("idx_featured_cycle").on(table.cycleEndDate),
  ],
);

// Restaurant Subscriptions - Monetization tiers for restaurants
export const restaurantSubscriptions = pgTable(
  "restaurant_subscriptions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    tier: varchar("tier").notNull().default("free"), // 'free' | 'monthly' | 'quarterly' | 'yearly'
    // Legacy recurring-billing fields retained for cancellation and audit only.
    status: varchar("status").notNull().default("active"), // 'active' | 'canceled' | 'past_due'
    priceCents: integer("price_cents").default(0),
    billingInterval: varchar("billing_interval").default("monthly"), // 'monthly' | 'quarterly' | 'yearly'
    nextBillingAt: timestamp("next_billing_at"),
    quarterlyTrialUsed: boolean("quarterly_trial_used").default(false), // 3-month deal usable once
    quarterlyTrialActivatedAt: timestamp("quarterly_trial_activated_at"),
    // Lifetime free access (granted by admin)
    isLifetimeFree: boolean("is_lifetime_free").default(false), // Admin-granted permanent Premium access
    lifetimeGrantedBy: varchar("lifetime_granted_by"), // Admin user ID who granted it
    lifetimeGrantedAt: timestamp("lifetime_granted_at"),
    lifetimeReason: text("lifetime_reason"), // Why this restaurant got lifetime access
    // Features
    canPostVideos: boolean("can_post_videos").default(false), // Free: false, paid/lifetime: true
    canPostDeals: boolean("can_post_deals").default(false),
    canUseFeaturedSlots: boolean("can_use_featured_slots").default(false),
    maxFeaturedSlots: integer("max_featured_slots").default(0), // Paid: 3 by default
    hasAnalytics: boolean("has_analytics").default(false),
    hasDealScheduling: boolean("has_deal_scheduling").default(false),
    // Billing
    stripeCustomerId: varchar("stripe_customer_id"),
    stripeSubscriptionId: varchar("stripe_subscription_id"),
    stripeEventId: varchar("stripe_event_id"),
    stripeEventCreatedAt: timestamp("stripe_event_created_at"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    canceledAt: timestamp("canceled_at"),
    // Metadata
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_subscription_restaurant").on(table.restaurantId),
    index("idx_subscription_tier").on(table.tier),
    index("idx_subscription_status").on(table.status),
  ],
);

// Minimal relations for query builder support on admin/SOC/affiliate tables
export const incidentsRelations = relations(incidents, ({ one }) => ({
  user: one(users, {
    fields: [incidents.userId],
    references: [users.id],
  }),
}));

export const oncallRotationRelations = relations(oncallRotation, ({ one }) => ({
  user: one(users, {
    fields: [oncallRotation.userId],
    references: [users.id],
  }),
}));

export const securityAuditLogRelations = relations(
  securityAuditLog,
  ({ one }) => ({
    user: one(users, {
      fields: [securityAuditLog.userId],
      references: [users.id],
    }),
  }),
);

export const supportTicketsRelations = relations(supportTickets, ({ one }) => ({
  user: one(users, {
    fields: [supportTickets.userId],
    references: [users.id],
  }),
  assignedToAdmin: one(users, {
    fields: [supportTickets.assignedToAdminId],
    references: [users.id],
  }),
  resolvedByAdmin: one(users, {
    fields: [supportTickets.resolvedByAdminId],
    references: [users.id],
  }),
}));

export const moderationEventsRelations = relations(
  moderationEvents,
  ({ one }) => ({
    reportedUser: one(users, {
      fields: [moderationEvents.reportedUserId],
      references: [users.id],
    }),
    reporter: one(users, {
      fields: [moderationEvents.reporterUserId],
      references: [users.id],
    }),
    reviewedBy: one(users, {
      fields: [moderationEvents.reviewedByAdminId],
      references: [users.id],
    }),
  }),
);

export const affiliateLinksRelations = relations(
  affiliateLinks,
  ({ one, many }) => ({
    affiliateUser: one(users, {
      fields: [affiliateLinks.affiliateUserId],
      references: [users.id],
    }),
    clicks: many(affiliateClicks),
    commissions: many(affiliateCommissions),
  }),
);

export const affiliateClicksRelations = relations(
  affiliateClicks,
  ({ one }) => ({
    link: one(affiliateLinks, {
      fields: [affiliateClicks.affiliateLinkId],
      references: [affiliateLinks.id],
    }),
    restaurantUser: one(users, {
      fields: [affiliateClicks.restaurantSignupId],
      references: [users.id],
    }),
  }),
);

export const affiliateCommissionsRelations = relations(
  affiliateCommissions,
  ({ one }) => ({
    affiliateUser: one(users, {
      fields: [affiliateCommissions.affiliateUserId],
      references: [users.id],
    }),
    restaurantUser: one(users, {
      fields: [affiliateCommissions.restaurantUserId],
      references: [users.id],
    }),
    affiliateLink: one(affiliateLinks, {
      fields: [affiliateCommissions.affiliateLinkId],
      references: [affiliateLinks.id],
    }),
  }),
);

export const affiliateWalletRelations = relations(
  affiliateWallet,
  ({ one }) => ({
    user: one(users, {
      fields: [affiliateWallet.userId],
      references: [users.id],
    }),
  }),
);

export const affiliateWithdrawalsRelations = relations(
  affiliateWithdrawals,
  ({ one }) => ({
    user: one(users, {
      fields: [affiliateWithdrawals.userId],
      references: [users.id],
    }),
  }),
);

export const locationRequestsRelations = relations(
  locationRequests,
  ({ one, many }) => ({
    postedBy: one(users, {
      fields: [locationRequests.postedByUserId],
      references: [users.id],
    }),
    interests: many(truckInterests),
    claims: many(hostLocationClaims),
  }),
);

export const truckInterestsRelations = relations(truckInterests, ({ one }) => ({
  locationRequest: one(locationRequests, {
    fields: [truckInterests.locationRequestId],
    references: [locationRequests.id],
  }),
  restaurant: one(restaurants, {
    fields: [truckInterests.restaurantId],
    references: [restaurants.id],
  }),
}));

export const hostLocationClaimsRelations = relations(
  hostLocationClaims,
  ({ one }) => ({
    locationRequest: one(locationRequests, {
      fields: [hostLocationClaims.locationRequestId],
      references: [locationRequests.id],
    }),
    claimedBy: one(users, {
      fields: [hostLocationClaims.claimedByUserId],
      references: [users.id],
    }),
    host: one(hosts, {
      fields: [hostLocationClaims.hostId],
      references: [hosts.id],
    }),
  }),
);

export const hostsRelations = relations(hosts, ({ one, many }) => ({
  user: one(users, {
    fields: [hosts.userId],
    references: [users.id],
  }),
  events: many(events),
  reviews: many(hostReviews),
  bookings: many(eventBookings),
}));

export const eventInterestsRelations = relations(eventInterests, ({ one }) => ({
  event: one(events, {
    fields: [eventInterests.eventId],
    references: [events.id],
  }),
  truck: one(restaurants, {
    fields: [eventInterests.truckId],
    references: [restaurants.id],
  }),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  host: one(hosts, {
    fields: [events.hostId],
    references: [hosts.id],
  }),
  coordinator: one(users, {
    fields: [events.coordinatorUserId],
    references: [users.id],
  }),
  series: one(eventSeries, {
    fields: [events.seriesId],
    references: [eventSeries.id],
  }),
  bookedRestaurant: one(restaurants, {
    fields: [events.bookedRestaurantId],
    references: [restaurants.id],
  }),
  interests: many(eventInterests),
  bookings: many(eventBookings),
}));

export const parkingPassBlackoutDatesRelations = relations(
  parkingPassBlackoutDates,
  ({ one }) => ({
    series: one(eventSeries, {
      fields: [parkingPassBlackoutDates.seriesId],
      references: [eventSeries.id],
    }),
  }),
);

export const hostReviewsRelations = relations(hostReviews, ({ one }) => ({
  host: one(hosts, {
    fields: [hostReviews.hostId],
    references: [hosts.id],
  }),
  truck: one(restaurants, {
    fields: [hostReviews.truckId],
    references: [restaurants.id],
  }),
  user: one(users, {
    fields: [hostReviews.userId],
    references: [users.id],
  }),
}));

export const eventBookingsRelations = relations(eventBookings, ({ one }) => ({
  event: one(events, {
    fields: [eventBookings.eventId],
    references: [events.id],
  }),
  truck: one(restaurants, {
    fields: [eventBookings.truckId],
    references: [restaurants.id],
  }),
  host: one(hosts, {
    fields: [eventBookings.hostId],
    references: [hosts.id],
  }),
}));

export const truckManualSchedulesRelations = relations(
  truckManualSchedules,
  ({ one }) => ({
    truck: one(restaurants, {
      fields: [truckManualSchedules.truckId],
      references: [restaurants.id],
    }),
  }),
);

export const truckParkingReportsRelations = relations(
  truckParkingReports,
  ({ one }) => ({
    truck: one(restaurants, {
      fields: [truckParkingReports.truckId],
      references: [restaurants.id],
    }),
    booking: one(eventBookings, {
      fields: [truckParkingReports.bookingId],
      references: [eventBookings.id],
    }),
    manualSchedule: one(truckManualSchedules, {
      fields: [truckParkingReports.manualScheduleId],
      references: [truckManualSchedules.id],
    }),
    host: one(hosts, {
      fields: [truckParkingReports.hostId],
      references: [hosts.id],
    }),
  }),
);

export const referralsRelations = relations(referrals, ({ one }) => ({
  affiliateUser: one(users, {
    fields: [referrals.affiliateUserId],
    references: [users.id],
  }),
  referredRestaurant: one(restaurants, {
    fields: [referrals.referredRestaurantId],
    references: [restaurants.id],
  }),
}));

export const referralClicksRelations = relations(referralClicks, ({ one }) => ({
  affiliateUser: one(users, {
    fields: [referralClicks.affiliateUserId],
    references: [users.id],
  }),
}));

export const restaurantSubmissionsRelations = relations(
  restaurantSubmissions,
  ({ one }) => ({
    submittedBy: one(users, {
      fields: [restaurantSubmissions.submittedByUserId],
      references: [users.id],
    }),
    convertedRestaurant: one(restaurants, {
      fields: [restaurantSubmissions.convertedToRestaurantId],
      references: [restaurants.id],
    }),
  }),
);

export const affiliateCommissionLedgerRelations = relations(
  affiliateCommissionLedger,
  ({ one }) => ({
    affiliateUser: one(users, {
      fields: [affiliateCommissionLedger.affiliateUserId],
      references: [users.id],
    }),
    referral: one(referrals, {
      fields: [affiliateCommissionLedger.referralId],
      references: [referrals.id],
    }),
    restaurant: one(restaurants, {
      fields: [affiliateCommissionLedger.restaurantId],
      references: [restaurants.id],
    }),
  }),
);

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  user: one(users, {
    fields: [creditLedger.userId],
    references: [users.id],
  }),
}));

export const userPayoutPreferencesRelations = relations(
  userPayoutPreferences,
  ({ one }) => ({
    user: one(users, {
      fields: [userPayoutPreferences.userId],
      references: [users.id],
    }),
  }),
);

export const restaurantCreditRedemptionsRelations = relations(
  restaurantCreditRedemptions,
  ({ one }) => ({
    restaurant: one(restaurants, {
      fields: [restaurantCreditRedemptions.restaurantId],
      references: [restaurants.id],
    }),
    user: one(users, {
      fields: [restaurantCreditRedemptions.userId],
      references: [users.id],
    }),
  }),
);

export type LocationRequest = typeof locationRequests.$inferSelect;
export type InsertLocationRequest = z.infer<typeof insertLocationRequestSchema>;
export type InsertHostPartnerLead = z.infer<typeof insertHostPartnerLeadSchema>;
export type TruckInterest = typeof truckInterests.$inferSelect;
export type InsertTruckInterest = z.infer<typeof insertTruckInterestSchema>;
export type HostLocationClaim = typeof hostLocationClaims.$inferSelect;
export type InsertHostLocationClaim = typeof hostLocationClaims.$inferInsert;

export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type SupportTicket = typeof supportTickets.$inferSelect;

export type InsertModerationEvent = z.infer<typeof insertModerationEventSchema>;
export type ModerationEvent = typeof moderationEvents.$inferSelect;

export type AffiliateLink = typeof affiliateLinks.$inferSelect;
export type InsertAffiliateLink = z.infer<typeof insertAffiliateLinkSchema>;

export type AffiliateClick = typeof affiliateClicks.$inferSelect;
export type AffiliateCommission = typeof affiliateCommissions.$inferSelect;
export type AffiliateWallet = typeof affiliateWallet.$inferSelect;
export type AffiliateWithdrawal = typeof affiliateWithdrawals.$inferSelect;
export type RestaurantSubmission = typeof restaurantSubmissions.$inferSelect;
export type InsertRestaurantSubmission = z.infer<
  typeof insertRestaurantSubmissionSchema
>;

// PHASE 1: Referral types
export type Referral = typeof referrals.$inferSelect;
export type InsertReferral = typeof referrals.$inferInsert;
export type ReferralClick = typeof referralClicks.$inferSelect;
export type InsertReferralClick = typeof referralClicks.$inferInsert;

// PHASE 3: Commission ledger types
export type AffiliateCommissionLedger =
  typeof affiliateCommissionLedger.$inferSelect;
export type InsertAffiliateCommissionLedger =
  typeof affiliateCommissionLedger.$inferInsert;

// PHASE 4: Credit ledger types
export type CreditLedger = typeof creditLedger.$inferSelect;
export type InsertCreditLedger = typeof creditLedger.$inferInsert;

export type HostEarningsLedger = typeof hostEarningsLedger.$inferSelect;
export type InsertHostEarningsLedger = typeof hostEarningsLedger.$inferInsert;
export type HostPayoutRequest = typeof hostPayoutRequests.$inferSelect;
export type InsertHostPayoutRequest = typeof hostPayoutRequests.$inferInsert;

// PHASE 5: Payout preferences types
export type UserPayoutPreferences = typeof userPayoutPreferences.$inferSelect;
export type InsertUserPayoutPreferences =
  typeof userPayoutPreferences.$inferInsert;

// PHASE R1: Restaurant credit redemption types
export type RestaurantCreditRedemption =
  typeof restaurantCreditRedemptions.$inferSelect;
export type InsertRestaurantCreditRedemption =
  typeof restaurantCreditRedemptions.$inferInsert;

// PHASE R2: Settlement batch types
export type RestaurantSettlementBatch =
  typeof restaurantSettlementBatch.$inferSelect;
export type InsertRestaurantSettlementBatch =
  typeof restaurantSettlementBatch.$inferInsert;

export type OperatingHoursTimeSlot = z.infer<
  typeof operatingHoursTimeSlotSchema
>;
export type OperatingHours = z.infer<typeof operatingHoursSchema>;
export type UpdateRestaurantLocation = z.infer<
  typeof updateRestaurantLocationSchema
>;
export type UpdateRestaurantOperatingHours = z.infer<
  typeof updateRestaurantOperatingHoursSchema
>;

// Schemas for support tickets
export const insertLocationRequestSchema = createInsertSchema(
  locationRequests,
  {
    preferredDates: z.array(z.string()),
    expectedFootTraffic: z.number().int(),
    notes: z.string().max(200).optional(),
  },
)
  .omit({
    id: true,
    status: true,
    demandStatus: true,
    thresholdReachedAt: true,
    createdAt: true,
  })
  .superRefine((val, ctx) => {
    const dates = val.preferredDates ?? [];
    if (dates.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select at least one preferred date",
        path: ["preferredDates"],
      });
    }
    if (dates.length > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "You can only pick up to 3 dates",
        path: ["preferredDates"],
      });
    }

    const now = new Date();
    dates.forEach((dateStr, idx) => {
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Preferred dates must be valid dates",
          path: ["preferredDates", idx],
        });
        return;
      }
      if (date < now) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dates must be in the future",
          path: ["preferredDates", idx],
        });
      }
    });

    if (val.expectedFootTraffic < 1 || val.expectedFootTraffic > 10000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected foot traffic must be between 1 and 10,000",
        path: ["expectedFootTraffic"],
      });
    }

    if (
      val.minInterestedTrucks !== undefined &&
      (val.minInterestedTrucks < 1 || val.minInterestedTrucks > 20)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Minimum interested trucks must be between 1 and 20",
        path: ["minInterestedTrucks"],
      });
    }
  });

export const insertTruckInterestSchema = createInsertSchema(truckInterests, {
  message: z.string().max(500).optional(),
}).omit({
  id: true,
  createdAt: true,
});

export const insertHostLocationClaimSchema = createInsertSchema(
  hostLocationClaims,
  {
    message: z.string().max(500).optional(),
  },
).omit({
  id: true,
  hostId: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
});

export const insertSupportTicketSchema = createInsertSchema(
  supportTickets,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  assignedToAdminId: true,
  resolvedByAdminId: true,
  adminNotes: true,
});

// Schemas for moderation events
export const insertModerationEventSchema = createInsertSchema(
  moderationEvents,
).omit({
  id: true,
  createdAt: true,
  reviewedAt: true,
  reviewedByAdminId: true,
});

// Schemas for affiliate system
export const insertAffiliateLinkSchema = createInsertSchema(
  affiliateLinks,
).omit({
  id: true,
  code: true,
  clickCount: true,
  conversions: true,
  createdAt: true,
  updatedAt: true,
});

export const insertRestaurantSubmissionSchema = createInsertSchema(
  restaurantSubmissions,
).omit({
  id: true,
  approvedAt: true,
  convertedToRestaurantId: true,
  createdAt: true,
});

// Schemas for award system
export const insertAwardHistorySchema = createInsertSchema(awardHistory).omit({
  id: true,
  awardedAt: true,
});

export type AwardHistory = typeof awardHistory.$inferSelect;
export type InsertAwardHistory = z.infer<typeof insertAwardHistorySchema>;

// Schemas for image uploads
export const insertImageUploadSchema = createInsertSchema(imageUploads).omit({
  id: true,
  uploadedAt: true,
});

export type ImageUpload = typeof imageUploads.$inferSelect;
export type InsertImageUpload = z.infer<typeof insertImageUploadSchema>;

// Schemas for featured video slots
export const insertFeaturedVideoSlotSchema = createInsertSchema(
  featuredVideoSlots,
).omit({
  id: true,
  cycleStartDate: true,
  updatedAt: true,
});

export type FeaturedVideoSlot = typeof featuredVideoSlots.$inferSelect;
export type InsertFeaturedVideoSlot = z.infer<
  typeof insertFeaturedVideoSlotSchema
>;

// Schemas for restaurant subscriptions
export const insertRestaurantSubscriptionSchema = createInsertSchema(
  restaurantSubscriptions,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  quarterlyTrialUsed: true,
  quarterlyTrialActivatedAt: true,
});

export type RestaurantSubscription =
  typeof restaurantSubscriptions.$inferSelect;
export type InsertRestaurantSubscription = z.infer<
  typeof insertRestaurantSubscriptionSchema
>;

// Schemas for video story reports
export const insertVideoStoryReportSchema = createInsertSchema(
  videoStoryReports,
).omit({
  id: true,
  createdAt: true,
  status: true,
  reviewedByAdminId: true,
  reviewedAt: true,
  adminNotes: true,
});

export type VideoStoryReport = typeof videoStoryReports.$inferSelect;
export type InsertVideoStoryReport = z.infer<
  typeof insertVideoStoryReportSchema
>;

// Schemas for feed ads
export const insertFeedAdSchema = createInsertSchema(feedAds).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type FeedAd = typeof feedAds.$inferSelect;
export type InsertFeedAd = z.infer<typeof insertFeedAdSchema>;

// Schemas for geo ads
export const insertGeoAdSchema = createInsertSchema(geoAds).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type GeoAd = typeof geoAds.$inferSelect;
export type InsertGeoAd = z.infer<typeof insertGeoAdSchema>;

export const insertGeoAdEventSchema = createInsertSchema(geoAdEvents).omit({
  id: true,
  createdAt: true,
});

export type GeoAdEvent = typeof geoAdEvents.$inferSelect;
export type InsertGeoAdEvent = z.infer<typeof insertGeoAdEventSchema>;

export const insertGeoLocationPingSchema = createInsertSchema(
  geoLocationPings,
).omit({
  id: true,
  createdAt: true,
});

export type GeoLocationPing = typeof geoLocationPings.$inferSelect;
export type InsertGeoLocationPing = z.infer<typeof insertGeoLocationPingSchema>;

export const insertHostSchema = createInsertSchema(hosts)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    isVerified: true,
  })
  .extend({
    city: z.string().min(1, "City is required"),
    state: z.string().min(2, "State is required"),
    spotCount: z
      .number()
      .int()
      .min(1, "Number of spots must be at least 1")
      .optional(),
  });

export type Host = typeof hosts.$inferSelect;
export type InsertHost = z.infer<typeof insertHostSchema>;

export const insertParkingPassBlackoutDateSchema = createInsertSchema(
  parkingPassBlackoutDates,
).omit({
  id: true,
  createdAt: true,
});

export type ParkingPassBlackoutDate =
  typeof parkingPassBlackoutDates.$inferSelect;
export type InsertParkingPassBlackoutDate = z.infer<
  typeof insertParkingPassBlackoutDateSchema
>;

export const insertEventSeriesSchema = createInsertSchema(eventSeries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  publishedAt: true,
});

export type EventSeries = typeof eventSeries.$inferSelect;
export type InsertEventSeries = z.infer<typeof insertEventSeriesSchema>;

export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  bookedRestaurantId: true,
});

export type Event = typeof events.$inferSelect;
export type InsertEvent = z.infer<typeof insertEventSchema>;

export const insertEventInterestSchema = createInsertSchema(
  eventInterests,
).omit({
  id: true,
  createdAt: true,
});

export type EventInterest = typeof eventInterests.$inferSelect;
export type InsertEventInterest = z.infer<typeof insertEventInterestSchema>;

export const insertHostReviewSchema = createInsertSchema(hostReviews).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type HostReview = typeof hostReviews.$inferSelect;
export type InsertHostReview = z.infer<typeof insertHostReviewSchema>;

export const insertEventBookingSchema = createInsertSchema(eventBookings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  paidAt: true,
  bookingConfirmedAt: true,
  cancelledAt: true,
  refundedAt: true,
});

export type EventBooking = typeof eventBookings.$inferSelect;
export type InsertEventBooking = z.infer<typeof insertEventBookingSchema>;

export const insertTruckManualScheduleSchema = createInsertSchema(
  truckManualSchedules,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type TruckManualSchedule = typeof truckManualSchedules.$inferSelect;
export type InsertTruckManualSchedule = z.infer<
  typeof insertTruckManualScheduleSchema
>;

export const insertTruckParkingReportSchema = createInsertSchema(
  truckParkingReports,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type TruckParkingReport = typeof truckParkingReports.$inferSelect;
export type InsertTruckParkingReport = z.infer<
  typeof insertTruckParkingReportSchema
>;

export const insertEmailVerificationTokenSchema = createInsertSchema(
  emailVerificationTokens,
).omit({
  id: true,
  createdAt: true,
});

export type EmailVerificationToken =
  typeof emailVerificationTokens.$inferSelect;
export type InsertEmailVerificationToken = z.infer<
  typeof insertEmailVerificationTokenSchema
>;

// Telemetry: Generic event tracking for analytics
export const telemetryEvents = pgTable(
  "telemetry_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventName: varchar("event_name").notNull(),
    userId: varchar("user_id"),
    properties: jsonb("properties"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_telemetry_name").on(table.eventName),
    index("idx_telemetry_created").on(table.createdAt),
  ],
);

export type TelemetryEvent = typeof telemetryEvents.$inferSelect;
export type InsertTelemetryEvent = typeof telemetryEvents.$inferInsert;

// Account-synced Parking Pass route plans, schedules, and alert snapshots.
export const parkingRoutePlans = pgTable(
  "parking_route_plans",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    originLabel: varchar("origin_label").notNull(),
    destinationLabel: varchar("destination_label").notNull(),
    origin: jsonb("origin").notNull(),
    destination: jsonb("destination").notNull(),
    scope: varchar("scope").notNull().default("nationwide"),
    recurring: boolean("recurring").notNull().default(true),
    schedule: jsonb("schedule").notNull().default(sql`'[]'::jsonb`),
    hostSnapshot: jsonb("host_snapshot").notNull().default(sql`'[]'::jsonb`),
    lastCheckedAt: timestamp("last_checked_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_parking_route_plans_user").on(table.userId),
    index("idx_parking_route_plans_updated").on(table.updatedAt),
  ],
);

export type ParkingRoutePlan = typeof parkingRoutePlans.$inferSelect;
export type InsertParkingRoutePlan = typeof parkingRoutePlans.$inferInsert;

// Request logs for admin reporting (48-hour retention)
export const requestLogs = pgTable(
  "request_logs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    method: varchar("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    userId: varchar("user_id"),
    sessionId: varchar("session_id"),
    anonymousActorId: varchar("anonymous_actor_id"),
    actorType: varchar("actor_type"), // human | bot | llm_bot | internal
    sourceType: varchar("source_type"), // human | crawler | llm_crawler | internal
    eventType: varchar("event_type"), // profile_view | search_submit | ...
    surface: varchar("surface"), // restaurant_profile | search | map | ...
    entityId: varchar("entity_id"),
    entityType: varchar("entity_type"),
    ip: varchar("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_request_logs_created").on(table.createdAt),
    index("idx_request_logs_user").on(table.userId),
    index("idx_request_logs_path").on(table.path),
    index("idx_request_logs_session").on(table.sessionId),
    index("idx_request_logs_actor").on(table.actorType, table.sourceType),
    index("idx_request_logs_event_type").on(table.eventType),
  ],
);

export const requestLogsRelations = relations(requestLogs, ({ one }) => ({
  user: one(users, {
    fields: [requestLogs.userId],
    references: [users.id],
  }),
}));

export const adminDailyReports = pgTable(
  "admin_daily_reports",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reportDate: timestamp("report_date").notNull(),
    reportType: varchar("report_type").notNull(),
    summary: jsonb("summary").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_admin_daily_reports_date").on(table.reportDate),
    index("idx_admin_daily_reports_type").on(table.reportType),
  ],
);

// Admin market intelligence: stored county-level facts for ops heatmaps.
export const marketCounties = pgTable(
  "market_counties",
  {
    countyFips: varchar("county_fips").primaryKey(),
    countyName: varchar("county_name").notNull(),
    stateCode: varchar("state_code").notNull(),
    stateName: varchar("state_name"),
    centroidLat: decimal("centroid_lat", { precision: 10, scale: 8 }),
    centroidLng: decimal("centroid_lng", { precision: 11, scale: 8 }),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_market_counties_state").on(table.stateCode),
    index("idx_market_counties_name_state").on(
      table.countyName,
      table.stateCode,
    ),
  ],
);

export const marketMetrics = pgTable(
  "market_metrics",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    countyFips: varchar("county_fips")
      .notNull()
      .references(() => marketCounties.countyFips, { onDelete: "cascade" }),
    metricKey: varchar("metric_key").notNull(),
    metricValue: integer("metric_value").notNull().default(0),
    timeframe: varchar("timeframe").notNull().default("30d"),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_market_metrics_county").on(table.countyFips),
    index("idx_market_metrics_key").on(table.metricKey),
    index("idx_market_metrics_timeframe").on(table.timeframe),
    unique("uq_market_metrics_county_key_timeframe").on(
      table.countyFips,
      table.metricKey,
      table.timeframe,
    ),
  ],
);

export const marketNotes = pgTable(
  "market_notes",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    countyFips: varchar("county_fips")
      .notNull()
      .references(() => marketCounties.countyFips, { onDelete: "cascade" }),
    authorUserId: varchar("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    category: varchar("category").notNull().default("general"),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_market_notes_county").on(table.countyFips),
    index("idx_market_notes_category").on(table.category),
    index("idx_market_notes_created").on(table.createdAt),
  ],
);

export const marketEntities = pgTable(
  "market_entities",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    countyFips: varchar("county_fips")
      .notNull()
      .references(() => marketCounties.countyFips, { onDelete: "cascade" }),
    entityType: varchar("entity_type").notNull(),
    entityId: varchar("entity_id"),
    label: varchar("label").notNull(),
    status: varchar("status").notNull().default("active"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_market_entities_county").on(table.countyFips),
    index("idx_market_entities_type").on(table.entityType),
    index("idx_market_entities_status").on(table.status),
  ],
);

export type RequestLog = typeof requestLogs.$inferSelect;
export type InsertRequestLog = typeof requestLogs.$inferInsert;
export type AdminDailyReport = typeof adminDailyReports.$inferSelect;
export type InsertAdminDailyReport = typeof adminDailyReports.$inferInsert;
export type MarketCounty = typeof marketCounties.$inferSelect;
export type InsertMarketCounty = typeof marketCounties.$inferInsert;
export type MarketMetric = typeof marketMetrics.$inferSelect;
export type InsertMarketMetric = typeof marketMetrics.$inferInsert;
export type MarketNote = typeof marketNotes.$inferSelect;
export type InsertMarketNote = typeof marketNotes.$inferInsert;
export type MarketEntity = typeof marketEntities.$inferSelect;
export type InsertMarketEntity = typeof marketEntities.$inferInsert;

// Email sequences (drip campaigns): idempotent send tracking
export const emailSequenceSends = pgTable(
  "email_sequence_sends",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sequence: varchar("sequence").notNull(),
    step: integer("step").notNull(),
    sentAt: timestamp("sent_at").defaultNow(),
    metadata: jsonb("metadata"),
  },
  (table) => [
    unique("uq_email_sequence_sends_user_sequence_step").on(
      table.userId,
      table.sequence,
      table.step,
    ),
    index("idx_email_sequence_sends_sequence_step").on(
      table.sequence,
      table.step,
      table.sentAt,
    ),
    index("idx_email_sequence_sends_user").on(table.userId, table.sentAt),
  ],
);

export type EmailSequenceSend = typeof emailSequenceSends.$inferSelect;
export type InsertEmailSequenceSend = typeof emailSequenceSends.$inferInsert;

// Host partner lead magnet: non-food businesses with parking capacity
export const hostPartnerLeads = pgTable(
  "host_partner_leads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: varchar("email").notNull(),
    firstName: varchar("first_name"),
    phone: varchar("phone"),
    businessName: varchar("business_name").notNull(),
    address: text("address"),
    city: varchar("city"),
    state: varchar("state"),
    locationType: varchar("location_type").notNull().default("other"),
    parkingSpots: integer("parking_spots"),
    dailyFootTraffic: integer("daily_foot_traffic"),
    notes: text("notes"),
    source: varchar("source").notNull().default("host_location_partner"),
    status: varchar("status").notNull().default("new"), // 'new' | 'contacted' | 'qualified' | 'converted' | 'unqualified'
    ip: varchar("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_host_partner_leads_created").on(table.createdAt),
    index("idx_host_partner_leads_status").on(table.status, table.createdAt),
    index("idx_host_partner_leads_source").on(table.source, table.createdAt),
  ],
);

export const hostPartnerLeadSequenceSends = pgTable(
  "host_partner_lead_sequence_sends",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    leadId: varchar("lead_id")
      .notNull()
      .references(() => hostPartnerLeads.id, { onDelete: "cascade" }),
    sequence: varchar("sequence").notNull(),
    step: integer("step").notNull(),
    sentAt: timestamp("sent_at").defaultNow(),
    metadata: jsonb("metadata"),
  },
  (table) => [
    unique("uq_host_partner_lead_sequence_step").on(
      table.leadId,
      table.sequence,
      table.step,
    ),
    index("idx_host_partner_lead_sequence_step_sent").on(
      table.sequence,
      table.step,
      table.sentAt,
    ),
  ],
);

export const hostPartnerEmailClaims = pgTable(
  "host_partner_email_claims",
  {
    emailNormalized: text("email_normalized").notNull(),
    sequence: varchar("sequence").notNull(),
    step: integer("step").notNull(),
    leadId: varchar("lead_id").references(() => hostPartnerLeads.id, {
      onDelete: "set null",
    }),
    status: varchar("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at").notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at"),
  },
  (table) => [
    primaryKey({
      name: "pk_host_partner_email_claims",
      columns: [table.emailNormalized, table.sequence, table.step],
    }),
    check(
      "host_partner_email_claims_status_check",
      sql`${table.status} in ('pending', 'accepted')`,
    ),
  ],
);

export type HostPartnerLead = typeof hostPartnerLeads.$inferSelect;
export type InsertHostPartnerLeadRow = typeof hostPartnerLeads.$inferInsert;
export type HostPartnerLeadSequenceSend =
  typeof hostPartnerLeadSequenceSends.$inferSelect;
export type InsertHostPartnerLeadSequenceSend =
  typeof hostPartnerLeadSequenceSends.$inferInsert;
export type HostPartnerEmailClaim = typeof hostPartnerEmailClaims.$inferSelect;

export const insertHostPartnerLeadSchema = createInsertSchema(
  hostPartnerLeads,
  {
    email: z.string().email("Enter a valid email address"),
    firstName: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().min(7).max(30).optional(),
    businessName: z.string().trim().min(2).max(140),
    address: z.string().trim().max(240).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(40).optional(),
    locationType: z.string().trim().min(2).max(40),
    parkingSpots: z.number().int().min(1).max(2000).optional(),
    dailyFootTraffic: z.number().int().min(0).max(100000).optional(),
    notes: z.string().trim().max(1000).optional(),
    source: z.string().trim().max(80).optional(),
  },
).omit({
  id: true,
  status: true,
  ip: true,
  userAgent: true,
  createdAt: true,
  updatedAt: true,
});

// Pensacola lead magnet: report leads + download tokens
export const pensacolaReportLeads = pgTable(
  "pensacola_report_leads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: varchar("email").notNull(),
    firstName: varchar("first_name"),
    source: varchar("source").notNull().default("pensacola_report"),
    ip: varchar("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    // DB enforces case-insensitive uniqueness via an index on lower(email) (see migrations/076_pensacola_report_leads.sql).
    index("idx_pensacola_report_leads_created").on(table.createdAt),
  ],
);

export const reportDownloadTokens = pgTable(
  "report_download_tokens",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    leadId: varchar("lead_id")
      .notNull()
      .references(() => pensacolaReportLeads.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    unique("uq_report_download_tokens_hash").on(table.tokenHash),
    index("idx_report_download_tokens_lead").on(table.leadId, table.createdAt),
    index("idx_report_download_tokens_expires").on(table.expiresAt),
  ],
);

export type PensacolaReportLead = typeof pensacolaReportLeads.$inferSelect;
export type InsertPensacolaReportLead =
  typeof pensacolaReportLeads.$inferInsert;
export type ReportDownloadToken = typeof reportDownloadTokens.$inferSelect;
export type InsertReportDownloadToken =
  typeof reportDownloadTokens.$inferInsert;

export const reportLeadSequenceSends = pgTable(
  "report_lead_sequence_sends",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    leadId: varchar("lead_id")
      .notNull()
      .references(() => pensacolaReportLeads.id, { onDelete: "cascade" }),
    sequence: varchar("sequence").notNull(),
    step: integer("step").notNull(),
    sentAt: timestamp("sent_at").defaultNow(),
    metadata: jsonb("metadata"),
  },
  (table) => [
    unique("uq_report_lead_sequence_sends_lead_sequence_step").on(
      table.leadId,
      table.sequence,
      table.step,
    ),
    index("idx_report_lead_sequence_sends_sequence_step").on(
      table.sequence,
      table.step,
      table.sentAt,
    ),
  ],
);

export type ReportLeadSequenceSend =
  typeof reportLeadSequenceSends.$inferSelect;
export type InsertReportLeadSequenceSend =
  typeof reportLeadSequenceSends.$inferInsert;

export const ownerAiActionDrafts = pgTable(
  "owner_ai_action_drafts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorApiKeyId: varchar("connector_api_key_id").references(
      () => apiKeys.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: varchar("idempotency_key", { length: 64 }),
    requestHash: varchar("request_hash", { length: 64 }),
    status: varchar("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    packet: jsonb("packet").notNull(),
    normalizedPlan: jsonb("normalized_plan").notNull(),
    currentSnapshot: jsonb("current_snapshot").notNull().default(sql`'{}'::jsonb`),
    socialDrafts: jsonb("social_drafts").notNull().default(sql`'[]'::jsonb`),
    mediaManifest: jsonb("media_manifest").notNull().default(sql`'[]'::jsonb`),
    expectedVersions: jsonb("expected_versions").notNull(),
    approvedByUserId: varchar("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    appliedAt: timestamp("applied_at"),
    cancelledAt: timestamp("cancelled_at"),
    expiresAt: timestamp("expires_at").notNull(),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    result: jsonb("result"),
    socialPublishLeaseId: varchar("social_publish_lease_id", { length: 64 }),
    socialPublishLeaseExpiresAt: timestamp("social_publish_lease_expires_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_owner_ai_drafts_restaurant_status").on(
      table.restaurantId,
      table.status,
    ),
    index("idx_owner_ai_drafts_creator").on(table.createdByUserId),
    index("idx_owner_ai_drafts_expires").on(table.expiresAt),
    uniqueIndex("uq_owner_ai_drafts_connector_idempotency")
      .on(table.connectorApiKeyId, table.idempotencyKey)
      .where(
        sql`${table.connectorApiKeyId} IS NOT NULL AND ${table.idempotencyKey} IS NOT NULL`,
      ),
  ],
);

export type OwnerAiActionDraft = typeof ownerAiActionDrafts.$inferSelect;
export type InsertOwnerAiActionDraft = typeof ownerAiActionDrafts.$inferInsert;

export const socialPostQueue = pgTable(
  "social_post_queue",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    platform: varchar("platform").notNull(),
    target: varchar("target"),
    message: text("message").notNull(),
    link: text("link"),
    imageUrl: text("image_url"),
    restaurantId: varchar("restaurant_id").references(() => restaurants.id, {
      onDelete: "cascade",
    }),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    source: varchar("source"),
    ownerAiActionDraftId: varchar("owner_ai_action_draft_id").references(
      () => ownerAiActionDrafts.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata"),
    status: varchar("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_social_post_queue_status").on(table.status),
    index("idx_social_post_queue_platform").on(table.platform),
    index("idx_social_post_queue_created").on(table.createdAt),
    index("idx_social_post_queue_owner_ai_draft").on(
      table.ownerAiActionDraftId,
    ),
    uniqueIndex("uq_social_post_queue_owner_ai_draft_platform")
      .on(table.ownerAiActionDraftId, table.platform)
      .where(sql`${table.ownerAiActionDraftId} IS NOT NULL`),
  ],
);

export type SocialPostQueueItem = typeof socialPostQueue.$inferSelect;
export type InsertSocialPostQueueItem = typeof socialPostQueue.$inferInsert;

export const socialPublishingConnections = pgTable(
  "social_publishing_connections",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    platform: varchar("platform").notNull(),
    displayName: varchar("display_name"),
    externalAccountId: varchar("external_account_id"),
    externalAccountUrl: text("external_account_url"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at"),
    scopes: jsonb("scopes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar("status").notNull().default("active"),
    lastPublishAt: timestamp("last_publish_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_social_publish_connections_restaurant").on(table.restaurantId),
    index("idx_social_publish_connections_platform").on(table.platform),
    index("idx_social_publish_connections_status").on(table.status),
    unique("uq_social_publish_connection_restaurant_platform").on(
      table.restaurantId,
      table.platform,
    ),
  ],
);

export type SocialPublishingConnection =
  typeof socialPublishingConnections.$inferSelect;
export type InsertSocialPublishingConnection =
  typeof socialPublishingConnections.$inferInsert;

export const searchQueryEvents = pgTable(
  "search_query_events",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    query: text("query").notNull(),
    source: varchar("source").notNull().default("unknown"),
    userId: varchar("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_search_query_events_created_at").on(table.createdAt),
    index("idx_search_query_events_query_created_at").on(
      table.query,
      table.createdAt,
    ),
  ],
);

export type SearchQueryEvent = typeof searchQueryEvents.$inferSelect;
export type InsertSearchQueryEvent = typeof searchQueryEvents.$inferInsert;

// LISA Phase 4A: Claim Persistence Table
// Purpose: Write-only fact recording layer for deterministic resolution
// NO scoring, NO automation, NO user-facing effects yet
export const lisaClaims = pgTable(
  "lisa_claim",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    // What the claim is about
    subjectType: text("subject_type").notNull(),
    subjectId: varchar("subject_id").notNull(),

    // Who caused or emitted the claim (optional - some claims are system-level)
    actorType: text("actor_type"),
    actorId: varchar("actor_id"),

    // App context (enforces separation between TradeScout and MealScout)
    app: text("app").notNull(),

    // Semantic meaning (verb-based, plain English)
    claimType: text("claim_type").notNull(),

    // Raw data only - no computed values
    claimValue: jsonb("claim_value").notNull(),

    // Where the claim originated
    source: text("source").notNull(),

    // Confidence level (0.0 to 1.0, default 1.0 for direct observations)
    confidence: decimal("confidence", { precision: 3, scale: 2 }).default(
      "1.0",
    ),

    // Immutable timestamp
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_lisa_claim_subject").on(table.subjectType, table.subjectId),
    index("idx_lisa_claim_actor").on(table.actorType, table.actorId),
    index("idx_lisa_claim_app").on(table.app),
    index("idx_lisa_claim_type").on(table.claimType),
    index("idx_lisa_claim_created_at").on(table.createdAt),
    index("idx_lisa_claim_app_subject").on(
      table.app,
      table.subjectType,
      table.subjectId,
    ),
  ],
);

export type LisaClaim = typeof lisaClaims.$inferSelect;
export type InsertLisaClaim = typeof lisaClaims.$inferInsert;

// LISA Claim Type definitions (minimal taxonomy - Phase 4A only)
export const LISA_CLAIM_TYPES = {
  // Identity / Auth
  USER_LOGGED_IN: "user_logged_in",
  OAUTH_PROVIDER_USED: "oauth_provider_used",

  // MealScout — Discovery & Content
  VIDEO_RECOMMENDATION_CREATED: "video_recommendation_created",
  VIDEO_RECOMMENDATION_VIEWED: "video_recommendation_viewed",
  MERCHANT_LISTED: "merchant_listed",
  DEAL_CREATED: "deal_created",

  // MealScout — Ordering & Menus
  ORDER_PLACED: "order_placed",
  ORDER_COMPLETED: "order_completed",
  ORDER_CANCELLED: "order_cancelled",
  MENU_CREATED: "menu_created",
  MENU_PUBLISHED: "menu_published",
  MENU_ITEM_CREATED: "menu_item_created",

  // MealScout — Subscriptions & Monetization
  SUBSCRIPTION_STARTED: "subscription_started",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  PARKING_PASS_BOOKED: "parking_pass_booked",
  PARKING_PASS_CANCELLED: "parking_pass_cancelled",

  // MealScout — Events
  EVENT_CREATED: "event_created",
  EVENT_INTEREST_EXPRESSED: "event_interest_expressed",
  EVENT_CANCELLED: "event_cancelled",

  // TradeScout (reserved for shared account claims)
  PROJECT_POSTED: "project_posted",
  CONTRACTOR_ENGAGED: "contractor_engaged",
  VERIFICATION_COMPLETED: "verification_completed",
} as const;

export type LisaClaimType =
  (typeof LISA_CLAIM_TYPES)[keyof typeof LISA_CLAIM_TYPES];

// LISA Claim Source definitions
export const LISA_CLAIM_SOURCES = {
  SYSTEM: "system",
  USER: "user",
  OAUTH: "oauth",
  VIDEO: "video",
  RECOMMENDATION: "recommendation",
  DEAL: "deal",
  MERCHANT: "merchant",
  ORDER: "order",
  MENU: "menu",
  SUBSCRIPTION: "subscription",
  PARKING: "parking",
  EVENT: "event",
} as const;

export type LisaClaimSource =
  (typeof LISA_CLAIM_SOURCES)[keyof typeof LISA_CLAIM_SOURCES];

// ============================================================================
// UNIFIED CLAIMS SYSTEM (North Star Architecture)
// ============================================================================
// One identity → many claims → verified → coordinated → monetized
// No roles, no modes, no beta. Just claims.

export const claims = pgTable(
  "claims",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    // Who is making the claim (identity)
    personId: varchar("person_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // What kind of claim
    claimType: varchar("claim_type").notNull(), // 'restaurant' | 'food_truck' | 'host' | 'event' | 'diner'

    // Verification lifecycle
    status: varchar("status").notNull().default("pending"), // 'pending' | 'provisional' | 'verified' | 'active'

    // Link to actual entity (polymorphic reference)
    restaurantId: varchar("restaurant_id").references(() => restaurants.id, {
      onDelete: "set null",
    }),
    hostId: varchar("host_id").references(() => hosts.id, {
      onDelete: "set null",
    }),
    eventId: varchar("event_id").references(() => events.id, {
      onDelete: "set null",
    }),

    // Claim data (flexible structure for different claim types)
    claimData: jsonb("claim_data").notNull().default("{}"),

    // Verification tracking
    verificationRefs: text("verification_refs").array(), // Documents, social proof, etc.
    verifiedBy: varchar("verified_by").references(() => users.id),
    verifiedAt: timestamp("verified_at"),

    // Notes and metadata
    notes: text("notes"),
    metadata: jsonb("metadata").default("{}"),

    // Timestamps (CRITICAL for pricing lock logic)
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_claims_person").on(table.personId, table.createdAt),
    index("idx_claims_type").on(table.claimType, table.createdAt),
    index("idx_claims_status").on(table.status),
    index("idx_claims_restaurant").on(table.restaurantId),
    index("idx_claims_host").on(table.hostId),
    index("idx_claims_event").on(table.eventId),
    index("idx_claims_person_type_status").on(
      table.personId,
      table.claimType,
      table.status,
    ),
  ],
);

export type Claim = typeof claims.$inferSelect;
export type InsertClaim = typeof claims.$inferInsert;

// Claim type constants
export const CLAIM_TYPES = {
  RESTAURANT: "restaurant",
  FOOD_TRUCK: "food_truck",
  HOST: "host",
  EVENT: "event",
  DINER: "diner",
} as const;

export type ClaimType = (typeof CLAIM_TYPES)[keyof typeof CLAIM_TYPES];

// Claim status constants
export const CLAIM_STATUS = {
  PENDING: "pending", // Submitted, not yet reviewed
  PROVISIONAL: "provisional", // Visible + usable, but not fully trusted
  VERIFIED: "verified", // Trusted, verified by admin
  ACTIVE: "active", // Monetizable (for restaurants)
} as const;

export type ClaimStatus = (typeof CLAIM_STATUS)[keyof typeof CLAIM_STATUS];

// ============================================================
// ONLINE MENUS, PICKUP ORDERING & DELIVERY INFRASTRUCTURE
// ============================================================

/**
 * menus – one menu per business (supports time-based availability).
 * A business may eventually have multiple menus (e.g. breakfast / lunch /
 * dinner) but for Phase 1 we differentiate them by serviceType.
 */
export const menus = pgTable(
  "menus",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name").notNull().default("Menu"), // e.g. "Breakfast Menu"
    serviceType: varchar("service_type").notNull().default("all"),
    // 'all' | 'breakfast' | 'lunch' | 'dinner' | 'late_night' | 'weekend_brunch'
    availableFrom: varchar("available_from"), // "06:00"  24-h HH:MM
    availableTo: varchar("available_to"), // "11:00"
    availableDays: jsonb("available_days").default(
      sql`'["mon","tue","wed","thu","fri","sat","sun"]'::jsonb`,
    ),
    // e.g. ["mon","tue","wed","thu","fri","sat","sun"]
    isActive: boolean("is_active").notNull().default(true),
    acceptsCash: boolean("accepts_cash").notNull().default(false),
    // When true customers see a "Pay in-store" option at checkout
    hidePlatformFee: boolean("hide_platform_fee").notNull().default(false),
    // If true the $1 fee is absorbed by the business (not shown to customer)
    pricesIncludeTax: boolean("prices_include_tax").notNull().default(false),
    // Merchant attestation required for native checkout; MealScout does not
    // calculate tax independently in this contract.
    importSource: varchar("import_source"),
    // 'manual' | 'csv' | 'ubereats' | 'doordash' | 'clover' | 'toast' | 'square' | 'gmb' | 'pdf'
    importedAt: timestamp("imported_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_menus_restaurant").on(table.restaurantId),
    index("idx_menus_service_type").on(table.serviceType),
    index("idx_menus_is_active").on(table.isActive),
  ],
);

export const menuCategories = pgTable(
  "menu_categories",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    menuId: varchar("menu_id")
      .notNull()
      .references(() => menus.id, { onDelete: "cascade" }),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(), // "Appetizers", "Mains", "Drinks"
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_menu_categories_menu").on(table.menuId),
    index("idx_menu_categories_restaurant").on(table.restaurantId),
    index("idx_menu_categories_sort").on(table.menuId, table.sortOrder),
  ],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    menuId: varchar("menu_id")
      .notNull()
      .references(() => menus.id, { onDelete: "cascade" }),
    categoryId: varchar("category_id").references(() => menuCategories.id, {
      onDelete: "set null",
    }),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    description: text("description"),
    // NULL means the business has published the item without a current price.
    // Unpriced items are browse-only and cannot enter checkout.
    priceCents: integer("price_cents"),
    itemType: varchar("item_type").notNull().default("food"),
    imageUrl: varchar("image_url"),
    sku: varchar("sku"),
    // Nutrition info (optional, for health-conscious labeling)
    calories: integer("calories"),
    proteinG: decimal("protein_g", { precision: 6, scale: 2 }),
    carbsG: decimal("carbs_g", { precision: 6, scale: 2 }),
    fatG: decimal("fat_g", { precision: 6, scale: 2 }),
    allergens: jsonb("allergens").default(sql`'[]'::jsonb`),
    // e.g. ["gluten","dairy","nuts"]
    dietaryTags: jsonb("dietary_tags").default(sql`'[]'::jsonb`),
    // e.g. ["vegan","gluten-free","keto"]
    // Inventory
    trackInventory: boolean("track_inventory").notNull().default(false),
    inventoryQty: integer("inventory_qty"),
    // Availability
    isAvailable: boolean("is_available").notNull().default(true),
    // True only when checkout inventory exhaustion, rather than an owner
    // decision, made this item unavailable. Cancellation may safely clear it.
    inventoryAutoUnavailable: boolean("inventory_auto_unavailable")
      .notNull()
      .default(false),
    availableFrom: varchar("available_from"), // override menu-level time
    availableTo: varchar("available_to"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_menu_items_menu").on(table.menuId),
    index("idx_menu_items_category").on(table.categoryId),
    index("idx_menu_items_restaurant").on(table.restaurantId),
    index("idx_menu_items_available").on(table.isAvailable),
    index("idx_menu_items_item_type").on(table.itemType),
  ],
);

// Menu-item level recommendations with optional proof comment/rating.
export const menuItemRecommendations = pgTable(
  "menu_item_recommendations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    menuItemId: varchar("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    comment: text("comment"),
    rating: integer("rating"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_menu_item_recommendations_restaurant").on(table.restaurantId),
    index("idx_menu_item_recommendations_menu_item").on(table.menuItemId),
    index("idx_menu_item_recommendations_user").on(table.userId),
    unique("uq_menu_item_recommendations_user_item").on(table.userId, table.menuItemId),
  ],
);

// User-submitted dish proof photos attached to a specific menu item.
export const menuItemPhotos = pgTable(
  "menu_item_photos",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    menuItemId: varchar("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    sourceUserId: varchar("source_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recommendationId: varchar("recommendation_id").references(
      () => menuItemRecommendations.id,
      { onDelete: "set null" },
    ),
    imageUrl: text("image_url").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    cloudinaryPublicId: varchar("cloudinary_public_id"),
    caption: text("caption"),
    status: varchar("status").notNull().default("pending"), // pending | accepted | rejected | featured
    moderationStatus: varchar("moderation_status").notNull().default("pending"), // pending | accepted | rejected | featured
    featuredByBusiness: boolean("featured_by_business").notNull().default(false),
    reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at"),
    rejectedReason: text("rejected_reason"),
    scorePhotoAwardedAt: timestamp("score_photo_awarded_at"),
    scoreFeaturedAwardedAt: timestamp("score_featured_awarded_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_menu_item_photos_restaurant").on(table.restaurantId),
    index("idx_menu_item_photos_menu_item").on(table.menuItemId),
    index("idx_menu_item_photos_source_user").on(table.sourceUserId),
    index("idx_menu_item_photos_status").on(table.status),
  ],
);

/**
 * menuItemVariants – size / style variants that change the price.
 * e.g. Small ($8), Medium ($10), Large ($12)
 */
export const menuItemVariants = pgTable(
  "menu_item_variants",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    menuItemId: varchar("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    label: varchar("label").notNull(), // "Large", "12 oz", "Spicy"
    additionalCents: integer("additional_cents").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [index("idx_menu_item_variants_item").on(table.menuItemId)],
);

/**
 * menuItemModifiers – optional add-ons that can be selected at order time.
 * e.g. "Extra Cheese +$0.50", "No Onions (free)"
 */
export const menuItemModifiers = pgTable(
  "menu_item_modifiers",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    menuItemId: varchar("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    groupName: varchar("group_name").notNull(), // "Sauces", "Toppings", "Temperature"
    label: varchar("label").notNull(), // "Ranch", "Extra Cheese", "Well Done"
    additionalCents: integer("additional_cents").notNull().default(0),
    isRequired: boolean("is_required").notNull().default(false),
    maxSelections: integer("max_selections").default(1),
    // If > 1, customer can pick multiple from this group
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("idx_menu_item_modifiers_item").on(table.menuItemId),
    index("idx_menu_item_modifiers_group").on(
      table.menuItemId,
      table.groupName,
    ),
  ],
);

/**
 * menuImportLogs – audit trail for every menu import event.
 */
export const menuImportLogs = pgTable(
  "menu_import_logs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    importedByUserId: varchar("imported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: varchar("source").notNull(),
    // 'manual' | 'csv' | 'ubereats' | 'doordash' | 'clover' | 'toast' | 'square' | 'gmb' | 'pdf'
    fileName: varchar("file_name"),
    itemsImported: integer("items_imported").default(0),
    itemsSkipped: integer("items_skipped").default(0),
    errors: jsonb("errors").default(sql`'[]'::jsonb`),
    status: varchar("status").notNull().default("complete"),
    // 'pending' | 'processing' | 'complete' | 'failed'
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_menu_import_logs_restaurant").on(table.restaurantId),
    index("idx_menu_import_logs_created").on(table.createdAt),
  ],
);

export const menuDraftReviews = pgTable(
  "menu_draft_reviews",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    profileId: varchar("profile_id"),
    businessName: varchar("business_name").notNull(),
    publicProfilePath: varchar("public_profile_path"),
    sourceType: varchar("source_type").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceUrls: jsonb("source_urls").default(sql`'[]'::jsonb`),
    sourceArtifactPaths: jsonb("source_artifact_paths").default(
      sql`'[]'::jsonb`,
    ),
    capturedAt: timestamp("captured_at"),
    artifactPath: varchar("artifact_path"),
    artifactGeneratedAt: timestamp("artifact_generated_at"),
    importStatus: varchar("import_status").notNull().default("pending_review"),
    reviewStatus: varchar("review_status").notNull().default("pending_review"),
    confidence: varchar("confidence").notNull().default("low"),
    currentness: varchar("currentness").notNull().default("unknown"),
    ownerApprovalNeeded: boolean("owner_approval_needed")
      .notNull()
      .default(true),
    ownerApproved: boolean("owner_approved").notNull().default(false),
    ownerApprovalEvidenceUrl: text("owner_approval_evidence_url"),
    reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at"),
    productionApplied: boolean("production_applied").notNull().default(false),
    appliedMenuId: varchar("applied_menu_id").references(() => menus.id, {
      onDelete: "set null",
    }),
    notes: jsonb("notes").default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_menu_draft_reviews_restaurant").on(table.restaurantId),
    index("idx_menu_draft_reviews_status").on(table.reviewStatus),
    index("idx_menu_draft_reviews_owner_approved").on(table.ownerApproved),
    index("idx_menu_draft_reviews_production_applied").on(
      table.productionApplied,
    ),
  ],
);

export const menuDraftReviewItems = pgTable(
  "menu_draft_review_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    draftReviewId: varchar("draft_review_id")
      .notNull()
      .references(() => menuDraftReviews.id, { onDelete: "cascade" }),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    sectionName: varchar("section_name"),
    sectionOrder: integer("section_order").notNull().default(0),
    itemName: varchar("item_name").notNull(),
    baseItemName: varchar("base_item_name"),
    variantLabel: varchar("variant_label"),
    description: text("description"),
    priceCents: integer("price_cents"),
    priceLabel: varchar("price_label"),
    category: varchar("category"),
    options: jsonb("options").default(sql`'[]'::jsonb`),
    sourceConfidence: varchar("source_confidence").notNull().default("low"),
    sourceRef: text("source_ref"),
    ownerApprovalNeeded: boolean("owner_approval_needed")
      .notNull()
      .default(true),
    ownerApproved: boolean("owner_approved").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_menu_draft_review_items_review").on(table.draftReviewId),
    index("idx_menu_draft_review_items_restaurant").on(table.restaurantId),
  ],
);

// ── MERCHANT-CONTROLLED CROSS-PROMOTION ──────────────────────────────────────

export const merchantPromotionPolicies = pgTable(
  "merchant_promotion_policies",
  {
    restaurantId: varchar("restaurant_id")
      .primaryKey()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    approvalMode: varchar("approval_mode").notNull().default("automatic"),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);

export const merchantPromotionPartners = pgTable(
  "merchant_promotion_partners",
  {
    sourceRestaurantId: varchar("source_restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    targetRestaurantId: varchar("target_restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    status: varchar("status").notNull(),
    commissionBps: integer("commission_bps").notNull().default(0),
    targetApprovedAt: timestamp("target_approved_at"),
    updatedByUserId: varchar("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.sourceRestaurantId, table.targetRestaurantId],
    }),
    index("idx_promotion_partners_target").on(
      table.targetRestaurantId,
      table.status,
    ),
  ],
);

export const promotionAttributions = pgTable(
  "promotion_attributions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tokenHash: varchar("token_hash").notNull().unique(),
    sourceRestaurantId: varchar("source_restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    targetRestaurantId: varchar("target_restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    affiliateUserId: varchar("affiliate_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sessionId: varchar("session_id"),
    customerUserId: varchar("customer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    orderId: varchar("order_id").unique(),
    clickedAt: timestamp("clicked_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    convertedAt: timestamp("converted_at"),
  },
  (table) => [
    index("idx_promotion_attributions_source").on(
      table.sourceRestaurantId,
      table.clickedAt,
    ),
    index("idx_promotion_attributions_target").on(
      table.targetRestaurantId,
      table.clickedAt,
    ),
  ],
);

export const promotedOrderCommissions = pgTable(
  "promoted_order_commissions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orderId: varchar("order_id").notNull().unique(),
    attributionId: varchar("attribution_id")
      .notNull()
      .unique()
      .references(() => promotionAttributions.id, { onDelete: "cascade" }),
    sourceRestaurantId: varchar("source_restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    targetRestaurantId: varchar("target_restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    affiliateUserId: varchar("affiliate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    commissionBps: integer("commission_bps").notNull(),
    eligibleOrderCents: integer("eligible_order_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: varchar("status").notNull().default("pending"),
    eligibleAt: timestamp("eligible_at"),
    reversedAt: timestamp("reversed_at"),
    paidAt: timestamp("paid_at"),
    reversalReason: text("reversal_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_promoted_commissions_affiliate").on(
      table.affiliateUserId,
      table.status,
    ),
    index("idx_promoted_commissions_source").on(
      table.sourceRestaurantId,
      table.createdAt,
    ),
  ],
);

// ── PICKUP ORDERS ────────────────────────────────────────────────────────────

/**
 * pickupOrders – durable order records. The current public contract only
 * creates pickup orders paid by card; legacy order types remain readable.
 */
export const pickupOrders = pgTable(
  "pickup_orders",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    customerId: varchar("customer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Guest checkout: customerName and at least one contact method are required
    customerName: varchar("customer_name").notNull(),
    customerEmail: varchar("customer_email"),
    customerPhone: varchar("customer_phone"),
    orderType: varchar("order_type").notNull().default("pickup"),
    // 'pickup' | 'dine_in' | 'delivery'
    orderingContractVersion: varchar("ordering_contract_version"),
    status: varchar("status").notNull().default("pending"),
    // 'pending' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'payment_disputed' | 'cancellation_pending' | 'cancelled'
    // Pricing (all in cents)
    subtotalCents: integer("subtotal_cents").notNull(),
    mealscoutFeeCents: integer("mealscout_fee_cents").notNull().default(0),
    processingFeeCents: integer("processing_fee_cents").notNull().default(0),
    platformFeeCents: integer("platform_fee_cents").notNull().default(0),
    feePaidByBusiness: boolean("fee_paid_by_business").notNull().default(false),
    // true if business absorbed the fee (hidePlatformFee = true on menu)
    pricesIncludeTax: boolean("prices_include_tax").notNull().default(false),
    totalCents: integer("total_cents").notNull(),
    // Payment
    paymentMethod: varchar("payment_method").notNull().default("card"),
    // 'card' | 'cash'
    stripePaymentIntentId: varchar("stripe_payment_intent_id"),
    stripeTransferGroupId: varchar("stripe_transfer_group_id"),
    stripeRefundId: varchar("stripe_refund_id"),
    stripeRefundStatus: varchar("stripe_refund_status"),
    stripeRefundAmountCents: integer("stripe_refund_amount_cents"),
    refundAttemptCount: integer("refund_attempt_count").notNull().default(0),
    refundFailureReason: text("refund_failure_reason"),
    refundUpdatedAt: timestamp("refund_updated_at"),
    stripeDisputeId: varchar("stripe_dispute_id"),
    stripeDisputeStatus: varchar("stripe_dispute_status"),
    stripeDisputeAmountCents: integer("stripe_dispute_amount_cents"),
    stripeDisputeReason: varchar("stripe_dispute_reason"),
    disputeFailureReason: text("dispute_failure_reason"),
    disputeUpdatedAt: timestamp("dispute_updated_at"),
    checkoutRequestId: varchar("checkout_request_id").unique(),
    customerAccessTokenHash: varchar("customer_access_token_hash"),
    payoutStatus: varchar("payout_status").notNull().default("pending"),
    // 'pending' | 'transferred' | 'failed' | 'reversal_pending' | 'partially_reversed' | 'reversed' | 'dispute_reversal_pending' | 'dispute_reinstatement_pending' | 'disputed'
    payoutReversalAttemptCount: integer("payout_reversal_attempt_count")
      .notNull()
      .default(0),
    payoutReversalFailureReason: text("payout_reversal_failure_reason"),
    payoutReversalUpdatedAt: timestamp("payout_reversal_updated_at"),
    // Fulfillment
    merchantNameSnapshot: varchar("merchant_name_snapshot"),
    merchantOwnerIdSnapshot: varchar("merchant_owner_id_snapshot"),
    stripeConnectAccountIdSnapshot: varchar(
      "stripe_connect_account_id_snapshot",
    ),
    merchantAcknowledgementMinutesSnapshot: integer(
      "merchant_acknowledgement_minutes_snapshot",
    ),
    merchantAcknowledgementDueAt: timestamp("merchant_acknowledgement_due_at"),
    merchantAcknowledgedAt: timestamp("merchant_acknowledged_at"),
    pickupAddressSnapshot: text("pickup_address_snapshot"),
    pickupDirectionsUrlSnapshot: text("pickup_directions_url_snapshot"),
    specialInstructions: text("special_instructions"),
    // Null until the business supplies a preparation estimate.
    prepTimeMinutes: integer("prep_time_minutes"),
    scheduledFor: timestamp("scheduled_for"),
    deliveryAddress: text("delivery_address"),
    deliveryCity: varchar("delivery_city"),
    deliveryState: varchar("delivery_state"),
    deliveryPostalCode: varchar("delivery_postal_code"),
    deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    tipCents: integer("tip_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    deliveryEstimateMinutes: integer("delivery_estimate_minutes"),
    deliveryInstructions: text("delivery_instructions"),
    outForDeliveryAt: timestamp("out_for_delivery_at"),
    deliveredAt: timestamp("delivered_at"),
    // null = ASAP; future timestamp = pre-order
    confirmedAt: timestamp("confirmed_at"),
    readyAt: timestamp("ready_at"),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    cancellationReason: text("cancellation_reason"),
    inventoryRestoredAt: timestamp("inventory_restored_at"),
    // Notifications
    readyNotificationSent: boolean("ready_notification_sent")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_pickup_orders_restaurant").on(table.restaurantId),
    index("idx_pickup_orders_customer").on(table.customerId),
    index("idx_pickup_orders_status").on(table.status),
    index("idx_pickup_orders_created").on(table.createdAt),
    index("idx_pickup_orders_scheduled").on(table.scheduledFor),
    index("idx_pickup_orders_payout_status").on(table.payoutStatus),
  ],
);

/**
 * pickupOrderItems – line items within a pickup order.
 * Prices snapshot at purchase time so menu changes don't break receipts.
 */
export const pickupOrderItems = pgTable(
  "pickup_order_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orderId: varchar("order_id")
      .notNull()
      .references(() => pickupOrders.id, { onDelete: "cascade" }),
    menuItemId: varchar("menu_item_id").references(() => menuItems.id, {
      onDelete: "set null",
    }),
    // Snapshot fields (preserved even if item is later deleted)
    itemName: varchar("item_name").notNull(),
    itemDescription: text("item_description"),
    basePriceCents: integer("base_price_cents").notNull(),
    selectedVariant: jsonb("selected_variant"),
    // { id, label, additionalCents }
    selectedModifiers: jsonb("selected_modifiers").default(sql`'[]'::jsonb`),
    // [{ id, groupName, label, additionalCents }]
    quantity: integer("quantity").notNull().default(1),
    // Quantity actually decremented from tracked inventory for this line.
    // Null identifies a legacy row with no safe restoration provenance.
    inventoryReservedQuantity: integer("inventory_reserved_quantity"),
    lineTotalCents: integer("line_total_cents").notNull(),
    specialInstructions: text("special_instructions"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_pickup_order_items_order").on(table.orderId),
    index("idx_pickup_order_items_menu_item").on(table.menuItemId),
  ],
);

/**
 * orderNotifications – log of all customer notifications sent for an order.
 */
export const orderNotifications = pgTable(
  "order_notifications",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orderId: varchar("order_id")
      .notNull()
      .references(() => pickupOrders.id, { onDelete: "cascade" }),
    channel: varchar("channel").notNull(), // 'email' | 'sms' | 'push'
    type: varchar("type").notNull(), // 'confirmation' | 'ready' | 'cancelled'
    recipient: varchar("recipient"), // email address or phone
    sentAt: timestamp("sent_at").defaultNow(),
    status: varchar("status").notNull().default("sent"), // 'sent' | 'failed'
    errorMessage: text("error_message"),
    dedupeKey: varchar("dedupe_key").unique(),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (table) => [
    index("idx_order_notifications_order").on(table.orderId),
    index("idx_order_notifications_sent").on(table.sentAt),
  ],
);

// ── DELIVERY INFRASTRUCTURE (Phase 2 – schema ready, routes dormant) ─────────

/**
 * driverProfiles – contractor driver resume + reputation.
 * Linked to a regular MealScout user account.
 */
export const driverProfiles = pgTable(
  "driver_profiles",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    bio: text("bio"),
    vehicleType: varchar("vehicle_type"), // 'car' | 'motorcycle' | 'bicycle' | 'scooter'
    serviceCities: jsonb("service_cities").default(sql`'[]'::jsonb`),
    // list of city slugs where the driver works
    ratePerDeliveryCents: integer("rate_per_delivery_cents"),
    // driver's requested rate; null = negotiable
    totalDeliveries: integer("total_deliveries").notNull().default(0),
    averageRating: decimal("average_rating", { precision: 3, scale: 2 }),
    isActive: boolean("is_active").notNull().default(true),
    backgroundCheckStatus: varchar("background_check_status").default("none"),
    // 'none' | 'pending' | 'approved' | 'rejected'
    resumeUrl: varchar("resume_url"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_driver_profiles_user").on(table.userId),
    index("idx_driver_profiles_active").on(table.isActive),
  ],
);

/**
 * deliveryJobs – job listings posted by businesses looking for drivers.
 * Can be recurring (e.g. "every Fri-Sun 5-10pm") or one-time.
 */
export const deliveryJobs = pgTable(
  "delivery_jobs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    title: varchar("title").notNull(),
    description: text("description"),
    jobType: varchar("job_type").notNull().default("recurring"),
    // 'recurring' | 'one_time'
    scheduleDescription: text("schedule_description"),
    // human-readable: "Fri–Sun 5pm–10pm"
    rateOfferedCents: integer("rate_offered_cents"),
    // null = open to driver's rate
    deliveryZoneRadius: decimal("delivery_zone_radius", {
      precision: 6,
      scale: 2,
    }),
    // miles
    status: varchar("status").notNull().default("open"),
    // 'open' | 'filled' | 'closed'
    positionsAvailable: integer("positions_available").default(1),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_delivery_jobs_restaurant").on(table.restaurantId),
    index("idx_delivery_jobs_status").on(table.status),
    index("idx_delivery_jobs_created").on(table.createdAt),
  ],
);

/**
 * deliveryJobApplications – driver applies to a job listing.
 */
export const deliveryJobApplications = pgTable(
  "delivery_job_applications",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    jobId: varchar("job_id")
      .notNull()
      .references(() => deliveryJobs.id, { onDelete: "cascade" }),
    driverProfileId: varchar("driver_profile_id")
      .notNull()
      .references(() => driverProfiles.id, { onDelete: "cascade" }),
    coverNote: text("cover_note"),
    proposedRateCents: integer("proposed_rate_cents"),
    status: varchar("status").notNull().default("pending"),
    // 'pending' | 'accepted' | 'rejected' | 'withdrawn'
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_delivery_job_apps_job").on(table.jobId),
    index("idx_delivery_job_apps_driver").on(table.driverProfileId),
    index("idx_delivery_job_apps_status").on(table.status),
    unique("uq_delivery_job_apps_job_driver").on(
      table.jobId,
      table.driverProfileId,
    ),
  ],
);

// ── HIRING MARKETPLACE + PRIVATE CHEF LEADS ─────────────────────────────────

export const workerProfiles = pgTable(
  "worker_profiles",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: varchar("display_name").notNull(),
    headline: varchar("headline"),
    bio: text("bio"),
    roles: jsonb("roles")
      .notNull()
      .default(sql`'[]'::jsonb`),
    experienceLevel: varchar("experience_level").default("experienced"),
    serviceCities: jsonb("service_cities")
      .notNull()
      .default(sql`'[]'::jsonb`),
    availability: jsonb("availability")
      .notNull()
      .default(sql`'{}'::jsonb`),
    desiredRateCents: integer("desired_rate_cents"),
    resumeUrl: varchar("resume_url"),
    portfolioUrl: varchar("portfolio_url"),
    phone: varchar("phone"),
    email: varchar("email"),
    isOpenToWork: boolean("is_open_to_work").notNull().default(true),
    isPublic: boolean("is_public").notNull().default(true),
    backgroundCheckStatus: varchar("background_check_status").default("none"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_worker_profiles_user").on(table.userId),
    index("idx_worker_profiles_open_public").on(
      table.isOpenToWork,
      table.isPublic,
    ),
    index("idx_worker_profiles_created").on(table.createdAt),
  ],
);

export const jobPosts = pgTable(
  "job_posts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    restaurantId: varchar("restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    postedByUserId: varchar("posted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: varchar("title").notNull(),
    description: text("description"),
    role: varchar("role").notNull(),
    jobType: varchar("job_type").notNull().default("part_time"),
    locationType: varchar("location_type").notNull().default("onsite"),
    city: varchar("city"),
    state: varchar("state"),
    address: varchar("address"),
    scheduleDescription: text("schedule_description"),
    rateMinCents: integer("rate_min_cents"),
    rateMaxCents: integer("rate_max_cents"),
    status: varchar("status").notNull().default("open"),
    positionsAvailable: integer("positions_available").notNull().default(1),
    startsAt: timestamp("starts_at"),
    expiresAt: timestamp("expires_at"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_job_posts_restaurant").on(table.restaurantId),
    index("idx_job_posts_status_created").on(table.status, table.createdAt),
    index("idx_job_posts_city_state").on(table.city, table.state),
    index("idx_job_posts_role").on(table.role),
  ],
);

export const jobApplications = pgTable(
  "job_applications",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    jobId: varchar("job_id")
      .notNull()
      .references(() => jobPosts.id, { onDelete: "cascade" }),
    workerProfileId: varchar("worker_profile_id")
      .notNull()
      .references(() => workerProfiles.id, { onDelete: "cascade" }),
    applicantUserId: varchar("applicant_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    coverNote: text("cover_note"),
    proposedRateCents: integer("proposed_rate_cents"),
    status: varchar("status").notNull().default("pending"),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_job_applications_job").on(table.jobId),
    index("idx_job_applications_worker").on(table.workerProfileId),
    index("idx_job_applications_applicant").on(table.applicantUserId),
    index("idx_job_applications_status").on(table.status),
    unique("uq_job_applications_job_worker").on(
      table.jobId,
      table.workerProfileId,
    ),
  ],
);

export const privateChefLeads = pgTable(
  "private_chef_leads",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    chefRestaurantId: varchar("chef_restaurant_id")
      .notNull()
      .references(() => restaurants.id, { onDelete: "cascade" }),
    customerUserId: varchar("customer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    customerName: varchar("customer_name").notNull(),
    customerEmail: varchar("customer_email"),
    customerPhone: varchar("customer_phone"),
    eventDate: timestamp("event_date"),
    city: varchar("city"),
    state: varchar("state"),
    address: varchar("address"),
    guestCount: integer("guest_count"),
    budgetCents: integer("budget_cents"),
    occasion: varchar("occasion"),
    dietaryNeeds: text("dietary_needs"),
    notes: text("notes"),
    status: varchar("status").notNull().default("new"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_private_chef_leads_chef").on(table.chefRestaurantId),
    index("idx_private_chef_leads_customer").on(table.customerUserId),
    index("idx_private_chef_leads_status").on(table.status),
    index("idx_private_chef_leads_created").on(table.createdAt),
  ],
);

// ── RELATIONS ────────────────────────────────────────────────────────────────

export const menusRelations = relations(menus, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [menus.restaurantId],
    references: [restaurants.id],
  }),
  categories: many(menuCategories),
  items: many(menuItems),
}));

export const menuCategoriesRelations = relations(
  menuCategories,
  ({ one, many }) => ({
    menu: one(menus, {
      fields: [menuCategories.menuId],
      references: [menus.id],
    }),
    items: many(menuItems),
  }),
);

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  menu: one(menus, {
    fields: [menuItems.menuId],
    references: [menus.id],
  }),
  category: one(menuCategories, {
    fields: [menuItems.categoryId],
    references: [menuCategories.id],
  }),
  variants: many(menuItemVariants),
  modifiers: many(menuItemModifiers),
  recommendations: many(menuItemRecommendations),
  photos: many(menuItemPhotos),
}));

export const menuItemRecommendationsRelations = relations(
  menuItemRecommendations,
  ({ one, many }) => ({
    restaurant: one(restaurants, {
      fields: [menuItemRecommendations.restaurantId],
      references: [restaurants.id],
    }),
    menuItem: one(menuItems, {
      fields: [menuItemRecommendations.menuItemId],
      references: [menuItems.id],
    }),
    user: one(users, {
      fields: [menuItemRecommendations.userId],
      references: [users.id],
    }),
    photos: many(menuItemPhotos),
  }),
);

export const menuItemPhotosRelations = relations(menuItemPhotos, ({ one }) => ({
  restaurant: one(restaurants, {
    fields: [menuItemPhotos.restaurantId],
    references: [restaurants.id],
  }),
  menuItem: one(menuItems, {
    fields: [menuItemPhotos.menuItemId],
    references: [menuItems.id],
  }),
  sourceUser: one(users, {
    fields: [menuItemPhotos.sourceUserId],
    references: [users.id],
  }),
  reviewedByUser: one(users, {
    fields: [menuItemPhotos.reviewedByUserId],
    references: [users.id],
  }),
  recommendation: one(menuItemRecommendations, {
    fields: [menuItemPhotos.recommendationId],
    references: [menuItemRecommendations.id],
  }),
}));

export const menuItemVariantsRelations = relations(
  menuItemVariants,
  ({ one }) => ({
    item: one(menuItems, {
      fields: [menuItemVariants.menuItemId],
      references: [menuItems.id],
    }),
  }),
);

export const menuItemModifiersRelations = relations(
  menuItemModifiers,
  ({ one }) => ({
    item: one(menuItems, {
      fields: [menuItemModifiers.menuItemId],
      references: [menuItems.id],
    }),
  }),
);

export const pickupOrdersRelations = relations(
  pickupOrders,
  ({ one, many }) => ({
    restaurant: one(restaurants, {
      fields: [pickupOrders.restaurantId],
      references: [restaurants.id],
    }),
    customer: one(users, {
      fields: [pickupOrders.customerId],
      references: [users.id],
    }),
    items: many(pickupOrderItems),
    notifications: many(orderNotifications),
  }),
);

export const pickupOrderItemsRelations = relations(
  pickupOrderItems,
  ({ one }) => ({
    order: one(pickupOrders, {
      fields: [pickupOrderItems.orderId],
      references: [pickupOrders.id],
    }),
    menuItem: one(menuItems, {
      fields: [pickupOrderItems.menuItemId],
      references: [menuItems.id],
    }),
  }),
);

export const orderNotificationsRelations = relations(
  orderNotifications,
  ({ one }) => ({
    order: one(pickupOrders, {
      fields: [orderNotifications.orderId],
      references: [pickupOrders.id],
    }),
  }),
);

export const driverProfilesRelations = relations(
  driverProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [driverProfiles.userId],
      references: [users.id],
    }),
    applications: many(deliveryJobApplications),
  }),
);

export const deliveryJobsRelations = relations(
  deliveryJobs,
  ({ one, many }) => ({
    restaurant: one(restaurants, {
      fields: [deliveryJobs.restaurantId],
      references: [restaurants.id],
    }),
    applications: many(deliveryJobApplications),
  }),
);

export const deliveryJobApplicationsRelations = relations(
  deliveryJobApplications,
  ({ one }) => ({
    job: one(deliveryJobs, {
      fields: [deliveryJobApplications.jobId],
      references: [deliveryJobs.id],
    }),
    driverProfile: one(driverProfiles, {
      fields: [deliveryJobApplications.driverProfileId],
      references: [driverProfiles.id],
    }),
  }),
);

export const workerProfilesRelations = relations(
  workerProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [workerProfiles.userId],
      references: [users.id],
    }),
    applications: many(jobApplications),
  }),
);

export const jobPostsRelations = relations(jobPosts, ({ one, many }) => ({
  restaurant: one(restaurants, {
    fields: [jobPosts.restaurantId],
    references: [restaurants.id],
  }),
  postedBy: one(users, {
    fields: [jobPosts.postedByUserId],
    references: [users.id],
  }),
  applications: many(jobApplications),
}));

export const jobApplicationsRelations = relations(
  jobApplications,
  ({ one }) => ({
    job: one(jobPosts, {
      fields: [jobApplications.jobId],
      references: [jobPosts.id],
    }),
    workerProfile: one(workerProfiles, {
      fields: [jobApplications.workerProfileId],
      references: [workerProfiles.id],
    }),
    applicant: one(users, {
      fields: [jobApplications.applicantUserId],
      references: [users.id],
    }),
  }),
);

export const privateChefLeadsRelations = relations(
  privateChefLeads,
  ({ one }) => ({
    chef: one(restaurants, {
      fields: [privateChefLeads.chefRestaurantId],
      references: [restaurants.id],
    }),
    customer: one(users, {
      fields: [privateChefLeads.customerUserId],
      references: [users.id],
    }),
  }),
);

// ── ZOOD VALIDATION SCHEMAS ──────────────────────────────────────────────────

export const insertMenuSchema = createInsertSchema(menus).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMenuCategorySchema = createInsertSchema(menuCategories).omit(
  {
    id: true,
    createdAt: true,
    updatedAt: true,
  },
);

export const insertMenuItemSchema = createInsertSchema(menuItems, {
  priceCents: z.number().int().min(0).nullable(),
  itemType: z.enum(["food", "merchandise"]).default("food"),
  calories: z.number().int().min(0).optional().nullable(),
}).omit({
  id: true,
  inventoryAutoUnavailable: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMenuItemRecommendationSchema = createInsertSchema(
  menuItemRecommendations,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMenuItemPhotoSchema = createInsertSchema(menuItemPhotos).omit(
  {
    id: true,
    reviewedByUserId: true,
    reviewedAt: true,
    scorePhotoAwardedAt: true,
    scoreFeaturedAwardedAt: true,
    createdAt: true,
    updatedAt: true,
  },
);

export const insertMenuItemVariantSchema = createInsertSchema(
  menuItemVariants,
  {
    additionalCents: z.number().int().min(0),
  },
).omit({ id: true });

export const insertMenuItemModifierSchema = createInsertSchema(
  menuItemModifiers,
  {
    additionalCents: z.number().int().min(0),
  },
).omit({ id: true });

export const insertPickupOrderSchema = createInsertSchema(pickupOrders, {
  subtotalCents: z.number().int().min(1),
  totalCents: z.number().int().min(1),
  prepTimeMinutes: z.number().int().min(1).max(120).optional().nullable(),
}).omit({
  id: true,
  stripePaymentIntentId: true,
  stripeTransferGroupId: true,
  payoutStatus: true,
  merchantAcknowledgementMinutesSnapshot: true,
  merchantAcknowledgementDueAt: true,
  merchantAcknowledgedAt: true,
  confirmedAt: true,
  readyAt: true,
  completedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  readyNotificationSent: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPickupOrderItemSchema = createInsertSchema(
  pickupOrderItems,
  {
    basePriceCents: z.number().int().min(0),
    lineTotalCents: z.number().int().min(0),
    quantity: z.number().int().min(1),
  },
).omit({ id: true, createdAt: true });

export const insertDriverProfileSchema = createInsertSchema(driverProfiles, {
  ratePerDeliveryCents: z.number().int().min(0).optional().nullable(),
}).omit({
  id: true,
  totalDeliveries: true,
  averageRating: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDeliveryJobSchema = createInsertSchema(deliveryJobs, {
  rateOfferedCents: z.number().int().min(0).optional().nullable(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const insertDeliveryJobApplicationSchema = createInsertSchema(
  deliveryJobApplications,
  {
    proposedRateCents: z.number().int().min(0).optional().nullable(),
  },
).omit({ id: true, respondedAt: true, createdAt: true });

export const insertWorkerProfileSchema = createInsertSchema(workerProfiles, {
  desiredRateCents: z.number().int().min(0).optional().nullable(),
}).omit({
  id: true,
  userId: true,
  backgroundCheckStatus: true,
  createdAt: true,
  updatedAt: true,
});

export const insertJobPostSchema = createInsertSchema(jobPosts, {
  rateMinCents: z.number().int().min(0).optional().nullable(),
  rateMaxCents: z.number().int().min(0).optional().nullable(),
  positionsAvailable: z.number().int().min(1).optional(),
}).omit({
  id: true,
  postedByUserId: true,
  createdAt: true,
  updatedAt: true,
});

export const insertJobApplicationSchema = createInsertSchema(jobApplications, {
  proposedRateCents: z.number().int().min(0).optional().nullable(),
}).omit({
  id: true,
  workerProfileId: true,
  applicantUserId: true,
  respondedAt: true,
  createdAt: true,
});

export const insertPrivateChefLeadSchema = createInsertSchema(
  privateChefLeads,
  {
    guestCount: z.number().int().min(1).optional().nullable(),
    budgetCents: z.number().int().min(0).optional().nullable(),
  },
).omit({
  id: true,
  customerUserId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

// ── MENU / ORDER TYPES ───────────────────────────────────────────────────────

export type Menu = typeof menus.$inferSelect;
export type InsertMenu = z.infer<typeof insertMenuSchema>;
export type MenuCategory = typeof menuCategories.$inferSelect;
export type InsertMenuCategory = z.infer<typeof insertMenuCategorySchema>;
export type MenuItem = typeof menuItems.$inferSelect;
export type InsertMenuItem = z.infer<typeof insertMenuItemSchema>;
export type MenuItemVariant = typeof menuItemVariants.$inferSelect;
export type InsertMenuItemVariant = z.infer<typeof insertMenuItemVariantSchema>;
export type MenuItemModifier = typeof menuItemModifiers.$inferSelect;
export type InsertMenuItemModifier = z.infer<
  typeof insertMenuItemModifierSchema
>;
export type MenuImportLog = typeof menuImportLogs.$inferSelect;
export type MenuDraftReview = typeof menuDraftReviews.$inferSelect;
export type MenuDraftReviewItem = typeof menuDraftReviewItems.$inferSelect;
export type PickupOrder = typeof pickupOrders.$inferSelect;
export type MerchantDeliverySettings = typeof merchantDeliverySettings.$inferSelect;
export type InsertPickupOrder = z.infer<typeof insertPickupOrderSchema>;
export type PickupOrderItem = typeof pickupOrderItems.$inferSelect;
export type InsertPickupOrderItem = z.infer<typeof insertPickupOrderItemSchema>;
export type OrderNotification = typeof orderNotifications.$inferSelect;
export type DriverProfile = typeof driverProfiles.$inferSelect;
export type InsertDriverProfile = z.infer<typeof insertDriverProfileSchema>;
export type DeliveryJob = typeof deliveryJobs.$inferSelect;
export type InsertDeliveryJob = z.infer<typeof insertDeliveryJobSchema>;
export type DeliveryJobApplication =
  typeof deliveryJobApplications.$inferSelect;
export type InsertDeliveryJobApplication = z.infer<
  typeof insertDeliveryJobApplicationSchema
>;
export type WorkerProfile = typeof workerProfiles.$inferSelect;
export type InsertWorkerProfile = z.infer<typeof insertWorkerProfileSchema>;
export type JobPost = typeof jobPosts.$inferSelect;
export type InsertJobPost = z.infer<typeof insertJobPostSchema>;
export type JobApplication = typeof jobApplications.$inferSelect;
export type InsertJobApplication = z.infer<typeof insertJobApplicationSchema>;
export type PrivateChefLead = typeof privateChefLeads.$inferSelect;
export type InsertPrivateChefLead = z.infer<
  typeof insertPrivateChefLeadSchema
>;

// ── ORDER STATUS ENUM ────────────────────────────────────────────────────────
