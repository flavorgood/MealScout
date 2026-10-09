import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  toPublicRestaurantListing,
  toPublicRestaurantListingArray,
} from "../server/publicProfiles/toPublicRestaurantListing";
import {
  toPublicEventListing,
  toPublicEventListingArray,
} from "../server/publicProfiles/toPublicEventListing";
import { toPublicMapLocationsPayload } from "../server/publicProfiles/toPublicMapLocations";
import { toPublicParkingPassListingArray } from "../server/publicProfiles/toPublicParkingPassListing";
import { toPublicRestaurantReviewArray } from "../server/publicProfiles/toPublicRestaurantReview";
import {
  canExposeAnonymousEventDetail,
  canExposeAnonymousEventFeedItem,
  canExposeAnonymousEventListItem,
  canExposeAuthorizedPaidEventDetail,
} from "../server/publicProfiles/publicEventDetailAccess";
import {
  toPublicLocationProfile,
  toPublicRestaurantProfile,
  toPublicSupplierProfile,
} from "../server/publicProfiles";
import {
  buildPublicCta,
  normalizePublicUrl,
} from "../server/publicProfiles/publicProfileUtils";
import { extractIdFromSlug } from "../client/src/lib/seo-slug";
import { assessParkingPassTruckEligibility } from "../server/services/parkingPassTruckEligibility";
import {
  loadEligiblePage,
  publicStoryFeedRateLimitKey,
} from "../server/utils/eligiblePagination";
import { postgresTextArray } from "../server/utils/postgresTextArray";

// --- Runtime: forbidden fields must never survive the DTO ---------------

const compiledTextArrayQuery = new PgDialect().sqlToQuery(
  sql`select 1 where candidate_id = any(${postgresTextArray(["one", "two"])})`,
);
assert.match(
  compiledTextArrayQuery.sql,
  /any\(array\[\$1, \$2\]::text\[\]\)/,
  "PostgreSQL text arrays must compile as arrays, not parenthesized records",
);
assert.deepEqual(compiledTextArrayQuery.params, ["one", "two"]);

const virtualParkingPassId =
  "pp:1a125115-d1a9-4d5d-9ef1-a8250e2d91d3:2026-08-22";
assert.equal(
  extractIdFromSlug(`paid-team-lunch--${virtualParkingPassId}`),
  virtualParkingPassId,
  "event route parsing must preserve the complete virtual Parking Pass id",
);
assert.equal(
  extractIdFromSlug(
    "paid-team-lunch--1a125115-d1a9-4d5d-9ef1-a8250e2d91d3",
  ),
  "1a125115-d1a9-4d5d-9ef1-a8250e2d91d3",
);

const eligibilityNow = new Date("2026-08-22T17:00:00.000Z");
const validTruckEligibility = assessParkingPassTruckEligibility({
  user: { userType: "food_truck", emailVerified: true },
  truck: {
    businessType: "restaurant",
    isFoodTruck: true,
    insuranceVerified: true,
    insuranceExpiresAt: "2026-08-23T17:00:00.000Z",
  },
  now: eligibilityNow,
});
assert.equal(validTruckEligibility.isTruckProfile, true);
assert.equal(validTruckEligibility.storedInsuranceValid, true);
assert.equal(validTruckEligibility.roleAllowed, true);
assert.equal(
  assessParkingPassTruckEligibility({
    user: { userType: "customer", emailVerified: true },
    truck: {
      businessType: "food_truck",
      isFoodTruck: true,
      insuranceVerified: true,
    },
    now: eligibilityNow,
  }).roleAllowed,
  true,
  "an authenticated collaborator is governed by exact manageParkingPass permission rather than a stale global role",
);
assert.equal(
  assessParkingPassTruckEligibility({
    user: { userType: "restaurant_owner", emailVerified: true },
    truck: {
      businessType: "restaurant",
      isFoodTruck: false,
      insuranceVerified: true,
    },
    now: eligibilityNow,
  }).isTruckProfile,
  false,
  "a fixed restaurant must not qualify for Parking Pass booking",
);
assert.equal(
  assessParkingPassTruckEligibility({
    user: { userType: "food_truck", emailVerified: true },
    truck: {
      businessType: "food_truck",
      isFoodTruck: true,
      insuranceVerified: true,
      insuranceExpiresAt: "2026-08-21T17:00:00.000Z",
    },
    now: eligibilityNow,
  }).storedInsuranceValid,
  false,
  "expired insurance must not qualify for Parking Pass booking",
);
assert.equal(
  assessParkingPassTruckEligibility({
    user: { userType: "food_truck", emailVerified: false },
    truck: {
      businessType: "food_truck",
      isFoodTruck: true,
      insuranceVerified: true,
    },
    now: eligibilityNow,
  }).emailVerified,
  false,
  "unverified email must remain visible to the booking gate",
);

const unsafePublicUrls = [
  "javascript:alert(1)",
  "data:text/html,unsafe",
  "//attacker.example.invalid/path",
  "https://user:password@attacker.example.invalid/path",
];
for (const unsafeUrl of unsafePublicUrls) {
  assert.equal(normalizePublicUrl(unsafeUrl), null);
  assert.equal(
    buildPublicCta({ label: "Unsafe", href: unsafeUrl, type: "external" }),
    null,
  );
}
assert.equal(
  normalizePublicUrl("merchant.example.invalid/menu"),
  "https://merchant.example.invalid/menu",
);
assert.equal(
  normalizePublicUrl("/menu/public", { allowInternalPath: true }),
  "/menu/public",
);
assert.equal(normalizePublicUrl("/menu/public"), null);

const unsafeRestaurantProfile = toPublicRestaurantProfile({
  row: {
    id: "unsafe-restaurant-url",
    name: "Unsafe URL Kitchen",
    businessType: "restaurant",
    websiteUrl: unsafePublicUrls[0],
    instagramUrl: unsafePublicUrls[1],
    facebookPageUrl: unsafePublicUrls[2],
    xUrl: unsafePublicUrls[3],
    menuUrl: unsafePublicUrls[0],
    menuImageUrl: unsafePublicUrls[1],
    menuPdfUrl: unsafePublicUrls[2],
    dealsItems: [
      {
        id: "unsafe-deal-url",
        title: "Unsafe deal",
        actionHref: unsafePublicUrls[0],
        actionType: "website",
      },
    ],
    eventsItems: [
      {
        id: "unsafe-event-url",
        title: "Unsafe event",
        actionHref: unsafePublicUrls[2],
        actionType: "website",
      },
    ],
  },
  baseUrl: "https://www.mealscout.us",
});
const unsafeLocationProfile = toPublicLocationProfile({
  row: {
    id: "unsafe-location-url",
    businessName: "Unsafe URL Location",
    websiteUrl: unsafePublicUrls[0],
    instagramUrl: unsafePublicUrls[1],
    facebookPageUrl: unsafePublicUrls[2],
    xUrl: unsafePublicUrls[3],
    spotImageUrl: unsafePublicUrls[1],
  },
  baseUrl: "https://www.mealscout.us",
});
const unsafeSupplierProfile = toPublicSupplierProfile({
  row: {
    id: "unsafe-supplier-url",
    businessName: "Unsafe URL Supplier",
    websiteUrl: unsafePublicUrls[3],
    logoUrl: unsafePublicUrls[2],
  },
  activeProductCount: 0,
  baseUrl: "https://www.mealscout.us",
});
for (const projection of [
  unsafeRestaurantProfile,
  unsafeLocationProfile,
  unsafeSupplierProfile,
]) {
  const serialized = JSON.stringify(projection);
  for (const sentinel of ["javascript:", "data:", "//attacker", "user:password@"]) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `public projection leaked unsafe URL sentinel ${sentinel}`,
    );
  }
}
assert.deepEqual(unsafeRestaurantProfile.deals.items, []);
assert.deepEqual(unsafeRestaurantProfile.events.items, []);

for (const unsafeUrl of unsafePublicUrls) {
  const unsafeEventMedia = toPublicEventListing({
    id: "unsafe-event-media",
    host: {
      id: "unsafe-event-host",
      businessName: "Unsafe Event Host",
      spotImageUrl: unsafeUrl,
    },
    trucks: [
      {
        id: "unsafe-event-truck",
        name: "Unsafe Event Truck",
        logoUrl: unsafeUrl,
        coverImageUrl: unsafeUrl,
      },
    ],
  }) as any;
  assert.equal(unsafeEventMedia.host.spotImageUrl, null);
  assert.equal(unsafeEventMedia.trucks[0].logoUrl, null);
  assert.equal(unsafeEventMedia.trucks[0].coverImageUrl, null);
}

const safeEventMedia = toPublicEventListing({
  id: "safe-event-media",
  host: {
    id: "safe-event-host",
    businessName: "Safe Event Host",
    spotImageUrl: "/uploads/event-host.jpg",
  },
  trucks: [
    {
      id: "safe-event-truck",
      name: "Safe Event Truck",
      logoUrl: "https://cdn.example.invalid/truck-logo.jpg",
      coverImageUrl: "merchant.example.invalid/truck-cover.jpg",
    },
  ],
}) as any;
assert.equal(safeEventMedia.host.spotImageUrl, "/uploads/event-host.jpg");
assert.equal(
  safeEventMedia.trucks[0].logoUrl,
  "https://cdn.example.invalid/truck-logo.jpg",
);
assert.equal(
  safeEventMedia.trucks[0].coverImageUrl,
  "https://merchant.example.invalid/truck-cover.jpg",
);

const forbiddenRestaurantKeys = [
  "ownerId",
  "rawData",
  "rankingScore",
  "lockedPriceCents",
  "priceLockDate",
  "priceLockReason",
  "claimedFromImportId",
  "countyFips",
  "countyName",
  "geoEnrichedAt",
  "insuranceVerifiedAt",
  "insuranceExpiresAt",
  "insuranceVerifiedByUserId",
  "socialAutopostSettings",
  "promoCode",
];

const rawRestaurant: Record<string, unknown> = {
  id: "rest-1",
  name: "Test Kitchen",
  address: "123 Main St",
  phone: "555-0100",
  businessType: "restaurant",
  cuisineType: "bbq",
  latitude: "30.4",
  longitude: "-87.2",
  city: "Pensacola",
  state: "FL",
  isActive: true,
  isVerified: true,
  insuranceVerified: true,
  logoUrl: "https://example.com/logo.png",
  coverImageUrl: "https://example.com/cover.png",
  description: "A place to eat",
  websiteUrl: "https://example.com",
  amenities: { parking: true },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  distance: 1.2,
  favoriteCount: 3,
  homeRankingScore: 42,
  homeRankingReason: ["popular_here"],
};
for (const key of forbiddenRestaurantKeys) {
  rawRestaurant[key] = `SECRET_${key}`;
}

const publicRestaurant = toPublicRestaurantListing(rawRestaurant);
for (const key of forbiddenRestaurantKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicRestaurant, key),
    false,
    `toPublicRestaurantListing must strip "${key}"`,
  );
}
assert.equal(publicRestaurant.id, "rest-1");
assert.equal(publicRestaurant.name, "Test Kitchen");
// Computed/derived fields the canonical Scout page relies on for sorting
// must survive — this is not raw DB state, and dropping it silently
// degrades Scout's ranking tie-break.
assert.equal(publicRestaurant.homeRankingScore, 42);
assert.equal(publicRestaurant.distance, 1.2);

const publicRestaurantArray = toPublicRestaurantListingArray([rawRestaurant]);
assert.equal(publicRestaurantArray.length, 1);
for (const key of forbiddenRestaurantKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicRestaurantArray[0], key),
    false,
    `toPublicRestaurantListingArray must strip "${key}"`,
  );
}

const revocableListingNow = Date.now();
const revocableListing = {
  id: "rest-revocable",
  ownerId: "owner-revocable",
  name: "Revocable Truck",
  address: "456 Current Stop",
  phone: "555-0111",
  websiteUrl: "https://revocable.example.invalid",
  businessType: "food_truck",
  isFoodTruck: true,
  latitude: "30.41",
  longitude: "-87.21",
  mobileOnline: true,
  liveBroadcasting: true,
  currentLatitude: "30.42",
  currentLongitude: "-87.22",
  lastBroadcastAt: new Date(revocableListingNow).toISOString(),
  liveUntilAt: new Date(revocableListingNow + 60_000).toISOString(),
  locationSource: "owner_gps",
  rawData: {
    profileLocations: { addressKind: "operating_location" },
  },
};
const visibleListing = toPublicRestaurantListingArray(
  [revocableListing],
  new Map([
    [
      "owner-revocable",
      { showAddress: true, showContact: true, ownerEnabled: true },
    ],
  ]),
)[0] as any;
assert.equal(visibleListing.address, "456 Current Stop");
assert.equal(visibleListing.phone, "555-0111");
assert.equal(visibleListing.currentLatitude, 30.42);
assert.equal(visibleListing.currentLongitude, -87.22);

const hiddenListing = toPublicRestaurantListingArray(
  [
    {
      ...revocableListing,
      mobileOnline: false,
      liveBroadcasting: false,
    },
  ],
  new Map([
    [
      "owner-revocable",
      { showAddress: false, showContact: false, ownerEnabled: true },
    ],
  ]),
)[0] as any;
assert.equal(hiddenListing.address, null);
assert.equal(hiddenListing.phone, null);
assert.equal(hiddenListing.websiteUrl, null);
assert.equal(hiddenListing.currentLatitude, null);
assert.equal(hiddenListing.currentLongitude, null);
assert.deepEqual(
  toPublicRestaurantListingArray(
    [revocableListing],
    new Map([
      [
        "owner-revocable",
        { showAddress: true, showContact: true, ownerEnabled: false },
      ],
    ]),
  ),
  [],
  "a second projection must drop the listing immediately after owner authority is revoked",
);

const forbiddenEventKeys = [
  "coordinatorUserId",
  "stripeProductId",
  "stripePriceId",
  "unbookedNotificationSentAt",
];
const forbiddenAnonymousEventFeedPricingKeys = [
  "hostPriceCents",
  "breakfastPriceCents",
  "lunchPriceCents",
  "dinnerPriceCents",
  "dailyPriceCents",
  "weeklyPriceCents",
  "monthlyPriceCents",
];
const forbiddenAnonymousEventFeedKeys = [
  ...forbiddenEventKeys,
  ...forbiddenAnonymousEventFeedPricingKeys,
];
const forbiddenHostKeys = [
  "userId",
  "contactPhone",
  "notes",
  "adminCreated",
  "spotCount",
  "expectedFootTraffic",
  "stripeConnectAccountId",
  "stripeConnectStatus",
  "stripeOnboardingCompleted",
  "stripeChargesEnabled",
  "stripePayoutsEnabled",
  "parkingPassBreakfastPriceCents",
  "parkingPassStartTime",
  "parkingPassDaysOfWeek",
];

const rawEvent: Record<string, unknown> = {
  id: "event-1",
  hostId: "host-1",
  name: "Friday Food Trucks",
  description: "Weekly food truck night",
  eventType: "food_truck_night",
  date: "2026-07-17T00:00:00.000Z",
  startTime: "17:00",
  endTime: "20:00",
  maxTrucks: 3,
  status: "open",
  requiresPayment: false,
  hostPriceCents: 5000,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  host: {
    id: "host-1",
    businessName: "Downtown Taproom",
    address: "456 Palafox St",
    city: "Pensacola",
    state: "FL",
    latitude: "30.4",
    longitude: "-87.2",
    locationType: "bar",
    isVerified: true,
  },
  series: {
    id: "series-1",
    name: "Friday series",
    coordinatorUserId: "SECRET_series_coordinator",
    defaultHostPriceCents: 1234,
  },
};
for (const key of forbiddenAnonymousEventFeedKeys) {
  rawEvent[key] = `SECRET_${key}`;
}
for (const key of forbiddenHostKeys) {
  (rawEvent.host as Record<string, unknown>)[key] = `SECRET_${key}`;
}

const publicEvent = toPublicEventListing(rawEvent);
for (const key of forbiddenAnonymousEventFeedKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicEvent, key),
    false,
    `toPublicEventListing must strip "${key}"`,
  );
}
const publicHost = publicEvent.host as Record<string, unknown>;
assert.ok(publicHost, "toPublicEventListing must still include a host object");
for (const key of forbiddenHostKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicHost, key),
    false,
    `toPublicEventListing must strip host.${key}`,
  );
}
assert.equal(publicHost.businessName, "Downtown Taproom");
assert.deepEqual(
  publicEvent.series,
  { id: "series-1", name: "Friday series" },
  "toPublicEventListing must preserve only the public series identity",
);
const canonicalTruckEvent = toPublicEventListing({
  id: "event-canonical-truck",
  bookedRestaurantId: "legacy-canceled-pointer",
  trucks: [
    {
      id: "confirmed-truck",
      name: "Confirmed Truck",
      ownerId: "SECRET_owner",
    },
  ],
});
assert.equal(
  canonicalTruckEvent.bookedRestaurantId,
  "confirmed-truck",
  "The singular compatibility alias must derive from canonical trucks[]",
);
assert.deepEqual(canonicalTruckEvent.trucks, [
  {
    id: "confirmed-truck",
    name: "Confirmed Truck",
    cuisineType: null,
    city: null,
    state: null,
    logoUrl: null,
    coverImageUrl: null,
  },
]);

const publicEventArray = toPublicEventListingArray([rawEvent]);
assert.equal(publicEventArray.length, 1);
const arrayHost = (publicEventArray[0] as any).host as Record<string, unknown>;
for (const key of forbiddenHostKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(arrayHost, key),
    false,
    `toPublicEventListingArray must strip host.${key}`,
  );
}
assert.deepEqual(toPublicEventListingArray([null, [], "invalid"]), [
  {},
  {},
  {},
]);

assert.equal(
  canExposeAnonymousEventDetail({
    eventType: "event",
    requiresPayment: false,
    status: "open",
    slotIsPublic: true,
  }),
  true,
  "a current confirmed free event may have an anonymous detail page",
);
for (const blockedDetail of [
  {
    eventType: "event",
    requiresPayment: true,
    status: "open",
    slotIsPublic: true,
  },
  {
    eventType: "event",
    requiresPayment: false,
    status: "open",
    slotIsPublic: false,
  },
  {
    eventType: "event",
    requiresPayment: false,
    status: "draft",
    slotIsPublic: true,
  },
  {
    eventType: "private_event",
    requiresPayment: false,
    status: "open",
    slotIsPublic: true,
  },
]) {
  assert.equal(
    canExposeAnonymousEventDetail(blockedDetail),
    false,
    "paid, stale/unconfirmed, and draft event details must stay private",
  );
}

assert.equal(
  canExposeAuthorizedPaidEventDetail({
    eventType: "parking_pass",
    requiresPayment: true,
    status: "open",
    slotIsBookable: true,
  }),
  true,
  "an unbooked future Parking Pass may be shown after separate ownership authorization",
);
for (const blockedAuthorizedDetail of [
  {
    eventType: "private_event",
    requiresPayment: true,
    status: "open",
    slotIsBookable: true,
  },
  {
    eventType: "event",
    requiresPayment: true,
    status: "open",
    slotIsBookable: true,
  },
  {
    eventType: "parking_pass",
    requiresPayment: false,
    status: "open",
    slotIsBookable: true,
  },
  {
    eventType: "parking_pass",
    requiresPayment: true,
    status: "draft",
    slotIsBookable: true,
  },
  {
    eventType: "parking_pass",
    requiresPayment: true,
    status: "open",
    slotIsBookable: false,
  },
]) {
  assert.equal(
    canExposeAuthorizedPaidEventDetail(blockedAuthorizedDetail),
    false,
    "authorization must not expose private, non-Parking-Pass, free, closed, or ended event details",
  );
}

const validAnonymousListEvent = {
  eventType: "event",
  requiresPayment: false,
  status: "open",
  eventName: "Harbor Lunch",
  hostName: "Harbor Brewery",
};
assert.equal(
  canExposeAnonymousEventListItem(validAnonymousListEvent),
  true,
  "a valid free public event and host must remain in anonymous list feeds",
);
for (const blockedListEvent of [
  { ...validAnonymousListEvent, eventType: "private_event" },
  { ...validAnonymousListEvent, requiresPayment: true },
  { ...validAnonymousListEvent, status: "draft" },
  { ...validAnonymousListEvent, eventName: "asdfasdf" },
  { ...validAnonymousListEvent, hostName: "Test Truck 1728000000000" },
  { ...validAnonymousListEvent, eventName: "" },
  { ...validAnonymousListEvent, hostName: "" },
]) {
  assert.equal(
    canExposeAnonymousEventListItem(blockedListEvent),
    false,
    "anonymous lists must reject private, paid, inactive, malformed, or synthetic event/host rows",
  );
}

const validAnonymousFeedEvent = {
  ...validAnonymousListEvent,
  slotIsPublic: true,
  hasPublicConfirmedTruck: true,
  ended: false,
};
assert.equal(
  canExposeAnonymousEventFeedItem(validAnonymousFeedEvent),
  true,
  "a current public event with a public confirmed truck may enter anonymous feeds",
);
for (const blockedFeedEvent of [
  { ...validAnonymousFeedEvent, slotIsPublic: false },
  { ...validAnonymousFeedEvent, hasPublicConfirmedTruck: false },
  { ...validAnonymousFeedEvent, ended: true },
  { ...validAnonymousFeedEvent, eventType: "private_event" },
  { ...validAnonymousFeedEvent, eventName: "asdfasdf" },
]) {
  assert.equal(
    canExposeAnonymousEventFeedItem(blockedFeedEvent),
    false,
    "anonymous feeds must reject stale, unconfirmed, ended, private, and synthetic events",
  );
}

const rawMapPayload = {
  hostLocations: [
    {
      id: "host-map-1",
      type: "host_location",
      hostId: "host-map-1",
      name: "Public host",
      address: "123 Host St",
      latitude: "30.1",
      longitude: "-87.2",
      locationRequestId: "SECRET_request",
      preferredDates: ["SECRET_date"],
      userId: "SECRET_userId",
      contactPhone: "SECRET_contactPhone",
      notes: "SECRET_notes",
      expectedFootTraffic: 9000,
      stripeConnectAccountId: "SECRET_stripe",
      stripeConnectStatus: "SECRET_status",
      parkingPassBreakfastPriceCents: 1234,
    },
    null,
    [],
  ],
  eventLocations: [
    {
      id: "event-map-1",
      type: "event",
      name: "Public event",
      hostId: "host-map-1",
      hostName: "Public host",
      stripeProductId: "SECRET_product",
      stripePriceId: "SECRET_price",
      coordinatorUserId: "SECRET_coordinator",
    },
    "invalid-event-row",
  ],
  supplierLocations: [
    {
      id: "supplier-map-1",
      type: "supplier",
      supplierId: "supplier-map-1",
      name: "Public supplier",
      contactEmail: "SECRET_email",
      contactPhone: "SECRET_phone",
      stripeConnectAccountId: "SECRET_stripe",
    },
    null,
  ],
};
const publicMapPayload = toPublicMapLocationsPayload(rawMapPayload);
for (const key of [
  "userId",
  "contactPhone",
  "notes",
  "expectedFootTraffic",
  "stripeConnectAccountId",
  "stripeConnectStatus",
  "parkingPassBreakfastPriceCents",
  "locationRequestId",
  "preferredDates",
]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicMapPayload.hostLocations[0], key),
    false,
    `/api/map/locations must strip hostLocations.${key}`,
  );
}
assert.deepEqual(publicMapPayload.hostLocations[1], {});
assert.deepEqual(publicMapPayload.hostLocations[2], {});
assert.deepEqual(publicMapPayload.eventLocations[1], {});
assert.deepEqual(publicMapPayload.supplierLocations[1], {});
for (const key of ["stripeProductId", "stripePriceId", "coordinatorUserId"]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicMapPayload.eventLocations[0], key),
    false,
    `/api/map/locations must strip eventLocations.${key}`,
  );
}
for (const key of ["contactEmail", "contactPhone", "stripeConnectAccountId"]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicMapPayload.supplierLocations[0], key),
    false,
    `/api/map/locations must strip supplierLocations.${key}`,
  );
}

const publicParkingPass = toPublicParkingPassListingArray([
  {
    id: "parking-pass-1",
    hostId: "host-1",
    seriesId: "series-1",
    name: "Lunch parking",
    date: "2026-07-18T00:00:00.000Z",
    startTime: "11:00",
    endTime: "14:00",
    status: "open",
    requiresPayment: true,
    paymentsEnabled: true,
    breakfastPriceCents: 2500,
    stripeProductId: "SECRET_product",
    stripePriceId: "SECRET_price",
    unbookedNotificationSentAt: "SECRET_notification",
    coordinatorUserId: "SECRET_coordinator",
    bookings: [
      {
        truckId: "truck-1",
        truckName: "Public truck",
        slotType: "lunch",
        spotNumber: 2,
        bookingConfirmedAt: "SECRET_confirmation_time",
        stripePaymentIntentId: "SECRET_payment",
        userId: "SECRET_user",
      },
    ],
    host: {
      id: "host-1",
      businessName: "Public host",
      address: "123 Host St",
      city: "Pensacola",
      state: "FL",
      latitude: "30.1",
      longitude: "-87.2",
      userId: "SECRET_user",
      contactPhone: "SECRET_phone",
      notes: "SECRET_notes",
      expectedFootTraffic: 9000,
      adminCreated: true,
      stripeConnectAccountId: "SECRET_stripe",
      stripeConnectStatus: "SECRET_status",
      stripeOnboardingCompleted: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      parkingPassBreakfastPriceCents: 2500,
      parkingPassStartTime: "11:00",
      parkingPassDaysOfWeek: [1, 2, 3],
    },
  },
]);
assert.equal(publicParkingPass.length, 1);
for (const key of forbiddenEventKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicParkingPass[0], key),
    false,
    `/api/parking-pass must strip event.${key}`,
  );
}
const publicParkingHost = publicParkingPass[0].host as Record<string, unknown>;
for (const key of forbiddenHostKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicParkingHost, key),
    false,
    `/api/parking-pass must strip host.${key}`,
  );
}
const publicParkingBooking = (
  publicParkingPass[0].bookings as Record<string, unknown>[]
)[0];
assert.deepEqual(publicParkingBooking, {
  truckId: "truck-1",
  truckName: "Public truck",
  slotType: "lunch",
  spotNumber: 2,
});
assert.deepEqual(toPublicParkingPassListingArray([null, [], "invalid"]), [
  {},
  {},
  {},
]);
assert.equal(toPublicParkingPassListingArray([{ host: [] }])[0].host, null);

const publicReviews = toPublicRestaurantReviewArray([
  {
    id: "review-1",
    restaurantId: "rest-1",
    userId: "SECRET_user",
    rating: 0,
    reviewText: "Worth the trip",
    createdAt: "2026-07-16T00:00:00.000Z",
    user: {
      firstName: "Public",
      lastName: "Reviewer",
      profileImageUrl: null,
      email: "SECRET_email",
    },
  },
]);
assert.equal(publicReviews.length, 1);
for (const key of ["userId", "rating"]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicReviews[0], key),
    false,
    `/api/reviews/restaurant/:restaurantId must strip ${key}`,
  );
}
assert.equal(
  Object.prototype.hasOwnProperty.call(
    publicReviews[0].user as Record<string, unknown>,
    "email",
  ),
  false,
  "public review user projection must strip email",
);
assert.deepEqual(toPublicRestaurantReviewArray([null, [], "invalid"]), [
  {},
  {},
  {},
]);

// --- Source: the public endpoints must actually call the DTOs -----------

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const restaurantRoutesSource = readSource(
  "server/routes/restaurantCoreRoutes.ts",
);
assert.match(
  restaurantRoutesSource,
  /toPublicRestaurantListing/,
  "restaurantCoreRoutes.ts must import the public restaurant DTO",
);

const sliceAfter = (source: string, marker: string, span = 400): string => {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `expected to find "${marker}" in source`);
  return source.slice(index, index + span);
};

const menuRoutesSource = readSource("server/routes/menuRoutes.ts");
const publicMenuParent = sliceAfter(
  menuRoutesSource,
  "async function loadPublicMenuParent",
  1300,
);
assert.match(
  publicMenuParent,
  /restaurant\.isActive !== true[\s\S]*isPublicBusinessVisible\(restaurant\)[\s\S]*deriveProfileEvidenceQuarantineVisibility\(restaurant\)\.isQuarantined[\s\S]*toPublicRestaurantListingWithVisibility\(restaurant\)[\s\S]*publicRestaurant as any\)\?\.id/,
  "Every public menu sibling must share active, enabled-owner, visible, evidence-safe parent authority",
);
const publicMenuStart = menuRoutesSource.indexOf('"/api/menus/:restaurantId"');
const publicMenuEnd = menuRoutesSource.indexOf(
  '"/api/owner/restaurants/:restaurantId/ordering-readiness"',
  publicMenuStart,
);
assert.ok(publicMenuStart >= 0 && publicMenuEnd > publicMenuStart);
const publicMenuRoute = menuRoutesSource.slice(publicMenuStart, publicMenuEnd);
assert.match(
  publicMenuRoute,
  /Cache-Control", "no-store"[\s\S]*loadPublicMenuParent\(restaurantId\)[\s\S]*toPublicOrderingReadiness\(/,
  "Public menus must re-check parent authority and expose only customer readiness",
);
assert.match(publicMenuRoute, /toPublicMenuItem\(/);
assert.doesNotMatch(
  publicMenuRoute,
  /\.\.\.(?:menu|item|cat)\b/,
  "Public menu responses must not spread raw menu, item, category, inventory, or import rows",
);
const featuredMenuItemRoute = sliceAfter(
  menuRoutesSource,
  '"/api/restaurants/:restaurantId/featured-item"',
  6200,
);
assert.match(
  featuredMenuItemRoute,
  /Cache-Control", "no-store"[\s\S]*loadPublicMenuParent\(restaurantId\)[\s\S]*gt\(menuItems\.priceCents, 0\)[\s\S]*eq\(menus\.isActive, true\)/,
  "Featured menu items must be current, priced children of a public parent",
);
const publicMenuPhotosRoute = sliceAfter(
  menuRoutesSource,
  '"/api/menu-items/:menuItemId/photos/public"',
  2600,
);
assert.match(
  publicMenuPhotosRoute,
  /Cache-Control", "no-store"[\s\S]*itemParent\.menuActive !== true[\s\S]*loadPublicMenuParent\([\s\S]*eq\(users\.isDisabled, false\)/,
  "Public menu photos must inherit menu, restaurant, owner, and evidence authority",
);

assert.match(
  sliceAfter(
    restaurantRoutesSource,
    'app.get("/api/restaurants/:id"',
    1000,
  ),
  /publicRestaurant\s*=\s*[\s\S]*await toPublicRestaurantListingWithVisibility\(restaurant\)[\s\S]*!\(publicRestaurant as any\)\?\.id[\s\S]*status\(404\)[\s\S]*res\.json\(publicRestaurant\)/,
  "GET /api/restaurants/:id must fail closed and return only the sanitized restaurant DTO",
);
{
  const searchHandler = sliceAfter(
    restaurantRoutesSource,
    'app.get("/api/restaurants/search"',
    2500,
  );
  assert.match(
    searchHandler,
    /toPublicRestaurantListingArrayWithVisibility\(restaurants\)[\s\S]*filteredRestaurants\.slice\(0, RESTAURANT_SEARCH_RESULT_LIMIT\)/,
    "GET /api/restaurants/search must return sanitized, count-bounded restaurant DTOs",
  );
  assert.match(
    searchHandler,
    /clampArrayToMaxBytes/,
    "GET /api/restaurants/search must byte-clamp the public listing",
  );
  assert.doesNotMatch(
    searchHandler,
    /res\.json\(\s*toPublicRestaurantListingArray\(\s*filteredRestaurants\s*\)\s*\)/,
    "GET /api/restaurants/search must not return an unbounded restaurant listing",
  );
}
assert.match(
  sliceAfter(
    restaurantRoutesSource,
    'app.get("/api/restaurants/nearby/:lat/:lng"',
    1800,
  ),
  /toPublicRestaurantListingArrayWithVisibility\([\s\S]*filterProjectedPublicNearbyRestaurantRows\(/,
  "GET /api/restaurants/nearby must return sanitized restaurant DTOs",
);
const publicRestaurantRouteSource = sliceAfter(
  restaurantRoutesSource,
  'app.get("/api/restaurants/public"',
  14000,
);
assert.match(
  publicRestaurantRouteSource,
  /toPublicRestaurantListingArrayWithVisibility\(activeRestaurants\)[\s\S]*res\.json\(sorted\.slice/,
  "GET /api/restaurants/public must return sanitized restaurant DTOs",
);
assert.match(
  publicRestaurantRouteSource,
  /restaurantIdArraySql = postgresTextArray\(restaurantIds\)/,
  "GET /api/restaurants/public must bind ranking ids as a PostgreSQL text array",
);
assert.equal(
  (publicRestaurantRouteSource.match(/any\(\$\{restaurantIdArraySql\}\)/g) || [])
    .length,
  3,
  "all three raw ranking aggregates must use the bound text-array expression",
);
assert.doesNotMatch(
  publicRestaurantRouteSource,
  /any\(\$\{restaurantIds\}::text\[\]\)/,
  "Drizzle expands a directly interpolated JavaScript array as a record, not text[]",
);
assert.doesNotMatch(
  sliceAfter(
    restaurantRoutesSource,
    '"/api/restaurants/:restaurantId/recommendations/public"',
    5000,
  ),
  /userId\s*:/,
  "GET public restaurant recommendations must not expose raw user ids",
);

const locationRoutesSource = readSource(
  "server/routes/locationUtilityRoutes.ts",
);
assert.match(
  locationRoutesSource,
  /toPublicRestaurantListing/,
  "locationUtilityRoutes.ts must import the public restaurant DTO",
);
assert.match(
  sliceAfter(
    locationRoutesSource,
    'app.get("/api/restaurants/subscribed/:lat/:lng"',
    6500,
  ),
  /deriveProfileEvidenceQuarantineVisibility\(restaurant\)[\s\S]*toPublicRestaurantListingArrayWithVisibility\(\s*canonicalPublicRows/,
  "GET /api/restaurants/subscribed must return sanitized restaurant DTOs",
);

const eventRoutesSource = readSource("server/routes/eventRoutes.ts");
assert.match(
  eventRoutesSource,
  /toPublicEventListingArray/,
  "eventRoutes.ts must import the public event DTO",
);
assert.match(
  sliceAfter(eventRoutesSource, 'app.get("/api/events/public"', 1400),
  /buildAnonymousPublicEventFeed\(\s*upcomingEvents,\s*publicEventNow\(\),?\s*\)[\s\S]*toPublicEventListingArray[\s\S]*sendPublicEventFeedUnavailable/,
  "GET /api/events/public must gate public confirmed slots and fail terminally before returning sanitized event DTOs",
);
assert.match(
  sliceAfter(eventRoutesSource, 'app.get("/api/events/upcoming"', 1400),
  /buildAnonymousPublicEventFeed\(\s*upcomingEvents,\s*publicEventNow\(\),?\s*\)[\s\S]*toPublicEventListingArray[\s\S]*sendPublicEventFeedUnavailable/,
  "GET /api/events/upcoming must gate public confirmed slots and fail terminally before returning sanitized event DTOs",
);
for (const snippet of [
  "canExposeAnonymousEventFeedItem",
  "filterPublicConfirmedEventTrucks",
  "resolveCityTimeZone",
  "buildSlotDateTimes",
  "isSlotPublic",
  'setHeader("Retry-After", "60")',
  'setHeader("Cache-Control", "no-store")',
  'setHeader("X-Robots-Tag", "noindex,follow")',
]) {
  assert.ok(
    eventRoutesSource.includes(snippet),
    `anonymous event feed parity missing: ${snippet}`,
  );
}
const defaultPublicEventDetailLoader = sliceAfter(
  eventRoutesSource,
  "const loadPublicEventDetail",
  4200,
);
assert.match(
  defaultPublicEventDetailLoader,
  /parseParkingPassVirtualId\(eventId\)[\s\S]*loadParkingPassOccurrenceById\(eventId\)[\s\S]*occurrence\.host\.businessName[\s\S]*return row \|\| null/,
  "public detail must resolve a genuine series-only Parking Pass occurrence without requiring an events row",
);
assert.doesNotMatch(
  defaultPublicEventDetailLoader,
  /ensureParkingPassEventRow|insert\(events\)/,
  "public detail lookup must remain read-only for a series-only occurrence",
);
const parkingPassVirtualSource = readSource(
  "server/services/parkingPassVirtual.ts",
);
assert.match(
  parkingPassVirtualSource,
  /parseParkingPassVirtualId\(String\(row\.id \|\| ""\)\)\?\.dateKey \|\|[\s\S]*dateKeyFromUnknown\(row\.date, "UTC"\)/,
  "materialized virtual rows must override their exact series date instead of shifting at timezone boundaries",
);
const virtualOccurrenceByIdLoader = sliceAfter(
  parkingPassVirtualSource,
  "export async function loadParkingPassOccurrenceById",
  1100,
);
assert.match(
  virtualOccurrenceByIdLoader,
  /parseParkingPassVirtualId\(passId\)[\s\S]*seriesIds: \[parsed\.seriesId\][\s\S]*includeDraft: false[\s\S]*occurrence\.id === passId/,
  "series-only lookup must be exact-id, exact-series, and published-only",
);
const virtualOccurrenceMaterializer = sliceAfter(
  parkingPassVirtualSource,
  "export async function ensureParkingPassEventRow",
  9000,
);
assert.match(
  virtualOccurrenceMaterializer,
  /loadParkingPassOccurrenceById\(args\.passId\)[\s\S]*buildSlotDateTimes\([\s\S]*interval\.startUtc\.getTime\(\)[\s\S]*statusCode: 400[\s\S]*db\.insert\(events\)/,
  "same-day-past virtual occurrences must be rejected before any event row is materialized",
);
const publicDiscoveryRoutesSource = readSource(
  "server/routes/publicDiscoveryRoutes.ts",
);
const publicProfileEventPayload = sliceAfter(
  publicDiscoveryRoutesSource,
  "const buildPublicEventsPayload",
  9000,
);
assert.match(
  publicProfileEventPayload,
  /requiresPayment: events\.requiresPayment/,
  "public profile event payloads must select paid/private eligibility truth",
);
assert.match(
  publicProfileEventPayload,
  /canExposeAnonymousEventFeedItem\([\s\S]*eventName: row\.title[\s\S]*hostName: row\.hostName/,
  "public host and restaurant profile event arrays must reuse anonymous list eligibility",
);
const authenticatedEventsRoute = sliceAfter(
  eventRoutesSource,
  'app.get("/api/events", isAuthenticated',
  4500,
);
assert.match(
  authenticatedEventsRoute,
  /storage\.getHost\(hostIdFilter\)/,
  "GET /api/events?hostId must load the requested host before returning management data",
);
assert.match(
  authenticatedEventsRoute,
  /requestedHost\.userId[\s\S]*res\.status\(403\)/,
  "GET /api/events?hostId must enforce host ownership",
);
assert.match(
  authenticatedEventsRoute,
  /toPublicEventListingArray\([\s\S]*attachConfirmedPublicEventTrucks\(filtered\)/,
  "GET /api/events without a host filter must canonicalize and sanitize its cross-host feed",
);
const publicEventDetailRoute = sliceAfter(
  eventRoutesSource,
  'app.get("/api/public/events/:eventId"',
  8000,
);
assert.match(
  publicEventDetailRoute,
  /canExposeAnonymousEventDetail/,
  "public event detail must gate paid and non-public rows",
);
assert.doesNotMatch(
  publicEventDetailRoute,
  /authorizedPaidDetail\s*=\s*Boolean\(req\.isAuthenticated/,
  "authenticated identity alone must not authorize a paid event detail",
);
assert.match(
  publicEventDetailRoute,
  /canExposeAnonymousEventDetail\([\s\S]*res\.status\(404\)/,
  "public event detail must hide protected rows from every caller",
);
assert.match(
  publicEventDetailRoute,
  /requestedTruckId[\s\S]*req\.isAuthenticated[\s\S]*canExposeAuthorizedPaidEventDetail[\s\S]*verifyRestaurantOwnership\([\s\S]*"manageParkingPass"/,
  "paid event detail must require authentication and exact Parking Pass ownership authorization",
);
assert.match(
  publicEventDetailRoute,
  /hasParkingPassAccess[\s\S]*storage\.getRestaurant\(requestedTruckId\)[\s\S]*assessParkingPassTruckEligibility\([\s\S]*\.isTruckProfile/,
  "paid event detail must reject an owned fixed restaurant while retaining legacy truck classification",
);
assert.match(
  publicEventDetailRoute,
  /res\.setHeader\("Cache-Control", "no-store"\)/,
  "revocable public and authorized paid event detail must never enter a cache",
);
assert.match(
  publicEventDetailRoute,
  /noIndex: authorizedPaidDetail \|\| ended \|\| !gateOk/,
  "authorized paid event detail must remain noindex",
);
assert.match(
  publicEventDetailRoute,
  /hostPriceCents: row\.hostPriceCents \?\? null/,
  "eligible event detail must retain the consumer booking price",
);
const exactPostRoute = (source: string, routePath: string) => {
  const parsed = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "app" &&
        node.expression.name.text === "post" && ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === routePath) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(matches.length, 1, `expected exactly one POST ${routePath}`);
  const handler = matches[0].arguments.at(-1)!;
  assert.ok(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler));
  const printer = ts.createPrinter({ removeComments: true });
  return {
    call: matches[0],
    handler,
    source: printer.printNode(ts.EmitHint.Unspecified, handler, parsed),
  };
};
const retiredEventCheckout = exactPostRoute(eventRoutesSource, "/api/events/:eventId/book");
assert.equal(retiredEventCheckout.call.arguments.length, 3, "retired checkout must contain only its path, authentication and pure handoff handler");
assert.ok(
  retiredEventCheckout.call.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "isAuthenticated"),
  "retired event checkout must retain authentication",
);
assert.match(
  retiredEventCheckout.source,
  /return res\.status\(409\)\.json\(\{[\s\S]*code: "canonical_checkout_required"[\s\S]*checkoutPath: `\/parking-pass\?\$\{params\.toString\(\)\}`/,
  "retired event checkout must hand off to canonical Parking Pass selection without creating a booking",
);
const retiredHandler = retiredEventCheckout.handler;
const handoffOnlyCalls = new Set(["String", "params.set", "params.toString", "res.status", "res.status(409).json"]);
const retiredOperationIdentifiers = new Set(["db", "storage", "stripe", "fetch", "axios", "eventBookings"]);
const inspectRetiredHandler = (node: ts.Node) => {
  assert.ok(!ts.isAwaitExpression(node), "retired checkout must not perform asynchronous operations");
  if (ts.isIdentifier(node)) {
    assert.ok(!retiredOperationIdentifiers.has(node.text), "retired checkout must not reference database or provider owners");
  }
  if (ts.isCallExpression(node)) {
    const stringTrim = ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "trim" && ts.isCallExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === "String";
    assert.ok(stringTrim || handoffOnlyCalls.has(node.expression.getText()),
      `retired checkout must not call booking, database or provider operations: ${node.expression.getText()}`);
  }
  if (ts.isNewExpression(node)) {
    assert.equal(node.expression.getText(), "URLSearchParams", "retired checkout may only construct its handoff URL");
  }
  ts.forEachChild(node, inspectRetiredHandler);
};
inspectRetiredHandler(retiredHandler.body);
assert.ok(ts.isBlock(retiredHandler.body));
assert.deepEqual(retiredHandler.parameters.map((parameter) => parameter.name.getText()), ["req", "res"]);
const expectedRetiredHandoff = ts.createSourceFile("retired-handoff-contract.ts", "const params = new URLSearchParams({ pass: String(req.params.eventId) });\nconst truckId = String(req.body?.truckId || \"\").trim();\nif (truckId) params.set(\"truckId\", truckId);\nreturn res.status(409).json({\n  code: \"canonical_checkout_required\",\n  message: \"Choose your Parking Pass date and slots before checking out.\",\n  checkoutPath: `/parking-pass?${params.toString()}`,\n});", ts.ScriptTarget.Latest, true);
assert.equal(retiredHandler.body.statements.length, expectedRetiredHandoff.statements.length,
  "retired checkout must have only its effective URL handoff statements and terminal response");
const handoffPrinter = ts.createPrinter({ removeComments: true });
for (let index = 0; index < expectedRetiredHandoff.statements.length; index += 1) {
  assert.equal(handoffPrinter.printNode(ts.EmitHint.Unspecified, retiredHandler.body.statements[index], retiredHandler.body.getSourceFile()),
    handoffPrinter.printNode(ts.EmitHint.Unspecified, expectedRetiredHandoff.statements[index], expectedRetiredHandoff),
    "every retired checkout response path must produce the exact canonical handoff without overrides");
}
const canonicalParkingBooking = exactPostRoute(
  readSource("server/routes/hostRoutes.ts"), "/api/parking-pass/:passId/book",
);
const canonicalParkingBookingRoute = canonicalParkingBooking.source;
assert.ok(
  canonicalParkingBooking.call.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "isAuthenticated"),
  "canonical Parking Pass checkout must require authentication",
);
assert.match(
  canonicalParkingBookingRoute,
  /verifyRestaurantOwnership\([\s\S]*"manageParkingPass"[\s\S]*if \(!truck \|\| !hasManageParkingPass\)[\s\S]*res\.status\(403\)/,
  "canonical Parking Pass checkout must require exact truck ownership",
);
assert.match(
  canonicalParkingBookingRoute,
  /assessParkingPassTruckEligibility\([\s\S]*!truckEligibility\.isTruckProfile[\s\S]*truck_verification_required[\s\S]*!truckEligibility\.roleAllowed/,
  "canonical Parking Pass checkout must enforce truck classification, verification and role gates",
);
assert.match(
  canonicalParkingBookingRoute,
  /ensureParkingPassEventRow\(\{\s*passId,\s*requireFuture: true/,
  "canonical checkout must materialize a genuine future Parking Pass occurrence",
);
const availabilityQueries: ts.VariableStatement[] = [];
const findAvailabilityQuery = (node: ts.Node) => {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    ts.isIdentifier(declaration.name) && declaration.name.text === "bookingEvents")) availabilityQueries.push(node);
  ts.forEachChild(node, (child) => { if (!ts.isFunctionLike(child)) findAvailabilityQuery(child); });
};
findAvailabilityQuery(canonicalParkingBooking.handler.body);
assert.equal(availabilityQueries.length, 1, "canonical checkout must have one owning range availability query");
const availabilityQuery = availabilityQueries[0];
assert.ok(ts.isBlock(availabilityQuery.parent));
const rangeStatements = availabilityQuery.parent.statements;
const availabilityQueryIndex = rangeStatements.indexOf(availabilityQuery);
assert.ok(availabilityQueryIndex >= 2);
const expectedRangeMaterialization = ts.createSourceFile("range-materialization-contract.ts", "const parsedVirtualPassId = parseParkingPassVirtualId(passId);\nif (parsedVirtualPassId) {\n  await Promise.all(\n    expectedDateKeys.map((dateKey) =>\n      ensureParkingPassEventRow({\n        passId: buildParkingPassVirtualId(\n          parsedVirtualPassId.seriesId,\n          dateKey,\n        ),\n        requireFuture: true,\n      }),\n    ),\n  );\n}\nconst bookingEvents = await db\n  .select()\n  .from(events)\n  .where(\n    and(\n      eq(events.hostId, host.id),\n      eq(events.requiresPayment, true),\n      gte(events.date, rangeQueryStart),\n      lt(events.date, rangeQueryEnd),\n    ),\n  )\n  .orderBy(asc(events.date));", ts.ScriptTarget.Latest, true);
const rangePrinter = ts.createPrinter({ removeComments: true });
for (let index = 0; index < expectedRangeMaterialization.statements.length; index += 1) {
  assert.equal(rangePrinter.printNode(ts.EmitHint.Unspecified, rangeStatements[availabilityQueryIndex - 2 + index], availabilityQuery.getSourceFile()),
    rangePrinter.printNode(ts.EmitHint.Unspecified, expectedRangeMaterialization.statements[index], expectedRangeMaterialization),
    "canonical checkout must await every requested virtual occurrence before querying range availability");
}
const admissionTransactions: ts.CallExpression[] = [];
const findAdmissionAssignment = (node: ts.Node) => {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === "insertedHolds" &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isAwaitExpression(node.right) &&
      ts.isCallExpression(node.right.expression)) {
    const call = node.right.expression;
    if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "db" && call.expression.name.text === "transaction") admissionTransactions.push(call);
  }
  ts.forEachChild(node, (child) => { if (!ts.isFunctionLike(child)) findAdmissionAssignment(child); });
};
findAdmissionAssignment(canonicalParkingBooking.handler.body);
assert.equal(admissionTransactions.length, 1, "canonical admission must have one owning transaction");
const admissionTransaction = admissionTransactions[0];
assert.ok(ts.isAwaitExpression(admissionTransaction.parent), "canonical admission must await its transaction");
const assertExecutedAdmission = (
  transaction: ts.CallExpression,
  handler: ts.ArrowFunction | ts.FunctionExpression,
) => {
  assert.ok(ts.isBlock(handler.body), "canonical admission must own the checkout block");
  assert.ok(ts.isAwaitExpression(transaction.parent), "canonical admission must be awaited");
  const assignment = transaction.parent.parent;
  assert.ok(ts.isBinaryExpression(assignment) && ts.isIdentifier(assignment.left) &&
    assignment.left.text === "insertedHolds" && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken,
    "canonical admission must assign the actual holds");
  const assignmentStatement = assignment.parent;
  assert.ok(ts.isExpressionStatement(assignmentStatement) && assignmentStatement.expression === assignment,
    "canonical admission must execute as a direct assignment, without a conditional skip");
  const admissionBlock = assignmentStatement.parent;
  assert.ok(ts.isBlock(admissionBlock) && admissionBlock.statements.length === 1 &&
    admissionBlock.statements[0] === assignmentStatement,
    "canonical admission must be the sole executed statement in its try block");
  const admissionTry = admissionBlock.parent;
  assert.ok(ts.isTryStatement(admissionTry) && admissionTry.tryBlock === admissionBlock && !admissionTry.finallyBlock,
    "canonical admission must retain its direct error boundary");
  const checkoutBlock = admissionTry.parent;
  assert.ok(ts.isBlock(checkoutBlock) && ts.isTryStatement(checkoutBlock.parent) &&
    checkoutBlock.parent.tryBlock === checkoutBlock && checkoutBlock.parent.parent === handler.body,
    "canonical admission must execute directly on the owning checkout path");
  assert.ok(admissionTry.catchClause, "canonical admission must abort failed hold creation");
  assert.ok(ts.isReturnStatement(admissionTry.catchClause.block.statements.at(-1)!),
    "canonical admission must return after failed hold creation");


  // Ownership must be the awaited capability result that actually denies checkout.
  const ownsBinding = (name: ts.BindingName, binding: string): boolean => ts.isIdentifier(name)
    ? name.text === binding
    : name.elements.some((element) => ts.isBindingElement(element) && ownsBinding(element.name, binding));
  const directOwnershipBinding = (binding: string) => {
    const matches: { declaration: ts.VariableDeclaration; statement: ts.VariableStatement; index: number }[] = [];
    checkoutBlock.statements.forEach((statement, index) => {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ownsBinding(declaration.name, binding)) matches.push({ declaration, statement, index });
        }
      }
    });
    assert.equal(matches.length, 1, "ownership must use one direct " + binding + " binding");
    assert.ok(matches[0].statement.declarationList.flags & ts.NodeFlags.Const,
      "ownership must retain immutable identity and capability bindings");
    return matches[0];
  };
  const ownershipTruckId = directOwnershipBinding("truckId");
  const ownershipUserId = directOwnershipBinding("userId");
  const ownershipTruck = directOwnershipBinding("truck");
  const ownershipCapability = directOwnershipBinding("hasManageParkingPass");
  const truckInput = ownershipTruckId.declaration;
  assert.ok(ts.isObjectBindingPattern(truckInput.name) && truckInput.initializer &&
    truckInput.initializer.getText().replace(/\s+/g, "") === "req.body",
    "ownership must take the requested truck from the direct request body");
  const truckFields = truckInput.name.elements.filter((element) => ownsBinding(element.name, "truckId"));
  assert.ok(truckFields.length === 1 && ts.isIdentifier(truckFields[0].name) &&
    truckFields[0].name.text === "truckId" && !truckFields[0].propertyName &&
    !truckFields[0].initializer && !truckFields[0].dotDotDotToken,
    "ownership must retain the unaliased requested truck without defaults");
  assert.ok(ts.isIdentifier(ownershipUserId.declaration.name) && ownershipUserId.declaration.initializer &&
    ownershipUserId.declaration.initializer.getText().replace(/\s+/g, "") === "req.user.id",
    "ownership must use the authenticated user identity");
  assert.ok(ownershipTruckId.index < ownershipTruck.index && ownershipUserId.index < ownershipTruck.index &&
    ownershipCapability.index === ownershipTruck.index + 1 &&
    ownershipCapability.index + 1 < checkoutBlock.statements.indexOf(admissionTry),
    "ownership must read the truck, await capability and deny before admission");
  const ownershipPrinter = ts.createPrinter({ removeComments: true });
  const expectedOwnership = ts.createSourceFile("ownership-packet.ts", "const truck = await storage.getRestaurant(truckId);\nconst hasManageParkingPass = await storage.verifyRestaurantOwnership(truckId, userId, \"manageParkingPass\");\nif (!truck || !hasManageParkingPass) {\n          const ownedRestaurants = await storage.getRestaurantsByOwner(userId);\n          const hasOwnedTruckProfile = Array.isArray(ownedRestaurants)\n            ? ownedRestaurants.some((row: any) => {\n                const businessType = String(row?.businessType || \"\").toLowerCase();\n                return row?.isFoodTruck === true || businessType === \"food_truck\";\n              })\n            : false;\n\n          console.warn(\"[parking-pass] rejected booking attempt\", {\n            userId,\n            userType: req.user?.userType || null,\n            truckId,\n            truckIsFoodTruck: truck?.isFoodTruck ?? null,\n            hasManageParkingPass,\n            hasOwnedTruckProfile,\n            reason: !truck ? \"truck_not_found\" : \"missing_manageParkingPass\",\n          });\n\n          if (!hasOwnedTruckProfile) {\n            return res.status(409).json({\n              code: \"truck_profile_required\",\n              message:\n                \"Complete your food truck profile before booking Parking Pass spots.\",\n              onboardingPath:\n                \"/restaurant-signup?businessType=food_truck&source=parking-pass&claim=1\",\n            });\n          }\n\n          return res.status(403).json({ message: \"Not authorized\" });\n        }", ts.ScriptTarget.Latest, true);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(ownershipPrinter.printNode(ts.EmitHint.Unspecified, checkoutBlock.statements[ownershipTruck.index + index], handler.getSourceFile()),
      ownershipPrinter.printNode(ts.EmitHint.Unspecified, expectedOwnership.statements[index], expectedOwnership),
      "ownership must use the exact awaited verifier and effective terminal denial");
  }
  const protectedOwnershipBindings = ["req", "storage", "truckId", "userId", "truck", "hasManageParkingPass"];
  const allowedOwnershipDeclarations = new Map<string, ts.Node>([
    ["truckId", truckInput], ["userId", ownershipUserId.declaration],
    ["truck", ownershipTruck.declaration], ["hasManageParkingPass", ownershipCapability.declaration],
  ]);
  const writesOwnershipBinding = (expression: ts.Expression, binding: string): boolean => {
    if (ts.isIdentifier(expression)) return expression.text === binding;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) ||
        ts.isParenthesizedExpression(expression)) return writesOwnershipBinding(expression.expression, binding);
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.some((element) =>
      ts.isSpreadElement(element) ? writesOwnershipBinding(element.expression, binding) : writesOwnershipBinding(element, binding));
    if (ts.isObjectLiteralExpression(expression)) return expression.properties.some((property) =>
      ts.isShorthandPropertyAssignment(property) ? property.name.text === binding :
      ts.isPropertyAssignment(property) ? writesOwnershipBinding(property.initializer, binding) :
      ts.isSpreadAssignment(property) && writesOwnershipBinding(property.expression, binding));
    return false;
  };
  const assertOwnershipBindings = (node: ts.Node) => {
    for (const binding of protectedOwnershipBindings) {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ownsBinding(node.name, binding)) {
        assert.ok(allowedOwnershipDeclarations.get(binding) === node,
          "ownership must not shadow identity, truck or verifier bindings");
      }
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        assert.ok(node.name.text !== binding, "ownership must not shadow identity, truck or verifier bindings");
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        assert.ok(!writesOwnershipBinding(node.left, binding), "ownership must not overwrite identity, truck or verifier bindings");
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        assert.ok(!writesOwnershipBinding(node.operand, binding), "ownership must not overwrite identity, truck or verifier bindings");
      }
    }
    ts.forEachChild(node, assertOwnershipBindings);
  };
  assertOwnershipBindings(checkoutBlock);

  const callback = transaction.arguments[0];
  assert.ok(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback));
  assert.ok(ts.isBlock(callback.body) && callback.body.statements.length === 5,
    "admission callback must execute its prelude, loop, checkpoint and return without alternate exits");
  const executionPrinter = ts.createPrinter({ removeComments: true });
  const expectedPrelude = ts.createSourceFile("admission-prelude.ts",
    "const now = new Date(); const inserted: any[] = [];", ts.ScriptTarget.Latest, true);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(executionPrinter.printNode(ts.EmitHint.Unspecified, callback.body.statements[index], callback.getSourceFile()),
      executionPrinter.printNode(ts.EmitHint.Unspecified, expectedPrelude.statements[index], expectedPrelude),
      "admission callback must initialize its own hold collection before the loop");
  }
  const loop = callback.body.statements[2];
  assert.ok(ts.isForStatement(loop) && loop.initializer && loop.condition && loop.incrementor,
    "admission loop must execute directly before the recovery checkpoint");
  assert.equal(loop.initializer.getText().replace(/\s+/g, ""), "letindex=0", "admission loop must start at the first requested date");
  assert.equal(loop.condition.getText().replace(/\s+/g, ""), "index<sortedDateKeys.length", "admission loop must cover every requested date");
  assert.equal(loop.incrementor.getText().replace(/\s+/g, ""), "index+=1", "admission loop must advance one requested date at a time");
  assert.ok(ts.isBlock(loop.statement));
  const expectedRowPrelude = ts.createSourceFile("admission-row-prelude.ts",
    "const dateKey = sortedDateKeys[index]; const row = eventsByDate.get(dateKey); if (!row) { throw new Error(\"Missing parking pass date in booking range.\"); }",
    ts.ScriptTarget.Latest, true);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(executionPrinter.printNode(ts.EmitHint.Unspecified, loop.statement.statements[index], loop.getSourceFile()),
      executionPrinter.printNode(ts.EmitHint.Unspecified, expectedRowPrelude.statements[index], expectedRowPrelude),
      "admission loop must reach its row lock without an early exit");
  }
  const checkpoint = callback.body.statements[3];
  assert.ok(ts.isExpressionStatement(checkpoint) && ts.isAwaitExpression(checkpoint.expression) &&
    ts.isCallExpression(checkpoint.expression.expression),
    "admission callback must await its direct recovery checkpoint");
  const checkpointCall = checkpoint.expression.expression;
  assert.ok(ts.isIdentifier(checkpointCall.expression) && checkpointCall.expression.text === "recordParkingBookingHolds",
    "admission callback must record its holds before returning");
  assert.equal(checkpointCall.arguments.length, 3);
  assert.ok(ts.isIdentifier(callback.parameters[0].name) && ts.isIdentifier(checkpointCall.arguments[0]) &&
    checkpointCall.arguments[0].text === callback.parameters[0].name.text,
    "admission callback must checkpoint through its owning transaction");
  const checkpointInput = checkpointCall.arguments[2];
  assert.ok(ts.isObjectLiteralExpression(checkpointInput) && checkpointInput.properties.every((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name)),
    "admission callback must use direct checkpoint fields");
  const checkpointHolds = checkpointInput.properties.filter((property) => property.name!.getText() === "holds");
  assert.equal(checkpointHolds.length, 1);
  assert.ok(ts.isPropertyAssignment(checkpointHolds[0]) && ts.isIdentifier(checkpointHolds[0].initializer) &&
    checkpointHolds[0].initializer.text === "inserted", "admission callback must checkpoint its actual hold collection");
  const completedHolds = callback.body.statements[4];
  assert.ok(ts.isReturnStatement(completedHolds) && completedHolds.expression &&
    ts.isIdentifier(completedHolds.expression) && completedHolds.expression.text === "inserted",
    "admission callback must return its checkpointed holds");

  const providerCalls: ts.CallExpression[] = [];
  const findProviderCreation = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "create" && ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "paymentIntents" &&
        ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === "stripe") providerCalls.push(node);
    ts.forEachChild(node, (child) => { if (!ts.isFunctionLike(child)) findProviderCreation(child); });
  };
  findProviderCreation(checkoutBlock);
  assert.equal(providerCalls.length, 1, "canonical admission must precede the actual provider creation");
  const providerCall = providerCalls[0];
  assert.ok(ts.isAwaitExpression(providerCall.parent));
  const providerAssignment = providerCall.parent.parent;
  assert.ok(ts.isBinaryExpression(providerAssignment) && ts.isIdentifier(providerAssignment.left) &&
    providerAssignment.left.text === "paymentIntent" && providerAssignment.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  const providerStatement = providerAssignment.parent;
  assert.ok(ts.isExpressionStatement(providerStatement) && ts.isBlock(providerStatement.parent));
  const providerTry = providerStatement.parent.parent;
  assert.ok(ts.isTryStatement(providerTry) && providerTry.tryBlock === providerStatement.parent &&
    providerTry.parent === checkoutBlock &&
    checkoutBlock.statements.indexOf(admissionTry) < checkoutBlock.statements.indexOf(providerTry),
    "canonical admission must execute before the later sibling provider-creation path");
};
assertExecutedAdmission(admissionTransaction, canonicalParkingBooking.handler);
const executionMutations: [string, string, string][] = [
  ["conditional admission", "insertedHolds = await db.transaction", "if (false) insertedHolds = await db.transaction"],
  ["early callback return", "const inserted: any[] = [];", "const inserted: any[] = []; return inserted;"],
  ["disabled date loop", "index < sortedDateKeys.length;", "index < sortedDateKeys.length && false;"],
  ["skipped checkpoint", "await recordParkingBookingHolds(", "if (false) await recordParkingBookingHolds("],
];
const assertRejectedExecutionMutation = (name: string, mutatedSource: string) => {
  const parsed = ts.createSourceFile("admission-execution-negative.ts",
    "const checkout = " + mutatedSource + ";", ts.ScriptTarget.Latest, true);
  const declarationStatement = parsed.statements[0];
  assert.ok(ts.isVariableStatement(declarationStatement));
  const mutatedHandler = declarationStatement.declarationList.declarations[0].initializer!;
  assert.ok(ts.isArrowFunction(mutatedHandler) || ts.isFunctionExpression(mutatedHandler));
  const mutatedTransactions: ts.CallExpression[] = [];
  const findMutatedAdmission = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "db" &&
        node.expression.name.text === "transaction") mutatedTransactions.push(node);
    ts.forEachChild(node, (child) => { if (!ts.isFunctionLike(child)) findMutatedAdmission(child); });
  };
  assert.ok(ts.isBlock(mutatedHandler.body));
  findMutatedAdmission(mutatedHandler.body);
  assert.equal(mutatedTransactions.length, 1);
  assert.throws(() => assertExecutedAdmission(mutatedTransactions[0], mutatedHandler),
    /canonical admission must|admission callback must|admission loop must|ownership must/, name);
};
for (const [name, original, replacement] of executionMutations) {
  assert.equal(canonicalParkingBookingRoute.split(original).length, 2, "execution regression fixture must replace one actual source fragment");
  assertRejectedExecutionMutation(name, canonicalParkingBookingRoute.replace(original, replacement));
}
const ownershipMutations: [string, RegExp, string][] = [
  ["request-body ownership bypass", /const hasManageParkingPass = await/, "const hasManageParkingPass = req.body?.skipOwnership === true || await"],
  ["unawaited ownership promise", /const hasManageParkingPass = await/, "const hasManageParkingPass ="],
  ["wrong ownership truck", /storage\.verifyRestaurantOwnership\(\s*truckId,/, "storage.verifyRestaurantOwnership(req.body.otherTruckId,"],
  ["wrong ownership user", /storage\.verifyRestaurantOwnership\(\s*truckId,\s*userId,/, "storage.verifyRestaurantOwnership(truckId, req.body.userId,"],
  ["wrong ownership capability", /storage\.verifyRestaurantOwnership\(\s*truckId,\s*userId,\s*"manageParkingPass"/, 'storage.verifyRestaurantOwnership(truckId, userId, "manageMenu"'],
  ["disabled ownership denial", /if \(!truck \|\| !hasManageParkingPass\)/, "if (false && (!truck || !hasManageParkingPass))"],
  ["nonterminal ownership denial", /return\s+res\.status\(403\)\.json\(\{\s*message:\s*"Not authorized"\s*\}\);/, 'res.status(403).json({ message: "Not authorized" });'],
  ["request-body principal", /const userId = req\.user\.id;/, "const userId = req.body.userId;"],
  ["default requested truck", /const \{\s*truckId,/, 'const { truckId = "fallback-truck",'],
  ["shadowed verifier in body destructure", /const \{\s*truckId,/, "const { storage = { verifyRestaurantOwnership: async () => true }, truckId,"],
  ["shadowed admission principal", /db\.transaction\(async \(tx: any\) => \{/, "db.transaction(async (tx: any) => { const userId = req.body.userId;"],
  ["overwritten ownership verifier", /const userId = req\.user\.id;/, "const userId = req.user.id; storage.verifyRestaurantOwnership = async () => true;"],
  ["overwritten authenticated principal", /const userId = req\.user\.id;/, "req.user.id = req.body.userId; const userId = req.user.id;"],
];
for (const [name, original, replacement] of ownershipMutations) {
  assert.equal(canonicalParkingBookingRoute.split(original).length, 2, "ownership regression fixture must replace one actual source fragment");
  assertRejectedExecutionMutation(name, canonicalParkingBookingRoute.replace(original, replacement));
}
console.log("Canonical checkout execution and ownership regressions: PASS");

const admissionCallback = admissionTransaction.arguments[0];
assert.ok(ts.isArrowFunction(admissionCallback) || ts.isFunctionExpression(admissionCallback));
assert.equal(admissionCallback.parameters.length, 1);
assert.ok(ts.isIdentifier(admissionCallback.parameters[0].name));
const transactionClient = admissionCallback.parameters[0].name.text;
assert.ok(ts.isBlock(admissionCallback.body));
const bindsClient = (name: ts.BindingName, binding = transactionClient): boolean => ts.isIdentifier(name)
  ? name.text === binding
  : name.elements.some((element) => ts.isBindingElement(element) && bindsClient(element.name, binding));
const writesClient = (expression: ts.Expression, binding = transactionClient): boolean => {
  if (ts.isIdentifier(expression)) return expression.text === binding;
  if (ts.isParenthesizedExpression(expression)) return writesClient(expression.expression, binding);
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.some((element) =>
    ts.isSpreadElement(element) ? writesClient(element.expression, binding) : writesClient(element, binding));
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.some((property) =>
    ts.isShorthandPropertyAssignment(property) ? property.name.text === binding :
    ts.isPropertyAssignment(property) ? writesClient(property.initializer, binding) :
    ts.isSpreadAssignment(property) && writesClient(property.expression, binding));
  return false;
};
const assertTransactionClientBinding = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    assert.ok(!bindsClient(node.name), "the admission callback client must not be redeclared or shadowed");
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
    assert.ok(!writesClient(node.left), "the admission callback client must not be reassigned");
  }
  ts.forEachChild(node, assertTransactionClientBinding);
};
assertTransactionClientBinding(admissionCallback.body);
const assertAssessmentBinding = (node: ts.Node) => {
  const protectedBindings = ["assessParkingPassTruckEligibility", "Number", "Boolean", "Math"];
  for (const assessor of protectedBindings) {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    assert.ok(!bindsClient(node.name, assessor), "the current eligibility assessor must not be locally shadowed");
  }
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) assert.notEqual(node.name.text, assessor);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
    assert.ok(!writesClient(node.left, assessor), "the current eligibility assessor must not be reassigned");
  }
  }
  ts.forEachChild(node, assertAssessmentBinding);
};
assertAssessmentBinding(canonicalParkingBooking.handler.body);
const admissionLoops = admissionCallback.body.statements.filter(ts.isForStatement);
assert.equal(admissionLoops.length, 1, "admission must bind the per-date loop inside its owning transaction");
const admissionLoop = admissionLoops[0];
assert.match(admissionLoop.condition!.getText(), /index < sortedDateKeys\.length/);
assert.ok(ts.isBlock(admissionLoop.statement));
const admissionStatements = admissionLoop.statement.statements;
const admissionPrinter = ts.createPrinter({ removeComments: true });
const admissionLoopSource = admissionPrinter.printNode(ts.EmitHint.Unspecified, admissionLoop, admissionLoop.getSourceFile());
const eventLocks = admissionStatements.flatMap((statement, index) => {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return [];
  const call = statement.expression.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) ||
      !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== transactionClient ||
      call.expression.name.text !== "execute") return [];
  return [{ call, index }];
});
assert.equal(eventLocks.length, 1, "the event lock must be awaited through the admission transaction client");
const eventLock = eventLocks[0];
assert.equal(eventLock.call.arguments.length, 1);
const eventLockQuery = admissionPrinter.printNode(ts.EmitHint.Unspecified, eventLock.call.arguments[0], eventLock.call.getSourceFile());
assert.match(eventLockQuery, /^sql\s*`select \$\{events\.id\} from \$\{events\} where \$\{events\.id\} = \$\{row\.id\} for update`$/i,
  "the admission transaction must acquire the exact event-row FOR UPDATE lock");
const admissionDeclaration = (name: string) => {
  const declarations = admissionStatements.flatMap((statement, index) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.filter((declaration) => {
      if (ts.isIdentifier(declaration.name)) return declaration.name.text === name;
      return ts.isArrayBindingPattern(declaration.name) && declaration.name.elements.some((element) =>
        ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === name);
    }).map((declaration) => ({ declaration, index }));
  });
  assert.equal(declarations.length, 1, `admission must directly bind ${name} in its transaction loop`);
  return declarations[0];
};
const currentTruckRead = admissionDeclaration("currentTruck");
const currentUserRead = admissionDeclaration("currentUser");
const currentEligibilityRead = admissionDeclaration("currentEligibility");
const currentEligibilityInitializer = currentEligibilityRead.declaration.initializer!;
assert.ok(ts.isConditionalExpression(currentEligibilityInitializer),
  "current eligibility must be assessed from the locked truck and user reads");
const currentEligibilityCondition = currentEligibilityInitializer.condition;
assert.ok(ts.isBinaryExpression(currentEligibilityCondition) &&
  currentEligibilityCondition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
  ts.isIdentifier(currentEligibilityCondition.left) && currentEligibilityCondition.left.text === "currentTruck" &&
  ts.isIdentifier(currentEligibilityCondition.right) && currentEligibilityCondition.right.text === "currentUser");
const currentAssessment = currentEligibilityInitializer.whenTrue;
assert.ok(ts.isCallExpression(currentAssessment) && ts.isIdentifier(currentAssessment.expression) &&
  currentAssessment.expression.text === "assessParkingPassTruckEligibility",
  "current eligibility must call the assessment directly, without a preflight fallback");
assert.equal(currentAssessment.arguments.length, 1);
const currentAssessmentInput = currentAssessment.arguments[0];
assert.ok(ts.isObjectLiteralExpression(currentAssessmentInput));
assert.equal(currentAssessmentInput.properties.length, 2);
for (const [field, binding] of [["user", "currentUser"], ["truck", "currentTruck"]]) {
  assert.equal(currentAssessmentInput.properties.filter((property) => ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) && property.name.text === field &&
    ts.isIdentifier(property.initializer) && property.initializer.text === binding).length, 1,
    `current eligibility ${field} must use its locked transaction read`);
}
assert.equal(currentEligibilityInitializer.whenFalse.kind, ts.SyntaxKind.NullKeyword,
  "missing locked eligibility reads must fail closed");
const holdInsert = admissionDeclaration("created");
const awaitedClientMethod = (initializer: ts.Expression, method: string) => {
  assert.ok(ts.isAwaitExpression(initializer), "the admission operation must be awaited");
  let call = initializer.expression;
  while (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
    if (ts.isIdentifier(call.expression.expression) && call.expression.expression.text === transactionClient &&
        call.expression.name.text === method) return call;
    call = call.expression.expression;
  }
  assert.fail(`admission ${method} must use the owning transaction receiver chain`);
};
const compactAdmissionExpression = (expression: ts.Expression) => {
  const source = admissionPrinter.printNode(ts.EmitHint.Unspecified, expression, expression.getSourceFile());
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  let compact = "";
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) compact += scanner.getTokenText();
  return compact.replace(/,\}/g, "}").replace(/,\)/g, ")");
};
const lockedEligibilityReads = [
  { read: currentTruckRead, name: "currentTruck", query: `await ${transactionClient}.select({businessType:restaurants.businessType,isFoodTruck:restaurants.isFoodTruck,insuranceVerified:restaurants.insuranceVerified,insuranceExpiresAt:restaurants.insuranceExpiresAt}).from(restaurants).where(eq(restaurants.id,truckId)).for("share")` },
  { read: currentUserRead, name: "currentUser", query: `await ${transactionClient}.select({userType:users.userType,emailVerified:users.emailVerified}).from(users).where(eq(users.id,userId)).for("share")` },
];
for (const { read, name, query } of lockedEligibilityReads) {
  assert.ok(read.declaration.parent.flags & ts.NodeFlags.Const, "locked eligibility reads must remain const");
  assert.ok(ts.isArrayBindingPattern(read.declaration.name) && read.declaration.name.elements.length === 1);
  const binding = read.declaration.name.elements[0];
  assert.ok(ts.isBindingElement(binding) && ts.isIdentifier(binding.name) && binding.name.text === name &&
    !binding.initializer && !binding.dotDotDotToken, "locked eligibility reads must not fall back to preflight values");
  awaitedClientMethod(read.declaration.initializer!, "select");
  assert.equal(compactAdmissionExpression(read.declaration.initializer!), query.replace(/\s+/g, ""),
    `locked ${name} must select current verification fields for its exact ID under a share lock`);
}
assert.ok(currentEligibilityRead.declaration.parent.flags & ts.NodeFlags.Const);
assert.ok(ts.isIdentifier(currentEligibilityRead.declaration.name), "current eligibility must retain its direct const binding");
const holdInsertCall = awaitedClientMethod(holdInsert.declaration.initializer!, "insert");
assert.ok(ts.isIdentifier(holdInsertCall.arguments[0]) && holdInsertCall.arguments[0].text === "eventBookings",
  "the owning admission transaction must insert the booking hold");
assert.ok(eventLock.index < currentTruckRead.index && currentTruckRead.index < currentUserRead.index &&
  currentUserRead.index < currentEligibilityRead.index && currentEligibilityRead.index < holdInsert.index,
  "admission must acquire its lock before reading and rechecking current eligibility, before inserting holds");
const eligibilityDenials = admissionStatements.flatMap((statement, index) => {
  if (!ts.isIfStatement(statement) || !ts.isBlock(statement.thenStatement)) return [];
  if (statement.thenStatement.statements.length !== 1) return [];
  const condition = admissionPrinter.printNode(ts.EmitHint.Unspecified, statement.expression, statement.getSourceFile());
  const requiredCondition = "!currentEligibility || !currentEligibility.isTruckProfile || !currentEligibility.roleAllowed || (!currentEligibility.shouldBypassVerificationGate && (!currentEligibility.emailVerified || !currentEligibility.storedInsuranceValid))";
  if (condition.replace(/\s+/g, "") !== requiredCondition.replace(/\s+/g, "")) return [];
  const throws = statement.thenStatement.statements.filter(ts.isThrowStatement);
  if (throws.length !== 1 || !throws[0].expression || !ts.isCallExpression(throws[0].expression)) return [];
  const error = throws[0].expression;
  if (!ts.isPropertyAccessExpression(error.expression) || !ts.isIdentifier(error.expression.expression) ||
      error.expression.expression.text !== "Object" || error.expression.name.text !== "assign") return [];
  const fields = error.arguments[1];
  if (!fields || !ts.isObjectLiteralExpression(fields) || !fields.properties.some((property) =>
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "code" &&
    ts.isStringLiteral(property.initializer) && property.initializer.text === "TRUCK_ELIGIBILITY_CHANGED")) return [];
  return [index];
});
assert.equal(eligibilityDenials.length, 1, "current eligibility must have one fail-closed transaction denial");
assert.ok(currentTruckRead.index + 1 === currentUserRead.index &&
  currentUserRead.index + 1 === currentEligibilityRead.index &&
  currentEligibilityRead.index + 1 === eligibilityDenials[0],
  "locked eligibility reads, assessment and denial must remain consecutive without intervening field mutations");
assert.ok(currentEligibilityRead.index < eligibilityDenials[0] && eligibilityDenials[0] < holdInsert.index,
  "current qualification denial must execute after the locked recheck and before hold insertion");
const lockedEventRead = admissionDeclaration("lockedRow");
const capacityCounts = admissionDeclaration("counts");
const reservedCountRead = admissionDeclaration("reservedCount");
const hardCapRead = admissionDeclaration("hardCapEnabled");
const maxSpotsRead = admissionDeclaration("maxSpots");
const hostCentsRead = admissionDeclaration("hostCents");
const feeCentsRead = admissionDeclaration("feeCents");
const canonicalCapacityExpressions = [
  { read: lockedEventRead, expression: `await${transactionClient}.select().from(events).where(eq(events.id,row.id)).limit(1)` },
  { read: capacityCounts, expression: `await${transactionClient}.select({count:sql<number>\`count(*)\`}).from(eventBookings).where(and(eq(eventBookings.eventId,row.id),inArray(eventBookings.status,["confirmed","pending"])))` },
  { read: reservedCountRead, expression: "Number(counts[0]?.count||0)" },
  { read: hardCapRead, expression: "Boolean(lockedRow.hardCapEnabled)" },
  { read: maxSpotsRead, expression: "Math.max(1,Number(lockedRow.maxTrucks??1)||1)" },
  { read: hostCentsRead, expression: "hostSplit[index]??0" },
  { read: feeCentsRead, expression: "platformSplit[index]??0" },
];
for (const { read, expression } of canonicalCapacityExpressions) {
  assert.ok(read.declaration.parent.flags & ts.NodeFlags.Const, "capacity producers must retain direct const bindings");
  assert.equal(compactAdmissionExpression(read.declaration.initializer!), expression,
    "capacity admission must use the exact locked event row and same-transaction active booking count");
}
assert.ok(ts.isArrayBindingPattern(lockedEventRead.declaration.name) && lockedEventRead.declaration.name.elements.length === 1);
const lockedEventBinding = lockedEventRead.declaration.name.elements[0];
assert.ok(ts.isBindingElement(lockedEventBinding) && ts.isIdentifier(lockedEventBinding.name) &&
  lockedEventBinding.name.text === "lockedRow" && !lockedEventBinding.initializer && !lockedEventBinding.dotDotDotToken,
  "the locked event read must not fall back to a preflight row");
for (const read of [capacityCounts, reservedCountRead, hardCapRead, maxSpotsRead, hostCentsRead, feeCentsRead]) {
  assert.ok(ts.isIdentifier(read.declaration.name), "capacity values must retain their direct bindings");
}
const capacityDenials = admissionStatements.flatMap((statement, index) => {
  if (!ts.isIfStatement(statement) || !ts.isBlock(statement.thenStatement) ||
      compactAdmissionExpression(statement.expression) !== "hardCapEnabled&&reservedCount>=maxSpots") return [];
  return [{ statement, index }];
});
assert.equal(capacityDenials.length, 1, "capacity admission must have one effective hard-cap denial");
const capacityDenial = capacityDenials[0];
assert.ok(ts.isBlock(capacityDenial.statement.thenStatement));
const expectedCapacityDenial = ts.createSourceFile("capacity-denial-contract.ts", "const err: any = new Error(\"This parking pass is fully booked.\");\nerr.code = \"FULLY_BOOKED\";\nthrow err;", ts.ScriptTarget.Latest, true);
assert.deepEqual(capacityDenial.statement.thenStatement.statements.map((statement) =>
  admissionPrinter.printNode(ts.EmitHint.Unspecified, statement, statement.getSourceFile())),
  expectedCapacityDenial.statements.map((statement) => admissionPrinter.printNode(ts.EmitHint.Unspecified, statement, expectedCapacityDenial)),
  "capacity denial must construct its FULLY_BOOKED error and throw it without unreachable or alternate exits");
const rowAvailability = admissionStatements[lockedEventRead.index + 1];
assert.ok(ts.isIfStatement(rowAvailability) && ts.isBlock(rowAvailability.thenStatement));
const expectedRowAvailability = ts.createSourceFile("locked-row-policy-contract.ts", "if (!lockedRow || lockedRow.hostId !== row.hostId ||\n    lockedRow.status !== \"open\" || !lockedRow.requiresPayment ||\n    new Date(lockedRow.date).getTime() !== new Date(row.date).getTime() ||\n    selectedSlotTypes.some((slot) => !isSlotWithinHours(slot, lockedRow.startTime, lockedRow.endTime))) {\n  throw Object.assign(new Error(\"This parking pass changed while booking. Please refresh.\"), {\n    code: \"BOOKING_AVAILABILITY_CHANGED\",\n  });\n}", ts.ScriptTarget.Latest, true).statements[0];
assert.equal(admissionPrinter.printNode(ts.EmitHint.Unspecified, rowAvailability, rowAvailability.getSourceFile()),
  admissionPrinter.printNode(ts.EmitHint.Unspecified, expectedRowAvailability, expectedRowAvailability.getSourceFile()),
  "the locked event policy must fail closed without mutating its capacity fields");
assert.ok(eventLock.index + 1 === lockedEventRead.index && lockedEventRead.index + 2 === currentTruckRead.index &&
  eligibilityDenials[0] + 1 === capacityCounts.index && capacityCounts.index + 1 === reservedCountRead.index &&
  reservedCountRead.index + 1 === hardCapRead.index && hardCapRead.index + 1 === maxSpotsRead.index &&
  maxSpotsRead.index + 1 === capacityDenial.index && capacityDenial.index + 1 === hostCentsRead.index &&
  hostCentsRead.index + 1 === feeCentsRead.index && feeCentsRead.index + 1 === holdInsert.index,
  "the locked policy, active counts, effective capacity denial and admitted hold must retain their uninterrupted pipeline");
const holdValueCalls: ts.CallExpression[] = [];
let holdChain = (holdInsert.declaration.initializer! as ts.AwaitExpression).expression;
while (ts.isCallExpression(holdChain) && ts.isPropertyAccessExpression(holdChain.expression)) {
  if (holdChain.expression.name.text === "values") holdValueCalls.push(holdChain);
  holdChain = holdChain.expression.expression;
}
assert.equal(holdValueCalls.length, 1);
assert.equal(holdValueCalls[0].arguments.length, 1);
const holdValues = holdValueCalls[0].arguments[0];
assert.ok(ts.isObjectLiteralExpression(holdValues));
assert.ok(holdValues.properties.every((property) =>
  (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name)),
  "admitted holds must use direct identifier fields without spreads, computed keys, accessors or methods");
for (const [field, value] of [["eventId", "row.id"], ["status", '"pending"']]) {
  const fields = holdValues.properties.filter((property) => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText() === field);
  assert.equal(fields.length, 1, `admitted hold must have exactly one ${field}`);
  assert.ok(ts.isPropertyAssignment(fields[0]));
  assert.equal(compactAdmissionExpression(fields[0].initializer), value, `admitted hold ${field} must match the counted row and pending state`);
}

assert.match(
  admissionLoopSource,
  /from \$\{events\} where \$\{events\.id\} = \$\{row\.id\} for update[\s\S]*Boolean\(lockedRow\.hardCapEnabled\)[\s\S]*hardCapEnabled && reservedCount >= maxSpots/,
  "canonical checkout must serialize capacity admission under the actual event-row lock and current hard-cap policy",
);
assert.match(
  admissionLoopSource,
  /const currentEligibility[\s\S]*assessParkingPassTruckEligibility\([\s\S]*!currentEligibility\.isTruckProfile[\s\S]*!currentEligibility\.roleAllowed[\s\S]*!currentEligibility\.emailVerified[\s\S]*!currentEligibility\.storedInsuranceValid[\s\S]*TRUCK_ELIGIBILITY_CHANGED/,
  "canonical admission must recheck current truck verification and role after acquiring the event lock",
);
assert.doesNotMatch(
  canonicalParkingBookingRoute,
  /pg_advisory_xact_lock/,
  "canonical capacity admission must retain its shared event-row lock rather than a private advisory lock",
);
assert.match(
  canonicalParkingBookingRoute,
  /if \(rowDayStart < todayStart\)[\s\S]*if \(isSameDayBooking\)[\s\S]*getSlotWindowMinutesWithCleanup\([\s\S]*window\.startMinutes <= nowMinutes/,
  "canonical checkout must reject past dates and elapsed same-day slots without rejecting every same-day booking",
);
const eventDetailClientSource = readSource("client/src/pages/event-detail.tsx");
assert.match(
  eventDetailClientSource,
  /truckContext\.userId !== currentUserId[\s\S]*enabled: Boolean\(eventId\) && !waitingForOwnerContext/,
  "the event page must wait for exact account-scoped truck context before loading protected detail",
);
assert.match(
  eventDetailClientSource,
  /fetch\("\/api\/business-access\/me"[\s\S]*permissions\?\.manageParkingPass[\s\S]*resolveStoredFoodBusinessType/,
  "the event page must choose a canonical or legacy-flagged food truck with exact Parking Pass authority",
);
assert.match(
  eventDetailClientSource,
  /extractIdFromSlug\(eventParam\)/,
  "the event page must retain complete virtual Parking Pass ids",
);
const businessTeamAccessSource = readSource(
  "server/services/businessTeamAccess.ts",
);
assert.match(
  businessTeamAccessSource,
  /businessType: restaurants\.businessType,[\s\S]*isFoodTruck: restaurants\.isFoodTruck/,
  "account-scoped business access must retain the legacy food-truck flag",
);
assert.match(
  eventDetailClientSource,
  /queryKey: \[[\s\S]*currentUserId \|\| "guest"[\s\S]*truckId \|\| "anonymous"/,
  "authorized event cache keys must be scoped to the authenticated account and truck",
);
assert.match(
  eventDetailClientSource,
  /\?truckId=\$\{encodeURIComponent\(truckId\)\}[\s\S]*credentials: "include"/,
  "the event page must send the exact owned truck with authenticated detail requests",
);
assert.match(
  eventRoutesSource,
  /toPublicParkingPassListingArray/,
  "eventRoutes.ts must import the public Parking Pass DTO",
);
assert.match(
  sliceAfter(eventRoutesSource, '"/api/parking-pass",', 6500),
  /toPublicParkingPassListingArray/,
  "GET /api/parking-pass must return allowlisted listings",
);
assert.match(
  sliceAfter(eventRoutesSource, '"/api/parking-pass/host-ids"', 7000),
  /normalizeParkingStatus\(series\?\.status\) === "published"/,
  "public Parking Pass host ids must require a published series",
);
const parkingPassHostStatusSource = sliceAfter(
  eventRoutesSource,
  "const buildParkingPassHostStatusPayload",
  5000,
);
assert.match(
  parkingPassHostStatusSource,
  /includeDraft: false/,
  "public Parking Pass host status must exclude draft virtual occurrences",
);
assert.match(
  parkingPassHostStatusSource,
  /isParkingPassFeedCandidate\(event\)/,
  "public Parking Pass host status must exclude unavailable legacy rows",
);
assert.match(
  parkingPassHostStatusSource,
  /publishedParkingPassSeriesIds\.has\(String\(event\.seriesId\)\)/,
  "public Parking Pass host status must reject legacy rows linked to draft series",
);

const dealDiscoveryRoutesSource = readSource(
  "server/routes/dealDiscoveryRoutes.ts",
);
assert.match(
  sliceAfter(
    dealDiscoveryRoutesSource,
    'app.get("/api/reviews/restaurant/:restaurantId"',
    1200,
  ),
  /toPublicRestaurantReviewArray/,
  "GET /api/reviews/restaurant/:restaurantId must return public review DTOs",
);

const storiesRoutesSource = readSource("server/storiesRoutes.ts");
const eligiblePaginationFixture = [
  { id: "eligible-a", eligible: true },
  { id: "hidden-a", eligible: false },
  { id: "eligible-b", eligible: true },
  { id: "hidden-b", eligible: false },
  { id: "hidden-c", eligible: false },
  { id: "eligible-c", eligible: true },
  { id: "eligible-d", eligible: true },
  { id: "hidden-d", eligible: false },
  { id: "eligible-e", eligible: true },
  { id: "eligible-f", eligible: true },
];
const loadEligiblePaginationFixture = async (offset: number, limit: number) =>
  eligiblePaginationFixture.slice(offset, offset + limit);
const firstEligiblePage = await loadEligiblePage({
  offset: 0,
  limit: 3,
  batchSize: 2,
  maxBatches: 10,
  loadBatch: loadEligiblePaginationFixture,
  isEligible: (item) => item.eligible,
});
const secondEligiblePage = await loadEligiblePage({
  offset: 3,
  limit: 3,
  batchSize: 2,
  maxBatches: 10,
  loadBatch: loadEligiblePaginationFixture,
  isEligible: (item) => item.eligible,
});
assert.deepEqual(
  firstEligiblePage.items.map((item) => item.id),
  ["eligible-a", "eligible-b", "eligible-c"],
  "the first story page must paginate the eligible sequence",
);
assert.equal(firstEligiblePage.hasMore, true);
assert.deepEqual(
  secondEligiblePage.items.map((item) => item.id),
  ["eligible-d", "eligible-e", "eligible-f"],
  "the next story page must neither repeat nor skip eligible rows",
);
assert.equal(secondEligiblePage.hasMore, false);
let adversarialBatchCalls = 0;
const boundedAdversarialPage = await loadEligiblePage({
  offset: 1_000_000,
  limit: 3,
  batchSize: 2,
  maxBatches: 4,
  loadBatch: async () => {
    adversarialBatchCalls += 1;
    return [
      { id: `hidden-${adversarialBatchCalls}-a`, eligible: false },
      { id: `hidden-${adversarialBatchCalls}-b`, eligible: false },
    ];
  },
  isEligible: (item) => item.eligible,
});
assert.equal(
  adversarialBatchCalls,
  4,
  "adversarial eligible offsets must not cause unbounded database batches",
);
assert.equal(boundedAdversarialPage.scanLimitReached, true);
assert.deepEqual(boundedAdversarialPage.items, []);
assert.equal(
  publicStoryFeedRateLimitKey({
    ip: "203.0.113.10",
    sessionId: "anonymous-session-a",
  }),
  publicStoryFeedRateLimitKey({
    ip: "203.0.113.10",
    sessionId: "anonymous-session-b",
  }),
  "cookie-less sessions from the same IP must share the story feed limiter identity",
);
assert.notEqual(
  publicStoryFeedRateLimitKey({
    userId: "user-a",
    ip: "203.0.113.10",
  }),
  publicStoryFeedRateLimitKey({
    userId: "user-b",
    ip: "203.0.113.10",
  }),
  "authenticated story feed traffic must remain attributable per user",
);
assert.match(
  storiesRoutesSource,
  /const loadPublicEngageableStory[\s\S]*publicStoryPublicationWhere\(sql`NOW\(\)`\)[\s\S]*isPublicStoryAssociationEligible\(story\)/,
  "every public story engagement mutation must share current publication and association authority",
);
for (const storyMutationRoute of [
  "app.post('/api/stories/:storyId/like'",
  "'/api/stories/:storyId/comments'",
  "app.post('/api/stories/:storyId/view'",
  "app.post('/api/stories/:storyId/share'",
]) {
  assert.match(
    sliceAfter(storiesRoutesSource, storyMutationRoute, 3000),
    /loadPublicEngageableStory\(storyId\)/,
    `story mutation must fail closed through public authority: ${storyMutationRoute}`,
  );
}
assert.match(
  sliceAfter(storiesRoutesSource, "app.post('/api/stories/:storyId/view'", 3000),
  /storyViewLimiter[\s\S]*Number\.isFinite\(watchDuration\)[\s\S]*watchDuration < 3/,
  "story views must be rate-limited and require a real three-second watch",
);
const publicStoryDetailRoute = sliceAfter(
  storiesRoutesSource,
  "app.get('/api/stories/:storyId'",
  9500,
);
for (const requiredStoryBoundary of [
  "publicStoryPublicationWhere(publicStoryNow)",
  "eq(users.isDisabled, false)",
  "isPublicBusinessVisible(restaurant[0])",
  "toPublicRestaurantListingWithVisibility(restaurant[0], db)",
  "projectPublicStoryRow(story[0]",
]) {
  assert.ok(
    publicStoryDetailRoute.includes(requiredStoryBoundary),
    `anonymous story detail boundary missing: ${requiredStoryBoundary}`,
  );
}
const publicStoryFeedRoute = sliceAfter(
  storiesRoutesSource,
  "app.get('/api/stories/feed'",
  14000,
);
assert.match(
  publicStoryFeedRoute,
  /publicStoryPublicationWhere\(sql`NOW\(\)`\)[\s\S]*eq\(users\.isDisabled, false\)[\s\S]*isPublicStoryAssociationEligible\(row\)[\s\S]*projectPublicStoryRow\(story\)/,
  "anonymous story feed must gate moderation state and return only the public story DTO",
);
assert.match(
  publicStoryFeedRoute,
  /communityOffset = page \* communityPageSize[\s\S]*loadEligiblePage<any>\([\s\S]*offset: communityOffset[\s\S]*hasMore: communityPage\.hasMore/,
  "story feed pagination must offset and report continuation after association eligibility",
);
assert.match(
  publicStoryFeedRoute,
  /storyFeedLimiter[\s\S]*STORY_FEED_MAX_PAGE[\s\S]*STORY_FEED_MAX_SCAN_BATCHES[\s\S]*scanLimitReached/,
  "anonymous story feed work must be rate-limited and bounded by page and scan budgets",
);
assert.match(
  publicStoryFeedRoute,
  /featuredStoryIds[\s\S]*!featuredStoryIds\.has\(String\(row\.id\)\)/,
  "featured stories must not repeat in the community page",
);
const videoDetailSource = readSource("client/src/pages/video-detail.tsx");
assert.match(
  videoDetailSource,
  /onTimeUpdate[\s\S]*currentTarget\.played[\s\S]*recordQualifiedView\(watchDuration\)/,
  "story detail must wait for three seconds of played media before claiming the view limiter key",
);
assert.match(
  videoDetailSource,
  /body: JSON\.stringify\(\{ watchDuration: Math\.floor\(watchDuration\) \}\)/,
  "story detail must send the qualified watch duration to the view endpoint",
);
const publicUserStoriesRoute = sliceAfter(
  storiesRoutesSource,
  "app.get('/api/stories/user/:userId'",
  3000,
);
assert.match(
  publicUserStoriesRoute,
  /publicStoryPublicationWhere\(sql`NOW\(\)`\)[\s\S]*eq\(users\.isDisabled, false\)[\s\S]*isPublicStoryAssociationEligible\(row\)[\s\S]*projectPublicStoryRow/,
  "anonymous per-user story feed must gate public eligibility and return only the public story DTO",
);
const serverIndexSource = readSource("server/index.ts");
assert.match(
  serverIndexSource,
  /req\.path\.startsWith\("\/api\/"\)[\s\S]*Cache-Control", "no-store, max-age=0"/,
  "revocable API projections must be no-store by default",
);
const publicVideoSsrRoute = sliceAfter(
  serverIndexSource,
  'app.get("/video/:storyId"',
  12000,
);
for (const requiredVideoSsrBoundary of [
  "encodeURIComponent(storyId)",
  "publicStoryPublicationWhere(new Date())",
  "projectPublicStoryRow(storyRows[0])",
  "isPublicBusinessVisible(restaurantRows[0])",
  "toPublicRestaurantListingWithVisibility(restaurantRows[0], db)",
  'set("X-Robots-Tag", "noindex, nofollow")',
  "escapeHtml(canonical)",
]) {
  assert.ok(
    publicVideoSsrRoute.includes(requiredVideoSsrBoundary),
    `public video SSR boundary missing: ${requiredVideoSsrBoundary}`,
  );
}
assert.doesNotMatch(
  publicVideoSsrRoute,
  /href="\$\{canonicalBaseUrl\}\/video\/\$\{storyId\}"/,
  "public video SSR must not interpolate a raw path parameter into HTML",
);
assert.doesNotMatch(
  publicStoryDetailRoute,
  /story:\s*story\[0\]|restaurant:\s*restaurant\?\.\[0\]/,
  "anonymous story detail must never return raw story or restaurant rows",
);

const dealManagementRoutesSource = readSource(
  "server/routes/dealManagementRoutes.ts",
);
const publicDealViewRoute = sliceAfter(
  dealManagementRoutesSource,
  'app.post("/api/deals/:dealId/view"',
  2500,
);
assert.match(
  publicDealViewRoute,
  /publicDealViewLimiter[\s\S]*projectPublicDealRows\(\[deal\]\)[\s\S]*if \(!publicDeal\)[\s\S]*status\(404\)/,
  "deal views must require a current canonically public deal and abuse control",
);
assert.doesNotMatch(
  publicDealViewRoute,
  /res\.json\(\{ success: true, view \}\)/,
  "public deal view tracking must not return its stored analytics row",
);

const awardCalculationsSource = readSource("server/awardCalculations.ts");
for (const requiredAwardInputGate of [
  "getUserPublishedVideoRecommendations",
  "publicStoryPublicationWhere(sql`NOW()`)",
  "isPublicStoryAssociationEligible(row)",
  "currentPublicDeals",
  "vs.is_approved = true",
  "vs.expires_at >= now()",
  "story_creator.is_disabled = false",
]) {
  assert.ok(
    awardCalculationsSource.includes(requiredAwardInputGate),
    `award calculation input gate missing: ${requiredAwardInputGate}`,
  );
}
for (const forbiddenStoryDetailField of [
  "passwordHash",
  "AccessToken",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "accountSettings",
  "publicProfileSettings: users.publicProfileSettings",
  "rawData",
  "ownerId",
  "contactPhone",
]) {
  assert.equal(
    publicStoryDetailRoute.includes(forbiddenStoryDetailField),
    false,
    `anonymous story detail must not select or serialize ${forbiddenStoryDetailField}`,
  );
}

const publicMapRoutesSource = readSource("server/routes/publicMapRoutes.ts");
assert.match(
  publicMapRoutesSource,
  /to(?:Bounded)?PublicMapLocationsPayload/,
  "publicMapRoutes.ts must import the public map locations DTO",
);
assert.match(
  sliceAfter(publicMapRoutesSource, 'app.get("/api/map/locations"', 22000),
  /toBoundedPublicMapLocationsPayload/,
  "GET /api/map/locations must return sanitized map location DTOs",
);

const completenessReportSource = readSource(
  "scripts/realAccountCompletenessReport.ts",
);
assert.match(
  completenessReportSource,
  /from event_bookings eb[\s\S]*lower\(coalesce\(eb\.status, ''\)\) = 'confirmed'[\s\S]*e\.date >= current_date/,
  "account completeness must count confirmed current event bookings as schedule",
);
assert.doesNotMatch(
  completenessReportSource,
  /from telemetry_events|owner_created_at|owner_telemetry_event_count|owner_login_event_count/,
  "account completeness must not collect owner join/login/telemetry output data",
);
assert.match(
  completenessReportSource,
  /isLikelyTestBusiness\(\{[\s\S]*address: raw\.address[\s\S]*description: raw\.description/,
  "account completeness may use business evidence transiently for test-row exclusion",
);
const completenessOutputProjection = sliceAfter(
  completenessReportSource,
  "realRows.push({",
  1400,
);
for (const forbiddenOutputField of [
  "ownerCreatedAt",
  "ownerTelemetryEventCount",
  "ownerLoginEventCount",
  "address:",
  "description:",
  "cuisineType:",
  "operatingHours:",
  "logoUrl:",
  "coverImageUrl:",
]) {
  assert.equal(
    completenessOutputProjection.includes(forbiddenOutputField),
    false,
    `account completeness JSON projection must omit ${forbiddenOutputField}`,
  );
}
assert.match(completenessOutputProjection, /hasPhotos:/);
assert.match(completenessOutputProjection, /hasHours:/);

console.log("MealScout public data boundary contract: PASS");
