import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
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
// The legacy writer is retired. Parse its exact registration so a neighboring
// confirm/cancel route cannot accidentally satisfy this boundary contract.
const eventRoutesAst = ts.createSourceFile(
  "eventRoutes.ts",
  eventRoutesSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const legacyCheckoutRegistrations: ts.CallExpression[] = [];
const findLegacyCheckout = (node: ts.Node) => {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(eventRoutesAst) === "app" &&
    node.expression.name.text === "post" &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === "/api/events/:eventId/book"
  ) {
    legacyCheckoutRegistrations.push(node);
  }
  ts.forEachChild(node, findLegacyCheckout);
};
findLegacyCheckout(eventRoutesAst);
assert.equal(legacyCheckoutRegistrations.length, 1);
const legacyCheckoutSource = legacyCheckoutRegistrations[0].getText(eventRoutesAst);
assert.doesNotMatch(
  legacyCheckoutSource,
  /\b(?:db|storage|stripe)\b|ensureParkingPassEventRow|pg_advisory_xact_lock/,
  "the retired legacy checkout must not read/write booking state or call providers",
);
const authenticatedMiddleware = Symbol("isAuthenticated");
let legacyCheckoutHandler: ((req: unknown, res: unknown) => unknown) | undefined;
runInNewContext(
  ts.transpileModule(legacyCheckoutSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    app: {
      post(path: string, ...handlers: unknown[]) {
        assert.equal(path, "/api/events/:eventId/book");
        assert.equal(handlers.length, 2);
        assert.equal(handlers[0], authenticatedMiddleware);
        assert.equal(typeof handlers[1], "function");
        legacyCheckoutHandler = handlers[1] as typeof legacyCheckoutHandler;
      },
    },
    isAuthenticated: authenticatedMiddleware,
    URLSearchParams,
  },
  { timeout: 1000 },
);
assert.ok(legacyCheckoutHandler);
for (const truckId of [undefined, "", "  ", " truck-1 ", "truck&next=/outside"]) {
  let status: number | undefined;
  let response: { code: string; checkoutPath: string } | undefined;
  const res = {
    status(value: number) {
      status = value;
      return this;
    },
    json(value: typeof response) {
      response = value;
      return value;
    },
  };
  const result = legacyCheckoutHandler(
    { params: { eventId: "pp:series:2026-10-10&next=/outside" }, body: { truckId } },
    res,
  );
  assert.equal(result, response, "legacy checkout must return its rejection");
  assert.equal(status, 409);
  assert.ok(response);
  assert.equal(response.code, "canonical_checkout_required");
  const destination = new URL(response.checkoutPath, "https://mealscout.test");
  assert.equal(destination.origin, "https://mealscout.test");
  assert.equal(destination.pathname, "/parking-pass");
  assert.equal(destination.searchParams.get("pass"), "pp:series:2026-10-10&next=/outside");
  assert.equal(destination.searchParams.get("truckId"), truckId?.trim() || null);
  assert.deepEqual(
    [...destination.searchParams.keys()].sort(),
    truckId?.trim() ? ["pass", "truckId"] : ["pass"],
  );
}
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
