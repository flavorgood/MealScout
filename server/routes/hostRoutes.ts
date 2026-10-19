import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { emailService } from "../emailService";
import { db } from "../db";
import {
  insertHostSchema,
  insertEventSchema,
  events,
  eventSeries,
  hosts,
  restaurants,
  users,
  eventBookings,
  hostPayoutRequests,
  parkingPassBlackoutDates,
  verificationRequests,
} from "@shared/schema";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  sql,
} from "drizzle-orm";
import { isAuthenticated } from "../unifiedAuth";
import Stripe from "stripe";
import {
  upload,
  uploadToCloudinary,
  isCloudinaryConfigured,
} from "../imageUpload";
import {
  getHostByUserId,
  getEventAndHostForUser,
  getInterestEventAndHostForUser,
  userOwnsEvent,
} from "../services/hostOwnership";
import {
  computeAcceptedCount,
  shouldBlockAcceptance,
  buildCapacityFullError,
  computeFillRate,
} from "../services/interestDecision";
import { forwardGeocode } from "../utils/geocoding";
import { validateUsAddress } from "../utils/addressValidation";
import {
  PARKING_PASS_BOOKING_DAYS,
  PARKING_PASS_MEAL_WINDOWS,
  PARKING_PASS_SLOT_TYPES,
  getSlotWindowMinutesWithCleanup,
  isSlotWithinHours,
  slotWindowsOverlap,
} from "@shared/parkingPassSlots";
import {
  buildParkingPassVirtualId,
  ensureParkingPassEventRow,
  listParkingPassOccurrences,
  parseParkingPassVirtualId,
} from "../services/parkingPassVirtual";
import {
  addDaysToDateKey,
  dateKeyFromUnknown,
  dateKeyInZone,
  utcDateFromDateKey,
} from "../services/dateKeys";
import {
  computeParkingPassQualityFlags,
  isParkingPassPublicReady,
} from "../services/parkingPassQuality";
import { imageUploads } from "@shared/schema";
import { logAudit } from "../auditLogger";
import { getHostEarningsSummary } from "../hostEarningsService";
import { resolveCityTimeZoneSync } from "../services/cityTimeZone";
import { requireDurableIdempotencyKey, parkingBookingProviderKey } from "../middleware/durableIdempotency";
import { recordParkingBookingHolds, reconcileParkingBooking } from "../services/parkingBookingRecovery";
import { expireParkingPassHolds } from "../services/parkingHoldExpiry";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { registerHostProfileRoutes } from "./hosts/profileRoutes";
import { registerHostParkingPassRoutes } from "./hosts/eventsRoutes";
import { isStaffOrAdminUserType } from "@shared/profileAccessPolicy";
import { assessParkingPassTruckEligibility } from "../services/parkingPassTruckEligibility";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const getStripePublishableKey = () =>
  String(
    process.env.VITE_STRIPE_PUBLIC_KEY ||
      process.env.STRIPE_PUBLIC_KEY ||
      process.env.STRIPE_PUBLISHABLE_KEY ||
      "",
  ).trim();

export function registerHostRoutes(app: Express) {
  const parkingPassBookingBurstLimiter = distributedRateLimit({
    scope: "parking-pass-booking:burst",
    limit: 12,
    windowMs: 60 * 1000,
  });
  const parkingPassBookingDayLimiter = distributedRateLimit({
    scope: "parking-pass-booking:day",
    limit: 120,
    windowMs: 24 * 60 * 60 * 1000,
  });

  const isStaffOrAdminUser = (user: any) =>
    isStaffOrAdminUserType(user?.userType);

  app.get("/api/payments/stripe-config", (_req, res) => {
    const publishableKey = getStripePublishableKey();
    res.json({
      paymentsReady: Boolean(stripe && publishableKey),
      publishableKey,
    });
  });

  const normalizeLocationValue = (value?: string | null) =>
    (value ?? "").trim().toLowerCase();

  const buildLocationKey = (
    address?: string | null,
    city?: string | null,
    state?: string | null,
  ) =>
    [
      normalizeLocationValue(address),
      normalizeLocationValue(city),
      normalizeLocationValue(state),
    ].join("|");

  const buildGeocodeAddress = (
    address?: string | null,
    city?: string | null,
    state?: string | null,
  ) => [address, city, state, "USA"].filter(Boolean).join(", ");

  const getActiveParkingPassSeriesId = async (hostId: string) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = await db
      .select({
        seriesId: events.seriesId,
        date: events.date,
        breakfastPriceCents: events.breakfastPriceCents,
        lunchPriceCents: events.lunchPriceCents,
        dinnerPriceCents: events.dinnerPriceCents,
        dailyPriceCents: events.dailyPriceCents,
        weeklyPriceCents: events.weeklyPriceCents,
        monthlyPriceCents: events.monthlyPriceCents,
      })
      .from(events)
      .where(
        and(
          eq(events.hostId, hostId),
          eq(events.requiresPayment, true),
          gte(events.date, today),
          isNotNull(events.seriesId),
        ),
      )
      .orderBy(asc(events.date))
      .limit(14);
    const hasActivePricing = (row: (typeof rows)[number]) =>
      (row.breakfastPriceCents ?? 0) > 0 ||
      (row.lunchPriceCents ?? 0) > 0 ||
      (row.dinnerPriceCents ?? 0) > 0 ||
      (row.dailyPriceCents ?? 0) > 0 ||
      (row.weeklyPriceCents ?? 0) > 0 ||
      (row.monthlyPriceCents ?? 0) > 0;
    const activeRow = rows.find((row: (typeof rows)[number]) =>
      hasActivePricing(row),
    );
    return activeRow?.seriesId ?? null;
  };

  const getOwnedHostForRequest = async (req: any) => {
    const userId = String(req.user?.id || "").trim();
    if (!userId) return null;

    const requestedHostId = String(
      req.body?.hostId || req.query?.hostId || "",
    ).trim();
    const ownedHosts = await storage.getHostsByUserId(userId);
    if (!ownedHosts.length) return null;

    if (!requestedHostId) return ownedHosts[0];
    return (
      ownedHosts.find((item: any) => String(item.id) === requestedHostId) ||
      null
    );
  };

  // Register host profile routes (POST /api/hosts, GET /api/hosts/me)
  registerHostProfileRoutes(app);

  // Host Events & Related Endpoints (GET /api/hosts for listing, etc.)
  app.get("/api/hosts", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const hostProfiles = await storage.getHostsByUserId(userId);
      res.json(hostProfiles);
    } catch (error: any) {
      console.error("Error fetching host profiles:", error);
      res.status(500).json({ message: "Failed to fetch host profiles" });
    }
  });

  app.get(
    "/api/hosts/:hostId",
    isAuthenticated,
    async (req: any, res, next) => {
      const reserved = new Set(["events", "event-series", "parking-pass"]);
      if (reserved.has(req.params.hostId)) {
        return next();
      }
      try {
        const { hostId } = req.params;
        const userId = req.user.id;
        const host = await storage.getHost(hostId);
        if (!host || host.userId !== userId) {
          return res.status(404).json({ message: "Host profile not found" });
        }
        res.json(host);
      } catch (error: any) {
        console.error("Error fetching host profile:", error);
        res.status(500).json({ message: "Failed to fetch host profile" });
      }
    },
  );

  app.patch("/api/hosts/me", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const host = await getHostByUserId(userId);
      if (!host) {
        return res.status(404).json({ message: "Host profile not found" });
      }

      const amenitiesSchema = z.record(z.boolean()).optional().nullable();
      const parsedAmenities = amenitiesSchema.parse(req.body?.amenities);

      const [updated] = await db
        .update(hosts)
        .set({
          amenities: parsedAmenities ?? null,
          updatedAt: new Date(),
        })
        .where(eq(hosts.id, host.id))
        .returning();

      res.json(updated);
    } catch (error: any) {
      console.error("Error updating host profile:", error);
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ message: "Invalid amenities data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update host profile" });
    }
  });

  app.patch("/api/hosts/:hostId", isAuthenticated, async (req: any, res) => {
    try {
      const { hostId } = req.params;
      const userId = req.user.id;
      const host = await storage.getHost(hostId);
      if (!host || host.userId !== userId) {
        return res.status(404).json({ message: "Host profile not found" });
      }

      const latitudeSchema = z.preprocess(
        (value) => (value === null ? undefined : value),
        z.coerce.number().min(-90).max(90),
      );
      const longitudeSchema = z.preprocess(
        (value) => (value === null ? undefined : value),
        z.coerce.number().min(-180).max(180),
      );
      const updateSchema = z.object({
        businessName: z.string().min(1).optional(),
        address: z.string().min(1).optional(),
        city: z.string().min(1).optional(),
        state: z.string().min(2).optional(),
        locationType: z.string().min(1).optional(),
        contactPhone: z
          .string()
          .refine(
            (value) => value.replace(/\D/g, "").length >= 10,
            "A valid contact phone number is required",
          )
          .optional(),
        notes: z.string().optional().nullable(),
        amenities: z.record(z.boolean()).optional().nullable(),
        spotCount: z.number().int().min(1).optional(),
        latitude: latitudeSchema.optional(),
        longitude: longitudeSchema.optional(),
        // Parking Pass defaults live on the host (simple model: address + any price => bookable).
        parkingPassBreakfastPriceCents: z.number().int().min(0).optional(),
        parkingPassLunchPriceCents: z.number().int().min(0).optional(),
        parkingPassDinnerPriceCents: z.number().int().min(0).optional(),
        parkingPassDailyPriceCents: z.number().int().min(0).optional(),
        parkingPassWeeklyPriceCents: z.number().int().min(0).optional(),
        parkingPassMonthlyPriceCents: z.number().int().min(0).optional(),
        parkingPassStartTime: z.string().optional().nullable(),
        parkingPassEndTime: z.string().optional().nullable(),
        parkingPassDaysOfWeek: z
          .array(z.number().int().min(0).max(6))
          .optional(),
      });
      const parsed = updateSchema.parse(req.body || {});

      const hasManualCoords =
        parsed.latitude !== undefined || parsed.longitude !== undefined;
      if (
        hasManualCoords &&
        (parsed.latitude === undefined || parsed.longitude === undefined)
      ) {
        return res
          .status(400)
          .json({ message: "Latitude and longitude are required together." });
      }
      const manualCoords =
        parsed.latitude !== undefined && parsed.longitude !== undefined
          ? { lat: parsed.latitude, lng: parsed.longitude }
          : null;

      const nextAddress = parsed.address ?? host.address;
      const nextCity = parsed.city ?? host.city;
      const nextState = parsed.state ?? host.state;

      const validation = await validateUsAddress({
        address: nextAddress,
        city: nextCity ?? null,
        state: nextState ?? null,
      }).catch(() => null);

      if (validation && !validation.ok) {
        return res.status(422).json({
          code: "ADDRESS_VALIDATION_REQUIRED",
          message:
            "Please confirm or correct this address before saving the host location.",
          reason: validation.reason,
          missingComponentTypes: validation.missingComponentTypes,
          suggested: validation.suggested,
        });
      }

      const validatedAddress = validation?.suggested?.address || nextAddress;
      const validatedCity = validation?.suggested?.city || nextCity;
      const validatedState = validation?.suggested?.state || nextState;
      const nextKey = buildLocationKey(
        validatedAddress,
        validatedCity,
        validatedState,
      );

      const siblingHosts = await db
        .select({
          id: hosts.id,
          address: hosts.address,
          city: hosts.city,
          state: hosts.state,
        })
        .from(hosts)
        .where(eq(hosts.userId, userId));

      const hasDuplicate = siblingHosts.some(
        (item: (typeof siblingHosts)[number]) =>
          item.id !== host.id &&
          buildLocationKey(item.address, item.city, item.state) === nextKey,
      );
      if (hasDuplicate) {
        return res.status(409).json({
          message:
            "Another location already uses this address. Edit that location instead.",
        });
      }

      const addressChanged =
        buildLocationKey(host.address, host.city, host.state) !== nextKey;
      const shouldGeocode =
        !manualCoords && (addressChanged || !host.latitude || !host.longitude);
      const geocodeAddress = buildGeocodeAddress(
        validatedAddress,
        validatedCity ?? null,
        validatedState ?? null,
      );
      let coords: { lat: number; lng: number } | null = null;
      if (shouldGeocode && geocodeAddress) {
        try {
          coords = await forwardGeocode(geocodeAddress);
        } catch {
          coords = null;
        }
      }

      const [updated] = await db
        .update(hosts)
        .set({
          businessName: parsed.businessName ?? host.businessName,
          address: validatedAddress,
          city: validatedCity,
          state: validatedState,
          locationType: parsed.locationType ?? host.locationType,
          contactPhone: parsed.contactPhone
            ? parsed.contactPhone.replace(/\D/g, "")
            : host.contactPhone,
          notes: parsed.notes ?? host.notes,
          amenities: parsed.amenities ?? host.amenities ?? null,
          spotCount: parsed.spotCount ?? host.spotCount ?? 1,
          parkingPassBreakfastPriceCents:
            parsed.parkingPassBreakfastPriceCents ??
            (host as any).parkingPassBreakfastPriceCents ??
            0,
          parkingPassLunchPriceCents:
            parsed.parkingPassLunchPriceCents ??
            (host as any).parkingPassLunchPriceCents ??
            0,
          parkingPassDinnerPriceCents:
            parsed.parkingPassDinnerPriceCents ??
            (host as any).parkingPassDinnerPriceCents ??
            0,
          parkingPassDailyPriceCents:
            parsed.parkingPassDailyPriceCents ??
            (host as any).parkingPassDailyPriceCents ??
            0,
          parkingPassWeeklyPriceCents:
            parsed.parkingPassWeeklyPriceCents ??
            (host as any).parkingPassWeeklyPriceCents ??
            0,
          parkingPassMonthlyPriceCents:
            parsed.parkingPassMonthlyPriceCents ??
            (host as any).parkingPassMonthlyPriceCents ??
            0,
          parkingPassStartTime:
            parsed.parkingPassStartTime !== undefined
              ? (parsed.parkingPassStartTime ?? null)
              : ((host as any).parkingPassStartTime ?? null),
          parkingPassEndTime:
            parsed.parkingPassEndTime !== undefined
              ? (parsed.parkingPassEndTime ?? null)
              : ((host as any).parkingPassEndTime ?? null),
          parkingPassDaysOfWeek:
            parsed.parkingPassDaysOfWeek !== undefined
              ? parsed.parkingPassDaysOfWeek
              : ((host as any).parkingPassDaysOfWeek ?? []),
          latitude: manualCoords
            ? manualCoords.lat.toString()
            : coords
              ? coords.lat.toString()
              : addressChanged
                ? null
                : host.latitude,
          longitude: manualCoords
            ? manualCoords.lng.toString()
            : coords
              ? coords.lng.toString()
              : addressChanged
                ? null
                : host.longitude,
          updatedAt: new Date(),
        })
        .where(eq(hosts.id, host.id))
        .returning();

      // Keep the implementation-detail series in sync so bookings are possible via virtual ids.
      try {
        await storage.syncParkingPassSeriesFromHost(host.id);
      } catch (e) {
        console.warn(
          "syncParkingPassSeriesFromHost failed after host update:",
          e,
        );
      }
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating host profile:", error);
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ message: "Invalid amenities data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update host profile" });
    }
  });

  app.post(
    "/api/hosts/:hostId/spot-image",
    isAuthenticated,
    upload.single("image"),
    async (req: any, res) => {
      try {
        const { hostId } = req.params;
        const userId = req.user.id;

        const host = await storage.getHost(hostId);
        if (!host) {
          return res.status(404).json({ message: "Host profile not found" });
        }

        const allowed =
          isStaffOrAdminUser(req.user) ||
          String(host.userId) === String(userId);
        if (!allowed) {
          return res.status(403).json({ message: "Not authorized" });
        }

        if (!isCloudinaryConfigured()) {
          return res.status(400).json({ message: "Image uploads are not configured on this server.",
          });
        }

        if (!req.file?.buffer) {
          return res.status(400).json({ message: "No image uploaded." });
        }

        const result = await uploadToCloudinary(
          req.file.buffer,
          "host-spots",
          `host-${host.id}-spot`,
        );

        const [updated] = await db
          .update(hosts)
          .set({ spotImageUrl: result.secureUrl, updatedAt: new Date() })
          .where(eq(hosts.id, host.id))
          .returning();

        try {
          await db.insert(imageUploads).values({
            uploadedByUserId: userId,
            imageType: "host_spot",
            entityId: host.id,
            entityType: "host",
            cloudinaryPublicId: result.publicId,
            cloudinaryUrl: result.secureUrl,
            thumbnailUrl: result.thumbnailUrl,
            width: result.width,
            height: result.height,
            fileSize: result.bytes,
            mimeType: req.file.mimetype,
          } as any);
        } catch {
          // Non-blocking: host record already points to the new image.
        }

        res.json(updated ?? { ...host, spotImageUrl: result.secureUrl });
      } catch (error: any) {
        console.error("Error uploading host spot image:", error);
        res.status(500).json({ message: "Failed to upload image" });
      }
    },
  );

  app.patch(
    "/api/hosts/:hostId/coordinates",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { hostId } = req.params;
        const userId = req.user.id;
        const host = await storage.getHost(hostId);
        if (!host || host.userId !== userId) {
          return res.status(404).json({ message: "Host profile not found" });
        }

        const coordSchema = z.object({
          latitude: z.coerce.number().min(-90).max(90),
          longitude: z.coerce.number().min(-180).max(180),
        });
        const parsed = coordSchema.parse(req.body || {});

        const updated = await storage.updateHostCoordinates(
          host.id,
          parsed.latitude,
          parsed.longitude,
        );

        res.json(updated);
      } catch (error: any) {
        console.error("Error updating host coordinates:", error);
        if (error instanceof z.ZodError) {
          return res
            .status(400)
            .json({ message: "Invalid coordinates", errors: error.errors });
        }
        res.status(500).json({ message: "Failed to update coordinates" });
      }
    },
  );

  app.post(
    "/api/hosts/:hostId/geocode",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { hostId } = req.params;
        const userId = req.user.id;
        const host = await storage.getHost(hostId);
        if (!host || host.userId !== userId) {
          return res.status(404).json({ message: "Host profile not found" });
        }

        const geocodeAddress = buildGeocodeAddress(
          host.address,
          host.city ?? null,
          host.state ?? null,
        );
        let coords: { lat: number; lng: number } | null = null;
        if (geocodeAddress) {
          try {
            coords = await forwardGeocode(geocodeAddress);
          } catch {
            coords = null;
          }
        }

        if (!coords) {
          return res.status(400).json({
            message: "Unable to find coordinates for this address.",
          });
        }

        const updated = await storage.updateHostCoordinates(
          host.id,
          coords.lat,
          coords.lng,
        );

        res.json(updated);
      } catch (error: any) {
        console.error("Error geocoding host:", error);
        res.status(500).json({ message: "Failed to geocode host" });
      }
    },
  );

  app.get(
    "/api/hosts/:hostId/blackout-dates",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { hostId } = req.params;
        const userId = req.user.id;
        const host = await storage.getHost(hostId);
        if (!host || host.userId !== userId) {
          return res.status(404).json({ message: "Host profile not found" });
        }
        const seriesId = await getActiveParkingPassSeriesId(hostId);
        if (!seriesId) {
          return res.json([]);
        }
        const blackoutDates =
          await storage.getParkingPassBlackoutDates(seriesId);
        const timezone = resolveCityTimeZoneSync({
          city: host.city,
          state: host.state,
        });
        res.json(
          blackoutDates.map((row: any) => ({
            ...row,
            dateKey: dateKeyInZone(new Date(row.date), timezone),
          })),
        );
      } catch (error: any) {
        console.error("Error fetching blackout dates:", error);
        res.status(500).json({ message: "Failed to fetch blackout dates" });
      }
    },
  );

  app.post(
    "/api/hosts/:hostId/blackout-dates",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { hostId } = req.params;
        const userId = req.user.id;
        const host = await storage.getHost(hostId);
        if (!host || host.userId !== userId) {
          return res.status(404).json({ message: "Host profile not found" });
        }

        const seriesId = await getActiveParkingPassSeriesId(hostId);
        if (!seriesId) {
          return res
            .status(404)
            .json({ message: "No active parking pass found." });
        }

        const timezone = resolveCityTimeZoneSync({
          city: host.city,
          state: host.state,
        });
        const dateKey = dateKeyFromUnknown(req.body?.date, timezone);
        if (!dateKey) {
          return res.status(400).json({ message: "Valid date required" });
        }
        const date = utcDateFromDateKey(dateKey);

        const created = await storage.createParkingPassBlackoutDate({
          seriesId,
          date,
        });
        res.status(201).json(created);
      } catch (error: any) {
        console.error("Error creating blackout date:", error);
        res.status(500).json({ message: "Failed to create blackout date" });
      }
    },
  );

  app.delete(
    "/api/hosts/:hostId/blackout-dates",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { hostId } = req.params;
        const userId = req.user.id;
        const host = await storage.getHost(hostId);
        if (!host || host.userId !== userId) {
          return res.status(404).json({ message: "Host profile not found" });
        }

        const timezone = resolveCityTimeZoneSync({
          city: host.city,
          state: host.state,
        });
        const dateKey = dateKeyFromUnknown(req.body?.date, timezone);
        if (!dateKey) {
          return res.status(400).json({ message: "Valid date required" });
        }
        const date = utcDateFromDateKey(dateKey);
        const todayKey = dateKeyInZone(new Date(), timezone);
        if (dateKey <= todayKey) {
          return res.status(400).json({
            message: "Same-day blackout dates cannot be removed.",
          });
        }

        const seriesId = await getActiveParkingPassSeriesId(hostId);
        if (!seriesId) {
          return res
            .status(404)
            .json({ message: "No active parking pass found." });
        }

        await storage.deleteParkingPassBlackoutDate(seriesId, date);
        res.json({ message: "Blackout date removed" });
      } catch (error: any) {
        console.error("Error deleting blackout date:", error);
        res.status(500).json({ message: "Failed to delete blackout date" });
      }
    },
  );

  app.delete("/api/hosts/:hostId", isAuthenticated, async (req: any, res) => {
    try {
      const { hostId } = req.params;
      const userId = req.user.id;
      const host = await storage.getHost(hostId);
      if (!host || host.userId !== userId) {
        return res.status(404).json({ message: "Host profile not found" });
      }

      const existingBookings = await db
        .select({ id: eventBookings.id })
        .from(eventBookings)
        .where(eq(eventBookings.hostId, host.id))
        .limit(1);

      if (existingBookings.length > 0) {
        return res.status(409).json({
          message:
            "This location has bookings and cannot be deleted. Contact support if you need help.",
        });
      }

      await db.delete(hosts).where(eq(hosts.id, host.id));
      res.json({ message: "Location deleted" });
    } catch (error: any) {
      console.error("Error deleting host profile:", error);
      res.status(500).json({ message: "Failed to delete host profile" });
    }
  });

  registerHostParkingPassRoutes(app);

  // =====================================================================
  // STRIPE CONNECT & PAYMENT ENDPOINTS
  // =====================================================================

  const startHostStripeOnboarding = async (req: any, res: any) => {
    try {
      if (!stripe) {
        return res.status(500).json({ message: "Stripe not configured" });
      }

      const host = await getOwnedHostForRequest(req);
      if (!host) {
        return res.status(404).json({ message: "Host profile not found" });
      }

      let accountId = host.stripeConnectAccountId;

      if (!accountId) {
        const account = await stripe.accounts.create({
          type: "express",
          country: "US",
          email: req.user.email,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_type: "individual",
          metadata: {
            hostId: host.id,
            businessName: host.businessName,
          },
        });

        accountId = account.id;

        await db
          .update(hosts)
          .set({
            stripeConnectAccountId: accountId,
            stripeConnectStatus: "pending",
            stripeOnboardingCompleted: false,
            stripeChargesEnabled: false,
            stripePayoutsEnabled: false,
            updatedAt: new Date(),
          })
          .where(eq(hosts.id, host.id));
      }

      const baseUrl =
        process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${normalizedBaseUrl}/host/dashboard?setup=refresh&hostId=${encodeURIComponent(String(host.id))}`,
        return_url: `${normalizedBaseUrl}/host/dashboard?setup=complete&hostId=${encodeURIComponent(String(host.id))}`,
        type: "account_onboarding",
      });

      res.json({ onboardingUrl: accountLink.url });
    } catch (error: any) {
      console.error("Error creating Stripe Connect account:", error);
      res.status(500).json({ message: "Failed to initiate Stripe onboarding" });
    }
  };

  const checkHostStripeStatus = async (req: any, res: any) => {
    try {
      if (!stripe) {
        return res.status(500).json({ message: "Stripe not configured" });
      }

      const host = await getOwnedHostForRequest(req);
      if (!host) {
        return res.status(404).json({ message: "Host profile not found" });
      }

      if (!host.stripeConnectAccountId) {
        return res.json({
          connected: false,
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingCompleted: false,
          connectStatus: "not_connected",
        });
      }

      const account = await stripe.accounts.retrieve(
        host.stripeConnectAccountId,
      );

      await db
        .update(hosts)
        .set({
          stripeChargesEnabled: account.charges_enabled,
          stripePayoutsEnabled: account.payouts_enabled,
          stripeOnboardingCompleted: account.details_submitted,
          stripeConnectStatus:
            account.charges_enabled && account.payouts_enabled
              ? "active"
              : "pending",
          updatedAt: new Date(),
        })
        .where(eq(hosts.id, host.id));

      res.json({
        connected: true,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        onboardingCompleted: account.details_submitted,
        connectStatus:
          account.charges_enabled && account.payouts_enabled
            ? "active"
            : "pending",
        accountId: host.stripeConnectAccountId,
      });
    } catch (error: any) {
      console.error("Error checking Stripe status:", error);
      res.status(500).json({ message: "Failed to check Stripe status" });
    }
  };

  // Stripe Connect Onboarding: Host enables payments
  app.post(
    "/api/hosts/stripe/onboard",
    isAuthenticated,
    startHostStripeOnboarding,
  );
  app.post(
    "/api/hosts/:hostId/stripe/onboard",
    isAuthenticated,
    async (req: any, res) => {
      req.body = {
        ...(req.body || {}),
        hostId: String(req.params.hostId || "").trim(),
      };
      return startHostStripeOnboarding(req, res);
    },
  );

  // Check Stripe Connect account status
  app.get("/api/hosts/stripe/status", isAuthenticated, checkHostStripeStatus);
  app.get(
    "/api/hosts/:hostId/stripe/status",
    isAuthenticated,
    async (req: any, res) => {
      req.query = {
        ...(req.query || {}),
        hostId: String(req.params.hostId || "").trim(),
      };
      return checkHostStripeStatus(req, res);
    },
  );

  app.get(
    "/api/hosts/earnings/summary",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const host = await getOwnedHostForRequest(req);
        if (!host) {
          return res.status(404).json({ message: "Host profile not found" });
        }

        const summary = await getHostEarningsSummary(host.id);
        const stripePayoutReady = Boolean(
          host.stripeConnectAccountId &&
          host.stripeChargesEnabled &&
          host.stripePayoutsEnabled &&
          host.stripeOnboardingCompleted,
        );

        res.json({
          ...summary,
          stripePayoutReady,
          canRequestPayout: stripePayoutReady && summary.availableCents > 0,
        });
      } catch (error: any) {
        console.error("Error loading host earnings summary:", error);
        res.status(500).json({ message: "Failed to fetch host earnings summary" });
      }
    },
  );

  app.post(
    "/api/hosts/earnings/payout-request",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const host = await getOwnedHostForRequest(req);
        if (!host) {
          return res.status(404).json({ message: "Host profile not found" });
        }

        const stripePayoutReady = Boolean(
          host.stripeConnectAccountId &&
          host.stripeChargesEnabled &&
          host.stripePayoutsEnabled &&
          host.stripeOnboardingCompleted,
        );
        if (!stripePayoutReady) {
          return res.status(400).json({
            message:
              "Complete Stripe onboarding to request payout. Bookings can continue in the meantime.",
            code: "stripe_payout_not_ready",
          });
        }

        // getHostEarningsSummary's availableCents already subtracts
        // pending/approved payout requests, but reading the summary,
        // validating against it, and inserting a new request were three
        // separate round trips with no lock between them -- two concurrent
        // requests (double-click, retry) could both read the same
        // availableCents before either insert committed, both pass
        // validation, and both get created, letting a host request payouts
        // summing to more than they've actually earned. Serialize per-host
        // with an advisory lock so the read-check-insert is atomic.
        const requestedAmountRaw = Number(req.body?.amountCents);
        const notes =
          typeof req.body?.notes === "string" && req.body.notes.trim()
            ? req.body.notes.trim()
            : null;

        let createdRequest: typeof hostPayoutRequests.$inferSelect;
        try {
          createdRequest = await db.transaction(async (tx: any) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext(${`host_payout:${host.id}`}))`,
            );

            const summary = await getHostEarningsSummary(host.id, tx);
            const requestedAmountCents = Number.isFinite(requestedAmountRaw)
              ? Math.floor(requestedAmountRaw)
              : summary.availableCents;

            if (requestedAmountCents <= 0) {
              throw Object.assign(
                new Error("Payout amount must be greater than $0.00"),
                { statusCode: 400 },
              );
            }
            if (requestedAmountCents > summary.availableCents) {
              throw Object.assign(
                new Error("Requested amount exceeds available earnings."),
                { statusCode: 400, availableCents: summary.availableCents },
              );
            }

            const [inserted] = await tx
              .insert(hostPayoutRequests)
              .values({
                hostId: host.id,
                userId: req.user.id,
                amountCents: requestedAmountCents,
                status: "pending",
                notes,
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .returning();
            return inserted;
          });
        } catch (error: any) {
          if (error?.statusCode === 400) {
            return res.status(400).json({
              message: error.message,
              ...(error.availableCents !== undefined
                ? { availableCents: error.availableCents }
                : {}),
            });
          }
          throw error;
        }

        const updatedSummary = await getHostEarningsSummary(host.id);

        res.status(201).json({
          request: createdRequest,
          summary: {
            ...updatedSummary,
            stripePayoutReady,
            canRequestPayout:
              stripePayoutReady && updatedSummary.availableCents > 0,
          },
        });
      } catch (error: any) {
        console.error("Error creating host payout request:", error);
        res.status(500).json({ message: "Failed to create payout request" });
      }
    },
  );

  // GET payout request history for the authenticated host
  app.get(
    "/api/hosts/earnings/payout-requests",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const host = await getOwnedHostForRequest(req);
        if (!host) {
          return res.status(404).json({ message: "Host profile not found" });
        }
        const requests = await db
          .select()
          .from(hostPayoutRequests)
          .where(eq(hostPayoutRequests.hostId, host.id))
          .orderBy(sql`${hostPayoutRequests.createdAt} desc`)
          .limit(50);
        res.json({ requests });
      } catch (error: unknown) {
        console.error("Error loading payout request history:", error);
        res
          .status(500)
          .json({ message: "Failed to load payout request history" });
      }
    },
  );

  // Book a Parking Pass (creates payment intent with $10/day platform fee auto-added)
  app.post(
    "/api/parking-pass/:passId/book",
    parkingPassBookingBurstLimiter,
    parkingPassBookingDayLimiter,
    isAuthenticated,
    requireDurableIdempotencyKey({
      scope: "parking_pass_booking",
      authorizeReplay: async (req) => storage.verifyRestaurantOwnership(
        String(req.body?.truckId || ""), String((req as any).user.id), "manageParkingPass",
      ),
      reconcile: (req, checkpoint) => reconcileParkingBooking(req, checkpoint, stripe?.paymentIntents || null, async () => {
        const truck = await storage.getRestaurant(String(req.body?.truckId || ""));
        if (!truck) return false;
        const gate = assessParkingPassTruckEligibility({ user: (req as any).user, truck });
        return gate.isTruckProfile && gate.roleAllowed &&
          (gate.shouldBypassVerificationGate || (gate.emailVerified && gate.storedInsuranceValid));
      }),
    }),
    async (req: any, res) => {
      try {
        const testModeEnabled =
          String(process.env.MEALSCOUT_TEST_MODE || "").toLowerCase() ===
            "true" || process.env.NODE_ENV !== "production";
        const testPromosRequireAdmin =
          String(
            process.env.MEALSCOUT_TEST_PROMOS_REQUIRE_ADMIN || "",
          ).toLowerCase() === "true";
        const testPromoAllowlist = new Set(
          String(process.env.MEALSCOUT_TEST_PROMO_ALLOWLIST || "")
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter((value) => value.length > 0),
        );
        const isAdminUser = [
          "admin",
          "duper_admin",
          "super_admin",
          "staff",
        ].includes(String(req.user?.userType || ""));
        const bookingFeePromoFlag = String(
          process.env.BOOKFEE10_ENABLED || "",
        )
          .trim()
          .toLowerCase();
        const bookingFeePromoEnabled =
          !["0", "false", "no", "off", "disabled"].includes(
            bookingFeePromoFlag,
          );
        const bypassStripe =
          String(process.env.MEALSCOUT_BYPASS_STRIPE || "").toLowerCase() ===
            "true" ||
          String(process.env.MEALSCOUT_TEST_MODE || "").toLowerCase() ===
            "true";
        if (!stripe && !bypassStripe) {
          return res.status(500).json({ message: "Stripe not configured" });
        }

        const { passId } = req.params;
        const {
          truckId,
          slotType,
          slotTypes,
          selectedDates,
          applyCreditsCents,
          promoCode,
        } = req.body;
        const userId = req.user.id;

        if (!truckId) {
          return res.status(400).json({ message: "Truck ID required" });
        }

        const normalizedPromoCode = String(promoCode || "")
          .trim()
          .toUpperCase();
        const isTestDollarPromo =
          normalizedPromoCode === "TEST1" ||
          normalizedPromoCode === "FREE100" ||
          normalizedPromoCode === "SCOUT100";
        const bookingPromoCodes = new Set([
          "TEST1",
          "FREE100",
          "SCOUT100",
          "BOOKFEE10",
        ]);
        if (
          normalizedPromoCode &&
          !bookingPromoCodes.has(normalizedPromoCode)
        ) {
          return res.status(400).json({ message: "Invalid promo code" });
        }
        if (isTestDollarPromo) {
          const emailKey = String(req.user?.email || "")
            .trim()
            .toLowerCase();
          const userIdKey = String(req.user?.id || "")
            .trim()
            .toLowerCase();
          const allowlisted =
            (emailKey && testPromoAllowlist.has(emailKey)) ||
            (userIdKey && testPromoAllowlist.has(userIdKey));
          if (testPromosRequireAdmin && !isAdminUser && !allowlisted) {
            return res.status(403).json({
              code: "promo_admin_only",
              message: "This test promo code is admin-only.",
            });
          }
          // If admin-only mode is not enabled, allow test promos for verified booking flows.
          // We intentionally do not hard-block on environment mode here, because Parking Pass
          // QA in production-like environments needs a no-charge path for verified trucks.
        }
        if (normalizedPromoCode === "BOOKFEE10" && !bookingFeePromoEnabled) {
          return res
            .status(400)
            .json({ message: "Promo code is not available" });
        }
        const allowedSlotTypes = new Set<string>(
          PARKING_PASS_SLOT_TYPES as readonly string[],
        );
        const requestedSlots = Array.isArray(slotTypes)
          ? slotTypes
          : slotType
            ? [slotType]
            : [];
        const normalizedSlots = Array.from(
          new Set(
            requestedSlots
              .filter((value: any) => typeof value === "string")
              .map((value: string) => value.trim())
              .filter((value: string) => value.length > 0),
          ),
        );
        if (normalizedSlots.length === 0) {
          return res.status(400).json({ message: "Valid slotTypes required" });
        }
        if (normalizedSlots.some((value) => !allowedSlotTypes.has(value))) {
          return res.status(400).json({ message: "Valid slotTypes required" });
        }

        const durationSlots = normalizedSlots.filter((value) =>
          ["daily", "weekly", "monthly"].includes(value),
        );
        const mealSlots = normalizedSlots.filter((value) =>
          ["breakfast", "lunch", "dinner"].includes(value),
        );
        if (durationSlots.length > 0 && mealSlots.length > 0) {
          return res.status(400).json({
            message:
              "Daily, weekly, and monthly bookings cannot be combined with meal slots.",
          });
        }
        if (durationSlots.length > 1) {
          return res.status(400).json({
            message: "Select only one of daily, weekly, or monthly.",
          });
        }

        const selectedSlotTypes = (
          durationSlots.length > 0 ? durationSlots : mealSlots
        ) as (typeof PARKING_PASS_SLOT_TYPES)[number][];
        console.info("[parking-pass] booking request normalized", {
          passId,
          truckId,
          selectedSlotTypes,
          rawSlotType: slotType || null,
          rawSlotTypes: Array.isArray(slotTypes) ? slotTypes : null,
          rawSelectedDates: Array.isArray(selectedDates) ? selectedDates : null,
        });

        // Verify truck capability and type
        const truck = await storage.getRestaurant(truckId);
        const hasManageParkingPass = await storage.verifyRestaurantOwnership(
          truckId,
          userId,
          "manageParkingPass",
        );
        if (!truck || !hasManageParkingPass) {
          const ownedRestaurants = await storage.getRestaurantsByOwner(userId);
          const hasOwnedTruckProfile = Array.isArray(ownedRestaurants)
            ? ownedRestaurants.some((row: any) => {
                const businessType = String(row?.businessType || "").toLowerCase();
                return row?.isFoodTruck === true || businessType === "food_truck";
              })
            : false;

          console.warn("[parking-pass] rejected booking attempt", {
            userId,
            userType: req.user?.userType || null,
            truckId,
            truckIsFoodTruck: truck?.isFoodTruck ?? null,
            hasManageParkingPass,
            hasOwnedTruckProfile,
            reason: !truck ? "truck_not_found" : "missing_manageParkingPass",
          });

          if (!hasOwnedTruckProfile) {
            return res.status(409).json({
              code: "truck_profile_required",
              message:
                "Complete your food truck profile before booking Parking Pass spots.",
              onboardingPath:
                "/restaurant-signup?businessType=food_truck&source=parking-pass&claim=1",
            });
          }

          return res.status(403).json({ message: "Not authorized" });
        }
        const truckEligibility = assessParkingPassTruckEligibility({
          user: req.user,
          truck,
        });
        if (!truckEligibility.isTruckProfile) {
          console.warn("[parking-pass] rejected booking attempt", {
            userId,
            userType: req.user?.userType || null,
            truckId,
            truckIsFoodTruck: truck.isFoodTruck,
            truckBusinessType: truck.businessType || null,
            hasManageParkingPass,
            reason: "not_food_truck",
          });
          return res.status(403).json({
            message:
              "Parking Pass bookings are only available for food trucks.",
          });
        }
        if (!truckEligibility.shouldBypassVerificationGate) {
          if (
            !truckEligibility.emailVerified ||
            !truckEligibility.storedInsuranceValid
          ) {
            return res.status(409).json({
              code: "truck_verification_required",
              message:
                "Verify your email and submit business insurance to book Parking Pass spots.",
              onboardingPath:
                "/restaurant-signup?businessType=food_truck&source=parking-pass&step=verification",
              requirements: {
                emailVerified: truckEligibility.emailVerified,
                businessInsuranceSubmitted:
                  truckEligibility.storedInsuranceValid,
              },
            });
          }
        }
        if (!truckEligibility.roleAllowed) {
          return res.status(403).json({
            message: "Only food truck accounts can book Parking Pass slots.",
          });
        }

        // Get (or materialize) the Parking Pass occurrence row.
        const event = await ensureParkingPassEventRow({
          passId,
          requireFuture: true,
        });
        if (!event) {
          return res.status(404).json({ message: "Parking pass not found" });
        }

        if (event.status !== "open") {
          return res
            .status(400)
            .json({ message: "Parking pass not available for booking" });
        }

        if (!event.requiresPayment) {
          return res.status(400).json({
            message:
              "Payments are only available for Parking Pass listings, not events.",
          });
        }

        // Get host
        const host = await storage.getHost(event.hostId);
        if (!host) {
          return res.status(404).json({ message: "Host not found" });
        }

        const hostPaymentsEnabled = Boolean(
          host.stripeConnectAccountId &&
          host.stripeChargesEnabled &&
          host.stripePayoutsEnabled &&
          host.stripeOnboardingCompleted,
        );
        // Host payouts may still be configuring Stripe Connect.
        // We still allow bookings: if Connect is not ready we charge on platform,
        // and payouts are handled after host onboarding is completed.
        const hostStripeAccountId = hostPaymentsEnabled
          ? host.stripeConnectAccountId
          : null;
        const bookingTimeZone = resolveCityTimeZoneSync({
          city: host.city,
          state: host.state,
        });

        // A clock deadline alone cannot establish that a hold is unpaid.
        // Scope the payment-aware sweep to this authorized truck and run it
        // before the existing-booking check so positively cancelled holds can
        // be rebooked without deleting their history.
        const holdTtlMinutesRaw = Number(
          process.env.PARKING_PASS_HOLD_TTL_MINUTES ?? 7,
        );
        const holdTtlMinutes = Number.isFinite(holdTtlMinutesRaw)
          ? Math.max(1, Math.min(holdTtlMinutesRaw, 60))
          : 7;
        await expireParkingPassHolds(stripe?.paymentIntents || null, {
          ttlMs: holdTtlMinutes * 60 * 1000,
          truckId: String(truck.id),
        });

        // Check for existing booking
        const existingBooking = await db
          .select()
          .from(eventBookings)
          .where(and(
            eq(eventBookings.eventId, event.id),
            eq(eventBookings.truckId, truckId),
            inArray(eventBookings.status, ["pending", "confirmed"]),
          ))
          .limit(1);

        if (existingBooking.length > 0) {
          return res.status(400).json({
            message:
              existingBooking[0].status === "pending"
                ? "You already have a checkout in progress for this parking pass."
                : "You already have a booking for this parking pass",
            bookingId: existingBooking[0].id,
          });
        }

        const eventVirtualId = parseParkingPassVirtualId(String(event.id || ""));
        const eventDateKey =
          eventVirtualId?.dateKey || dateKeyFromUnknown(event.date, "UTC");
        if (!eventDateKey) {
          return res.status(400).json({
            message: "Invalid parking pass date.",
          });
        }
        const rangeStart = utcDateFromDateKey(eventDateKey);

        const requestedDateKeys = Array.isArray(selectedDates)
          ? Array.from(
              new Set(
                selectedDates
                  .filter((value: unknown) => typeof value === "string")
                  .map((value: string) => value.trim())
                  .map((value: string) => {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
                    const normalized = dateKeyFromUnknown(
                      value,
                      bookingTimeZone,
                    );
                    return normalized || "";
                  })
                  .filter((value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
              ),
            )
          : [];
        if (
          Array.isArray(selectedDates) &&
          selectedDates.length > 0 &&
          requestedDateKeys.length !== selectedDates.length
        ) {
          return res
            .status(400)
            .json({ message: "Invalid selectedDates format." });
        }

        const bookingDaysDefault = durationSlots.includes("monthly")
          ? 30
          : durationSlots.includes("weekly")
            ? 7
            : 1;
        const isSingleOccurrenceBooking =
          mealSlots.length > 0 || durationSlots.includes("daily");
        const expectedDateKeys: string[] = isSingleOccurrenceBooking
          ? [eventDateKey]
          : requestedDateKeys.length > 0
            ? requestedDateKeys
            : Array.from({ length: bookingDaysDefault }, (_, offset) => {
                return addDaysToDateKey(eventDateKey, offset);
              });
        console.info("[parking-pass] availability validation scope", {
          passId,
          eventDateKey,
          requestedDateKeys,
          bookingDaysDefault,
          isSingleOccurrenceBooking,
          expectedDateKeys,
          selectedSlotTypes,
          eventStartTime: event.startTime,
          eventEndTime: event.endTime,
        });
        if (expectedDateKeys.length === 0) {
          return res
            .status(400)
            .json({ message: "No booking dates selected." });
        }
        if (expectedDateKeys.length > 31) {
          return res
            .status(400)
            .json({ message: "Too many booking dates selected." });
        }

        const sortedDateKeys = [...expectedDateKeys].sort();
        const firstDate = new Date(`${sortedDateKeys[0]}T00:00:00.000Z`);
        const lastDate = new Date(
          `${sortedDateKeys[sortedDateKeys.length - 1]}T00:00:00.000Z`,
        );
        if (
          !Number.isFinite(firstDate.getTime()) ||
          !Number.isFinite(lastDate.getTime())
        ) {
          return res
            .status(400)
            .json({ message: "Invalid booking dates selected." });
        }
        const rangeQueryStart = new Date(firstDate);
        const rangeQueryEnd = new Date(lastDate);
        rangeQueryEnd.setDate(rangeQueryEnd.getDate() + 1);

        const parsedVirtualPassId = parseParkingPassVirtualId(passId);
        if (parsedVirtualPassId) {
          await Promise.all(
            expectedDateKeys.map((dateKey) =>
              ensureParkingPassEventRow({
                passId: buildParkingPassVirtualId(
                  parsedVirtualPassId.seriesId,
                  dateKey,
                ),
                requireFuture: true,
              }),
            ),
          );
        }

        const bookingEvents = await db
          .select()
          .from(events)
          .where(
            and(
              eq(events.hostId, host.id),
              eq(events.requiresPayment, true),
              gte(events.date, rangeQueryStart),
              lt(events.date, rangeQueryEnd),
            ),
          )
          .orderBy(asc(events.date));

        const eventsByDate = new Map<string, (typeof bookingEvents)[number]>();
        for (const row of bookingEvents) {
          const rowVirtualId = parseParkingPassVirtualId(String(row.id || ""));
          const dateKey =
            rowVirtualId?.dateKey || dateKeyFromUnknown(row.date, "UTC");
          if (!dateKey) {
            continue;
          }
          eventsByDate.set(dateKey, row);
        }

        const missingDates = expectedDateKeys.filter(
          (dateKey) => !eventsByDate.has(dateKey),
        );
        if (missingDates.length > 0) {
          console.warn("[parking-pass] full-range validation failed", {
            passId,
            hostId: host.id,
            eventDateKey,
            expectedDateKeys,
            missingDates,
            bookingEvents: bookingEvents.map((row: any) => ({
              id: row.id,
              date: row.date,
              startTime: row.startTime,
              endTime: row.endTime,
              status: row.status,
            })),
            selectedSlotTypes,
          });
          return res.status(400).json({
            message:
              "This parking pass does not have availability for the full booking range.",
          });
        }

        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        for (const dateKey of expectedDateKeys) {
          const row = eventsByDate.get(dateKey);
          if (!row) continue;
          const rowDate = new Date(row.date);
          const rowDayStart = new Date(rowDate);
          rowDayStart.setHours(0, 0, 0, 0);

          if (rowDayStart < todayStart) {
            return res.status(400).json({
              message: "Cannot book past parking pass dates.",
            });
          }

          const isSameDayBooking =
            rowDayStart.getTime() === todayStart.getTime();

          if (row.status !== "open") {
            return res.status(400).json({
              message: "This parking pass is not available for that date.",
            });
          }
          for (const slotType of selectedSlotTypes) {
            if (!isSlotWithinHours(slotType, row.startTime, row.endTime)) {
              return res.status(400).json({
                message: "Selected slots do not fit within host parking hours.",
              });
            }

            if (isSameDayBooking) {
              const window = getSlotWindowMinutesWithCleanup(
                slotType,
                row.startTime,
                row.endTime,
              );
              if (!window || window.startMinutes <= nowMinutes) {
                return res.status(400).json({
                  message:
                    "Selected slots must start in the future. Choose a later slot or a different date.",
                });
              }
            }
          }
        }

        const existingBookings: Array<{
          slotType: string | null;
          eventDate: Date | string;
          eventStartTime: string | null;
          eventEndTime: string | null;
        }> = await db
          .select({
            slotType: eventBookings.slotType,
            eventDate: events.date,
            eventStartTime: events.startTime,
            eventEndTime: events.endTime,
          })
          .from(eventBookings)
          .innerJoin(events, eq(eventBookings.eventId, events.id))
          .where(
            and(
              eq(eventBookings.truckId, truckId),
              inArray(eventBookings.status, ["confirmed", "pending"]),
              gte(events.date, rangeQueryStart),
              lt(events.date, rangeQueryEnd),
            ),
          );

        const requestedWindowsByDate = new Map<
          string,
          Array<{ start: number; end: number }>
        >();
        for (const dateKey of expectedDateKeys) {
          const row = eventsByDate.get(dateKey);
          if (!row) continue;
          const windows: Array<{ start: number; end: number }> = [];
          for (const slotType of selectedSlotTypes) {
            const window = getSlotWindowMinutesWithCleanup(
              slotType,
              row.startTime,
              row.endTime,
            );
            if (window) {
              windows.push({
                start: window.startMinutes,
                end: window.endMinutes,
              });
            }
          }
          if (windows.length > 0) {
            requestedWindowsByDate.set(dateKey, windows);
          }
        }

        for (const booking of existingBookings) {
          // Event dates store the intended calendar day at UTC midnight.
          // Shifting that marker into a US timezone changes it to yesterday.
          const dateKey = dateKeyFromUnknown(booking.eventDate, "UTC");
          if (!dateKey) continue;
          const requested = requestedWindowsByDate.get(dateKey);
          if (!requested || requested.length === 0) continue;
          const slotParts = (booking.slotType || "")
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter((value) => value.length > 0);
          const normalizedExisting = slotParts.filter((value) =>
            allowedSlotTypes.has(value),
          );
          const existingSlots =
            normalizedExisting.length > 0 ? normalizedExisting : ["daily"];
          for (const slot of existingSlots) {
            const window = getSlotWindowMinutesWithCleanup(
              slot as (typeof PARKING_PASS_SLOT_TYPES)[number],
              booking.eventStartTime,
              booking.eventEndTime,
            );
            if (!window) continue;
            for (const requestedWindow of requested) {
              if (
                slotWindowsOverlap(
                  requestedWindow.start,
                  requestedWindow.end,
                  window.startMinutes,
                  window.endMinutes,
                )
              ) {
                return res.status(400).json({
                  message:
                    "You already have a booking that overlaps this time.",
                });
              }
            }
          }
        }

        const bookingDays = expectedDateKeys.length;
        // Calculate pricing: Host price + $10 platform fee
        const slotPriceMap: Record<string, number | null | undefined> = {
          breakfast: event.breakfastPriceCents,
          lunch: event.lunchPriceCents,
          dinner: event.dinnerPriceCents,
          daily: event.dailyPriceCents,
          weekly: event.weeklyPriceCents,
          monthly: event.monthlyPriceCents,
        };
        const selectedPrices = selectedSlotTypes.map((slot) => ({
          slot,
          price: Number(slotPriceMap[slot] ?? 0),
        }));
        if (
          selectedPrices.some(
            (item) => !Number.isFinite(item.price) || item.price < 0,
          )
        ) {
          return res.status(400).json({
            message: "One or more selected slots are not available.",
          });
        }
        const hostPriceCents = selectedPrices.reduce(
          (sum, item) => sum + item.price,
          0,
        );
        if (hostPriceCents <= 0) {
          return res.status(400).json({
            message: "This parking spot does not have a bookable price yet.",
          });
        }
        let platformFeeCents = 1000 * bookingDays; // $10/day, no cap
        let adjustedHostPriceCents = hostPriceCents;
        let promoDiscountCents = 0;

        if (isTestDollarPromo) {
          // Admin/testing-only: force a $1 total booking regardless of slot price.
          // This is intentionally not available in production unless MEALSCOUT_TEST_MODE is enabled.
          adjustedHostPriceCents = 0;
          platformFeeCents = 100;
        } else if (normalizedPromoCode === "BOOKFEE10") {
          const userRecord = await storage.getUser(userId);
          const bookingPromoState = (userRecord?.accountSettings as any)?.promos
            ?.bookingFee10;
          if (bookingPromoState?.redeemedAt) {
            return res.status(400).json({ message: "Promo code already used" });
          }
          if (bookingPromoState?.pendingPaymentIntentId) {
            return res
              .status(400)
              .json({ message: "Promo code already pending" });
          }
          promoDiscountCents = Math.min(1000, platformFeeCents);
        }

        let creditAppliedCents = 0;
        const requestedCreditCents = isTestDollarPromo
          ? 0
          : Number(applyCreditsCents || 0);
        if (requestedCreditCents > 0) {
          const { getUserCreditBalance } = await import("../creditService");
          const creditBalance = await getUserCreditBalance(userId);
          const availableCents = Math.max(0, Math.floor(creditBalance * 100));
          creditAppliedCents = Math.min(
            requestedCreditCents,
            platformFeeCents,
            availableCents,
          );
        }

        const adjustedPlatformFeeCents = Math.max(
          platformFeeCents - creditAppliedCents - promoDiscountCents,
          0,
        );
        const totalCents = adjustedHostPriceCents + adjustedPlatformFeeCents;

        const splitAmount = (total: number, days: number) => {
          if (days <= 1) return [total];
          const base = Math.floor(total / days);
          const remainder = total - base * days;
          return Array.from({ length: days }, (_, index) =>
            index === 0 ? base + remainder : base,
          );
        };

        const hostSplit = splitAmount(adjustedHostPriceCents, bookingDays);
        const platformSplit = splitAmount(
          adjustedPlatformFeeCents,
          bookingDays,
        );

        // Create the pending holds inside a DB transaction with row-level locks on each event row.
        // This prevents two trucks from simultaneously booking the last spot and paying.
        let insertedHolds: any[] = [];
        try {
          insertedHolds = await db.transaction(async (tx: any) => {
            const now = new Date();
            const inserted: any[] = [];

            // Every multi-day request acquires event locks in the same order.
            for (let index = 0; index < sortedDateKeys.length; index += 1) {
              const dateKey = sortedDateKeys[index];
              const row = eventsByDate.get(dateKey);
              if (!row) {
                throw new Error("Missing parking pass date in booking range.");
              }

              // Lock this event row so capacity checks + hold insert are serialized.
              await tx.execute(
                sql`select ${events.id} from ${events} where ${events.id} = ${row.id} for update`,
              );
              // The preflight snapshot can be stale after waiting for this lock.
              const [lockedRow] = await tx.select().from(events)
                .where(eq(events.id, row.id)).limit(1);
              if (!lockedRow || lockedRow.hostId !== row.hostId ||
                  lockedRow.status !== "open" || !lockedRow.requiresPayment ||
                  new Date(lockedRow.date).getTime() !== new Date(row.date).getTime() ||
                  selectedSlotTypes.some((slot) =>
                    !isSlotWithinHours(slot, lockedRow.startTime, lockedRow.endTime))) {
                throw Object.assign(new Error("This parking pass changed while booking. Please refresh."), {
                  code: "BOOKING_AVAILABILITY_CHANGED",
                });
              }

              // Verify current eligibility inside admission, not just before a
              // possibly long lock wait. Share locks prevent verification edits
              // from committing between this read and the hold transaction.
              const [currentTruck] = await tx.select({
                businessType: restaurants.businessType,
                isFoodTruck: restaurants.isFoodTruck,
                insuranceVerified: restaurants.insuranceVerified,
                insuranceExpiresAt: restaurants.insuranceExpiresAt,
              }).from(restaurants).where(eq(restaurants.id, truckId)).for("share");
              const [currentUser] = await tx.select({
                userType: users.userType,
                emailVerified: users.emailVerified,
              }).from(users).where(eq(users.id, userId)).for("share");
              const currentEligibility = currentTruck && currentUser
                ? assessParkingPassTruckEligibility({ user: currentUser, truck: currentTruck })
                : null;
              if (!currentEligibility || !currentEligibility.isTruckProfile ||
                  !currentEligibility.roleAllowed ||
                  (!currentEligibility.shouldBypassVerificationGate &&
                    (!currentEligibility.emailVerified || !currentEligibility.storedInsuranceValid))) {
                throw Object.assign(new Error("Truck verification changed while booking. Please verify your account and insurance."), {
                  code: "TRUCK_ELIGIBILITY_CHANGED",
                });
              }

              const counts = await tx
                .select({ count: sql<number>`count(*)` })
                .from(eventBookings)
                .where(
                  and(
                    eq(eventBookings.eventId, row.id),
                    inArray(eventBookings.status, ["confirmed", "pending"]),
                  ),
                );

              const reservedCount = Number(counts[0]?.count || 0);
              const hardCapEnabled = Boolean(lockedRow.hardCapEnabled);
              const maxSpots = Math.max(1, Number(lockedRow.maxTrucks ?? 1) || 1);
              if (hardCapEnabled && reservedCount >= maxSpots) {
                const err: any = new Error(
                  "This parking pass is fully booked.",
                );
                err.code = "FULLY_BOOKED";
                throw err;
              }

              const hostCents = hostSplit[index] ?? 0;
              const feeCents = platformSplit[index] ?? 0;

              const [created] = await tx
                .insert(eventBookings)
                .values({
                  eventId: row.id,
                  truckId,
                  hostId: row.hostId,
                  hostPriceCents: hostCents,
                  platformFeeCents: feeCents,
                  totalCents: hostCents + feeCents,
                  status: "pending",
                  stripePaymentStatus: "pending",
                  stripeApplicationFeeAmount: hostStripeAccountId
                    ? feeCents
                    : null,
                  stripeTransferDestination: hostStripeAccountId,
                  slotType: selectedSlotTypes.join(","),
                  createdAt: now,
                  updatedAt: now,
                })
                .returning();

              if (!created) {
                throw new Error("Failed to reserve parking pass hold.");
              }

              inserted.push(created);
            }

            // The checkpoint and all holds commit together or roll back together.
            await recordParkingBookingHolds(tx, String(req.get("Idempotency-Key") || "").trim(), {
              userId, route: req.path, passId: String(event.id), truckId, hostId: String(host.id),
              bookingStartDate: sortedDateKeys[0], slotTypes: selectedSlotTypes.join(","),
              destination: hostStripeAccountId || null, holds: inserted,
              setup: { totalCents, hostPaymentsReady: hostPaymentsEnabled, breakdown: {
                hostPrice: adjustedHostPriceCents, platformFee: adjustedPlatformFeeCents,
                creditsApplied: creditAppliedCents, promoDiscount: promoDiscountCents,
                promoCode: normalizedPromoCode || undefined,
              } },
            });
            return inserted;
          });
        } catch (error: any) {
          if (error?.code === "BOOKING_AVAILABILITY_CHANGED") {
            return res.status(400).json({ message: error.message });
          }
          if (error?.code === "TRUCK_ELIGIBILITY_CHANGED") {
            return res.status(409).json({
              code: "truck_verification_required",
              message: error.message,
              onboardingPath: "/restaurant-signup?businessType=food_truck&source=parking-pass&step=verification",
            });
          }
          if (error?.code === "FULLY_BOOKED") {
            return res
              .status(400)
              .json({ message: "This parking pass is fully booked." });
          }

          // Unique constraint or race conditions should surface as "already booked" / "in progress".
          console.error("Failed to create booking holds:", error);
          return res.status(409).json({
            message:
              "Unable to reserve this parking pass right now. Please refresh and try again.",
          });
        }

        if (bypassStripe) {
          const holdIds = insertedHolds.map((row) => row.id);
          const now = new Date();
          if (holdIds.length > 0) {
            await db
              .update(eventBookings)
              .set({
                status: "confirmed",
                stripePaymentStatus: "bypassed",
                bookingConfirmedAt: now,
                paidAt: now,
                updatedAt: now,
              })
              .where(inArray(eventBookings.id, holdIds));
          }

          if (normalizedPromoCode === "BOOKFEE10") {
            try {
              const userRecord = await storage.getUser(userId);
              const existingSettings =
                (userRecord?.accountSettings as any) || {};
              const promos = existingSettings.promos || {};
              promos.bookingFee10 = {
                ...(promos.bookingFee10 || {}),
                redeemedAt: now.toISOString(),
                redeemedPaymentIntentId: "bypass",
                discountCents: promoDiscountCents,
                pendingPaymentIntentId: null,
                pendingAt: null,
              };
              await storage.updateUser(userId, {
                accountSettings: { ...existingSettings, promos } as any,
              });
            } catch {
              // ignore
            }
          }

          return res.json({
            bypassed: true,
            bookingIds: holdIds,
            totalCents,
            breakdown: {
              hostPrice: adjustedHostPriceCents,
              platformFee: adjustedPlatformFeeCents,
              creditsApplied: creditAppliedCents,
              promoDiscount: promoDiscountCents,
              promoCode: normalizedPromoCode || undefined,
            },
          });
        }

        // Create Stripe PaymentIntent.
        // Always create the intent on the platform account so the existing client Payment Element
        // can confirm with the platform publishable key. When host payouts are ready, attach
        // transfer_data.destination and application_fee_amount as a destination charge.
        // Otherwise, charge on the platform and record host earnings for later payout.
        if (!stripe) {
          return res.status(500).json({ message: "Stripe is not configured" });
        }

        let paymentIntent: Stripe.PaymentIntent;
        try {
          const intentParams: Stripe.PaymentIntentCreateParams = {
            amount: totalCents,
            currency: "usd",
            metadata: {
              bookingRequestKey: parkingBookingProviderKey(userId, req.path, String(req.get("Idempotency-Key") || "").trim()),
              passId: event.id,
              hostId: host.id,
              truckId,
              userId,
              slotTypes: selectedSlotTypes.join(","),
              bookingDays: bookingDays.toString(),
              bookingStartDate: sortedDateKeys[0],
              hostPriceCents: adjustedHostPriceCents.toString(),
              platformFeeCents: adjustedPlatformFeeCents.toString(),
              totalCents: totalCents.toString(),
              creditAppliedCents: creditAppliedCents.toString(),
              bookingPromoCode: normalizedPromoCode || "",
              bookingPromoDiscountCents: promoDiscountCents.toString(),
            },
          };

          if (hostStripeAccountId) {
            intentParams.application_fee_amount = adjustedPlatformFeeCents;
            intentParams.transfer_data = {
              destination: hostStripeAccountId,
            };
          }

          paymentIntent = await stripe.paymentIntents.create(intentParams, {
            idempotencyKey: parkingBookingProviderKey(userId, req.path, String(req.get("Idempotency-Key") || "").trim()),
          });
        } catch {
          // A returned error does not prove that the provider did nothing.
          // Retain capacity and any concurrently confirmed/paid state unchanged.
          // An error response preserves the transactional recovery checkpoint in
          // durableIdempotency and permits evidence-only same-reference recovery.
          // Do not turn uncertainty into a completed 202 or cancel these holds.
          const requestId = String(req.get("Idempotency-Key") || "").trim();
          console.error("[parking-pass-booking] Payment setup outcome is unresolved; reservations retained", {
            passId: event.id,
            hostId: host.id,
            truckId,
            userId,
            holdCount: insertedHolds.length,
          });
          res.setHeader("Retry-After", "5");
          return res.status(503).json({
            code: "booking_request_unresolved",
            requestId,
            message:
              "Payment setup could not be verified. Your reservation is retained. Retry this same request reference; do not start a new payment.",
          });
        }

        const holdIds = insertedHolds.map((row) => row.id);
        if (holdIds.length > 0) {
          await db
            .update(eventBookings)
            .set({
              stripePaymentIntentId: paymentIntent.id,
              updatedAt: new Date(),
            })
            .where(inArray(eventBookings.id, holdIds));
        }

        res.json({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
          totalCents,
          // hostPaymentsReady: true means the host has a fully-onboarded Stripe Connect
          // account and will receive their payout immediately after the booking is confirmed.
          // false means the payment is charged to the MealScout platform account and the
          // host payout will be processed once they complete Stripe Connect onboarding.
          hostPaymentsReady: hostPaymentsEnabled,
          breakdown: {
            hostPrice: adjustedHostPriceCents,
            platformFee: adjustedPlatformFeeCents,
            creditsApplied: creditAppliedCents,
            promoDiscount: promoDiscountCents,
            promoCode: normalizedPromoCode || undefined,
          },
        });

        if (normalizedPromoCode === "BOOKFEE10") {
          try {
            const userRecord = await storage.getUser(userId);
            const existingSettings = (userRecord?.accountSettings as any) || {};
            const promos = existingSettings.promos || {};
            promos.bookingFee10 = {
              ...(promos.bookingFee10 || {}),
              pendingPaymentIntentId: paymentIntent.id,
              pendingAt: new Date().toISOString(),
              discountCents: promoDiscountCents,
            };
            await storage.updateUser(userId, {
              accountSettings: { ...existingSettings, promos } as any,
            });
          } catch (error) {
            console.warn(
              "Failed to persist promo reservation (continuing):",
              error,
            );
          }
        }
      } catch (error: any) {
        console.error("Error creating booking:", error);
        res.status(500).json({ message: "Failed to create booking" });
      }
    },
  );
}
