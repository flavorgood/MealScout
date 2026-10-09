import type { Express } from "express";
import { z } from "zod";
import Stripe from "stripe";
import { storage } from "../storage";
import { emailService } from "../emailService";
import { db } from "../db";
import {
  isAuthenticated,
  isRestaurantOwner,
  isStaffOrAdmin,
} from "../unifiedAuth";
import {
  claims,
  eventBookings,
  events,
  eventSeries,
  hosts,
  insertEventInterestSchema,
  restaurants,
  users,
  CLAIM_STATUS,
  CLAIM_TYPES,
} from "@shared/schema";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
import { forwardGeocode, reverseGeocode } from "../utils/geocoding";
import { notifyNearbyTrucksOfEventRequest } from "../truckEventMatchService";
import {
  ensureParkingPassEventRow,
  listParkingPassOccurrences,
  loadParkingPassOccurrenceById,
  parseParkingPassVirtualId,
} from "../services/parkingPassVirtual";
import { PARKING_PASS_MEAL_WINDOWS } from "@shared/parkingPassSlots";
import {
  computeHostProfileQualityFlags,
  computeParkingPassQualityFlags,
  isHostProfileMapEligible,
  isParkingPassPublicReady,
  normalizeUsStateAbbr,
} from "../services/parkingPassQuality";
import crypto from "crypto";
import {
  handleReportRequest,
  renderReportPdfForToken,
  requestReportSchema,
} from "../services/pensacolaReportLeadMagnet";
import { buildSlotDateTimes } from "../services/timeIntent";
import {
  resolveCityTimeZone,
  resolveCityTimeZoneSync,
} from "../services/cityTimeZone";
import { isSlotPublic, type PublicSlot } from "../services/publicSlotGate";
import { toPublicEventListingArray } from "../publicProfiles/toPublicEventListing";
import { toPublicParkingPassListingArray } from "../publicProfiles/toPublicParkingPassListing";
import {
  canExposeAnonymousEventDetail,
  canExposeAnonymousEventFeedItem,
  canExposeAuthorizedPaidEventDetail,
} from "../publicProfiles/publicEventDetailAccess";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { dateKeyFromUnknown, dateKeyInZone } from "../services/dateKeys";
import {
  filterPublicConfirmedEventTrucks,
  loadConfirmedEventTrucks,
} from "../services/confirmedEventTrucks";
import { isPublicDiscoveryEligibleEntity } from "@shared/publicDiscoveryIntegrity";
import { resolvePublicProfileVisibility } from "../publicProfiles/publicProfileUtils";
import { resolvePublicCanonicalOrigin } from "../seo/publicCanonicalOrigin";
import { assessParkingPassTruckEligibility } from "../services/parkingPassTruckEligibility";
import { isLegacyParkingPaymentBound } from "../services/legacyParkingPaymentBinding";

const normalizeParkingStatus = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const unavailableParkingStatuses = new Set([
  "archived",
  "cancelled",
  "canceled",
  "closed",
  "completed",
  "deleted",
  "disabled",
  "draft",
  "expired",
  "inactive",
  "unavailable",
]);

type PublicHostOwnerAuthority = {
  showAddress: boolean;
  showContact: boolean;
};

const enforcePublicHostOwnerAuthority = async (
  rows: any[] | null | undefined,
): Promise<any[]> => {
  const candidates = Array.isArray(rows) ? rows : [];
  const ownerIds = Array.from(
    new Set(
      candidates
        .map((row: any) =>
          String(
            row?.host?.userId || row?.hostUserId || row?.userId || "",
          ).trim(),
        )
        .filter(Boolean),
    ),
  );
  const ownerRows = await Promise.all(
    ownerIds.map(async (ownerId) => {
      const owner = await storage.getUser(ownerId);
      if (!owner || owner.isDisabled !== false) return null;
      return [
        ownerId,
        resolvePublicProfileVisibility(owner.publicProfileSettings),
      ] as const;
    }),
  );
  const authorityByOwnerId = new Map<string, PublicHostOwnerAuthority>(
    ownerRows.filter(
      (row): row is readonly [string, PublicHostOwnerAuthority] => Boolean(row),
    ),
  );

  return candidates.flatMap((row: any) => {
    const host = row?.host && typeof row.host === "object" ? row.host : row;
    const ownerId = String(
      host?.userId || row?.hostUserId || row?.userId || "",
    ).trim();
    const authority = ownerId ? authorityByOwnerId.get(ownerId) : null;
    if (!authority) return [];
    const publicHost = {
      ...host,
      address: authority.showAddress ? host?.address ?? null : null,
      latitude: authority.showAddress ? host?.latitude ?? null : null,
      longitude: authority.showAddress ? host?.longitude ?? null : null,
      contactEmail: authority.showContact ? host?.contactEmail ?? null : null,
      contactPhone: authority.showContact ? host?.contactPhone ?? null : null,
      businessWebsite: authority.showContact
        ? host?.businessWebsite ?? null
        : null,
    };
    return row?.host && typeof row.host === "object"
      ? [{ ...row, host: publicHost, __hostPublicAuthority: authority }]
      : [{ ...publicHost, __hostPublicAuthority: authority }];
  });
};

const attachConfirmedPublicEventTrucks = async (rows: any[]) => {
  const confirmedByEvent = await loadConfirmedEventTrucks(
    rows.map((row) => String(row?.id || "")),
  );
  return rows.map((row) => {
    const trucks = filterPublicConfirmedEventTrucks(
      confirmedByEvent.get(String(row?.id || "")) || [],
    ).map((truck) => ({
        id: truck.truckId,
        name: truck.name,
        cuisineType: truck.cuisineType,
        city: truck.city,
        state: truck.state,
        logoUrl: truck.logoUrl,
        coverImageUrl: truck.coverImageUrl,
        bookingConfirmedAt: truck.bookingConfirmedAt,
      }));
    return {
      ...row,
      bookedRestaurantId: trucks[0]?.id || null,
      trucks,
    };
  });
};

export const buildAnonymousPublicEventFeed = async (rows: unknown, now: Date) => {
  const attached = await enforcePublicHostOwnerAuthority(
    await attachConfirmedPublicEventTrucks(
      Array.isArray(rows) ? rows : [],
    ),
  );
  const evaluated = await Promise.all(
    attached.map(async (event: any) => {
      const primaryTruck = event?.trucks?.[0] || null;
      const timeZone = await resolveCityTimeZone({
        city: event?.host?.city,
        state: event?.host?.state,
      });
      const interval = buildSlotDateTimes({
        timeZone,
        date: event?.date,
        startTime: String(event?.startTime || ""),
        endTime: String(event?.endTime || ""),
      });
      const lastConfirmedAtUtc = new Date(
        primaryTruck?.bookingConfirmedAt ||
          event?.lastConfirmedAt ||
          event?.updatedAt ||
          event?.date ||
          Number.NaN,
      );
      const slotIsPublic = Boolean(
        primaryTruck &&
          interval &&
          Number.isFinite(lastConfirmedAtUtc.getTime()) &&
          isSlotPublic({
            slot: {
              source: "parking_pass_booking",
              status: "confirmed",
              startsAtUtc: interval.startUtc,
              endsAtUtc: interval.endUtc,
              lastConfirmedAtUtc,
            },
            now,
            ttlHours: 24 * 365 * 100,
          }),
      );
      if (!canExposeAnonymousEventFeedItem({
        eventType: event?.eventType,
        requiresPayment: event?.requiresPayment,
        status: event?.status,
        eventName: event?.name,
        hostName: event?.host?.businessName,
        slotIsPublic,
        hasPublicConfirmedTruck: Boolean(primaryTruck),
        ended: Boolean(interval && interval.endUtc.getTime() <= now.getTime()),
      })) {
        return null;
      }
      return event;
    }),
  );
  return evaluated.filter((event): event is any => Boolean(event));
};

const sendPublicEventFeedUnavailable = (res: any) =>
  res
    .status(503)
    .setHeader("Retry-After", "60")
    .setHeader("Cache-Control", "no-store")
    .setHeader("X-Robots-Tag", "noindex,follow")
    .json({ message: "Events are temporarily unavailable" });

export const isParkingPassFeedCandidate = (event: any) => {
  const eventStatus = normalizeParkingStatus(event?.status || "open");
  const seriesStatus = normalizeParkingStatus(event?.seriesStatus || "published");
  const hostStatus = normalizeParkingStatus(event?.host?.status || event?.hostStatus || "");
  if (unavailableParkingStatuses.has(eventStatus)) return false;
  if (seriesStatus && seriesStatus !== "published") return false;
  if (hostStatus && unavailableParkingStatuses.has(hostStatus)) return false;
  if (event?.deletedAt || event?.archivedAt || event?.cancelledAt) return false;
  if (event?.host?.deletedAt || event?.host?.archivedAt || event?.host?.cancelledAt) return false;

  const eventDate = event?.date ? new Date(event.date) : null;
  if (!eventDate || !Number.isFinite(eventDate.getTime())) return false;
  const endTime = String(event?.endTime || "").trim();
  if (/^\d{1,2}:\d{2}/.test(endTime)) {
    const [hour, minute] = endTime.split(":").map((part) => Number(part));
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      eventDate.setHours(hour, minute, 0, 0);
    }
  }
  if (eventDate.getTime() < Date.now() - 30 * 60 * 1000) return false;
  return true;
};

export const hasParkingPassAvailability = (event: any) => {
  // Legacy listings may not have capacity enforcement enabled. In that mode
  // an empty availableSpotNumbers array means "not enumerated", not "full".
  // New Parking Pass listings always enforce their configured spot count.
  if (!Boolean(event?.hardCapEnabled)) {
    return true;
  }
  if (Array.isArray(event?.availableSpotNumbers)) {
    return event.availableSpotNumbers.length > 0;
  }
  if (typeof event?.availableSpots === "number") {
    return event.availableSpots > 0;
  }
  const maxSpots = Number(event?.spotCount ?? event?.maxTrucks ?? 0);
  const booked = Number(event?.bookedSpots ?? 0);
  if (Number.isFinite(maxSpots) && maxSpots > 0 && Number.isFinite(booked)) {
    if (maxSpots - booked <= 0) return false;
  }
  if (!Number.isFinite(maxSpots) || maxSpots <= 0) return false;
  if (!Number.isFinite(booked)) return true;
  return maxSpots - booked > 0;
};

export const sanitizeParkingPassPublicFeedRows = (events: any[]) =>
  (Array.isArray(events) ? events : []).filter(
    (event) =>
      isParkingPassFeedCandidate(event) &&
      isParkingPassPublicReady(event) &&
      hasParkingPassAvailability(event),
  );

type EventRouteDependencies = {
  hasCompleteProfileAccess: (userId: string) => Promise<boolean>;
  parkingPassFeedBuilder?: () => Promise<any[]>;
  publicEventFeedLoader?: () => Promise<any[]>;
  publicEventDetailLoader?: (eventId: string) => Promise<any | null>;
  publicEventNow?: () => Date;
};

export function registerEventRoutes(
  app: Express,
  dependencies: EventRouteDependencies,
) {
  const { hasCompleteProfileAccess } = dependencies;
  const loadPublicEventFeed =
    dependencies.publicEventFeedLoader || (() => storage.getAllUpcomingEvents());
  const loadPublicEventDetail =
    dependencies.publicEventDetailLoader ||
    (async (eventId: string) => {
      if (parseParkingPassVirtualId(eventId)) {
        const occurrence = await loadParkingPassOccurrenceById(eventId);
        if (!occurrence) return null;
        return {
          id: occurrence.id,
          hostId: occurrence.hostId,
          name: occurrence.name,
          description: occurrence.description,
          eventType: occurrence.eventType,
          date: occurrence.date,
          startTime: occurrence.startTime,
          endTime: occurrence.endTime,
          status: occurrence.status,
          lastConfirmedAt: occurrence.lastConfirmedAt,
          updatedAt: occurrence.updatedAt,
          maxTrucks: occurrence.maxTrucks,
          requiresPayment: occurrence.requiresPayment,
          hostPriceCents: occurrence.hostPriceCents,
          hostUserId: occurrence.host.userId,
          hostName: occurrence.host.businessName,
          hostAddress: occurrence.host.address,
          hostCity: occurrence.host.city,
          hostState: occurrence.host.state,
          hostLatitude: occurrence.host.latitude,
          hostLongitude: occurrence.host.longitude,
        };
      }

      const [row] = await db
        .select({
          id: events.id,
          hostId: events.hostId,
          name: events.name,
          description: events.description,
          eventType: events.eventType,
          date: events.date,
          startTime: events.startTime,
          endTime: events.endTime,
          status: events.status,
          lastConfirmedAt: events.lastConfirmedAt,
          updatedAt: events.updatedAt,
          maxTrucks: events.maxTrucks,
          requiresPayment: events.requiresPayment,
          hostPriceCents: events.hostPriceCents,
          hostUserId: hosts.userId,
          hostName: hosts.businessName,
          hostAddress: hosts.address,
          hostCity: hosts.city,
          hostState: hosts.state,
          hostLatitude: hosts.latitude,
          hostLongitude: hosts.longitude,
        })
        .from(events)
        .innerJoin(hosts, eq(events.hostId, hosts.id))
        .where(eq(events.id, eventId))
        .limit(1);
      return row || null;
    });
  const publicEventNow = dependencies.publicEventNow || (() => new Date());
  const parkingPassFeedLimiter = distributedRateLimit({
    scope: "parking-pass-feed",
    limit: 120,
    windowMs: 60 * 1000,
  });
  const parkingPassBookabilityLimiter = distributedRateLimit({
    scope: "parking-pass-bookability",
    limit: 180,
    windowMs: 60 * 1000,
  });

  let parkingPassPublicFeedBuildInFlight: Promise<any[]> | null = null;
  let parkingPassHostDefaultsLastSyncedAt = 0;
  let parkingPassHostDefaultsSyncInFlight: Promise<number> | null = null;
  let parkingPassCoordinateWarmupInFlight = false;
  const parkingPassCoordinateWarmupCooldown = new Map<string, number>();

  const toTeaserId = (value: string) =>
    crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

  const normalizeLoose = (value: unknown) =>
    String(value || "")
      .trim()
      .toLowerCase();
  const normalizeStateToken = (value: unknown) =>
    normalizeLoose(value).replace(/[^a-z]/g, "");

  const isPensacola = (value: unknown) => {
    const raw = normalizeLoose(value);
    if (!raw) return false;
    if (raw === "pensacola") return true;
    // Accept common variants like "Pensacola, FL", "Pensacola Beach", etc.
    return raw.includes("pensacola");
  };

  const isFlorida = (value: unknown) => {
    const abbr = normalizeUsStateAbbr(String(value || "").trim());
    if (abbr === "FL") return true;
    const token = normalizeStateToken(value);
    if (!token) return false;
    if (token === "fl" || token === "fla") return true;
    // Common misspellings: flordia, floridia, etc.
    return token.startsWith("florid") || token.startsWith("flord");
  };

  const isFloridaLoose = (value: unknown) => {
    const raw = normalizeLoose(value);
    if (!raw) return false;
    if (isFlorida(raw)) return true;
    const token = normalizeStateToken(raw);
    if (token === "fl" || token === "fla") return true;
    return (
      raw.includes(", fl") ||
      raw.includes(" fl ") ||
      raw.endsWith(" fl") ||
      raw.includes(" florida") ||
      raw.includes(" flordia") ||
      raw.includes(" floridia")
    );
  };

  const roundCoord = (value: unknown, digits: number) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const factor = Math.pow(10, digits);
    return Math.round(num * factor) / factor;
  };

  const minStartingPriceCents = (event: any): number | null => {
    const centsValues: number[] = [];
    for (const [key, raw] of Object.entries(event || {})) {
      if (!key.toLowerCase().endsWith("pricecents")) continue;
      const num = Number(raw);
      if (Number.isFinite(num) && num > 0) centsValues.push(Math.floor(num));
    }
    if (centsValues.length === 0) return null;
    return Math.min(...centsValues);
  };

  const hasPositiveParkingPassHostPrice = (host: any) =>
    [
      host?.parkingPassBreakfastPriceCents,
      host?.parkingPassLunchPriceCents,
      host?.parkingPassDinnerPriceCents,
      host?.parkingPassDailyPriceCents,
      host?.parkingPassWeeklyPriceCents,
      host?.parkingPassMonthlyPriceCents,
    ].some((value) => Number(value) > 0);

  const hasParkingPassHostScheduleDefaults = (host: any) =>
    Boolean(
      String(host?.parkingPassStartTime || "").trim() ||
        String(host?.parkingPassEndTime || "").trim() ||
        (Array.isArray(host?.parkingPassDaysOfWeek) &&
          host.parkingPassDaysOfWeek.length > 0),
    );

  const redactParkingPassEventForGuest = (event: any) => {
    const host = event?.host ? { ...(event.host as any) } : null;
    const hostLat = host?.latitude ?? null;
    const hostLng = host?.longitude ?? null;
    const hostCity = host?.city ?? event?.hostCity ?? event?.city ?? null;
    const hostState = host?.state ?? event?.hostState ?? event?.state ?? null;
    if (host) {
      host.businessName = "Verified host";
      host.address = null;
      host.latitude = roundCoord(hostLat, 2);
      host.longitude = roundCoord(hostLng, 2);
    }

    const redacted: any = { ...event, host };
    redacted.name = "Parking Pass host spot";
    redacted.description =
      [hostCity, hostState].filter(Boolean).join(", ") ||
      "Verified host location";
    if ("hostAddress" in redacted) redacted.hostAddress = null;
    if ("address" in redacted) redacted.address = null;
    if ("hostName" in redacted) redacted.hostName = "Verified host";
    if ("hostBusinessName" in redacted)
      redacted.hostBusinessName = "Verified host";
    if ("businessName" in redacted) redacted.businessName = "Verified host";
    return redacted;
  };

  const syncPublicReadyParkingPassHostDefaults = async () => {
    const now = Date.now();
    if (now - parkingPassHostDefaultsLastSyncedAt < 15 * 60_000) {
      return 0;
    }
    if (parkingPassHostDefaultsSyncInFlight) {
      return parkingPassHostDefaultsSyncInFlight;
    }

    parkingPassHostDefaultsSyncInFlight = (async () => {
    const allHosts = await storage.getAllHosts();
    const seriesHostIds = new Set(
      (await storage.getParkingPassSeriesSafe().catch(() => []))
        .map((series: any) => String(series?.hostId || "").trim())
        .filter(Boolean),
    );
    let synced = 0;

    for (const host of allHosts as any[]) {
      const hostId = String(host?.id || "").trim();
      if (!hostId) continue;
      if (
        !seriesHostIds.has(hostId) &&
        !hasPositiveParkingPassHostPrice(host) &&
        !hasParkingPassHostScheduleDefaults(host)
      ) {
        continue;
      }

      const hostStatus = normalizeParkingStatus(host?.status || "");
      if (hostStatus && unavailableParkingStatuses.has(hostStatus)) continue;
      if (host?.deletedAt || host?.archivedAt || host?.cancelledAt) continue;
      if (
        !isHostProfileMapEligible({
          businessName: host?.businessName,
          address: host?.address,
          city: host?.city,
          state: host?.state,
        })
      ) {
        continue;
      }

      const listing = {
        host,
        startTime:
          String(host?.parkingPassStartTime || "").trim() ||
          PARKING_PASS_MEAL_WINDOWS.breakfast.start,
        endTime:
          String(host?.parkingPassEndTime || "").trim() ||
          PARKING_PASS_MEAL_WINDOWS.dinner.end,
        maxTrucks: host?.spotCount ?? 1,
        breakfastPriceCents: host?.parkingPassBreakfastPriceCents,
        lunchPriceCents: host?.parkingPassLunchPriceCents,
        dinnerPriceCents: host?.parkingPassDinnerPriceCents,
        dailyPriceCents: host?.parkingPassDailyPriceCents,
        weeklyPriceCents: host?.parkingPassWeeklyPriceCents,
        monthlyPriceCents: host?.parkingPassMonthlyPriceCents,
      };

      if (!isParkingPassPublicReady(listing as any)) continue;

      try {
        const seriesId = await storage.syncParkingPassSeriesFromHost(hostId);
        if (seriesId) synced += 1;
      } catch (error) {
        console.warn("Failed to sync Parking Pass host defaults:", {
          hostId,
          error,
        });
      }
    }

    if (synced > 0) {
      console.info(
        `[parking-pass] Synced ${synced} host default listing(s) before feed build`,
      );
    }

      parkingPassHostDefaultsLastSyncedAt = Date.now();
      return synced;
    })();

    try {
      return await parkingPassHostDefaultsSyncInFlight;
    } finally {
      parkingPassHostDefaultsSyncInFlight = null;
    }
  };

  const scheduleParkingPassCoordinateWarmup = (parkingEvents: any[]) => {
    if (!Array.isArray(parkingEvents) || parkingEvents.length === 0) return;
    if (parkingPassCoordinateWarmupInFlight) return;

    const now = Date.now();
    const seenHostIds = new Set<string>();
    const candidateHosts: any[] = [];

    for (const event of parkingEvents) {
      const host: any = event?.host;
      const hostId = String(host?.id || "").trim();
      if (!hostId || seenHostIds.has(hostId)) continue;
      seenHostIds.add(hostId);

      const lat = host.latitude !== null && host.latitude !== undefined
        ? Number(host.latitude)
        : NaN;
      const lng = host.longitude !== null && host.longitude !== undefined
        ? Number(host.longitude)
        : NaN;
      const hasCoords =
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180;
      if (hasCoords) continue;

      const nextAllowedAt = parkingPassCoordinateWarmupCooldown.get(hostId) || 0;
      if (nextAllowedAt > now) continue;
      candidateHosts.push(host);
    }

    if (candidateHosts.length === 0) return;

    parkingPassCoordinateWarmupInFlight = true;
    const timer = setTimeout(async () => {
      const startedAt = Date.now();
      let updated = 0;
      try {
        for (const host of candidateHosts.slice(0, 10)) {
          const hostId = String(host?.id || "").trim();
          if (!hostId) continue;
          parkingPassCoordinateWarmupCooldown.set(hostId, Date.now() + 60 * 60_000);

          const addressParts = [host.address, host.city, host.state, "USA"]
            .map((value: any) => String(value || "").trim())
            .filter((value: string) => value.length > 0);
          if (addressParts.length === 0) continue;

          const coords = await forwardGeocode(addressParts.join(", ")).catch(
            () => null,
          );
          if (!coords) continue;

          try {
            await storage.updateHostCoordinates(hostId, coords.lat, coords.lng);
            updated += 1;
          } catch {
            // Ignore persistence errors; this is a background warmup.
          }
        }
      } catch (error) {
        console.warn("[parking-pass] Coordinate warmup failed:", error);
      } finally {
        parkingPassCoordinateWarmupInFlight = false;
        if (updated > 0) {
          console.info(
            `[parking-pass] Coordinate warmup updated ${updated} host(s) in ${Date.now() - startedAt}ms`,
          );
        }
      }
    }, 0);
    timer.unref?.();
  };

  const buildParkingPassPublicFeed = async (): Promise<any[]> => {
    const startedAt = Date.now();
    let lastMarkAt = startedAt;
    const timings: Record<string, number> = {};
    const mark = (label: string) => {
      const now = Date.now();
      timings[label] = now - lastMarkAt;
      lastMarkAt = now;
    };

    // Public feed only returns published, current, available Parking Pass inventory.
    const { occurrences } = await listParkingPassOccurrences({
      horizonDays: 30,
      includeDraft: false,
    });
    mark("occurrences");

    const payoutsEnabled = (event: any) =>
      Boolean(
        event?.host?.stripeConnectAccountId &&
        event?.host?.stripeChargesEnabled,
      );
    const isPublicHostProfile = (host: any, event?: any) =>
      isHostProfileMapEligible({
        businessName: host?.businessName || event?.host?.businessName,
        address: host?.address || event?.hostAddress || event?.address,
        city: host?.city || event?.hostCity || event?.city,
        state: host?.state || event?.hostState || event?.state,
      });

    // NOTE: Public feed must only show Parking Pass listings that have pricing
    // and a clean, geocodable address. Draft/incomplete listings can exist
    // but must not be returned here.
    const virtualEvents = occurrences
      .filter(
        (event: any) =>
          isParkingPassFeedCandidate(event) &&
          isParkingPassPublicReady(event) &&
          isPublicHostProfile(event?.host, event),
      )
      .map((event: any) => ({
        ...event,
        paymentsEnabled: payoutsEnabled(event),
        qualityFlags: computeParkingPassQualityFlags(event),
      }));

    const publishedParkingPassSeriesIds = new Set(
      (await storage.getParkingPassSeriesSafe().catch(() => []))
        .filter(
          (series: any) =>
            normalizeParkingStatus(series?.status) === "published",
        )
        .map((series: any) => String(series?.id || "").trim())
        .filter(Boolean),
    );
    const legacyUpcoming = await storage.getAllUpcomingEvents();
    const legacyEvents = legacyUpcoming
      .filter(
        (event: any) =>
          event?.eventType === "parking_pass" &&
          (!event?.seriesId ||
            publishedParkingPassSeriesIds.has(String(event.seriesId))) &&
          isParkingPassFeedCandidate(event) &&
          isParkingPassPublicReady(event) &&
          isPublicHostProfile(event?.host, event),
      )
      .map((event: any) => ({
        ...event,
        paymentsEnabled: payoutsEnabled(event),
        qualityFlags: computeParkingPassQualityFlags(event),
      }));
    mark("legacy");

    const dedupedById = new Map<string, any>();
    for (const item of [...virtualEvents, ...legacyEvents]) {
      dedupedById.set(item.id, item);
    }
    const parkingEvents = await enforcePublicHostOwnerAuthority(
      Array.from(dedupedById.values()),
    );

    // Do not drop listings just because coordinates are missing.
    // Host locations can still render via /api/map/locations coords or client geocode fallback.
    const eventIds = parkingEvents.map((event) => event.id);

    const [bookingRows, pendingCounts] =
      eventIds.length > 0
        ? await Promise.all([
            db
              .select({
                eventId: eventBookings.eventId,
                spotNumber: eventBookings.spotNumber,
                bookingConfirmedAt: eventBookings.bookingConfirmedAt,
                slotType: eventBookings.slotType,
                truckId: eventBookings.truckId,
              })
              .from(eventBookings)
              .where(
                and(
                  inArray(eventBookings.eventId, eventIds),
                  inArray(eventBookings.status, ["confirmed"]),
                ),
              )
              .orderBy(asc(eventBookings.bookingConfirmedAt)),
            db
              .select({
                eventId: eventBookings.eventId,
                count: sql<number>`count(*)`,
              })
              .from(eventBookings)
              .where(
                and(
                  inArray(eventBookings.eventId, eventIds),
                  inArray(eventBookings.status, ["pending"]),
                ),
              )
              .groupBy(eventBookings.eventId),
          ])
        : [[], []];
    mark("bookings");

    const publicTrucksByEvent = await loadConfirmedEventTrucks(eventIds);

    const pendingByEvent = new Map<string, number>();
    for (const row of pendingCounts) {
      pendingByEvent.set(row.eventId, Number(row.count || 0));
    }

    const bookingsByEvent = new Map<string, typeof bookingRows>();
    for (const row of bookingRows) {
      const isPublicTruck = (
        publicTrucksByEvent.get(String(row.eventId || "")) || []
      ).some((truck) => truck.truckId === String(row.truckId || ""));
      if (!isPublicTruck) continue;
      const list = bookingsByEvent.get(row.eventId) ?? [];
      list.push(row);
      bookingsByEvent.set(row.eventId, list);
    }

    const enhancedEvents = parkingEvents.map((event) => {
      const rows = bookingsByEvent.get(event.id) ?? [];
      const pending = pendingByEvent.get(event.id) ?? 0;
      const maxSpots = event.maxTrucks ?? 1;

      const usedSpotNumbers = new Set<number>();
      for (const row of rows) {
        if (row.spotNumber && row.spotNumber > 0) {
          usedSpotNumbers.add(row.spotNumber);
        }
      }

      let nextSpot = 1;
      for (const row of rows) {
        if (row.spotNumber && row.spotNumber > 0) {
          continue;
        }
        while (usedSpotNumbers.has(nextSpot) && nextSpot <= maxSpots) {
          nextSpot += 1;
        }
        if (nextSpot <= maxSpots) {
          usedSpotNumbers.add(nextSpot);
          nextSpot += 1;
        }
      }

      const availableSpotNumbers: number[] = [];
      for (let spot = 1; spot <= maxSpots; spot += 1) {
        if (!usedSpotNumbers.has(spot)) {
          availableSpotNumbers.push(spot);
        }
      }

      const confirmedCount = rows.length;
      const hardCapEnabled = Boolean(event.hardCapEnabled);
      const reservedRaw = confirmedCount + pending;
      const reservedCount = hardCapEnabled
        ? Math.min(reservedRaw, maxSpots)
        : reservedRaw;
      const availableCount = hardCapEnabled
        ? Math.max(0, maxSpots - reservedCount)
        : maxSpots;
      const trimmedAvailable = hardCapEnabled
        ? availableSpotNumbers.slice(0, availableCount)
        : [];

      return {
        ...event,
        spotCount: maxSpots,
        bookedSpots: reservedCount,
        availableSpotNumbers: trimmedAvailable,
        bookings: rows.map((row: (typeof rows)[number]) => ({
          truckId: row.truckId,
          truckName:
            (
              publicTrucksByEvent.get(String(row.eventId || "")) || []
            ).find((truck) => truck.truckId === String(row.truckId || ""))
              ?.name || "Food truck",
          slotType: row.slotType,
          spotNumber: row.spotNumber,
          bookingConfirmedAt: row.bookingConfirmedAt,
        })),
      };
    }).filter(hasParkingPassAvailability);
    mark("shape");

    const summaryUniqueHostIds = new Set<string>();
    const summaryUniqueParkingPassIds = new Set<string>();
    const summaryUniqueOccurrenceIds = new Set<string>();
    const summaryUniqueDates = new Set<string>();
    const summaryUniqueLocations = new Set<string>();
    let summaryMinDate: string | null = null;
    let summaryMaxDate: string | null = null;
    for (const row of enhancedEvents) {
      const hostId = String(row?.host?.id || row?.hostId || "").trim();
      if (hostId) summaryUniqueHostIds.add(hostId);
      const parkingPassId = String(row?.seriesId || row?.id || "").trim();
      if (parkingPassId) summaryUniqueParkingPassIds.add(parkingPassId);
      const occurrenceId = String(row?.id || row?.occurrenceId || "").trim();
      if (occurrenceId) summaryUniqueOccurrenceIds.add(occurrenceId);
      const dateValue = String(row?.date || "").trim();
      if (dateValue) {
        summaryUniqueDates.add(dateValue);
        if (!summaryMinDate || dateValue < summaryMinDate) summaryMinDate = dateValue;
        if (!summaryMaxDate || dateValue > summaryMaxDate) summaryMaxDate = dateValue;
      }
      const locKey = [
        String(row?.host?.address || row?.hostAddress || "").trim().toLowerCase(),
        String(row?.host?.city || row?.hostCity || row?.city || "").trim().toLowerCase(),
        String(row?.host?.state || row?.hostState || row?.state || "").trim().toLowerCase(),
      ]
        .filter(Boolean)
        .join("|");
      if (locKey) summaryUniqueLocations.add(locKey);
    }

    const totalMs = Date.now() - startedAt;
    if (totalMs > 750 || process.env.PARKING_PASS_FEED_DEBUG === "true") {
      console.info("[parking-pass] public feed build timing", {
        totalMs,
        timings,
        occurrences: occurrences.length,
        legacy: legacyEvents.length,
        returned: enhancedEvents.length,
        summary: {
          returnedRows: enhancedEvents.length,
          uniqueHostIds: summaryUniqueHostIds.size,
          uniqueParkingPassIds: summaryUniqueParkingPassIds.size,
          uniqueOccurrenceIds: summaryUniqueOccurrenceIds.size,
          uniqueDates: summaryUniqueDates.size,
          uniqueLocations: summaryUniqueLocations.size,
          dateRange: { start: summaryMinDate, end: summaryMaxDate },
        },
      });
    }

    return enhancedEvents;
  };

  const getParkingPassPublicFeed = async (feedBuilder: () => Promise<any[]>) => {
    if (parkingPassPublicFeedBuildInFlight) {
      return parkingPassPublicFeedBuildInFlight;
    }
    parkingPassPublicFeedBuildInFlight = feedBuilder().finally(() => {
      parkingPassPublicFeedBuildInFlight = null;
    });
    return parkingPassPublicFeedBuildInFlight;
  };
  // Get all upcoming events (public)
  // ── Open event coordinator requests (visible to food trucks) ─────────────
  app.get("/api/events/open-requests", isAuthenticated, async (req: any, res) => {
    try {
      const openRequests = await db
        .select()
        .from(claims)
        .where(
          and(
            eq(claims.claimType, "event"),
            eq(claims.status, "provisional"),
          ),
        )
        .orderBy(desc(claims.createdAt));

      res.json(openRequests);
    } catch (error: any) {
      console.error("Error fetching open event requests:", error);
      res.json([]);
    }
  });

  // Public alias used by the Scout page (/scout)
  app.get("/api/events/public", async (req: any, res) => {
    try {
      const upcomingEvents = await loadPublicEventFeed();
      const publicEvents = await buildAnonymousPublicEventFeed(
        upcomingEvents,
        publicEventNow(),
      );
      res.json(
        toPublicEventListingArray(publicEvents),
      );
    } catch (error: any) {
      console.error("Error fetching public events:", error);
      return sendPublicEventFeedUnavailable(res);
    }
  });

  app.get("/api/events/upcoming", async (req: any, res) => {
    try {
      const upcomingEvents = await loadPublicEventFeed();
      const publicEvents = await buildAnonymousPublicEventFeed(
        upcomingEvents,
        publicEventNow(),
      );
      res.json(
        toPublicEventListingArray(publicEvents),
      );
    } catch (error: any) {
      console.error("Error fetching upcoming events:", error);
      return sendPublicEventFeedUnavailable(res);
    }
  });

  // Truck Discovery (authenticated)
  app.get("/api/events", isAuthenticated, async (req: any, res) => {
    try {
      const hasAccess = await hasCompleteProfileAccess(req.user.id);
      if (!hasAccess) {
        return res.status(402).json({
          message: "Profile access could not be verified for event tools.",
        });
      }

      const hostIdFilter = String(req.query?.hostId || "").trim();
      const upcomingEvents = await storage.getAllUpcomingEvents();
      let filtered = Array.isArray(upcomingEvents) ? upcomingEvents : [];
      if (hostIdFilter) {
        const requestedHost = await storage.getHost(hostIdFilter);
        if (!requestedHost) {
          return res.status(404).json({ message: "Host not found" });
        }
        const role = String(req.user?.userType || req.user?.role || "")
          .trim()
          .toLowerCase();
        const canInspectAnyHost = [
          "staff",
          "admin",
          "duper_admin",
          "super_admin",
        ].includes(role);
        if (
          !canInspectAnyHost &&
          String(requestedHost.userId || "") !== String(req.user.id || "")
        ) {
          return res.status(403).json({ message: "Not authorized" });
        }
        filtered = filtered.filter(
          (event: any) => String(event?.hostId || "") === hostIdFilter,
        );
      } else {
        filtered = filtered.filter(
          (event: any) => !Boolean(event?.requiresPayment),
        );
        return res.json(
          toPublicEventListingArray(
            await attachConfirmedPublicEventTrucks(filtered),
          ),
        );
      }
      res.json(filtered);
    } catch (error: any) {
      console.error("Error fetching all events:", error);
      res.json([]);
    }
  });

  // Parking Pass listings (truck-paid slots only)
  app.get(
    "/api/parking-pass",
    parkingPassFeedLimiter,
    async (req: any, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const feedBuilder =
          dependencies.parkingPassFeedBuilder ?? buildParkingPassPublicFeed;
        const enhancedEvents = sanitizeParkingPassPublicFeedRows(
          await enforcePublicHostOwnerAuthority(
            await getParkingPassPublicFeed(feedBuilder),
          ),
        );
        const publicEvents = toPublicParkingPassListingArray(enhancedEvents);
        res.json(publicEvents.map(redactParkingPassEventForGuest));
      } catch (error: any) {
        console.error("Error fetching parking pass listings:", error);
        res.status(503).json({ message: "Parking Pass listings unavailable" });
      }
    },
  );

  // Lead-magnet feed (Pensacola): a login is not authority to reveal a host.
  app.get("/api/public/pensacola/parking-pass-leads", async (req: any, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");

      const feed = toPublicParkingPassListingArray(
        sanitizeParkingPassPublicFeedRows(
          await enforcePublicHostOwnerAuthority(
            await getParkingPassPublicFeed(buildParkingPassPublicFeed),
          ),
        ),
      );

      const pensacolaEvents = (Array.isArray(feed) ? feed : []).filter(
        (row: any) => {
          const host = row?.host || {};
          const city = host.city ?? row?.hostCity ?? row?.city;
          const state = host.state ?? row?.hostState ?? row?.state;
          return (
            isPensacola(city) &&
            isFlorida(state)
          );
        },
      );

      // One card per host location: pick the soonest upcoming occurrence per host.
      const byHost = new Map<string, any>();
      for (const publicRow of pensacolaEvents) {
        const row: any = publicRow;
        const hostId = String(row?.host?.id || "").trim();
        if (!hostId) continue;
        const existing = byHost.get(hostId);
        if (!existing) {
          byHost.set(hostId, row);
          continue;
        }
        const existingDate = new Date(existing?.date || 0).getTime();
        const nextDate = new Date(row?.date || 0).getTime();
        if (
          Number.isFinite(nextDate) &&
          nextDate > 0 &&
          nextDate < existingDate
        ) {
          byHost.set(hostId, row);
        }
      }

      const limitRaw = Number(process.env.PENSACOLA_LEAD_LOCATIONS_LIMIT ?? 20);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(limitRaw, 200))
        : 20;

      const listings = Array.from(byHost.values())
        .slice(0, limit)
        .map((row: any) => {
          const host = row?.host || {};
          const teaserId = toTeaserId(
            String(row?.id || host?.id || JSON.stringify(row || {})),
          );
          const city = String(
            host.city || row?.hostCity || row?.city || "Pensacola",
          );
          const state = normalizeUsStateAbbr(
            String(host.state || row?.hostState || row?.state || "FL"),
          );
          const startingAtCents = minStartingPriceCents(row);
          const rowTimeZone = resolveCityTimeZoneSync({
            city: host.city || row?.hostCity || row?.city,
            state: host.state || row?.hostState || row?.state,
          });
          const nextDate = row?.date
            ? dateKeyInZone(new Date(row.date), rowTimeZone)
            : null;

          const lat = host.latitude ?? row?.hostLatitude ?? row?.latitude;
          const lng = host.longitude ?? row?.hostLongitude ?? row?.longitude;

          return {
            teaserId,
            locked: true,
            city,
            state,
            latitude: roundCoord(lat, 2),
            longitude: roundCoord(lng, 2),
            startingAtCents,
            nextDate,
          };
        });

      res.json({
        city: "Pensacola",
        state: "FL",
        totalLocations: byHost.size,
        locked: true,
        listings,
      });
    } catch (error) {
      console.error("[pensacola-leads] Error building lead feed:", error);
      res.json({
        city: "Pensacola",
        state: "FL",
        totalLocations: 0,
        locked: true,
        listings: [],
      });
    }
  });

  // Public event detail (crawler-friendly JSON for /event/:slug pages).
  app.get("/api/public/events/:eventId", async (req: any, res) => {
    try {
      const eventId = String(req.params.eventId || "").trim();
      if (!eventId)
        return res.status(400).json({ message: "eventId required" });

      const row = await loadPublicEventDetail(eventId);

      if (!row) return res.status(404).json({ message: "Event not found" });
      const hostOwner = await storage.getUser(row.hostUserId);
      if (!hostOwner || hostOwner.isDisabled !== false) {
        return res.status(404).json({ message: "Event not found" });
      }
      const { showAddress: showHostAddress } = resolvePublicProfileVisibility(
        hostOwner.publicProfileSettings,
      );
      const confirmedTrucks = filterPublicConfirmedEventTrucks(
        (await loadConfirmedEventTrucks([eventId])).get(eventId) || [],
      );
      const primaryTruck = confirmedTrucks[0] || null;

      const toSlug = (value: string | null | undefined) =>
        String(value || "")
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)+/g, "")
          .slice(0, 80);

      const baseUrl = resolvePublicCanonicalOrigin({
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
        serviceUrl: process.env.SERVICE_URL,
      });

      const title =
        row.name ||
        `${row.hostName || "Host"} ${row.eventType === "parking_pass" ? "Parking Pass" : "Event"}`;
      const slug = `${toSlug(title) || row.id}--${row.id}`;
      const canonicalUrl = `${baseUrl}/event/${encodeURIComponent(slug)}`;

      const timeZone = await resolveCityTimeZone({
        city: row.hostCity,
        state: row.hostState,
      });
      const dt = buildSlotDateTimes({
        timeZone,
        date: new Date(row.date as any),
        startTime: String(row.startTime || ""),
        endTime: String(row.endTime || ""),
      });

      const now = publicEventNow();
      const lastConfirmedAtUtc = new Date(
        primaryTruck?.bookingConfirmedAt ||
          row.lastConfirmedAt ||
          row.updatedAt ||
          row.date ||
          Date.now(),
      );
      const slot: PublicSlot | null = dt
        ? {
            source: "parking_pass_booking",
            status: primaryTruck ? "confirmed" : "tentative",
            startsAtUtc: dt.startUtc,
            endsAtUtc: dt.endUtc,
            lastConfirmedAtUtc,
          }
        : null;
      const gateOk = slot
        ? isSlotPublic({
            slot,
            now,
            ...(primaryTruck ? { ttlHours: 24 * 365 * 100 } : {}),
          })
        : false;
      const ended = dt ? dt.endUtc.getTime() < now.getTime() : false;
      const paidSlotIsBookable = Boolean(
        dt &&
          Number.isFinite(dt.startUtc.getTime()) &&
          Number.isFinite(dt.endUtc.getTime()) &&
          dt.startUtc.getTime() >= now.getTime(),
      );
      const hasPublicIdentity =
        isPublicDiscoveryEligibleEntity({ name: row.name, isActive: true }) &&
        isPublicDiscoveryEligibleEntity({
          name: row.hostName,
          isActive: true,
        });
      const anonymousDetailAllowed =
        hasPublicIdentity &&
        canExposeAnonymousEventDetail({
          eventType: row.eventType,
          requiresPayment: row.requiresPayment,
          status: row.status,
          slotIsPublic: gateOk,
        });
      const requestedTruckId = String(req.query?.truckId || "").trim();
      let authorizedPaidDetail = false;
      if (
        !anonymousDetailAllowed &&
        hasPublicIdentity &&
        requestedTruckId &&
        req.isAuthenticated?.() &&
        req.user?.id &&
        canExposeAuthorizedPaidEventDetail({
          eventType: row.eventType,
          requiresPayment: row.requiresPayment,
          status: row.status,
          slotIsBookable: paidSlotIsBookable,
        })
      ) {
        const hasParkingPassAccess = await storage.verifyRestaurantOwnership(
          requestedTruckId,
          String(req.user.id),
          "manageParkingPass",
        );
        if (hasParkingPassAccess) {
          const requestedTruck = await storage.getRestaurant(requestedTruckId);
          authorizedPaidDetail = Boolean(
            requestedTruck &&
              assessParkingPassTruckEligibility({
                user: req.user,
                truck: requestedTruck,
                now,
              }).isTruckProfile,
          );
        }
      }
      if (!anonymousDetailAllowed && !authorizedPaidDetail) {
        res.setHeader("Cache-Control", "private, no-store");
        return res.status(404).json({ message: "Event not found" });
      }

      const hostSlug = `${toSlug(row.hostName) || row.hostId}--${row.hostId}`;
      const hostPath = `/location/${encodeURIComponent(hostSlug)}`;
      const publicTrucks = confirmedTrucks.map((truck) => ({
        id: truck.truckId,
        name: truck.name,
        cuisineType: truck.cuisineType,
        city: truck.city,
        state: truck.state,
        path: `/truck/${encodeURIComponent(
          `${toSlug(truck.name) || truck.truckId}--${truck.truckId}`,
        )}`,
      }));

      res.setHeader("Cache-Control", "no-store");
      res.json({
        id: row.id,
        title,
        description: row.description || null,
        date: row.date ? new Date(row.date as any).toISOString() : null,
        startTime: row.startTime,
        endTime: row.endTime,
        timeZone,
        startsAtUtc: dt ? dt.startUtc.toISOString() : null,
        endsAtUtc: dt ? dt.endUtc.toISOString() : null,
        lastConfirmedAtUtc: lastConfirmedAtUtc.toISOString(),
        isPublic: anonymousDetailAllowed,
        ended,
        noIndex: authorizedPaidDetail || ended || !gateOk,
        status: row.status,
        maxTrucks: row.maxTrucks,
        eventType: row.eventType,
        requiresPayment: row.requiresPayment ?? false,
        hostPriceCents: row.hostPriceCents ?? null,
        host: {
          id: row.hostId,
          name: row.hostName,
          address: showHostAddress ? row.hostAddress : null,
          city: row.hostCity,
          state: row.hostState,
          latitude: showHostAddress ? row.hostLatitude : null,
          longitude: showHostAddress ? row.hostLongitude : null,
          path: hostPath,
        },
        truck: publicTrucks[0] || null,
        trucks: publicTrucks,
        canonicalUrl,
      });
    } catch (error: any) {
      console.error("[public-event] error:", error);
      return sendPublicEventFeedUnavailable(res);
    }
  });

  // Pensacola Report lead magnet: email capture -> send PDF link
  const reportBurstLimiter = distributedRateLimit({
    scope: "pensacola-report:burst",
    limit: 5,
    windowMs: 5 * 60 * 1000,
    key: (req) => {
      const ua = String(req.get("User-Agent") || "").slice(0, 80);
      return `${req.ip}:${ua}`;
    },
  });
  const reportDailyLimiter = distributedRateLimit({
    scope: "pensacola-report:day",
    limit: 30,
    windowMs: 24 * 60 * 60 * 1000,
  });
  const reportEmailLimiter = distributedRateLimit({
    scope: "pensacola-report:email",
    limit: 3,
    windowMs: 60 * 60 * 1000,
    key: (req) => {
      const email = String((req as any).body?.email || "")
        .trim()
        .toLowerCase();
      return email || String(req.ip || "unknown");
    },
  });

  app.post(
    "/api/public/pensacola/report/request",
    reportBurstLimiter,
    reportDailyLimiter,
    reportEmailLimiter,
    async (req: any, res) => {
      try {
        const parsed = requestReportSchema.parse(req.body);
        const result = await handleReportRequest({
          email: parsed.email,
          firstName: parsed.firstName || null,
          ip: String(req.ip || ""),
          userAgent: String(req.get("User-Agent") || ""),
        });

        if (!result.ok && result.code === "disabled") {
          return res
            .status(503)
            .json({ ok: false, message: "Report is temporarily unavailable." });
        }

        return res.json({
          ok: true,
          leadId: (result as any).leadId,
          emailed: (result as any).emailed ?? false,
          downloadUrl: (result as any).downloadUrl ?? null,
        });
      } catch (error: any) {
        if (error?.name === "ZodError") {
          return res
            .status(400)
            .json({ ok: false, message: "Valid email is required." });
        }
        console.error("[pensacola-report] request failed:", error);
        return res
          .status(500)
          .json({ ok: false, message: "Unable to send report right now." });
      }
    },
  );

  // Pensacola Report download: serve PDF by token (no auth required)
  app.get("/api/public/pensacola/report/download", async (req: any, res) => {
    try {
      const token = String(req.query?.token || "").trim();
      if (!token) {
        return res.status(400).send("Missing token");
      }

      const result = await renderReportPdfForToken(token);
      if (!result.ok) {
        return res.status(400).send("Invalid or expired link");
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="pensacola-food-truck-report.pdf"',
      );
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(result.pdf);
    } catch (error) {
      console.error("[pensacola-report] download failed:", error);
      return res.status(500).send("Unable to generate report");
    }
  });

  // Lightweight helper for map gating: which hosts have public-ready (priced) parking pass listings?
  // This endpoint intentionally avoids booking lookups/geocoding so maps can load quickly.
  app.get(
    "/api/parking-pass/host-ids",
    parkingPassBookabilityLimiter,
    async (_req: any, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");

        // Prefer the simple model: host pricing fields are the source of truth.
        // If host pricing columns are not present (older DB) this will naturally return [] and we'll fall back below.
        const hostPricingIds = new Set<string>();
        try {
          const allHosts = await enforcePublicHostOwnerAuthority(
            await storage.getAllHosts(),
          );
          const publishedSeriesHostIds = new Set(
            (await storage.getParkingPassSeriesSafe().catch(() => []))
              .filter(
                (series: any) =>
                  normalizeParkingStatus(series?.status) === "published",
              )
              .map((series: any) => String(series?.hostId || "").trim())
              .filter(Boolean),
          );
          for (const host of allHosts as any[]) {
            const hostId = String(host?.id || "").trim();
            if (!hostId) continue;
            if (!publishedSeriesHostIds.has(hostId)) {
              continue;
            }
            const hostStatus = normalizeParkingStatus(host?.status || "");
            if (hostStatus && unavailableParkingStatuses.has(hostStatus)) continue;
            if (host?.deletedAt || host?.archivedAt || host?.cancelledAt) continue;
            if (
              !isHostProfileMapEligible({
                businessName: host?.businessName,
                address: host?.address,
                city: host?.city,
                state: host?.state,
              })
            ) {
              continue;
            }

            const listing = {
              host,
              startTime:
                String(host?.parkingPassStartTime || "").trim() ||
                PARKING_PASS_MEAL_WINDOWS.breakfast.start,
              endTime:
                String(host?.parkingPassEndTime || "").trim() ||
                PARKING_PASS_MEAL_WINDOWS.dinner.end,
              maxTrucks: host?.spotCount ?? 1,
              breakfastPriceCents: host?.parkingPassBreakfastPriceCents,
              lunchPriceCents: host?.parkingPassLunchPriceCents,
              dinnerPriceCents: host?.parkingPassDinnerPriceCents,
              dailyPriceCents: host?.parkingPassDailyPriceCents,
              weeklyPriceCents: host?.parkingPassWeeklyPriceCents,
              monthlyPriceCents: host?.parkingPassMonthlyPriceCents,
            };
            if (!isParkingPassPublicReady(listing as any)) continue;
            hostPricingIds.add(hostId);
          }
        } catch (error) {
          console.warn(
            "parking-pass/host-ids host-pricing fast path failed:",
            error,
          );
        }

        if (hostPricingIds.size > 0) {
          const payload = {
            generatedAt: new Date().toISOString(),
            hostIds: Array.from(hostPricingIds),
          };
          return res.json(payload);
        }

        // Bookable = host has a public-ready Parking Pass series (address + pricing + valid window/spots).
        // Coordinates are best-effort and do not block bookability.
        const rows = await db
          .select({
            host: hosts,
            series: eventSeries,
            isDisabled: users.isDisabled,
            publicProfileSettings: users.publicProfileSettings,
          })
          .from(eventSeries)
          .innerJoin(hosts, eq(hosts.id, eventSeries.hostId))
          .innerJoin(users, eq(hosts.userId, users.id))
          .where(
            and(
              eq(eventSeries.seriesType, "parking_pass"),
              eq(users.isDisabled, false),
            ),
          );

        const hostIds = new Set<string>();
        rows.forEach((row: any) => {
          const hostId = String(row?.host?.id || "").trim();
          if (!hostId) return;
          if (
            row?.isDisabled !== false ||
            !resolvePublicProfileVisibility(row?.publicProfileSettings)
              .showAddress
          ) {
            return;
          }
          const seriesStatus = normalizeParkingStatus(row?.series?.status || "");
          const hostStatus = normalizeParkingStatus(row?.host?.status || "");
          if (seriesStatus !== "published") return;
          if (hostStatus && unavailableParkingStatuses.has(hostStatus)) return;
          if (row?.host?.deletedAt || row?.host?.archivedAt || row?.host?.cancelledAt) return;
          if (
            !isHostProfileMapEligible({
              businessName: row?.host?.businessName,
              address: row?.host?.address,
              city: row?.host?.city,
              state: row?.host?.state,
            })
          ) {
            return;
          }

          const publicReady = isParkingPassPublicReady({
            host: row.host,
            startTime: row?.series?.defaultStartTime,
            endTime: row?.series?.defaultEndTime,
            maxTrucks: row?.series?.defaultMaxTrucks,
            breakfastPriceCents: row?.series?.defaultBreakfastPriceCents,
            lunchPriceCents: row?.series?.defaultLunchPriceCents,
            dinnerPriceCents: row?.series?.defaultDinnerPriceCents,
            dailyPriceCents: row?.series?.defaultDailyPriceCents,
            weeklyPriceCents: row?.series?.defaultWeeklyPriceCents,
            monthlyPriceCents: row?.series?.defaultMonthlyPriceCents,
          });
          if (!publicReady) return;

          hostIds.add(hostId);
        });

        const payload = {
          generatedAt: new Date().toISOString(),
          hostIds: Array.from(hostIds),
        };
        res.json(payload);
      } catch (error: any) {
        console.error("Error fetching parking pass host ids:", error);
        res
          .status(200)
          .json({ generatedAt: new Date().toISOString(), hostIds: [] });
      }
    },
  );

  const normalizeDateKey = (value: unknown) =>
    dateKeyFromUnknown(value, "America/Chicago") ||
    dateKeyInZone(new Date(), "America/Chicago");

  const buildParkingPassHostStatusPayload = async (dateKey: string) => {
    const eventDateKey = (event: any) => {
      const tz = resolveCityTimeZoneSync({
        city: event?.host?.city || event?.hostCity || event?.city,
        state: event?.host?.state || event?.hostState || event?.state,
      });
      return dateKeyInZone(new Date(event?.date), tz);
    };
    const isPublicHostProfile = (host: any, event?: any) =>
      isHostProfileMapEligible({
        businessName: host?.businessName || event?.host?.businessName,
        address: host?.address || event?.hostAddress || event?.address,
        city: host?.city || event?.hostCity || event?.city,
        state: host?.state || event?.hostState || event?.state,
      });
    const { occurrences: rawOccurrences } = await listParkingPassOccurrences({
      horizonDays: 30,
      includeDraft: false,
    });
    const occurrences = await enforcePublicHostOwnerAuthority(rawOccurrences);
    const virtualEvents = occurrences.filter((event: any) => {
      if (!isParkingPassPublicReady(event)) return false;
      if (!isPublicHostProfile(event?.host, event)) return false;
      const eventDate = eventDateKey(event);
      return eventDate === dateKey;
    });

    const publishedParkingPassSeriesIds = new Set(
      (await storage.getParkingPassSeriesSafe().catch(() => []))
        .filter(
          (series: any) =>
            normalizeParkingStatus(series?.status) === "published",
        )
        .map((series: any) => String(series?.id || "").trim())
        .filter(Boolean),
    );
    const legacyUpcoming = await enforcePublicHostOwnerAuthority(
      await storage.getAllUpcomingEvents(),
    );
    const legacyEvents = legacyUpcoming.filter((event: any) => {
      if (event?.eventType !== "parking_pass") return false;
      if (
        event?.seriesId &&
        !publishedParkingPassSeriesIds.has(String(event.seriesId))
      ) {
        return false;
      }
      if (!isParkingPassFeedCandidate(event)) return false;
      if (!isParkingPassPublicReady(event)) return false;
      if (!isPublicHostProfile(event?.host, event)) return false;
      const eventDate = eventDateKey(event);
      return eventDate === dateKey;
    });

    const dedupedById = new Map<string, any>();
    for (const item of [...virtualEvents, ...legacyEvents]) {
      dedupedById.set(String(item.id), item);
    }
    const events = Array.from(dedupedById.values());
    const eventIds = events.map((event) => String(event.id));

    const bookingCounts =
      eventIds.length > 0
        ? await db
            .select({
              eventId: eventBookings.eventId,
              status: eventBookings.status,
              count: sql<number>`count(*)`,
            })
            .from(eventBookings)
            .where(inArray(eventBookings.eventId, eventIds))
            .where(inArray(eventBookings.status, ["confirmed", "pending"]))
            .groupBy(eventBookings.eventId, eventBookings.status)
        : [];

    const countsByEvent = new Map<
      string,
      { confirmed: number; pending: number }
    >();
    for (const row of bookingCounts) {
      const prev = countsByEvent.get(row.eventId) || {
        confirmed: 0,
        pending: 0,
      };
      if (row.status === "confirmed") prev.confirmed = Number(row.count || 0);
      if (row.status === "pending") prev.pending = Number(row.count || 0);
      countsByEvent.set(row.eventId, prev);
    }

    const byHost = new Map<
      string,
      { availableCount: number; spotCount: number; reservedCount: number }
    >();

    for (const event of events) {
      const hostId = String(event?.hostId ?? event?.host?.id ?? "").trim();
      if (!hostId) continue;
      const maxSpots = Number(event?.maxTrucks ?? 1) || 1;
      const counts = countsByEvent.get(String(event.id)) || {
        confirmed: 0,
        pending: 0,
      };
      const hardCapEnabled = Boolean(event?.hardCapEnabled);
      const reservedRaw = Number(counts.confirmed) + Number(counts.pending);
      const reservedCount = hardCapEnabled
        ? Math.min(maxSpots, reservedRaw)
        : reservedRaw;
      const availableCount = hardCapEnabled
        ? Math.max(0, maxSpots - reservedCount)
        : maxSpots;

      const prev = byHost.get(hostId) || {
        availableCount: 0,
        spotCount: 0,
        reservedCount: 0,
      };
      byHost.set(hostId, {
        availableCount: prev.availableCount + availableCount,
        spotCount: prev.spotCount + maxSpots,
        reservedCount: prev.reservedCount + reservedCount,
      });
    }

    const hosts = Array.from(byHost.entries()).map(([hostId, totals]) => ({
      hostId,
      availableCount: totals.availableCount,
      spotCount: totals.spotCount,
      reservedCount: totals.reservedCount,
      isFull: totals.availableCount <= 0,
    }));

    return {
      generatedAt: new Date().toISOString(),
      date: dateKey,
      hosts,
    };
  };

  app.get(
    "/api/parking-pass/host-status",
    parkingPassBookabilityLimiter,
    async (req: any, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const dateKey = normalizeDateKey(req.query?.date);

        const payload = await buildParkingPassHostStatusPayload(dateKey);
        res.json(payload);
      } catch (error: any) {
        console.error("Error fetching parking pass host status:", error);
        const dateKey = normalizeDateKey(req.query?.date);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "60");
        res.status(503).json({
          generatedAt: new Date().toISOString(),
          date: dateKey,
          hosts: [],
          message: "Parking Pass availability is temporarily unavailable",
        });
      }
    },
  );

  app.get(
    "/api/admin/parking-pass/host-status",
    isAuthenticated,
    isStaffOrAdmin,
    async (req: any, res) => {
      const dateKey = normalizeDateKey(req.query?.date);
      try {
        const payload = await buildParkingPassHostStatusPayload(dateKey);

        // Attach quality flags (staff/admin only) so map popups can show "needs fixes".
        const flagsByHost = new Map<string, Set<string>>();
        const { occurrences } = await listParkingPassOccurrences({
          horizonDays: 30,
          includeDraft: true,
        });
        occurrences.forEach((event: any) => {
          const hostId = String(event?.hostId ?? event?.host?.id ?? "").trim();
          const eventDate = dateKeyInZone(
            new Date(event?.date),
            resolveCityTimeZoneSync({
              city: event?.host?.city || event?.hostCity || event?.city,
              state: event?.host?.state || event?.hostState || event?.state,
            }),
          );
          if (!hostId || eventDate !== dateKey) return;
          const flags = computeParkingPassQualityFlags(event);
          const set = flagsByHost.get(hostId) || new Set<string>();
          flags.forEach((flag) => set.add(flag));
          flagsByHost.set(hostId, set);
        });

        const hosts = payload.hosts.map((host) => ({
          ...host,
          qualityFlags: Array.from(flagsByHost.get(host.hostId) || []),
        }));

        res.json({ ...payload, hosts });
      } catch (error: any) {
        console.error("Error fetching admin parking pass host status:", error);
        try {
          // Graceful fallback: keep map usable for staff/admin even if
          // quality-flag enrichment fails.
          const payload = await buildParkingPassHostStatusPayload(dateKey);
          res.setHeader("X-MealScout-Stale", "1");
          return res.status(200).json({
            ...payload,
            hosts: payload.hosts.map((host) => ({ ...host, qualityFlags: [] })),
          });
        } catch (fallbackError: any) {
          console.error(
            "Error building fallback admin parking pass host status:",
            fallbackError,
          );
          res.setHeader("X-MealScout-Stale", "1");
          return res.status(200).json({
            generatedAt: new Date().toISOString(),
            date: dateKey,
            hosts: [],
          });
        }
      }
    },
  );

  app.post(
    "/api/admin/parking-pass/cache/clear",
    isAuthenticated,
    isStaffOrAdmin,
    async (_req: any, res) => {
      res.json({ success: true, cache: "disabled" });
    },
  );

  app.get(
    "/api/admin/parking-pass/fix-queue",
    isAuthenticated,
    isStaffOrAdmin,
    async (_req: any, res) => {
      try {
        const seriesRows = await storage.getParkingPassSeriesSafe();
        const hostIds = Array.from(
          new Set<string>(
            seriesRows
              .map((row) => String(row.hostId || "").trim())
              .filter(Boolean),
          ),
        );
        const hostRows = await storage.getHostsByIds(hostIds);
        const hostById = new Map<string, any>(
          (hostRows || []).map((host: any) => [host.id, host]),
        );

        const items = seriesRows.map((series: any) => {
          const hostId = String(series.hostId || "").trim();
          const host = hostById.get(hostId) ?? null;
          const platformPaymentsEnabled = Boolean(
            process.env.STRIPE_SECRET_KEY,
          );
          const listing = {
            host,
            startTime: series.defaultStartTime,
            endTime: series.defaultEndTime,
            maxTrucks: series.defaultMaxTrucks,
            breakfastPriceCents: series.defaultBreakfastPriceCents,
            lunchPriceCents: series.defaultLunchPriceCents,
            dinnerPriceCents: series.defaultDinnerPriceCents,
            dailyPriceCents: series.defaultDailyPriceCents,
            weeklyPriceCents: series.defaultWeeklyPriceCents,
            monthlyPriceCents: series.defaultMonthlyPriceCents,
          };
          const qualityFlags = computeParkingPassQualityFlags(listing);
          const publicReady = isParkingPassPublicReady(listing);

          return {
            seriesId: series.id,
            seriesStatus: series.status ?? null,
            hostId: host?.id ?? hostId,
            hostUserId: host?.userId ?? null,
            businessName: host?.businessName ?? null,
            address: host?.address ?? null,
            city: host?.city ?? null,
            state: host?.state ?? null,
            paymentsEnabled: platformPaymentsEnabled,
            publicReady,
            qualityFlags,
            hasSpotPhoto: Boolean((host as any)?.spotImageUrl),
          };
        });

        items.sort((a: any, b: any) => {
          const aScore = (a.publicReady ? 0 : 10) + a.qualityFlags.length;
          const bScore = (b.publicReady ? 0 : 10) + b.qualityFlags.length;
          return bScore - aScore;
        });

        res.json({ rows: items });
      } catch (error: any) {
        console.error("Error building parking pass fix queue:", error);
        res.status(500).json({ message: "Failed to load fix queue" });
      }
    },
  );

  app.get(
    "/api/admin/parking-pass/host-trace",
    isAuthenticated,
    isStaffOrAdmin,
    async (req: any, res) => {
      try {
        const horizonRaw = Number(req.query?.horizonDays ?? 30);
        const horizonDays = Number.isFinite(horizonRaw)
          ? Math.min(90, Math.max(1, Math.floor(horizonRaw)))
          : 30;

        const [hostRows, seriesRows, occurrenceResult, legacyUpcoming] =
          await Promise.all([
            db
              .select({
                id: hosts.id,
                userId: hosts.userId,
                businessName: hosts.businessName,
                address: hosts.address,
                city: hosts.city,
                state: hosts.state,
                latitude: hosts.latitude,
                longitude: hosts.longitude,
                isDisabled: users.isDisabled,
              })
              .from(hosts)
              .leftJoin(users, eq(hosts.userId, users.id)),
            db
              .select({
                id: eventSeries.id,
                hostId: eventSeries.hostId,
                status: eventSeries.status,
                updatedAt: eventSeries.updatedAt,
              })
              .from(eventSeries)
              .where(eq(eventSeries.seriesType, "parking_pass")),
            listParkingPassOccurrences({ horizonDays, includeDraft: true }),
            storage.getAllUpcomingEvents(),
          ]);

        const parseCoord = (value?: string | number | null) => {
          if (value === null || value === undefined) return null;
          const parsed = typeof value === "string" ? Number(value) : value;
          return Number.isFinite(parsed) ? parsed : null;
        };

        const hostById = new Map<string, (typeof hostRows)[number]>();
        hostRows.forEach((host: any) => {
          hostById.set(String(host.id), host);
        });

        const seriesByHost = new Map<
          string,
          {
            total: number;
            published: number;
            draft: number;
            latestUpdatedAt: string | null;
          }
        >();
        seriesRows.forEach((series: any) => {
          const hostId = String(series.hostId || "").trim();
          if (!hostId) return;
          const prev = seriesByHost.get(hostId) || {
            total: 0,
            published: 0,
            draft: 0,
            latestUpdatedAt: null,
          };
          prev.total += 1;
          if (String(series.status || "").toLowerCase() === "published") {
            prev.published += 1;
          }
          if (String(series.status || "").toLowerCase() === "draft") {
            prev.draft += 1;
          }
          const updatedAt = series.updatedAt
            ? new Date(series.updatedAt)
            : null;
          const prevUpdatedAt = prev.latestUpdatedAt
            ? new Date(prev.latestUpdatedAt)
            : null;
          if (
            updatedAt &&
            (!prevUpdatedAt || updatedAt.getTime() > prevUpdatedAt.getTime())
          ) {
            prev.latestUpdatedAt = updatedAt.toISOString();
          }
          seriesByHost.set(hostId, prev);
        });

        const occurrenceByHost = new Map<
          string,
          {
            total: number;
            publicReady: number;
            qualityFlags: Set<string>;
            nextDate: string | null;
          }
        >();
        occurrenceResult.occurrences.forEach((event: any) => {
          const hostId = String(event?.hostId ?? event?.host?.id ?? "").trim();
          if (!hostId) return;
          const prev = occurrenceByHost.get(hostId) || {
            total: 0,
            publicReady: 0,
            qualityFlags: new Set<string>(),
            nextDate: null,
          };
          prev.total += 1;
          const flags = computeParkingPassQualityFlags(event);
          flags.forEach((flag) => prev.qualityFlags.add(flag));
          if (flags.length === 0) {
            prev.publicReady += 1;
          }
          const dateKey = String(event?.date || "").slice(0, 10);
          if (dateKey && (!prev.nextDate || dateKey < prev.nextDate)) {
            prev.nextDate = dateKey;
          }
          occurrenceByHost.set(hostId, prev);
        });

        const legacyByHost = new Map<
          string,
          { total: number; publicReady: number }
        >();
        legacyUpcoming.forEach((event: any) => {
          if (event?.eventType !== "parking_pass") return;
          const hostId = String(event?.hostId ?? event?.host?.id ?? "").trim();
          if (!hostId) return;
          const prev = legacyByHost.get(hostId) || { total: 0, publicReady: 0 };
          prev.total += 1;
          if (isParkingPassPublicReady(event)) {
            prev.publicReady += 1;
          }
          legacyByHost.set(hostId, prev);
        });

        const allHostIds = new Set<string>();
        hostById.forEach((_v, hostId) => allHostIds.add(hostId));
        seriesByHost.forEach((_v, hostId) => allHostIds.add(hostId));
        occurrenceByHost.forEach((_v, hostId) => allHostIds.add(hostId));
        legacyByHost.forEach((_v, hostId) => allHostIds.add(hostId));

        const rows = Array.from(allHostIds)
          .map((hostId) => {
            const host = hostById.get(hostId) || null;
            const series = seriesByHost.get(hostId) || {
              total: 0,
              published: 0,
              draft: 0,
              latestUpdatedAt: null,
            };
            const occurrences = occurrenceByHost.get(hostId) || {
              total: 0,
              publicReady: 0,
              qualityFlags: new Set<string>(),
              nextDate: null,
            };
            const legacy = legacyByHost.get(hostId) || {
              total: 0,
              publicReady: 0,
            };

            const lat = parseCoord(host?.latitude);
            const lng = parseCoord(host?.longitude);
            const hasCoords =
              lat !== null &&
              lng !== null &&
              Math.abs(lat) <= 90 &&
              Math.abs(lng) <= 180;
            const hasAddress = Boolean(String(host?.address || "").trim());
            const isDisabled = Boolean(host?.isDisabled);
            const hostQualityFlags = computeHostProfileQualityFlags({
              businessName: host?.businessName,
              address: host?.address,
              city: host?.city,
              state: host?.state,
            });

            const reasons: string[] = [];
            if (!host) reasons.push("missing_host_profile");
            if (isDisabled) reasons.push("user_disabled");
            if (!hasAddress) reasons.push("missing_address");
            hostQualityFlags.forEach((flag) => reasons.push(`quality:${flag}`));
            if (!hasCoords) reasons.push("missing_coords");
            if (series.total === 0) reasons.push("no_parking_pass_series");
            if (occurrences.publicReady === 0 && legacy.publicReady === 0) {
              reasons.push("no_public_ready_parking_pass");
            }
            occurrences.qualityFlags.forEach((flag) =>
              reasons.push(`quality:${flag}`),
            );

            const mapFeedCandidate = Boolean(
              host &&
              !isDisabled &&
              hasAddress &&
              hostQualityFlags.length === 0,
            );
            const parkingPassFeedVisible =
              occurrences.publicReady > 0 || legacy.publicReady > 0;

            return {
              hostId,
              businessName: host?.businessName || null,
              city: host?.city || null,
              state: host?.state || null,
              isDisabled,
              hasAddress,
              hasCoords,
              mapFeedCandidate,
              parkingPass: {
                seriesTotal: series.total,
                seriesPublished: series.published,
                seriesDraft: series.draft,
                latestSeriesUpdatedAt: series.latestUpdatedAt,
                occurrencesTotal: occurrences.total,
                occurrencesPublicReady: occurrences.publicReady,
                nextOccurrenceDate: occurrences.nextDate,
                legacyEventsTotal: legacy.total,
                legacyPublicReady: legacy.publicReady,
                visibleInFeed: parkingPassFeedVisible,
              },
              reasons,
            };
          })
          .sort((a, b) => {
            const severityA = a.reasons.length;
            const severityB = b.reasons.length;
            if (severityA !== severityB) return severityB - severityA;
            return String(a.businessName || a.hostId).localeCompare(
              String(b.businessName || b.hostId),
            );
          });

        const summary = {
          hostCount: rows.length,
          mapFeedCandidates: rows.filter((row) => row.mapFeedCandidate).length,
          parkingPassVisible: rows.filter(
            (row) => row.parkingPass.visibleInFeed,
          ).length,
          withBlockingReasons: rows.filter((row) => row.reasons.length > 0)
            .length,
          generatedAt: new Date().toISOString(),
          horizonDays,
        };

        res.json({ summary, rows });
      } catch (error: any) {
        console.error("Error building parking pass host trace:", error);
        res.status(500).json({ message: "Failed to build host trace" });
      }
    },
  );

  app.post(
    "/api/events/:eventId/interests",
    isRestaurantOwner,
    async (req: any, res) => {
      try {
        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message: "Profile access could not be verified for event tools.",
          });
        }

        const { eventId } = req.params;
        const { restaurantId, message } = req.body;

        if (!restaurantId) {
          return res.status(400).json({ message: "Restaurant ID is required" });
        }

        // Verify ownership
        const ownsRestaurant = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageParkingPass",
        );
        if (!ownsRestaurant) {
          return res.status(403).json({
            message: "You can only express interest for restaurants you own",
          });
        }

        // Check event expiry
        const event = await storage.getEvent(eventId);
        if (!event) {
          return res.status(404).json({ message: "Event not found" });
        }

        if (event.requiresPayment) {
          return res.status(400).json({
            message:
              "This listing uses Parking Pass. Events do not accept payments.",
          });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(event.date) < today) {
          return res
            .status(400)
            .json({ message: "Cannot express interest in past events" });
        }

        // Check idempotency
        const existing = await storage.getEventInterestByTruckId(
          eventId,
          restaurantId,
        );
        if (existing) {
          return res.status(200).json({
            message: "Interest already expressed",
            interest: existing,
          });
        }

        const parsed = insertEventInterestSchema.parse({
          eventId,
          truckId: restaurantId,
          message,
        });

        const interest = await storage.createEventInterest(parsed);

        // Send notification to host (fire and forget)
        (async () => {
          try {
            const event = await storage.getEvent(eventId);
            if (event) {
              // Telemetry: Interest Created
              await storage.createTelemetryEvent({
                eventName: "interest_created",
                userId: req.user.id,
                properties: {
                  eventId,
                  truckId: restaurantId,
                  eventDate: event.date,
                },
              });

              const host = await storage.getHost(event.hostId);
              const truck = await storage.getRestaurant(restaurantId);

              if (host && truck) {
                // Get host's user email
                const hostUser = await storage.getUser(host.userId);
                if (hostUser && hostUser.email) {
                  await emailService.sendInterestNotification(
                    hostUser.email,
                    host.businessName,
                    truck.name,
                    new Date(event.date).toLocaleDateString(),
                  );
                }
              }
            }
          } catch (err) {
            console.error("Failed to send interest notification:", err);
          }
        })();

        res.status(201).json({ message: "Interest sent", interest });
      } catch (error: any) {
        console.error("Error creating event interest:", error);
        if (error instanceof z.ZodError) {
          return res
            .status(400)
            .json({ message: "Invalid data", errors: error.errors });
        }
        res.status(500).json({ message: "Failed to submit interest" });
      }
    },
  );

  app.post("/api/events/signup", isAuthenticated, async (req: any, res) => {
    try {
      const schema = z.object({
        eventName: z.string().min(1),
        date: z.string().min(1),
        city: z.string().min(1),
        expectedCrowd: z.string().min(1),
        contactEmail: z.string().email(),
        contactPhone: z.string().optional(),
        notes: z.string().optional(),
      });

      const parsed = schema.parse(req.body);
      let updatedUserType = req.user?.userType;
      if (req.user?.userType === "customer") {
        const updatedUser = await storage.updateUserType(
          req.user.id,
          "event_coordinator",
        );
        updatedUserType = updatedUser.userType;
      }

      const adminEmail =
        process.env.ADMIN_ALERT_EMAIL || "info.mealscout@gmail.com";

      const subject = `New event coordinator request: ${parsed.eventName}`;
      const html = `
        <h2>New event coordinator request</h2>
        <p><strong>Event:</strong> ${parsed.eventName}</p>
        <p><strong>Date:</strong> ${parsed.date}</p>
        <p><strong>City:</strong> ${parsed.city}</p>
        <p><strong>Expected Crowd:</strong> ${parsed.expectedCrowd}</p>
        <p><strong>Contact Email:</strong> ${parsed.contactEmail}</p>
        ${parsed.contactPhone ? `<p><strong>Phone:</strong> ${parsed.contactPhone}</p>` : ""}
        ${parsed.notes ? `<p><strong>Notes:</strong> ${parsed.notes}</p>` : ""}
      `;

      await emailService.sendBasicEmail(adminEmail, subject, html);

      // ── Notify nearby food trucks (fire-and-forget, with opt-out + idempotency) ──
      const claimRecord = await storage.createUnifiedClaim({
        personId: req.user.id,
        claimType: "event",
        status: "provisional",
        claimData: {
          eventName: parsed.eventName,
          date: parsed.date,
          city: parsed.city,
          expectedCrowd: parsed.expectedCrowd,
          notes: parsed.notes,
          contactEmail: parsed.contactEmail,
          contactPhone: parsed.contactPhone,
        },
      });
      notifyNearbyTrucksOfEventRequest({
        id: claimRecord.id,
        eventName: parsed.eventName,
        date: parsed.date,
        city: parsed.city,
        expectedCrowd: parsed.expectedCrowd,
        notes: parsed.notes,
        contactEmail: parsed.contactEmail,
        contactPhone: parsed.contactPhone,
      }).catch((err) =>
        console.error("[EventSignup] Truck notify fire-and-forget error:", err),
      );
      // ─────────────────────────────────────────────────────────────────────

      await storage.createTelemetryEvent({
        eventName: "event_coordinator_request_created",
        userId: req.user.id,
        properties: {
          eventName: parsed.eventName,
          city: parsed.city,
          expectedCrowd: parsed.expectedCrowd,
        },
      });

      res.json({ message: "Request submitted", userType: updatedUserType });
    } catch (error: any) {
      console.error("Error submitting event coordinator request:", error);
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to submit request" });
    }
  });

  // ─── Event Booking & Payment Routes ─────────────────────────────────────────

  /** Legacy event checkout is retired. Slot selection and durable payment
   * recovery belong to the canonical Parking Pass flow. This route creates
   * no booking, event occurrence, or provider operation.
   */
  app.post(
    "/api/events/:eventId/book",
    isAuthenticated,
    (req: any, res) => {
      const params = new URLSearchParams({ pass: String(req.params.eventId) });
      const truckId = String(req.body?.truckId || "").trim();
      if (truckId) params.set("truckId", truckId);
      return res.status(409).json({
        code: "canonical_checkout_required",
        message: "Choose your Parking Pass date and slots before checking out.",
        checkoutPath: `/parking-pass?${params.toString()}`,
      });
    },
  );

  /**
   * POST /api/bookings/:bookingId/confirm
   * Called after Stripe payment succeeds (idempotent).
   * The webhook also handles this; this is for immediate client feedback.
   */
  app.post(
    "/api/bookings/:bookingId/confirm",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { bookingId } = req.params;

        const [booking] = await db
          .select()
          .from(eventBookings)
          .where(eq(eventBookings.id, bookingId))
          .limit(1);
        if (!booking) {
          return res.status(404).json({ message: "Booking not found" });
        }

        // Verify caller owns the truck
        const ownsT = await storage.verifyRestaurantOwnership(
          booking.truckId,
          req.user.id,
          "manageParkingPass",
        );
        if (!ownsT) {
          return res.status(403).json({ message: "Not authorized" });
        }

        if (booking.status === "confirmed") {
          return res.json({ message: "Already confirmed", bookingId });
        }
        if (booking.status === "cancelled" || booking.status === "refunded") {
          return res
            .status(400)
            .json({ message: `Booking is ${booking.status}` });
        }

        if (booking.status !== "pending" || !booking.stripePaymentIntentId) {
          return res.status(409).json({
            code: "booking_reconciliation_required",
            message: "Payment confirmation requires a bound pending booking. Check My Schedule before paying again.",
          });
        }
        if (!stripe) {
          return res.status(503).json({ message: "Could not verify payment" });
        }

        // A legacy receipt can confirm only its exact existing payment binding.
        if (booking.stripePaymentIntentId && stripe) {
          const hostStripeAccountId = booking.stripeTransferDestination;
          let intent: Stripe.PaymentIntent;
          let retrievedStripeAccount: string | null = null;
          try {
            try {
              intent = await stripe.paymentIntents.retrieve(
                booking.stripePaymentIntentId,
              );
            } catch (platformError: any) {
              if (!hostStripeAccountId) throw platformError;
              // Backward compatibility for any older direct-charge booking rows.
              intent = await stripe.paymentIntents.retrieve(
                booking.stripePaymentIntentId,
                { stripeAccount: hostStripeAccountId },
              );
              retrievedStripeAccount = hostStripeAccountId;
            }
          } catch (e: any) {
            console.error("[event-booking] Error retrieving PaymentIntent:", {
              bookingId,
              userId: req.user?.id,
              role: req.user?.userType || req.user?.role || null,
              truckId: booking.truckId,
              eventId: booking.eventId,
              paymentIntentId: booking.stripePaymentIntentId,
              failureReason: e?.message || "payment_intent_retrieve_failed",
            });
            return res
              .status(502)
              .json({ message: "Could not verify payment" });
          }

          if (intent.status !== "succeeded") {
            return res
              .status(402)
              .json({ message: "Payment has not succeeded yet" });
          }
          if (intent.metadata?.bookingRequestKey || intent.metadata?.passId) {
            return res.status(409).json({
              code: "parking_checkout_reconciliation_required",
              message: "Parking Pass confirmation is still being reconciled. Check My Schedule before paying again.",
            });
          }
          if (!isLegacyParkingPaymentBound(booking, intent, retrievedStripeAccount)) {
            return res.status(409).json({
              code: "booking_reconciliation_required",
              message: "Payment could not be matched to this booking.",
            });
          }
        }

        const now = new Date();
        const [confirmedBooking] = await db
          .update(eventBookings)
          .set({
            status: "confirmed",
            stripePaymentStatus: "succeeded",
            paidAt: now,
            bookingConfirmedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(eventBookings.id, bookingId),
              eq(eventBookings.status, "pending"),
              eq(eventBookings.stripePaymentIntentId, booking.stripePaymentIntentId),
              eq(eventBookings.eventId, booking.eventId),
              eq(eventBookings.truckId, booking.truckId),
              eq(eventBookings.hostId, booking.hostId),
              eq(eventBookings.hostPriceCents, booking.hostPriceCents),
              eq(eventBookings.platformFeeCents, booking.platformFeeCents),
              eq(eventBookings.totalCents, booking.totalCents),
              booking.stripeApplicationFeeAmount === null
                ? isNull(eventBookings.stripeApplicationFeeAmount)
                : eq(eventBookings.stripeApplicationFeeAmount, booking.stripeApplicationFeeAmount),
              booking.stripeTransferDestination === null
                ? isNull(eventBookings.stripeTransferDestination)
                : eq(eventBookings.stripeTransferDestination, booking.stripeTransferDestination),
            ),
          )
          .returning({ id: eventBookings.id });
        if (!confirmedBooking) {
          return res.status(409).json({
            code: "booking_reconciliation_required",
            message: "Booking changed during payment confirmation. Check My Schedule before paying again.",
          });
        }

        // Update event status if now full
        const [countRow] = await db
          .select({ count: sql<number>`count(*)` })
          .from(eventBookings)
          .where(
            and(
              eq(eventBookings.eventId, booking.eventId),
              eq(eventBookings.status, "confirmed"),
            ),
          );
        const confirmedCount = Number(countRow?.count ?? 0);

        const [eventRow] = await db
          .select({ maxTrucks: events.maxTrucks })
          .from(events)
          .where(eq(events.id, booking.eventId))
          .limit(1);

        if (eventRow) {
          const newStatus =
            confirmedCount >= (eventRow.maxTrucks ?? 1) ? "filled" : "open";
          await db
            .update(events)
            .set({ status: newStatus, updatedAt: new Date() })
            .where(eq(events.id, booking.eventId));
        }

        res.json({ message: "Booking confirmed", bookingId });
      } catch (error: any) {
        console.error("Error confirming booking:", error);
        res.status(500).json({ message: "Failed to confirm booking" });
      }
    },
  );

  /**
   * POST /api/bookings/:bookingId/cancel
   * Host or truck owner may cancel. No refunds are allowed.
   */
  app.post(
    "/api/bookings/:bookingId/cancel",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { bookingId } = req.params;
        const { reason, refundType } = req.body;

        // Booking policy: no refunds allowed.
        if (refundType && String(refundType).toLowerCase() !== "none") {
          return res.status(400).json({
            message: "Refunds are not allowed for bookings",
          });
        }

        const [booking] = await db
          .select()
          .from(eventBookings)
          .where(eq(eventBookings.id, bookingId))
          .limit(1);
        if (!booking) {
          return res.status(404).json({ message: "Booking not found" });
        }

        // Authorization: truck owner, host, or staff/admin
        const isAdmin = [
          "admin",
          "duper_admin",
          "super_admin",
          "staff",
        ].includes(String(req.user?.userType || ""));
        const ownsTruck = await storage.verifyRestaurantOwnership(
          booking.truckId,
          req.user.id,
          "manageParkingPass",
        );
        const [host] = await db
          .select({ userId: hosts.userId })
          .from(hosts)
          .where(eq(hosts.id, booking.hostId))
          .limit(1);
        const isHost = host?.userId === req.user.id;

        if (!ownsTruck && !isHost && !isAdmin) {
          return res.status(403).json({ message: "Not authorized" });
        }

        if (booking.status === "cancelled" || booking.status === "refunded") {
          return res
            .status(400)
            .json({ message: `Booking already ${booking.status}` });
        }

        const now = new Date();

        await db
          .update(eventBookings)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancellationReason: reason || null,
            refundStatus: "none",
            refundAmountCents: null,
            refundedAt: null,
            updatedAt: now,
          })
          .where(eq(eventBookings.id, bookingId));

        // Reopen the event if it was filled
        const [eventRow] = await db
          .select({ status: events.status, maxTrucks: events.maxTrucks })
          .from(events)
          .where(eq(events.id, booking.eventId))
          .limit(1);
        if (eventRow?.status === "filled") {
          await db
            .update(events)
            .set({ status: "open", updatedAt: new Date() })
            .where(eq(events.id, booking.eventId));
        }

        res.json({
          message: "Booking cancelled",
          bookingId,
          refunded: false,
        });
      } catch (error: any) {
        console.error("Error cancelling booking:", error);
        res.status(500).json({ message: "Failed to cancel booking" });
      }
    },
  );

  /**
   * GET /api/events/:eventId/bookings
   * Returns all bookings for this event (host view).
   */
  app.get(
    "/api/events/:eventId/bookings",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { eventId } = req.params;

        const [event] = await db
          .select({ hostId: events.hostId })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1);
        if (!event) {
          return res.status(404).json({ message: "Event not found" });
        }

        // Check caller is the host owner or staff/admin
        const isAdmin =
          req.user?.role === "admin" || req.user?.role === "staff";
        const [host] = await db
          .select({ userId: hosts.userId })
          .from(hosts)
          .where(eq(hosts.id, event.hostId))
          .limit(1);
        if (!isAdmin && host?.userId !== req.user.id) {
          return res.status(403).json({ message: "Not authorized" });
        }

        const rows = await db
          .select({
            booking: eventBookings,
            truckName: restaurants.name,
            truckOwnerId: restaurants.ownerId,
          })
          .from(eventBookings)
          .leftJoin(restaurants, eq(eventBookings.truckId, restaurants.id))
          .where(eq(eventBookings.eventId, eventId))
          .orderBy(desc(eventBookings.createdAt));

        res.json({ bookings: rows });
      } catch (error: any) {
        console.error("Error fetching event bookings:", error);
        res.status(500).json({ message: "Failed to fetch bookings" });
      }
    },
  );

  /**
   * GET /api/my/bookings?truckId=…
   * Returns all bookings for the authenticated truck owner.
   */
  app.get("/api/my/bookings", isRestaurantOwner, async (req: any, res) => {
    try {
      const { truckId } = req.query;
      if (!truckId) {
        return res
          .status(400)
          .json({ message: "truckId query param required" });
      }

      const ownsT = await storage.verifyRestaurantOwnership(
        String(truckId),
        req.user.id,
        "manageParkingPass",
      );
      if (!ownsT) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const rows = await db
        .select({
          booking: eventBookings,
          eventName: events.name,
          eventDate: events.date,
          eventStartTime: events.startTime,
          eventEndTime: events.endTime,
          hostId: events.hostId,
          hostName: hosts.businessName,
          hostAddress: hosts.address,
          hostCity: hosts.city,
          hostState: hosts.state,
        })
        .from(eventBookings)
        .leftJoin(events, eq(eventBookings.eventId, events.id))
        .leftJoin(hosts, eq(eventBookings.hostId, hosts.id))
        .where(eq(eventBookings.truckId, String(truckId)))
        .orderBy(desc(eventBookings.createdAt));

      res.json({ bookings: rows });
    } catch (error: any) {
      console.error("Error fetching truck bookings:", error);
      res.status(500).json({ message: "Failed to fetch bookings" });
    }
  });
}
