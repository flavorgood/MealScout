import type { Express } from "express";
import { createHash, randomBytes } from "crypto";
import { and, eq, gt, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import { emailService } from "../emailService";
import { storage } from "../storage";
import { checkRateLimit } from "../documentValidation";
import { liveRestaurantLocationLimiter } from "../middleware/restaurantLocationRateLimit";
import { isAuthenticated } from "../unifiedAuth";
import { reverseGeocode } from "../utils/geocoding";
import { broadcastLocationUpdate, broadcastStatusUpdate } from "../websocket";
import { getSuppressedLocationResourceIds } from "../services/truckLocationTrust";
import {
  getActiveSocialConnection,
  listSocialConnectionStatus,
} from "../services/socialPublishing";
import {
  insertFoodTruckLocationSchema,
  eventBookings,
  events,
  moderationEvents,
  menuItems,
  menus,
  requestLogs,
  restaurants,
  socialPostQueue,
  socialPublishingConnections,
  telemetryEvents,
  truckManualSchedules,
  truckParkingReports,
  verificationRequests,
  updateRestaurantLocationSchema,
  updateRestaurantMobileSettingsSchema,
  updateRestaurantOperatingHoursSchema,
} from "@shared/schema";
import { computeProfileCompletionStatus } from "@shared/profileCompletionStatus";
import {
  MAX_LIVE_TRUCKS_RESPONSE_BYTES,
  PUBLIC_LIVE_TRUCKS_TIMEOUT_MS,
  clampArrayToMaxBytes,
  clampLiveTrucksLimit,
  isDeadlineError,
  withDeadline,
} from "@shared/searchResponseBounds";
import { getBusinessAccessContext } from "../services/businessTeamAccess";
import { getBusinessVerificationState } from "../services/businessVerificationState";
import { loadProfileCompletionEvidenceBatch } from "../services/profileCompletionEvidence";
import {
  MENU_REVISION_ALGORITHM,
  loadMenuRevisionEvidence,
} from "../services/menuRevision";
import { toPublicRestaurantListingArrayWithVisibility } from "../publicProfiles/toPublicRestaurantListingWithVisibility";
import { isPublicBusinessVisible } from "../utils/publicBusinessVisibility";
import { deriveProfileEvidenceQuarantineVisibility } from "../services/profileEvidenceQuarantine";

type AnalyticsAccessResult = {
  hasAccess: boolean;
  error?: string;
  subscriptionTier?: string;
};

type RestaurantOperationsRouteDependencies = {
  validateProfileAnalyticsAccess: (userId: string) => Promise<AnalyticsAccessResult>;
  hasCompleteProfileAccess: (userId: string) => Promise<boolean>;
};

type SocialPublishPlatform = "facebook" | "instagram" | "x";
type SocialOAuthSession = {
  provider: "meta" | "x";
  restaurantId: string;
  platform: SocialPublishPlatform;
  redirectPath: string;
  state: string;
  codeVerifier?: string;
  createdAt: string;
};

const META_API_VERSION = "v24.0";

function getPublicBaseUrl(req: any) {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/$/, "");
}

function getSocialPublishingConfig(req: any) {
  const baseUrl = getPublicBaseUrl(req);
  const metaConfigured = Boolean(
    process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET,
  );
  const xConfigured = Boolean(
    process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID,
  );

  return {
    baseUrl,
    platforms: {
      facebook: {
        provider: "meta",
        configured: metaConfigured,
        callbackUrl: `${baseUrl}/api/social-connections/meta/callback`,
      },
      instagram: {
        provider: "meta",
        configured: metaConfigured,
        callbackUrl: `${baseUrl}/api/social-connections/meta/callback`,
      },
      x: {
        provider: "x",
        configured: xConfigured,
        callbackUrl: `${baseUrl}/api/social-connections/x/callback`,
      },
    },
    missing: [
      !process.env.PUBLIC_BASE_URL && !process.env.APP_BASE_URL
        ? "PUBLIC_BASE_URL"
        : null,
      !process.env.FACEBOOK_APP_ID ? "FACEBOOK_APP_ID" : null,
      !process.env.FACEBOOK_APP_SECRET ? "FACEBOOK_APP_SECRET" : null,
      !xConfigured ? "X_CLIENT_ID" : null,
    ].filter(Boolean),
  };
}

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

const safePersistenceErrorContext = (error: unknown) => {
  const record = asRecord(error);
  return {
    errorName:
      typeof record.name === "string" ? record.name.slice(0, 80) : "Error",
    errorCode:
      typeof record.code === "string" ? record.code.slice(0, 80) : "unknown",
  };
};

export const sanitizeOwnerWorkspaceSettings = (
  value: unknown,
  options?: { includePendingMedia?: boolean },
) => {
  const settings = asRecord(value);
  const safeSettings: Record<string, unknown> = {};
  if (settings.publicActionLinks && typeof settings.publicActionLinks === "object") {
    safeSettings.publicActionLinks = settings.publicActionLinks;
  }
  if (Array.isArray(settings.publicGalleryImages)) {
    safeSettings.publicGalleryImages = options?.includePendingMedia
      ? settings.publicGalleryImages
      : settings.publicGalleryImages.filter(
          (item: unknown) => asRecord(item).publicApproved === true,
        );
  }
  if (settings.platforms && typeof settings.platforms === "object") {
    safeSettings.platforms = settings.platforms;
  }
  if (settings.triggers && typeof settings.triggers === "object") {
    safeSettings.triggers = settings.triggers;
  }
  if (typeof settings.promptBeforePost === "boolean") {
    safeSettings.promptBeforePost = settings.promptBeforePost;
  }
  return safeSettings;
};

export const sanitizeOwnerWorkspaceRestaurant = (
  restaurant: Record<string, any>,
  options?: { includePendingMedia?: boolean },
) => {
  const { rawData: _rawData, ...safeRestaurant } = restaurant;
  return {
    ...safeRestaurant,
    socialAutopostSettings: sanitizeOwnerWorkspaceSettings(
      restaurant.socialAutopostSettings,
      options,
    ),
  };
};

const sanitizeOwnerMutationRestaurant = (restaurant: Record<string, any>) =>
  sanitizeOwnerWorkspaceRestaurant(restaurant, { includePendingMedia: true });

export const mergeOwnerProfileActionLinks = (
  settingsValue: unknown,
  actionLinkUpdates: Record<string, unknown>,
) => {
  const settings = asRecord(settingsValue);
  return {
    ...settings,
    publicActionLinks: {
      ...asRecord(settings.publicActionLinks),
      ...actionLinkUpdates,
    },
  };
};

type OwnerSocialSettingsPatch = {
  platforms?: Record<string, boolean | undefined>;
  triggers?: Record<string, boolean | undefined>;
  promptBeforePost?: boolean;
};

export const mergeOwnerSocialSettings = (
  settingsValue: unknown,
  patch?: OwnerSocialSettingsPatch,
) => {
  const settings = asRecord(settingsValue);
  if (!patch) return settings;
  return {
    ...settings,
    ...(patch.platforms
      ? {
          platforms: {
            ...asRecord(settings.platforms),
            ...patch.platforms,
          },
        }
      : {}),
    ...(patch.triggers
      ? {
          triggers: {
            ...asRecord(settings.triggers),
            ...patch.triggers,
          },
        }
      : {}),
    ...(patch.promptBeforePost !== undefined
      ? { promptBeforePost: patch.promptBeforePost }
      : {}),
  };
};

const withLockedRestaurantSettings = async <T>(
  restaurantId: string,
  mutate: (tx: any, restaurant: Record<string, any>) => Promise<T>,
): Promise<T | null> =>
  db.transaction(async (tx: any) => {
    // Profile evidence decisions use this same restaurant-scoped lock. Every
    // read/merge/write of the shared settings document must serialize with
    // those decisions so an unrelated owner update cannot restore stale JSON.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${restaurantId}))`,
    );
    const [restaurant] = await tx
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1)
      .for("update");
    if (!restaurant) return null;
    return mutate(tx, restaurant as Record<string, any>);
  });

const isTruckRow = (restaurant: any) =>
  Boolean(
    restaurant?.isFoodTruck ||
      String(restaurant?.businessType || "").toLowerCase() === "food_truck",
  );

export const buildOwnerMenuApprovalState = (
  restaurant: any,
  menuItemCount: number,
  currentMenuRevision: string | null = null,
) => {
  const rawData = asRecord(restaurant?.rawData);
  const approval = asRecord(rawData.ownerMenuApproval);
  const status = String(approval.status || "").trim().toLowerCase();
  const rejectedMenuRevision = String(
    approval.rejectedMenuRevision || "",
  ).trim();
  const rejected =
    (status === "rejected" || status === "not_current") &&
    (currentMenuRevision
      ? rejectedMenuRevision === currentMenuRevision
      : !rejectedMenuRevision);
  const claimsAdminVerification =
    status === "admin_verified" && approval.adminApproved === true;
  const claimsOwnerApproval =
    status === "approved" || approval.ownerApproved === true;
  const approvedMenuRevision = String(
    approval.approvedMenuRevision || "",
  ).trim();
  const ownerApprovalMatchesCurrentRevision = Boolean(
    !rejected &&
      claimsOwnerApproval &&
      currentMenuRevision &&
      approvedMenuRevision === currentMenuRevision,
  );
  const adminVerified = Boolean(
    !rejected &&
      claimsAdminVerification &&
      currentMenuRevision &&
      approvedMenuRevision === currentMenuRevision,
  );
  const ownerApproved =
    ownerApprovalMatchesCurrentRevision && !adminVerified;
  const hasMenuSurface = Boolean(
    menuItemCount > 0 ||
      restaurant?.menuUrl ||
      restaurant?.menuImageUrl ||
      restaurant?.menuPdfUrl,
  );
  const canApproveCurrentMenu = Boolean(
    isTruckRow(restaurant) &&
      menuItemCount > 0 &&
      currentMenuRevision &&
      !rejected,
  );
  const ownerApprovalRequired = Boolean(
    canApproveCurrentMenu && !ownerApproved && !adminVerified,
  );
  return {
    status: rejected
      ? "rejected"
      : adminVerified
        ? "admin_verified"
        : ownerApproved
          ? "owner_approved"
          : ownerApprovalRequired
            ? "needs_owner_confirmation"
            : "unavailable",
    label: rejected
      ? "Menu unavailable / pending update"
      : adminVerified
        ? "MealScout-verified menu"
        : ownerApproved
          ? "Owner-approved menu"
          : ownerApprovalRequired
            ? "Menu added from available source — needs owner confirmation"
            : isTruckRow(restaurant) && hasMenuSurface
              ? "Add or import structured menu items before approval"
              : "Menu unavailable / pending update",
    ownerApproved,
    adminVerified,
    ownerApprovalRequired,
    canApproveCurrentMenu,
    approvalBlockedReason:
      isTruckRow(restaurant) && hasMenuSurface && !canApproveCurrentMenu && !rejected
        ? "structured_menu_required"
        : null,
    approvalStale:
      (claimsOwnerApproval || claimsAdminVerification) &&
      !ownerApproved &&
      !adminVerified &&
      !rejected,
    reviewedAt: String(approval.reviewedAt || "").trim() || null,
    skippedAt: String(approval.skippedAt || "").trim() || null,
  };
};

function getSafeRedirectPath(value: unknown, fallback = "/parking-pass?tab=schedule") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }
  return trimmed;
}

function appendSocialStatus(
  redirectPath: string,
  status: "connected" | "error",
  message?: string,
) {
  const url = new URL(redirectPath, "https://mealscout.local");
  url.searchParams.set("social", status);
  if (message) {
    url.searchParams.set("socialMessage", message.slice(0, 240));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function saveSession(req: any) {
  return new Promise<void>((resolve, reject) => {
    req.session.save((error: unknown) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function base64Url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createOAuthState() {
  return base64Url(randomBytes(32));
}

function createPkceChallenge(verifier: string) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function getSocialOAuthSession(req: any): SocialOAuthSession | null {
  return (req.session?.socialPublishOAuth || null) as SocialOAuthSession | null;
}

async function setSocialOAuthSession(req: any, value: SocialOAuthSession | null) {
  req.session.socialPublishOAuth = value;
  await saveSession(req);
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      body?.error?.message ||
      body?.error_description ||
      body?.message ||
      response.statusText ||
      "Provider request failed";
    throw new Error(message);
  }
  return body;
}

export function registerRestaurantOperationsRoutes(
  app: Express,
  {
    validateProfileAnalyticsAccess,
    hasCompleteProfileAccess,
  }: RestaurantOperationsRouteDependencies,
) {
  const isAdminLikeUserType = (userType?: string | null) =>
    userType === "admin" ||
    userType === "duper_admin" ||
    userType === "super_admin" ||
    userType === "staff";

  const buildProfileActivitySummary = async (userId: string) => {
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);
    windowStart.setDate(windowStart.getDate() - 6);

    const ownedRestaurants = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.ownerId, userId));

    const restaurantIds = ownedRestaurants.map(
      (restaurant: { id: string }) => restaurant.id,
    );

    if (restaurantIds.length === 0) {
      return {
        hasAccess: true,
        weekStart: windowStart.toISOString(),
        weekEnd: now.toISOString(),
        restaurantCount: 0,
        stopsCovered: 0,
        liveLocationActivations: 0,
        manualScheduleUsage: 0,
        parkingReportsCompleted: 0,
      };
    }

    const [manualSchedules, parkingReports, liveLocationEvents] =
      await Promise.all([
        db
          .select({
            id: truckManualSchedules.id,
            date: truckManualSchedules.date,
            address: truckManualSchedules.address,
          })
          .from(truckManualSchedules)
          .where(
            and(
              inArray(truckManualSchedules.truckId, restaurantIds),
              gte(truckManualSchedules.createdAt, windowStart),
            ),
          ),
        db
          .select({
            id: truckParkingReports.id,
            date: truckParkingReports.date,
            address: truckParkingReports.address,
            locationName: truckParkingReports.locationName,
          })
          .from(truckParkingReports)
          .where(
            and(
              inArray(truckParkingReports.truckId, restaurantIds),
              gte(truckParkingReports.createdAt, windowStart),
            ),
          ),
        db
          .select({ id: telemetryEvents.id })
          .from(telemetryEvents)
          .where(
            and(
              eq(telemetryEvents.eventName, "premium_live_location_used"),
              eq(telemetryEvents.userId, userId),
              gte(telemetryEvents.createdAt, windowStart),
            ),
          ),
      ]);

    const stopKeys = new Set<string>();
    for (const schedule of manualSchedules) {
      const dateKey = schedule.date
        ? schedule.date.toISOString().split("T")[0]
        : "unknown-date";
      const addressKey = String(schedule.address || "unknown-address").trim();
      stopKeys.add(`${dateKey}:${addressKey}`);
    }

    for (const report of parkingReports) {
      const dateKey = report.date
        ? report.date.toISOString().split("T")[0]
        : "unknown-date";
      const place = String(
        report.address || report.locationName || report.id || "unknown-place",
      ).trim();
      stopKeys.add(`${dateKey}:${place}`);
    }

    return {
      hasAccess: true,
      weekStart: windowStart.toISOString(),
      weekEnd: now.toISOString(),
      restaurantCount: restaurantIds.length,
      stopsCovered: stopKeys.size,
      liveLocationActivations: liveLocationEvents.length,
      manualScheduleUsage: manualSchedules.length,
      parkingReportsCompleted: parkingReports.length,
    };
  };

  app.get(
    "/api/restaurants/my-restaurants",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const attachVerificationState = async (
          rows: any[],
          canManageProfileIds: Set<string>,
        ) => {
          if (!rows.length) return rows;
          const ids = rows.map((row) => row.id);
          const [verificationRows, menuCountRows, completionEvidenceByRestaurant] =
            await Promise.all([
            db
              .select({
                restaurantId: verificationRequests.restaurantId,
                status: verificationRequests.status,
                documents: verificationRequests.documents,
                licenseNumber: verificationRequests.licenseNumber,
                submittedAt: verificationRequests.submittedAt,
              })
              .from(verificationRequests)
              .where(inArray(verificationRequests.restaurantId, ids))
              .orderBy(sql`${verificationRequests.submittedAt} desc nulls last`),
            db
              .select({
                restaurantId: menuItems.restaurantId,
                count: sql<number>`count(*)::integer`,
              })
              .from(menuItems)
              .where(inArray(menuItems.restaurantId, ids))
              .groupBy(menuItems.restaurantId),
            loadProfileCompletionEvidenceBatch(ids.map((id) => String(id))),
          ]);

          const latestByRestaurant = new Map<string, any>();
          for (const row of verificationRows) {
            const restaurantId = String(row.restaurantId || "");
            if (!restaurantId || latestByRestaurant.has(restaurantId)) continue;
            latestByRestaurant.set(restaurantId, row);
          }
          const menuCountByRestaurant = new Map<string, number>();
          for (const row of menuCountRows) {
            menuCountByRestaurant.set(
              String(row.restaurantId || ""),
              Number(row.count || 0),
            );
          }

          return rows.map((restaurant) => {
            const latestVerification = latestByRestaurant.get(String(restaurant.id));
            const menuItemCount = menuCountByRestaurant.get(String(restaurant.id)) || 0;
            const completionEvidence = completionEvidenceByRestaurant.get(
              String(restaurant.id),
            );
            const businessInsuranceSubmitted =
              Boolean(String(latestVerification?.licenseNumber || "").trim()) ||
              (Array.isArray(latestVerification?.documents) &&
                latestVerification.documents.length > 0) ||
              String(latestVerification?.status || "").toLowerCase() === "approved";
            return sanitizeOwnerWorkspaceRestaurant(
              {
                ...restaurant,
                menuItemCount,
                menuApproval: buildOwnerMenuApprovalState(
                  restaurant,
                  menuItemCount,
                  completionEvidence?.menuRevision || null,
                ),
                profileCompletionTruth: completionEvidence?.truth || null,
                truckOperatingPlan:
                  completionEvidence?.truckOperatingPlan || null,
                verificationState: getBusinessVerificationState({
                  isActive: restaurant.isActive,
                  isVerified: restaurant.isVerified,
                  insuranceVerified: restaurant.insuranceVerified,
                  insuranceExpiresAt: restaurant.insuranceExpiresAt,
                  emailVerified: req.user?.emailVerified === true,
                  businessInsuranceSubmitted,
                  claimedFromImportId: restaurant.claimedFromImportId,
                }),
              },
              {
                includePendingMedia: canManageProfileIds.has(
                  String(restaurant.id),
                ),
              },
            );
          });
        };

        // This endpoint is account-scoped for every role. Admin inventory has
        // dedicated routes; returning the full restaurant table here can make
        // ordinary owner tools serialize an unbounded payload.
        const restaurantsByOwner = await storage.getRestaurantsByOwner(req.user.id);
        const context = await getBusinessAccessContext(req.user.id);
        const canManageProfileIds = new Set(
          context.restaurants
            .filter(
              (restaurant) =>
                restaurant.isOwner || restaurant.permissions.manageProfile,
            )
            .map((restaurant) => String(restaurant.id)),
        );

        const ownedIds = new Set(restaurantsByOwner.map((r: any) => r.id));
        const collaboratorRestaurantIds = context.restaurants
          .filter((r) => !r.isOwner)
          .map((r) => r.id);

        if (!collaboratorRestaurantIds.length) {
          return res.json(
            await attachVerificationState(
              restaurantsByOwner as any[],
              canManageProfileIds,
            ),
          );
        }

        const collaboratorRestaurants = await db
          .select()
          .from(restaurants)
          .where(inArray(restaurants.id, collaboratorRestaurantIds));

        const merged = [...restaurantsByOwner];
        for (const restaurant of collaboratorRestaurants) {
          if (!ownedIds.has(restaurant.id)) {
            merged.push(restaurant);
          }
        }

        res.json(
          await attachVerificationState(merged as any[], canManageProfileIds),
        );
      } catch (error) {
        console.error("Error fetching user restaurants:", error);
        res.status(500).json({ message: "Failed to fetch restaurants" });
      }
    },
  );

  app.patch(
    "/api/restaurants/:restaurantId/menu-approval",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const canBypassOwnership = isAdminLikeUserType(req.user?.userType);
        if (!canBypassOwnership) {
          const isAuthorized = await storage.verifyRestaurantOwnership(
            restaurantId,
            req.user.id,
            "manageProfile",
          );
          if (!isAuthorized) {
            return res.status(403).json({
              message:
                "Unauthorized: You can only review menus for restaurants you own",
            });
          }
        }

        const body = z
          .object({
            action: z.enum(["approve", "reject", "skip"]),
            note: z.string().trim().max(1000).optional().nullable(),
          })
          .parse(req.body || {});

        const [restaurant] = await db
          .select()
          .from(restaurants)
          .where(eq(restaurants.id, restaurantId))
          .limit(1);
        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }
        if (!isTruckRow(restaurant)) {
          return res.status(400).json({
            message: "Menu owner approval gate is only required for food trucks",
          });
        }

        const menuRevisionEvidence = await loadMenuRevisionEvidence(restaurantId);
        const menuItemCount = menuRevisionEvidence.publicItemCount;
        if (
          body.action === "approve" &&
          (menuItemCount <= 0 || !menuRevisionEvidence.revision)
        ) {
          return res.status(409).json({
            message: "Cannot approve an empty menu",
          });
        }

        const updated = await withLockedRestaurantSettings(
          restaurantId,
          async (tx, lockedRestaurant) => {
            const currentApproval = buildOwnerMenuApprovalState(
              lockedRestaurant,
              menuItemCount,
              menuRevisionEvidence.revision,
            );
            const rawData = asRecord(lockedRestaurant.rawData);
            const now = new Date().toISOString();
            const ownerMenuApproval = {
              ...asRecord(rawData.ownerMenuApproval),
              status:
                body.action === "approve"
                  ? "approved"
                  : body.action === "reject"
                    ? "rejected"
                    : "skipped",
              ownerApproved: body.action === "approve",
              ownerApprovalRequired: body.action === "skip",
              reviewedByUserId: req.user.id,
              reviewedAt: body.action === "skip" ? null : now,
              skippedAt: body.action === "skip" ? now : null,
              note: String(body.note || "").trim() || null,
              previousStatus: currentApproval.status,
              approvedMenuRevision:
                body.action === "approve"
                  ? menuRevisionEvidence.revision
                  : null,
              approvedMenuRevisionAlgorithm:
                body.action === "approve" ? MENU_REVISION_ALGORITHM : null,
              rejectedMenuRevision:
                body.action === "reject"
                  ? menuRevisionEvidence.revision
                  : null,
              rejectedMenuRevisionAlgorithm:
                body.action === "reject" && menuRevisionEvidence.revision
                  ? MENU_REVISION_ALGORITHM
                  : null,
            };
            const [nextRestaurant] = await tx
              .update(restaurants)
              .set({
                rawData: {
                  ...rawData,
                  ownerMenuApproval,
                } as any,
                updatedAt: new Date(),
              } as any)
              .where(eq(restaurants.id, restaurantId))
              .returning();
            return nextRestaurant;
          },
        );
        if (!updated) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        res.json({
          menuApproval: buildOwnerMenuApprovalState(
            updated,
            menuItemCount,
            menuRevisionEvidence.revision,
          ),
        });
      } catch (error) {
        console.error(
          "Owner menu approval persistence failed",
          safePersistenceErrorContext(error),
        );
        res.status(500).json({ message: "Failed to update menu approval" });
      }
    },
  );

  app.patch(
    "/api/restaurants/:restaurantId/profile-basics",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const canBypassOwnership = isAdminLikeUserType(req.user?.userType);
        if (!canBypassOwnership) {
          const isAuthorized = await storage.verifyRestaurantOwnership(
            restaurantId,
            req.user.id,
            "manageProfile",
          );
          if (!isAuthorized) {
            return res.status(403).json({
              message:
                "Unauthorized: You can only update profile details for restaurants you own",
            });
          }
        }

        const profileSchema = z.object({
          isActive: z.boolean().optional(),
          name: z.string().trim().min(1).max(160).optional(),
          description: z.string().trim().max(4000).optional().nullable(),
          cuisineType: z.string().trim().max(160).optional().nullable(),
          address: z.string().trim().max(240).optional().nullable(),
          city: z.string().trim().max(120).optional().nullable(),
          state: z.string().trim().max(120).optional().nullable(),
          phone: z.string().trim().max(40).optional().nullable(),
          websiteUrl: z.string().trim().max(500).optional().nullable(),
          facebookPageUrl: z.string().trim().max(500).optional().nullable(),
          instagramUrl: z.string().trim().max(500).optional().nullable(),
          xUrl: z.string().trim().max(500).optional().nullable(),
          menuUrl: z.string().trim().max(500).optional().nullable(),
          logoUrl: z.string().trim().max(500).optional().nullable(),
          coverImageUrl: z.string().trim().max(500).optional().nullable(),
          onlineOrderingUrl: z.string().trim().max(500).optional().nullable(),
          deliveryUrl: z.string().trim().max(500).optional().nullable(),
          doordashUrl: z.string().trim().max(500).optional().nullable(),
          uberEatsUrl: z.string().trim().max(500).optional().nullable(),
          toastUrl: z.string().trim().max(500).optional().nullable(),
          squareUrl: z.string().trim().max(500).optional().nullable(),
          chowNowUrl: z.string().trim().max(500).optional().nullable(),
          grubhubUrl: z.string().trim().max(500).optional().nullable(),
          cateringInquiryUrl: z.string().trim().max(500).optional().nullable(),
          truckBookingInquiryUrl: z.string().trim().max(500).optional().nullable(),
        });

        const parsed = profileSchema.parse(req.body || {});
        const normalize = (value: unknown) => {
          const text = String(value ?? "").trim();
          return text.length > 0 ? text : null;
        };

        const actionLinkKeys = new Set([
          "onlineOrderingUrl",
          "deliveryUrl",
          "doordashUrl",
          "uberEatsUrl",
          "toastUrl",
          "squareUrl",
          "chowNowUrl",
          "grubhubUrl",
          "cateringInquiryUrl",
          "truckBookingInquiryUrl",
        ]);

        const baseUpdates = Object.fromEntries(
          Object.entries(parsed)
            .filter(([key, value]) => value !== undefined && !actionLinkKeys.has(key))
            .map(([key, value]) => [
              key,
              key === "isActive" ? value : normalize(value),
            ]),
        );

        const actionLinkUpdates = Object.fromEntries(
          Object.entries(parsed)
            .filter(([key, value]) => value !== undefined && actionLinkKeys.has(key))
            .map(([key, value]) => [key, normalize(value)]),
        );

        if (
          Object.keys(baseUpdates).length === 0 &&
          Object.keys(actionLinkUpdates).length === 0
        ) {
          return res.status(400).json({ message: "No profile fields provided" });
        }

        const updatedRestaurant = await withLockedRestaurantSettings(
          restaurantId,
          async (tx, lockedRestaurant) => {
            if (parsed.isActive === true && lockedRestaurant.isVerified !== true) {
              throw Object.assign(
                new Error("Only a verified claimed profile can be published"),
                { statusCode: 409 },
              );
            }
            const updates: Record<string, unknown> = {
              ...baseUpdates,
              updatedAt: new Date(),
            };
            if (Object.keys(actionLinkUpdates).length > 0) {
              const existingSettings = asRecord(
                lockedRestaurant.socialAutopostSettings,
              );
              updates.socialAutopostSettings = mergeOwnerProfileActionLinks(
                existingSettings,
                actionLinkUpdates,
              );
            }
            const [updated] = await tx
              .update(restaurants)
              .set(updates as any)
              .where(eq(restaurants.id, restaurantId))
              .returning();
            return updated;
          },
        );
        if (!updatedRestaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        res.json({
          success: true,
          restaurant: sanitizeOwnerMutationRestaurant(updatedRestaurant),
        });
      } catch (error) {
        console.error(
          "Restaurant profile basics update failed",
          safePersistenceErrorContext(error),
        );
        res.status(400).json({
          message:
            error instanceof z.ZodError
              ? "Invalid business profile fields"
              : "Failed to update business profile",
        });
      }
    },
  );

  app.get(
    "/api/business/premium-weekly-summary",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message: "Profile access could not be verified for the weekly summary.",
            hasAccess: false,
          });
        }

        const summary = await buildProfileActivitySummary(req.user.id);

        await db.insert(telemetryEvents).values({
          eventName: "premium_summary_viewed",
          userId: req.user.id,
          properties: {
            weekStart: summary.weekStart,
            weekEnd: summary.weekEnd,
            restaurantCount: summary.restaurantCount,
          },
        });

        res.json(summary);
      } catch (error) {
        console.error("Error fetching profile activity summary:", error);
        res.status(500).json({ message: "Failed to fetch weekly summary" });
      }
    },
  );

  app.post(
    "/api/business/premium-weekly-summary/email",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message: "Profile access could not be verified for the weekly summary.",
          });
        }

        const user = await storage.getUser(req.user.id);
        const recipientEmail = String(user?.email || "").trim();
        if (!recipientEmail) {
          return res
            .status(400)
            .json({ message: "No account email found for this user." });
        }

        const summary = await buildProfileActivitySummary(req.user.id);
        const recipientName =
          String(user?.firstName || "").trim() || "MealScout operator";

        const sent = await emailService.sendProfileActivitySummaryEmail(
          recipientEmail,
          recipientName,
          {
            weekStart: summary.weekStart,
            weekEnd: summary.weekEnd,
            stopsCovered: summary.stopsCovered,
            liveLocationActivations: summary.liveLocationActivations,
            manualScheduleUsage: summary.manualScheduleUsage,
            parkingReportsCompleted: summary.parkingReportsCompleted,
          },
        );

        if (!sent) {
          return res.status(500).json({
            message: "Failed to send weekly summary email.",
          });
        }

        await db.insert(telemetryEvents).values({
          eventName: "premium_summary_emailed",
          userId: req.user.id,
          properties: {
            recipientEmail,
            weekStart: summary.weekStart,
            weekEnd: summary.weekEnd,
          },
        });

        res.json({ ok: true });
      } catch (error) {
        console.error("Error emailing profile activity summary:", error);
        res.status(500).json({ message: "Failed to send weekly summary" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/stats",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const deals = await storage.getDealsByRestaurant(
          req.params.restaurantId,
        );
        const stats = {
          totalDeals: deals.length,
          activeDeals: deals.filter((deal) => deal.isActive).length,
          totalViews: deals.reduce(
            (sum, deal) => sum + ((deal as any).viewCount || 0),
            0,
          ),
          totalClaims: deals.reduce(
            (sum, deal) => sum + (deal.currentUses || 0),
            0,
          ),
          conversionRate: 0,
        };

        if (stats.totalViews > 0) {
          stats.conversionRate = (stats.totalClaims / stats.totalViews) * 100;
        }

        res.json(stats);
      } catch (error) {
        console.error("Error fetching restaurant stats:", error);
        res.status(500).json({ message: "Failed to fetch stats" });
      }
    },
  );

  app.patch(
    "/api/restaurants/:restaurantId/mobile-settings",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only update settings for restaurants you own",
          });
        }

        const settings = updateRestaurantMobileSettingsSchema.parse(req.body);
        const updatedRestaurant = await storage.setRestaurantMobileSettings(
          restaurantId,
          settings,
        );

        if (settings.mobileOnline !== undefined) {
          broadcastStatusUpdate(restaurantId, {
            isOnline: updatedRestaurant.mobileOnline || false,
            mobileOnline: updatedRestaurant.mobileOnline || false,
          });
        }

        res.json({
          success: true,
          restaurant: sanitizeOwnerMutationRestaurant(updatedRestaurant),
        });
      } catch (error) {
        console.error("Error updating mobile settings:", error);
        res.status(400).json({
          message:
            error instanceof Error
              ? error.message
              : "Failed to update mobile settings",
        });
      }
    },
  );

  app.patch(
    "/api/restaurants/:restaurantId/location",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only update location for restaurants you own",
          });
        }

        const locationData = updateRestaurantLocationSchema.parse(req.body);
        const resolvedLocation = await reverseGeocode(
          locationData.latitude,
          locationData.longitude,
        );
        const updatedRestaurant = await storage.updateRestaurantLocation(
          restaurantId,
          {
            ...locationData,
            city: resolvedLocation.city,
            state: resolvedLocation.state,
          },
        );

        res.json({
          success: true,
          restaurant: sanitizeOwnerMutationRestaurant(updatedRestaurant),
        });
      } catch (error) {
        console.error("Error updating restaurant location:", error);
        res.status(400).json({
          message:
            error instanceof Error
              ? error.message
              : "Failed to update location",
        });
      }
    },
  );

  app.patch(
    "/api/restaurants/:restaurantId/operating-hours",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only update operating hours for restaurants you own",
          });
        }

        const hoursData = updateRestaurantOperatingHoursSchema.parse(req.body);
        const updatedRestaurant = await storage.setRestaurantOperatingHours(
          restaurantId,
          hoursData.operatingHours,
        );

        res.json({
          success: true,
          restaurant: sanitizeOwnerMutationRestaurant(updatedRestaurant),
        });
      } catch (error) {
        console.error("Error updating operating hours:", error);
        res.status(400).json({
          message:
            error instanceof Error
              ? error.message
              : "Failed to update operating hours",
        });
      }
    },
  );

  app.patch(
    "/api/restaurants/:restaurantId/social-settings",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message:
              "Profile access could not be verified for social publishing.",
          });
        }

        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only update social settings for restaurants you own",
          });
        }

        const socialAutopostSettingsSchema = z
          .object({
            platforms: z
              .object({
                facebook: z.boolean().optional(),
                instagram: z.boolean().optional(),
                x: z.boolean().optional(),
              })
              .strict()
              .optional(),
            triggers: z
              .object({
                schedule: z.boolean().optional(),
                booking: z.boolean().optional(),
                live: z.boolean().optional(),
                deal: z.boolean().optional(),
              })
              .strict()
              .optional(),
            promptBeforePost: z.boolean().optional(),
          })
          .strict();
        const schema = z.object({
          facebookPageUrl: z
            .string()
            .url()
            .optional()
            .nullable()
            .or(z.literal("")),
          instagramUrl: z
            .string()
            .url()
            .optional()
            .nullable()
            .or(z.literal("")),
          xUrl: z.string().url().optional().nullable().or(z.literal("")),
          socialAutopostSettings: socialAutopostSettingsSchema.optional(),
        });

        const parsed = schema.parse(req.body);
        const updated = await withLockedRestaurantSettings(
          restaurantId,
          async (tx, lockedRestaurant) => {
            const existingSettings = asRecord(
              lockedRestaurant.socialAutopostSettings,
            );
            const nextSettings = mergeOwnerSocialSettings(
              existingSettings,
              parsed.socialAutopostSettings,
            );
            const updates: Record<string, unknown> = {
              socialAutopostSettings: nextSettings,
              updatedAt: new Date(),
            };
            if (parsed.facebookPageUrl !== undefined) {
              updates.facebookPageUrl = parsed.facebookPageUrl || null;
            }
            if (parsed.instagramUrl !== undefined) {
              updates.instagramUrl = parsed.instagramUrl || null;
            }
            if (parsed.xUrl !== undefined) {
              updates.xUrl = parsed.xUrl || null;
            }
            const [nextRestaurant] = await tx
              .update(restaurants)
              .set(updates)
              .where(eq(restaurants.id, restaurantId))
              .returning();
            return nextRestaurant;
          },
        );
        if (!updated) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        res.json({
          success: true,
          restaurant: sanitizeOwnerMutationRestaurant(updated),
        });
      } catch (error) {
        console.error(
          "Restaurant social settings update failed",
          safePersistenceErrorContext(error),
        );
        res.status(400).json({
          message:
            error instanceof z.ZodError
              ? "Invalid social settings"
              : "Failed to update social settings",
        });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/social-connections/status",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only view social connections for restaurants you own",
          });
        }

        const connections = await listSocialConnectionStatus(restaurantId);
        res.json({
          restaurantId,
          connections,
          publishingConfig: getSocialPublishingConfig(req),
        });
      } catch (error) {
        console.error("Error loading social connections:", error);
        res.status(500).json({ message: "Failed to load social connections" });
      }
    },
  );

  app.post(
    "/api/restaurants/:restaurantId/social-connections",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only connect social accounts for restaurants you own",
          });
        }

        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message: "Profile access could not be verified for publishing.",
          });
        }

        const schema = z.object({
          platform: z.enum(["facebook", "instagram", "x"]),
          displayName: z.string().trim().max(160).optional().nullable(),
          externalAccountId: z.string().trim().max(200).optional().nullable(),
          externalAccountUrl: z
            .string()
            .url()
            .optional()
            .nullable()
            .or(z.literal("")),
          accessToken: z.string().trim().min(1).max(10000),
          refreshToken: z.string().trim().max(10000).optional().nullable(),
          tokenExpiresAt: z.string().datetime().optional().nullable(),
          scopes: z.array(z.string().trim()).optional().default([]),
          metadata: z.record(z.any()).optional().default({}),
        });
        const parsed = schema.parse(req.body || {});
        const tokenExpiresAt = parsed.tokenExpiresAt
          ? new Date(parsed.tokenExpiresAt)
          : null;

        const [connection] = await db
          .insert(socialPublishingConnections)
          .values({
            restaurantId,
            createdByUserId: req.user.id,
            platform: parsed.platform,
            displayName: parsed.displayName || null,
            externalAccountId: parsed.externalAccountId || null,
            externalAccountUrl: parsed.externalAccountUrl || null,
            accessToken: parsed.accessToken,
            refreshToken: parsed.refreshToken || null,
            tokenExpiresAt,
            scopes: parsed.scopes,
            metadata: parsed.metadata,
            status: "active",
            lastError: null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              socialPublishingConnections.restaurantId,
              socialPublishingConnections.platform,
            ],
            set: {
              createdByUserId: req.user.id,
              displayName: parsed.displayName || null,
              externalAccountId: parsed.externalAccountId || null,
              externalAccountUrl: parsed.externalAccountUrl || null,
              accessToken: parsed.accessToken,
              refreshToken: parsed.refreshToken || null,
              tokenExpiresAt,
              scopes: parsed.scopes,
              metadata: parsed.metadata,
              status: "active",
              lastError: null,
              updatedAt: new Date(),
            },
          })
          .returning();

        res.status(201).json({
          ...connection,
          accessToken: undefined,
          refreshToken: undefined,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({
            message: "Invalid social connection",
            errors: error.errors,
          });
        }
        console.error("Error saving social connection:", error);
        res.status(500).json({ message: "Failed to save social connection" });
      }
    },
  );

  app.delete(
    "/api/restaurants/:restaurantId/social-connections/:platform",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId, platform } = req.params;
        if (!["facebook", "instagram", "x"].includes(platform)) {
          return res.status(400).json({ message: "Invalid platform" });
        }

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only disconnect social accounts for restaurants you own",
          });
        }

        await db
          .update(socialPublishingConnections)
          .set({
            accessToken: null,
            refreshToken: null,
            tokenExpiresAt: null,
            status: "disconnected",
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(socialPublishingConnections.restaurantId, restaurantId),
              eq(socialPublishingConnections.platform, platform),
            ),
          );

        res.json({ success: true });
      } catch (error) {
        console.error("Error disconnecting social connection:", error);
        res
          .status(500)
          .json({ message: "Failed to disconnect social connection" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/social-connections/meta/start",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const platform = String(req.query.platform || "facebook").toLowerCase();
        if (platform !== "facebook" && platform !== "instagram") {
          return res.status(400).json({ message: "Invalid Meta platform" });
        }

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only connect social accounts for restaurants you own",
          });
        }

        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message: "Profile access could not be verified for publishing.",
          });
        }

        const clientId = process.env.FACEBOOK_APP_ID;
        const clientSecret = process.env.FACEBOOK_APP_SECRET;
        if (!clientId || !clientSecret) {
          return res.status(503).json({
            message: "Meta publishing is not configured on this environment.",
          });
        }

        const state = createOAuthState();
        const redirectUri = `${getPublicBaseUrl(req)}/api/social-connections/meta/callback`;
        await setSocialOAuthSession(req, {
          provider: "meta",
          restaurantId,
          platform,
          redirectPath: getSafeRedirectPath(req.query.redirect),
          state,
          createdAt: new Date().toISOString(),
        });

        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          response_type: "code",
          scope: [
            "pages_show_list",
            "pages_read_engagement",
            "pages_manage_posts",
            "instagram_basic",
            "instagram_content_publish",
          ].join(","),
        });

        res.redirect(
          `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?${params.toString()}`,
        );
      } catch (error) {
        console.error("Error starting Meta social connection:", error);
        res
          .status(500)
          .json({ message: "Failed to start Meta publishing connection" });
      }
    },
  );

  app.get(
    "/api/social-connections/meta/callback",
    isAuthenticated,
    async (req: any, res) => {
      const oauth = getSocialOAuthSession(req);
      const redirectPath = oauth?.redirectPath || "/parking-pass?tab=schedule";
      try {
        const code = String(req.query.code || "");
        const state = String(req.query.state || "");
        if (!oauth || oauth.provider !== "meta" || oauth.state !== state) {
          return res.redirect(
            appendSocialStatus(redirectPath, "error", "Connection expired"),
          );
        }
        if (!code) {
          return res.redirect(
            appendSocialStatus(redirectPath, "error", "Meta did not approve"),
          );
        }

        const clientId = process.env.FACEBOOK_APP_ID;
        const clientSecret = process.env.FACEBOOK_APP_SECRET;
        if (!clientId || !clientSecret) {
          return res.redirect(
            appendSocialStatus(redirectPath, "error", "Meta is not configured"),
          );
        }

        const redirectUri = `${getPublicBaseUrl(req)}/api/social-connections/meta/callback`;
        const tokenParams = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        });
        const token = await fetchJson(
          `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?${tokenParams.toString()}`,
        );

        const exchangeParams = new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: clientId,
          client_secret: clientSecret,
          fb_exchange_token: token.access_token,
        });
        const longLived = await fetchJson(
          `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?${exchangeParams.toString()}`,
        );
        const userAccessToken = longLived.access_token || token.access_token;

        const pageParams = new URLSearchParams({
          fields:
            "id,name,link,access_token,instagram_business_account{id,username}",
          access_token: userAccessToken,
        });
        const pagesPayload = await fetchJson(
          `https://graph.facebook.com/${META_API_VERSION}/me/accounts?${pageParams.toString()}`,
        );
        const pages = Array.isArray(pagesPayload?.data)
          ? pagesPayload.data
          : [];
        const selectedPage =
          oauth.platform === "instagram"
            ? pages.find((page: any) => page?.instagram_business_account?.id)
            : pages[0];

        if (!selectedPage?.id || !selectedPage?.access_token) {
          return res.redirect(
            appendSocialStatus(
              redirectPath,
              "error",
              oauth.platform === "instagram"
                ? "No Instagram Business account found"
                : "No Facebook Page found",
            ),
          );
        }

        const instagramAccount = selectedPage.instagram_business_account || null;
        const externalAccountUrl =
          oauth.platform === "instagram" && instagramAccount?.username
            ? `https://www.instagram.com/${instagramAccount.username}`
            : selectedPage.link || null;
        const displayName =
          oauth.platform === "instagram"
            ? instagramAccount?.username || selectedPage.name || "Instagram"
            : selectedPage.name || "Facebook Page";

        const [connection] = await db
          .insert(socialPublishingConnections)
          .values({
            restaurantId: oauth.restaurantId,
            createdByUserId: req.user.id,
            platform: oauth.platform,
            displayName,
            externalAccountId:
              oauth.platform === "instagram"
                ? instagramAccount?.id
                : selectedPage.id,
            externalAccountUrl,
            accessToken: selectedPage.access_token,
            refreshToken: userAccessToken,
            tokenExpiresAt: longLived.expires_in
              ? new Date(Date.now() + Number(longLived.expires_in) * 1000)
              : null,
            scopes: [
              "pages_show_list",
              "pages_read_engagement",
              "pages_manage_posts",
              "instagram_basic",
              "instagram_content_publish",
            ],
            metadata: {
              provider: "meta",
              pageId: selectedPage.id,
              pageName: selectedPage.name || null,
              instagramBusinessAccountId: instagramAccount?.id || null,
              instagramUsername: instagramAccount?.username || null,
            },
            status: "active",
            lastError: null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              socialPublishingConnections.restaurantId,
              socialPublishingConnections.platform,
            ],
            set: {
              createdByUserId: req.user.id,
              displayName,
              externalAccountId:
                oauth.platform === "instagram"
                  ? instagramAccount?.id
                  : selectedPage.id,
              externalAccountUrl,
              accessToken: selectedPage.access_token,
              refreshToken: userAccessToken,
              tokenExpiresAt: longLived.expires_in
                ? new Date(Date.now() + Number(longLived.expires_in) * 1000)
                : null,
              scopes: [
                "pages_show_list",
                "pages_read_engagement",
                "pages_manage_posts",
                "instagram_basic",
                "instagram_content_publish",
              ],
              metadata: {
                provider: "meta",
                pageId: selectedPage.id,
                pageName: selectedPage.name || null,
                instagramBusinessAccountId: instagramAccount?.id || null,
                instagramUsername: instagramAccount?.username || null,
              },
              status: "active",
              lastError: null,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (connection.externalAccountUrl) {
          await db
            .update(restaurants)
            .set({
              facebookPageUrl:
                oauth.platform === "facebook"
                  ? connection.externalAccountUrl
                  : undefined,
              instagramUrl:
                oauth.platform === "instagram"
                  ? connection.externalAccountUrl
                  : undefined,
              updatedAt: new Date(),
            })
            .where(eq(restaurants.id, oauth.restaurantId));
        }

        await setSocialOAuthSession(req, null);
        res.redirect(appendSocialStatus(redirectPath, "connected"));
      } catch (error) {
        console.error("Error completing Meta social connection:", error);
        await setSocialOAuthSession(req, null).catch(() => undefined);
        res.redirect(
          appendSocialStatus(
            redirectPath,
            "error",
            error instanceof Error ? error.message : "Meta connection failed",
          ),
        );
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/social-connections/x/start",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only connect social accounts for restaurants you own",
          });
        }

        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message: "Profile access could not be verified for publishing.",
          });
        }

        const clientId = process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID;
        if (!clientId) {
          return res.status(503).json({
            message: "X publishing is not configured on this environment.",
          });
        }

        const state = createOAuthState();
        const codeVerifier = base64Url(randomBytes(48));
        await setSocialOAuthSession(req, {
          provider: "x",
          restaurantId,
          platform: "x",
          redirectPath: getSafeRedirectPath(req.query.redirect),
          state,
          codeVerifier,
          createdAt: new Date().toISOString(),
        });

        const params = new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: `${getPublicBaseUrl(req)}/api/social-connections/x/callback`,
          scope: "tweet.read tweet.write users.read media.write offline.access",
          state,
          code_challenge: createPkceChallenge(codeVerifier),
          code_challenge_method: "S256",
        });

        res.redirect(`https://x.com/i/oauth2/authorize?${params.toString()}`);
      } catch (error) {
        console.error("Error starting X social connection:", error);
        res
          .status(500)
          .json({ message: "Failed to start X publishing connection" });
      }
    },
  );

  app.get(
    "/api/social-connections/x/callback",
    isAuthenticated,
    async (req: any, res) => {
      const oauth = getSocialOAuthSession(req);
      const redirectPath = oauth?.redirectPath || "/parking-pass?tab=schedule";
      try {
        const code = String(req.query.code || "");
        const state = String(req.query.state || "");
        if (
          !oauth ||
          oauth.provider !== "x" ||
          oauth.platform !== "x" ||
          oauth.state !== state ||
          !oauth.codeVerifier
        ) {
          return res.redirect(
            appendSocialStatus(redirectPath, "error", "Connection expired"),
          );
        }
        if (!code) {
          return res.redirect(
            appendSocialStatus(redirectPath, "error", "X did not approve"),
          );
        }

        const clientId = process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID;
        const clientSecret =
          process.env.X_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET;
        if (!clientId) {
          return res.redirect(
            appendSocialStatus(redirectPath, "error", "X is not configured"),
          );
        }

        const tokenBody = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${getPublicBaseUrl(req)}/api/social-connections/x/callback`,
          code_verifier: oauth.codeVerifier,
        });
        const tokenHeaders: Record<string, string> = {
          "Content-Type": "application/x-www-form-urlencoded",
        };
        if (clientSecret) {
          tokenHeaders.Authorization = `Basic ${Buffer.from(
            `${clientId}:${clientSecret}`,
          ).toString("base64")}`;
        } else {
          tokenBody.set("client_id", clientId);
        }
        const token = await fetchJson("https://api.x.com/2/oauth2/token", {
          method: "POST",
          headers: tokenHeaders,
          body: tokenBody.toString(),
        });

        const me = await fetchJson(
          "https://api.x.com/2/users/me?user.fields=username,name",
          {
            headers: {
              Authorization: `Bearer ${token.access_token}`,
            },
          },
        );
        const account = me?.data || {};
        if (!account?.id) {
          return res.redirect(
            appendSocialStatus(redirectPath, "error", "No X account found"),
          );
        }

        const username = account.username || account.name || "X account";
        const externalAccountUrl = account.username
          ? `https://x.com/${account.username}`
          : null;
        const [connection] = await db
          .insert(socialPublishingConnections)
          .values({
            restaurantId: oauth.restaurantId,
            createdByUserId: req.user.id,
            platform: "x",
            displayName: username,
            externalAccountId: account.id,
            externalAccountUrl,
            accessToken: token.access_token,
            refreshToken: token.refresh_token || null,
            tokenExpiresAt: token.expires_in
              ? new Date(Date.now() + Number(token.expires_in) * 1000)
              : null,
            scopes: String(token.scope || "")
              .split(" ")
              .filter(Boolean),
            metadata: { provider: "x", username: account.username || null },
            status: "active",
            lastError: null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              socialPublishingConnections.restaurantId,
              socialPublishingConnections.platform,
            ],
            set: {
              createdByUserId: req.user.id,
              displayName: username,
              externalAccountId: account.id,
              externalAccountUrl,
              accessToken: token.access_token,
              refreshToken: token.refresh_token || null,
              tokenExpiresAt: token.expires_in
                ? new Date(Date.now() + Number(token.expires_in) * 1000)
                : null,
              scopes: String(token.scope || "")
                .split(" ")
                .filter(Boolean),
              metadata: { provider: "x", username: account.username || null },
              status: "active",
              lastError: null,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (connection.externalAccountUrl) {
          await db
            .update(restaurants)
            .set({ xUrl: connection.externalAccountUrl, updatedAt: new Date() })
            .where(eq(restaurants.id, oauth.restaurantId));
        }

        await setSocialOAuthSession(req, null);
        res.redirect(appendSocialStatus(redirectPath, "connected"));
      } catch (error) {
        console.error("Error completing X social connection:", error);
        await setSocialOAuthSession(req, null).catch(() => undefined);
        res.redirect(
          appendSocialStatus(
            redirectPath,
            "error",
            error instanceof Error ? error.message : "X connection failed",
          ),
        );
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/live-share-card",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only share location for restaurants you own",
          });
        }

        const [restaurant] = await db
          .select({
            id: restaurants.id,
            name: restaurants.name,
            description: restaurants.description,
            cuisineType: restaurants.cuisineType,
            city: restaurants.city,
            state: restaurants.state,
            logoUrl: restaurants.logoUrl,
            coverImageUrl: restaurants.coverImageUrl,
            facebookPageUrl: restaurants.facebookPageUrl,
            instagramUrl: restaurants.instagramUrl,
            xUrl: restaurants.xUrl,
          })
          .from(restaurants)
          .where(eq(restaurants.id, restaurantId))
          .limit(1);

        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        const baseUrl = (process.env.PUBLIC_BASE_URL || "https://www.mealscout.us")
          .replace(/\/+$/, "");
        const profileUrl = `${baseUrl}/restaurant/${restaurant.id}`;
        const place = [restaurant.city, restaurant.state]
          .filter(Boolean)
          .join(", ");
        const description = String(
          restaurant.description ||
            restaurant.cuisineType ||
            "Food truck",
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180);
        const message = [
          `${restaurant.name} is serving now.`,
          place ? `Find us in ${place}.` : "",
          description,
          "Live location + menu:",
        ]
          .filter(Boolean)
          .join(" ");

        res.json({
          title: "Share live location",
          message,
          link: profileUrl,
          imageUrl: restaurant.coverImageUrl || restaurant.logoUrl || null,
          businessPageUrl: profileUrl,
          socialUrls: {
            facebook: restaurant.facebookPageUrl || null,
            instagram: restaurant.instagramUrl || null,
            x: restaurant.xUrl || null,
          },
        });
      } catch (error) {
        console.error("Error building live share card:", error);
        res.status(500).json({ message: "Failed to build share card" });
      }
    },
  );

  app.post(
    "/api/restaurants/:restaurantId/social-posts",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only queue social posts for restaurants you own",
          });
        }

        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message: "Profile access could not be verified for social publishing.",
          });
        }

        const rateLimitResult = checkRateLimit(
          `social_post_${req.user.id}_${restaurantId}`,
        );
        if (!rateLimitResult.allowed) {
          return res.status(429).json({
            message: "Please wait before queuing another social post.",
            nextAllowedTime: rateLimitResult.nextAllowedTime,
          });
        }

        const schema = z.object({
          message: z.string().trim().min(1).max(1200),
          link: z.string().url().optional().nullable(),
          imageUrl: z.string().url().optional().nullable(),
          source: z.string().trim().max(80).optional().nullable(),
          platforms: z.object({
            facebook: z.boolean().optional(),
            instagram: z.boolean().optional(),
            x: z.boolean().optional(),
          }),
        });
        const parsed = schema.parse(req.body || {});
        const selectedPlatforms = Object.entries(parsed.platforms)
          .filter(([, enabled]) => Boolean(enabled))
          .map(([platform]) => platform);

        if (selectedPlatforms.length === 0) {
          return res.status(400).json({ message: "Select at least one platform" });
        }

        const [restaurant] = await db
          .select({
            id: restaurants.id,
            name: restaurants.name,
            ownerId: restaurants.ownerId,
            facebookPageUrl: restaurants.facebookPageUrl,
            instagramUrl: restaurants.instagramUrl,
            xUrl: restaurants.xUrl,
          })
          .from(restaurants)
          .where(eq(restaurants.id, restaurantId))
          .limit(1);

        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        const targetByPlatform: Record<string, string | null> = {
          facebook: restaurant.facebookPageUrl || null,
          instagram: restaurant.instagramUrl || null,
          x: restaurant.xUrl || null,
        };

        const rows = [];
        for (const platform of selectedPlatforms) {
          const connection = await getActiveSocialConnection(restaurantId, platform);
          const instagramNeedsImage = platform === "instagram" && !parsed.imageUrl;
          rows.push({
            platform,
            target:
              connection?.externalAccountUrl ||
              connection?.externalAccountId ||
              targetByPlatform[platform] ||
              null,
            message: parsed.message,
            link: parsed.link || null,
            imageUrl: parsed.imageUrl || null,
            restaurantId,
            createdByUserId: req.user.id,
            source: parsed.source || "owner_prompt",
            status: connection && !instagramNeedsImage ? "pending" : "manual_required",
            errorMessage: connection
              ? instagramNeedsImage
                ? "Instagram publishing requires an image. Use the manual share handoff."
                : null
              : "Publishing is not connected for this platform. Use the manual share handoff.",
            metadata: {
              restaurantName: restaurant.name,
              intendedOwnerId: restaurant.ownerId || null,
              queuedFrom: "parking_pass",
              hasPublishingConnection: Boolean(connection),
              connectionId: connection?.id || null,
              userAgent: req.headers["user-agent"] || null,
            },
            updatedAt: new Date(),
          });
        }

        const created = await db.insert(socialPostQueue).values(rows).returning();
        const pendingCount = created.filter(
          (post: { status: string }) => post.status === "pending",
        ).length;
        const manualCount = created.filter(
          (post: { status: string }) => post.status === "manual_required",
        ).length;

        try {
          await db.insert(telemetryEvents).values({
            eventName: "owner_social_post_queued",
            userId: req.user.id,
            properties: {
              restaurantId,
              platforms: selectedPlatforms,
              source: parsed.source || "owner_prompt",
              hasImage: Boolean(parsed.imageUrl),
              hasLink: Boolean(parsed.link),
            },
          });
        } catch (trackingError) {
          console.warn("Failed to track social post queue:", trackingError);
        }

        res.json({
          success: true,
          posts: created,
          queuedForPublishing: pendingCount,
          manualRequired: manualCount > 0,
          manualRequiredCount: manualCount,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({
            message: "Invalid social post",
            errors: error.errors,
          });
        }
        console.error("Error queueing social post:", error);
        res.status(500).json({ message: "Failed to queue social post" });
      }
    },
  );

  app.get("/api/restaurants/:restaurantId/is-open", async (req: any, res) => {
    try {
      const isOpen = await storage.isRestaurantOpenNow(req.params.restaurantId);
      res.json({ success: true, isOpen });
    } catch (error) {
      console.error("Error checking restaurant hours:", error);
      res.status(400).json({
        message:
          error instanceof Error
            ? error.message
            : "Failed to check restaurant hours",
      });
    }
  });

  app.post(
    "/api/restaurants/:restaurantId/truck-session/start",
    isAuthenticated,
    liveRestaurantLocationLimiter,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const { deviceId } = req.body;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only start sessions for restaurants you own",
          });
        }

        if (!deviceId) {
          return res.status(400).json({ message: "deviceId is required" });
        }

        const locationData = insertFoodTruckLocationSchema.parse({
          ...req.body,
          restaurantId,
        });
        if (locationData.source !== "gps") {
          return res.status(400).json({ message: "Live sharing requires device GPS. Confirm a manual service stop instead." });
        }
        const session = await storage.startTruckSession(
          restaurantId,
          deviceId,
          req.user.id,
        );

        const liveForMinutesRaw = Number(req.body?.liveForMinutes);
        const liveForMinutes = Number.isFinite(liveForMinutesRaw)
          ? Math.min(240, Math.max(15, liveForMinutesRaw))
          : null;
        const liveUntilAt = new Date(
          Date.now() + (liveForMinutes || 240) * 60_000,
        );
        let location = null;
        {
          location = await storage.upsertLiveLocation(
            locationData,
            { liveUntilAt },
          );
          broadcastLocationUpdate(restaurantId, location);
        }

        const restaurant = await storage.getRestaurant(restaurantId);
        res.json({ success: true, session, location,
          restaurant: restaurant ? sanitizeOwnerMutationRestaurant(restaurant) : null });
      } catch (error) {
        console.error("Error starting truck session:", error);
        res.status(error instanceof z.ZodError ? 400 : 500).json({ message: "Failed to start truck session" });
      }
    },
  );

  app.post(
    "/api/restaurants/:restaurantId/truck-session/end",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only end sessions for restaurants you own",
          });
        }

        await storage.endTruckSession(restaurantId, req.user.id);
        await storage.setRestaurantMobileSettings(restaurantId, {
          mobileOnline: false,
        });
        res.json({ success: true });
      } catch (error) {
        console.error("Error ending truck session:", error);
        res.status(500).json({ message: "Failed to end truck session" });
      }
    },
  );

  app.post(
    "/api/restaurants/:restaurantId/location",
    isAuthenticated,
    liveRestaurantLocationLimiter,
    async (req: any, res) => {
      try {
        const hasAccess = await hasCompleteProfileAccess(req.user.id);
        if (!hasAccess) {
          return res.status(402).json({
            message:
              "Profile access could not be verified for live location updates.",
          });
        }

        const { restaurantId } = req.params;
        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only update location for restaurants you own",
          });
        }

        const locationData = insertFoodTruckLocationSchema.parse({
          ...req.body,
          restaurantId,
        });
        if (locationData.source !== "gps") {
          return res.status(400).json({ message: "Live sharing requires device GPS. Confirm a manual service stop instead." });
        }
        const liveForMinutesRaw = Number(req.body?.liveForMinutes);
        const liveForMinutes = Number.isFinite(liveForMinutesRaw)
          ? Math.min(240, Math.max(15, liveForMinutesRaw))
          : 240;
        const liveUntilAt = new Date(Date.now() + liveForMinutes * 60_000);
        const location = await storage.upsertLiveLocation(
          locationData,
          { liveUntilAt },
        );

        broadcastLocationUpdate(restaurantId, location);

        try {
          await db.insert(telemetryEvents).values({
            eventName: "premium_live_location_used",
            userId: req.user.id,
            properties: {
              restaurantId,
              latitude: location.latitude,
              longitude: location.longitude,
              liveForMinutes,
              liveUntilAt: liveUntilAt.toISOString(),
            },
          });
        } catch (trackingError) {
          console.warn("Failed to track live location usage:", trackingError);
        }

        const restaurant = await storage.getRestaurant(restaurantId);
        res.json({ success: true, location,
          restaurant: restaurant ? sanitizeOwnerMutationRestaurant(restaurant) : null });
      } catch (error) {
        console.error("Error updating location:", error);
        res.status(400).json({
          message:
            error instanceof Error
              ? error.message
              : "Failed to update location",
        });
      }
    },
  );

  app.get("/api/trucks/live", async (req: any, res) => {
    try {
      const { lat, lng, radiusKm = 5, limit } = req.query;
      if (!lat || !lng) {
        return res
          .status(400)
          .json({ message: "lat and lng query parameters are required" });
      }

      const latitude = parseFloat(lat as string);
      const longitude = parseFloat(lng as string);
      const radius = Math.min(parseFloat(radiusKm as string), 50);
      const maxTrucks = clampLiveTrucksLimit(limit);

      if (isNaN(latitude) || isNaN(longitude) || isNaN(radius)) {
        return res
          .status(400)
          .json({ message: "Invalid coordinates or radius" });
      }

      if (
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return res.status(400).json({ message: "Invalid coordinates range" });
      }

      const trustedPayloadTrucks = await withDeadline(
        (async () => {
          // Distance-sorted upstream; cap before per-owner access work so large
          // radii cannot fan out into unbounded Promise.all scans.
          const trucks = (
            await storage.getLiveTrucksNearby(latitude, longitude, radius)
          ).slice(0, maxTrucks);
          const visibleTrucks = (
            await Promise.all(
              trucks.map(async (truck: any) => {
                const ownerId = String(truck?.ownerId || "").trim();
                if (!ownerId) return null;
                try {
                  const hasAccess = await hasCompleteProfileAccess(ownerId);
                  return hasAccess ? truck : null;
                } catch {
                  // Access lookup failures are terminal for that row. A public
                  // location endpoint must never fall back to unfiltered data.
                  return null;
                }
              }),
            )
          ).filter(Boolean);
          const publicTrucks = (
            await toPublicRestaurantListingArrayWithVisibility(visibleTrucks)
          ).filter(
            (truck: any) =>
              isPublicBusinessVisible(truck) &&
              truck?.isActive === true &&
              truck?.mobileOnline === true &&
              Number.isFinite(Number(truck?.currentLatitude)) &&
              Number.isFinite(Number(truck?.currentLongitude)),
          );

          const truckIds = publicTrucks
            .map((truck: any) => String(truck?.id || "").trim())
            .filter(Boolean);
          const menuEligibleIds = new Set<string>();
          const menuCounts = new Map<string, number>();
          if (truckIds.length > 0) {
            const menuRows = await db
              .select({
                restaurantId: menuItems.restaurantId,
                count: sql<number>`count(*)::integer`,
              })
              .from(menuItems)
              .innerJoin(menus, eq(menuItems.menuId, menus.id))
              .where(
                and(
                  inArray(menuItems.restaurantId, truckIds),
                  eq(menus.isActive, true),
                  eq(menuItems.isAvailable, true),
                  gt(menuItems.priceCents, 0),
                ),
              )
              .groupBy(menuItems.restaurantId);
            for (const row of menuRows) {
              menuCounts.set(String(row.restaurantId), Number(row.count || 0));
              if (Number(row.count || 0) > 0) {
                menuEligibleIds.add(String(row.restaurantId));
              }
            }
          }
          const menuEligibleTrucks = publicTrucks.map((truck: any) => ({
            ...truck,
            menuItemCount:
              menuCounts.get(String(truck?.id || "").trim()) || 0,
            menuAvailable: menuEligibleIds.has(
              String(truck?.id || "").trim(),
            ),
          }));
          res.setHeader("X-MealScout-Filtered-Missing-Menu", "0");
          const suppressedTruckIds = await getSuppressedLocationResourceIds({
            resourceIds: menuEligibleTrucks
              .map((truck: any) => String(truck?.id || "").trim())
              .filter(Boolean),
            targetType: "live_location",
          });

          const filtered = menuEligibleTrucks.filter(
            (truck: any) => !suppressedTruckIds.has(String(truck?.id || "")),
          );
          if (suppressedTruckIds.size > 0) {
            res.setHeader(
              "X-MealScout-Suppressed-Live-Trucks",
              String(suppressedTruckIds.size),
            );
          }
          return filtered;
        })(),
        PUBLIC_LIVE_TRUCKS_TIMEOUT_MS,
        "live trucks",
      );

      const bounded = clampArrayToMaxBytes(
        trustedPayloadTrucks,
        maxTrucks,
        MAX_LIVE_TRUCKS_RESPONSE_BYTES,
        (trucks) => ({ trucks }),
      );
      if (bounded.truncated) {
        res.setHeader("X-MealScout-Live-Trucks-Truncated", "1");
        res.setHeader("X-MealScout-Live-Trucks-Bytes", String(bounded.bytes));
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ trucks: bounded.value });
    } catch (error) {
      if (isDeadlineError(error)) {
        console.error("Live trucks timeout:", error);
        return res.status(504).json({
          message: "Live trucks timed out",
          timeoutMs: PUBLIC_LIVE_TRUCKS_TIMEOUT_MS,
        });
      }
      console.error("Error fetching live trucks:", error);
      res.status(500).json({ message: "Failed to fetch live trucks" });
    }
  });

  app.post(
    "/api/trucks/:truckId/location-reports",
    isAuthenticated,
    async (req: any, res) => {
    try {
      const { truckId } = req.params;
      const rateLimitKey = `truck_missing_${truckId}_${req.user?.id || req.ip || "anon"}`;
      const rateLimitResult = checkRateLimit(rateLimitKey);
      if (!rateLimitResult.allowed) {
        return res.status(429).json({
          message: "Please wait before reporting this truck again.",
          nextAllowedTime: rateLimitResult.nextAllowedTime,
        });
      }

      const schema = z.object({
        targetType: z
          .enum(["live_location", "manual_schedule", "event_schedule"])
          .default("live_location"),
        manualScheduleId: z.string().optional(),
        eventId: z.string().optional(),
        expectedLatitude: z.coerce.number().min(-90).max(90).optional(),
        expectedLongitude: z.coerce.number().min(-180).max(180).optional(),
        reporterLatitude: z.coerce.number().min(-90).max(90).optional(),
        reporterLongitude: z.coerce.number().min(-180).max(180).optional(),
        sourceLabel: z.string().max(160).optional(),
        notes: z.string().max(500).optional(),
        observedAt: z.string().datetime().optional(),
      });
      const parsed = schema.parse(req.body || {});

      const [truck] = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, truckId))
        .limit(1);

      const [publicTruck] = truck
        ? await toPublicRestaurantListingArrayWithVisibility([truck])
        : [];
      if (
        !truck ||
        truck.isFoodTruck !== true ||
        truck.isActive !== true ||
        !isPublicBusinessVisible(truck) ||
        deriveProfileEvidenceQuarantineVisibility(truck).isQuarantined ||
        !publicTruck?.id
      ) {
        return res.status(404).json({ message: "Truck not found" });
      }

      const hasExpectedLatitude = parsed.expectedLatitude !== undefined;
      const hasExpectedLongitude = parsed.expectedLongitude !== undefined;
      const hasReporterLatitude = parsed.reporterLatitude !== undefined;
      const hasReporterLongitude = parsed.reporterLongitude !== undefined;
      if (
        hasExpectedLatitude !== hasExpectedLongitude ||
        hasReporterLatitude !== hasReporterLongitude ||
        (parsed.expectedLatitude === 0 && parsed.expectedLongitude === 0) ||
        (parsed.reporterLatitude === 0 && parsed.reporterLongitude === 0)
      ) {
        return res.status(400).json({
          message: "Latitude and longitude must be a valid coordinate pair",
        });
      }

      let reportedResourceId = truckId;
      if (parsed.targetType === "live_location") {
        if (parsed.manualScheduleId || parsed.eventId) {
          return res.status(400).json({
            message: "A live-location report cannot name a schedule",
          });
        }
      } else if (parsed.targetType === "manual_schedule") {
        if (!parsed.manualScheduleId || parsed.eventId) {
          return res.status(400).json({ message: "A valid manual schedule is required" });
        }
        const [schedule] = await db
          .select({ id: truckManualSchedules.id })
          .from(truckManualSchedules)
          .where(
            and(
              eq(truckManualSchedules.id, parsed.manualScheduleId),
              eq(truckManualSchedules.truckId, truckId),
              eq(truckManualSchedules.isPublic, true),
            ),
          )
          .limit(1);
        if (!schedule) {
          return res.status(404).json({ message: "Schedule not found" });
        }
        reportedResourceId = schedule.id;
      } else {
        if (!parsed.eventId || parsed.manualScheduleId) {
          return res.status(400).json({ message: "A valid event schedule is required" });
        }
        const [booking] = await db
          .select({ eventId: eventBookings.eventId })
          .from(eventBookings)
          .innerJoin(events, eq(events.id, eventBookings.eventId))
          .where(
            and(
              eq(eventBookings.eventId, parsed.eventId),
              eq(eventBookings.truckId, truckId),
              eq(eventBookings.status, "confirmed"),
              isNotNull(eventBookings.bookingConfirmedAt),
              inArray(events.status, ["open", "booked", "filled"]),
            ),
          )
          .limit(1);
        if (!booking) {
          return res.status(404).json({ message: "Event schedule not found" });
        }
        reportedResourceId = booking.eventId;
      }

      const [created] = await db
        .insert(moderationEvents)
        .values({
          eventType: "truck_location_missing_report",
          severity: "medium",
          reportedUserId: truck.ownerId || null,
          reportedResourceType: parsed.targetType,
          reportedResourceId,
          reporterUserId: req.user?.id || null,
          reason: "truck_not_at_expected_location",
          description:
            parsed.notes ||
            `${truck.name} was reported missing from its expected map location.`,
          metadata: {
            truckId,
            truckName: truck.name,
            targetType: parsed.targetType,
            manualScheduleId: parsed.manualScheduleId || null,
            eventId: parsed.eventId || null,
            expectedLatitude: parsed.expectedLatitude ?? null,
            expectedLongitude: parsed.expectedLongitude ?? null,
            reporterLatitude: parsed.reporterLatitude ?? null,
            reporterLongitude: parsed.reporterLongitude ?? null,
            sourceLabel: parsed.sourceLabel || null,
            observedAt: parsed.observedAt || new Date().toISOString(),
            userAgent: req.headers["user-agent"] || null,
            ip: req.ip || null,
          },
          status: "open",
        })
        .returning();

      res.status(201).json({
        success: true,
        report: {
          id: created?.id || null,
          status: created?.status || "open",
          createdAt: created?.createdAt || null,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid location report",
          errors: error.errors,
        });
      }
      console.error("Error creating truck location report:", error);
      res.status(500).json({ message: "Failed to submit location report" });
    }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/locations",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const { startDate, endDate } = req.query;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageProfile",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access location history for restaurants you own",
          });
        }

        let dateRange: { start: Date; end: Date } | undefined;
        if (startDate && endDate) {
          dateRange = {
            start: new Date(startDate as string),
            end: new Date(endDate as string),
          };
        }

        const locations = await storage.getTruckLocationHistory(
          restaurantId,
          dateRange,
        );
        res.json({ locations });
      } catch (error) {
        console.error("Error fetching location history:", error);
        res.status(500).json({ message: "Failed to fetch location history" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/analytics/profile-actions",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const canBypassOwnership = isAdminLikeUserType(req.user?.userType);
        if (!canBypassOwnership) {
          const isAuthorized = await storage.verifyRestaurantOwnership(
            restaurantId,
            req.user.id,
            "viewAnalytics",
          );
          if (!isAuthorized) {
            return res.status(403).json({
              message:
                "Unauthorized: You can only access analytics for restaurants you own",
            });
          }
        }

        const toDate = (value: unknown) => {
          if (!value) return null;
          const parsed = new Date(String(value));
          return Number.isNaN(parsed.getTime()) ? null : parsed;
        };

        const startDate = toDate(req.query.startDate);
        const endDate = toDate(req.query.endDate);
        const whereClauses = [
          eq(requestLogs.surface, "public_profile"),
          eq(requestLogs.entityId, String(restaurantId)),
          inArray(requestLogs.entityType, ["restaurant", "truck", "bar"]),
          inArray(requestLogs.eventType, ["profile_view", "profile_action", "qr_open"]),
        ] as any[];
        if (startDate) whereClauses.push(gte(requestLogs.createdAt, startDate));
        if (endDate) whereClauses.push(lte(requestLogs.createdAt, endDate));

        const [aggregate] = await db
          .select({
            profileViews:
              sql<number>`count(*) filter (where ${requestLogs.eventType} = 'profile_view')`.mapWith(
                Number,
              ),
            menuClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'menu_click')`.mapWith(
                Number,
              ),
            directionsClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'directions_click')`.mapWith(
                Number,
              ),
            callClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'call_click')`.mapWith(
                Number,
              ),
            orderClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' in ('order_click','delivery_click'))`.mapWith(
                Number,
              ),
            qrOpens:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' in ('qr_profile_open','qr_menu_open','qr_specials_open'))`.mapWith(
                Number,
              ),
            dealClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'deal_click')`.mapWith(
                Number,
              ),
            eventClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'event_click')`.mapWith(
                Number,
              ),
            socialClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'social_click')`.mapWith(
                Number,
              ),
            shareClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'share_click')`.mapWith(
                Number,
              ),
            cateringClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'catering_click')`.mapWith(
                Number,
              ),
            truckBookingClicks:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'truck_booking_click')`.mapWith(
                Number,
              ),
            last7Days:
              sql<number>`count(*) filter (where ${requestLogs.createdAt} >= now() - interval '7 days')`.mapWith(
                Number,
              ),
            last30Days:
              sql<number>`count(*) filter (where ${requestLogs.createdAt} >= now() - interval '30 days')`.mapWith(
                Number,
              ),
            lifetime:
              sql<number>`count(*)`.mapWith(Number),
          })
          .from(requestLogs)
          .where(and(...whereClauses));

        res.json({
          totals: aggregate || {
            profileViews: 0,
            menuClicks: 0,
            directionsClicks: 0,
            callClicks: 0,
            orderClicks: 0,
            qrOpens: 0,
            dealClicks: 0,
            eventClicks: 0,
            socialClicks: 0,
            shareClicks: 0,
            cateringClicks: 0,
            truckBookingClicks: 0,
            last7Days: 0,
            last30Days: 0,
            lifetime: 0,
          },
          range: {
            startDate: startDate ? startDate.toISOString() : null,
            endDate: endDate ? endDate.toISOString() : null,
          },
        });
      } catch (error) {
        console.error("Error fetching profile action analytics:", error);
        res.status(500).json({ message: "Failed to fetch profile action analytics" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/owner-value-dashboard",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const windowParam = String(req.query.window || "30d").toLowerCase();
        const windowDays = windowParam === "7d" ? 7 : windowParam === "30d" ? 30 : null;
        if (!windowDays) {
          return res.status(400).json({ message: "window must be 7d or 30d" });
        }

        const canBypassOwnership = isAdminLikeUserType(req.user?.userType);
        if (!canBypassOwnership) {
          const isAuthorized = await storage.verifyRestaurantOwnership(
            restaurantId,
            req.user.id,
            "viewAnalytics",
          );
          if (!isAuthorized) {
            return res.status(403).json({
              message:
                "Unauthorized: You can only access analytics for restaurants you own",
            });
          }
        }

        const restaurant = (await storage.getRestaurant(
          String(restaurantId),
        )) as any;
        if (!restaurant) {
          return res.status(404).json({ message: "Restaurant not found" });
        }

        const now = new Date();
        const currentStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
        const previousStart = new Date(
          currentStart.getTime() - windowDays * 24 * 60 * 60 * 1000,
        );

        const baseWhere = [
          eq(requestLogs.surface, "public_profile"),
          eq(requestLogs.entityId, String(restaurantId)),
          inArray(requestLogs.entityType, ["restaurant", "truck", "bar"]),
          inArray(requestLogs.eventType, ["profile_view", "profile_action", "qr_open"]),
        ] as any[];

        const [aggregate] = await db
          .select({
            profileViewsCurrent:
              sql<number>`count(*) filter (where ${requestLogs.eventType} = 'profile_view' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            profileViewsPrevious:
              sql<number>`count(*) filter (where ${requestLogs.eventType} = 'profile_view' and ${requestLogs.createdAt} >= ${previousStart} and ${requestLogs.createdAt} < ${currentStart})`.mapWith(
                Number,
              ),
            menuClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'menu_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            menuClicksPrevious:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'menu_click' and ${requestLogs.createdAt} >= ${previousStart} and ${requestLogs.createdAt} < ${currentStart})`.mapWith(
                Number,
              ),
            directionsClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'directions_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            directionsClicksPrevious:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'directions_click' and ${requestLogs.createdAt} >= ${previousStart} and ${requestLogs.createdAt} < ${currentStart})`.mapWith(
                Number,
              ),
            callClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'call_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            callClicksPrevious:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'call_click' and ${requestLogs.createdAt} >= ${previousStart} and ${requestLogs.createdAt} < ${currentStart})`.mapWith(
                Number,
              ),
            websiteClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'website_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            orderClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'order_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            orderClicksPrevious:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'order_click' and ${requestLogs.createdAt} >= ${previousStart} and ${requestLogs.createdAt} < ${currentStart})`.mapWith(
                Number,
              ),
            deliveryClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'delivery_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            deliveryClicksPrevious:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'delivery_click' and ${requestLogs.createdAt} >= ${previousStart} and ${requestLogs.createdAt} < ${currentStart})`.mapWith(
                Number,
              ),
            qrOpensCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' in ('qr_profile_open','qr_menu_open','qr_specials_open') and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            qrOpensPrevious:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' in ('qr_profile_open','qr_menu_open','qr_specials_open') and ${requestLogs.createdAt} >= ${previousStart} and ${requestLogs.createdAt} < ${currentStart})`.mapWith(
                Number,
              ),
            dealClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'deal_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            eventClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'event_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            socialClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'social_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            shareClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'share_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            cateringClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'catering_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            truckBookingClicksCurrent:
              sql<number>`count(*) filter (where ${requestLogs.metadata}->>'actionType' = 'truck_booking_click' and ${requestLogs.createdAt} >= ${currentStart} and ${requestLogs.createdAt} < ${now})`.mapWith(
                Number,
              ),
            latestEventAt: sql<Date>`max(${requestLogs.createdAt})`,
          })
          .from(requestLogs)
          .where(and(...baseWhere));

        const counts = aggregate || ({} as any);
        const totals = {
          profileViews: Number(counts.profileViewsCurrent || 0),
          menuClicks: Number(counts.menuClicksCurrent || 0),
          directionsClicks: Number(counts.directionsClicksCurrent || 0),
          callClicks: Number(counts.callClicksCurrent || 0),
          websiteClicks: Number(counts.websiteClicksCurrent || 0),
          orderClicks: Number(counts.orderClicksCurrent || 0),
          deliveryClicks: Number(counts.deliveryClicksCurrent || 0),
          qrOpens: Number(counts.qrOpensCurrent || 0),
          dealClicks: Number(counts.dealClicksCurrent || 0),
          eventClicks: Number(counts.eventClicksCurrent || 0),
          socialClicks: Number(counts.socialClicksCurrent || 0),
          shareClicks: Number(counts.shareClicksCurrent || 0),
          cateringClicks: Number(counts.cateringClicksCurrent || 0),
          truckBookingClicks: Number(counts.truckBookingClicksCurrent || 0),
        };
        const previousWindowTotals = {
          profileViews: Number(counts.profileViewsPrevious || 0),
          menuClicks: Number(counts.menuClicksPrevious || 0),
          directionsClicks: Number(counts.directionsClicksPrevious || 0),
          callClicks: Number(counts.callClicksPrevious || 0),
          orderClicks: Number(counts.orderClicksPrevious || 0),
          deliveryClicks: Number(counts.deliveryClicksPrevious || 0),
          qrOpens: Number(counts.qrOpensPrevious || 0),
        };
        const deltas = {
          profileViews: totals.profileViews - previousWindowTotals.profileViews,
          menuClicks: totals.menuClicks - previousWindowTotals.menuClicks,
          directionsClicks: totals.directionsClicks - previousWindowTotals.directionsClicks,
          callClicks: totals.callClicks - previousWindowTotals.callClicks,
          orderClicks:
            totals.orderClicks +
            totals.deliveryClicks -
            (previousWindowTotals.orderClicks + previousWindowTotals.deliveryClicks),
          qrOpens: totals.qrOpens - previousWindowTotals.qrOpens,
        };

        const topActions = [
          { actionType: "menu_click", label: "Menu", count: totals.menuClicks },
          {
            actionType: "directions_click",
            label: "Directions",
            count: totals.directionsClicks,
          },
          { actionType: "call_click", label: "Calls", count: totals.callClicks },
          {
            actionType: "order_delivery_click",
            label: "Orders / Delivery",
            count: totals.orderClicks + totals.deliveryClicks,
          },
          { actionType: "qr_open", label: "QR opens", count: totals.qrOpens },
          {
            actionType: "deal_event_click",
            label: "Deals / Events",
            count: totals.dealClicks + totals.eventClicks,
          },
          {
            actionType: "social_share_click",
            label: "Social / Shares",
            count: totals.socialClicks + totals.shareClicks,
          },
        ]
          .filter((item) => item.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 3);

        const hasAddress = Boolean(
          String(restaurant.address || "").trim() || String(restaurant.city || "").trim(),
        );
        const hasOrderingLink = Boolean(
          String(restaurant.onlineOrderingUrl || "").trim() ||
            String(restaurant.deliveryUrl || "").trim() ||
            String(restaurant.doordashUrl || "").trim() ||
            String(restaurant.uberEatsUrl || "").trim() ||
            String(restaurant.toastUrl || "").trim() ||
            String(restaurant.squareUrl || "").trim() ||
            String(restaurant.chowNowUrl || "").trim() ||
            String(restaurant.grubhubUrl || "").trim(),
        );
        const isTruck =
          Boolean(restaurant.isFoodTruck) ||
          String(restaurant.businessType || "").toLowerCase() === "food_truck";
        const hasTruckSchedule = Boolean(
          (restaurant as any).operatingHours || (restaurant as any).businessHours,
        );

        const recommendations: Array<{
          id: string;
          severity: "info" | "opportunity" | "urgent";
          title: string;
          body: string;
          ctaLabel: string;
          ctaHref: string;
        }> = [];
        if (totals.profileViews > 0 && totals.menuClicks === 0) {
          recommendations.push({
            id: "menu_visibility",
            severity: "opportunity",
            title: "Customers are viewing your profile but not opening your menu",
            body: "Add or refresh your menu so visitors can quickly see what you serve.",
            ctaLabel: "Update menu",
            ctaHref: `/menu-builder?restaurantId=${encodeURIComponent(String(restaurantId))}`,
          });
        }
        if (totals.profileViews > 0 && totals.directionsClicks === 0 && hasAddress) {
          recommendations.push({
            id: "promote_directions",
            severity: "opportunity",
            title: "No directions taps yet",
            body: "Promote your directions QR and confirm your public location details are clear.",
            ctaLabel: "Open profile setup",
            ctaHref: `/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(restaurantId))}`,
          });
        }
        if (totals.qrOpens === 0) {
          recommendations.push({
            id: "print_qr_assets",
            severity: "opportunity",
            title: "QR assets are not being used yet",
            body: "Display your Profile or Menu QR in-store so customers can open your links instantly.",
            ctaLabel: "Open QR Kit",
            ctaHref: `/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(restaurantId))}`,
          });
        }
        if (totals.orderClicks === 0 && hasOrderingLink) {
          recommendations.push({
            id: "improve_order_path",
            severity: "info",
            title: "Ordering links exist but no order clicks this period",
            body: "Move your ordering links higher and share a social graphic with your order CTA.",
            ctaLabel: "Edit profile links",
            ctaHref: `/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(restaurantId))}`,
          });
        }
        if (totals.profileViews === 0) {
          recommendations.push({
            id: "drive_initial_traffic",
            severity: "urgent",
            title: "No profile views recorded yet",
            body: "Share your MealScout profile link or QR code to start driving measurable customer actions.",
            ctaLabel: "Open QR Kit",
            ctaHref: `/restaurant-owner-dashboard?setup=profile&restaurantId=${encodeURIComponent(String(restaurantId))}`,
          });
        }
        if (totals.menuClicks > totals.directionsClicks + totals.callClicks) {
          recommendations.push({
            id: "convert_menu_intent",
            severity: "opportunity",
            title: "Menu interest is strong",
            body: "If you have a real current special, feature it so customers have a reason to choose you today.",
            ctaLabel: "Add a special",
            ctaHref: `/deal-creation?restaurantId=${encodeURIComponent(String(restaurantId))}`,
          });
        }
        if (isTruck && !hasTruckSchedule) {
          recommendations.push({
            id: "truck_schedule_missing",
            severity: "opportunity",
            title: "Your truck schedule looks incomplete",
            body: "Add your weekly or current stop schedule so customers know where to find you.",
            ctaLabel: "Update schedule",
            ctaHref: `/restaurant-owner-dashboard?setup=schedule&truck=1&restaurantId=${encodeURIComponent(String(restaurantId))}`,
          });
        }

        const latestEventAt =
          counts.latestEventAt instanceof Date
            ? counts.latestEventAt
            : counts.latestEventAt
              ? new Date(counts.latestEventAt)
              : null;
        let freshnessLabel = "Last updated just now";
        if (latestEventAt) {
          const ageMs = Math.max(0, now.getTime() - latestEventAt.getTime());
          const ageMinutes = Math.floor(ageMs / 60000);
          if (ageMinutes < 1) freshnessLabel = "Last updated just now";
          else if (ageMinutes < 60) freshnessLabel = `Last updated ${ageMinutes} min ago`;
          else freshnessLabel = "Last updated today";
        }

        return res.json({
          restaurantId: String(restaurantId),
          window: windowParam as "7d" | "30d",
          generatedAt: now.toISOString(),
          freshnessLabel,
          totals,
          previousWindowTotals,
          deltas,
          topActions,
          recommendations: recommendations.slice(0, 3),
        });
      } catch (error) {
        console.error("Error fetching owner value dashboard:", error);
        return res
          .status(500)
          .json({ message: "Failed to fetch owner value dashboard" });
      }
    },
  );

  app.get("/api/owner/value-attribution", isAuthenticated, async (req: any, res) => {
    try {
      const windowParam = String(req.query.window || "7d");
      if (windowParam !== "7d" && windowParam !== "30d") {
        return res.status(400).json({ message: "Invalid window parameter" });
      }

      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (windowParam === "30d" ? 30 : 7));

      const isAdminUser =
        req.user?.userType === "admin" ||
        req.user?.userType === "duper_admin" ||
        req.user?.userType === "super_admin" ||
        req.user?.userType === "staff";

      let ownerRestaurantIds: string[] = [];
      if (isAdminUser && req.query.ownerId) {
        const ownerRestaurants = await db
          .select({ id: restaurants.id })
          .from(restaurants)
          .where(eq(restaurants.ownerId, String(req.query.ownerId)));
        ownerRestaurantIds = ownerRestaurants.map((row: any) => String(row.id));
      } else {
        const context = await getBusinessAccessContext(req.user.id);
        ownerRestaurantIds = context.restaurants.map((row) => String(row.id));
      }

      if (ownerRestaurantIds.length === 0) {
        return res.json({
          window: windowParam as "7d" | "30d",
          generatedAt: now.toISOString(),
          ownerId: String(req.user.id),
          entities: [],
        });
      }

      const ownedRestaurants = await db
        .select()
        .from(restaurants)
        .where(inArray(restaurants.id, ownerRestaurantIds));
      const completionEvidenceByRestaurant =
        await loadProfileCompletionEvidenceBatch(ownerRestaurantIds);

      const rows = await db
        .select({
          entityId: requestLogs.entityId,
          entityType: requestLogs.entityType,
          createdAt: requestLogs.createdAt,
          surface: requestLogs.surface,
          eventType: requestLogs.eventType,
          metadata: requestLogs.metadata,
        })
        .from(requestLogs)
        .where(
          and(
            gte(requestLogs.createdAt, start),
            inArray(requestLogs.entityId, ownerRestaurantIds),
            inArray(requestLogs.surface, [
              "public_profile",
              "public_discovery",
              "owner_dashboard_profile_completion",
            ]),
          ),
        );

      const byEntity = new Map<string, any>();
      for (const restaurant of ownedRestaurants as any[]) {
        const completionTruth = completionEvidenceByRestaurant.get(
          String(restaurant.id),
        )?.truth;
        const compatibilityCompletionStatus = computeProfileCompletionStatus(
          restaurant,
          {
            hasActiveDeal:
              Number(restaurant?.activeDeals || 0) > 0 ||
              Number(restaurant?.activeDealsCount || 0) > 0 ||
              Boolean(restaurant?.hasActiveDeals),
          },
        );
        const entityType =
          restaurant.isFoodTruck || String(restaurant.businessType || "").toLowerCase() === "food_truck"
            ? "truck"
            : String(restaurant.businessType || "").toLowerCase() === "bar"
              ? "bar"
              : "restaurant";
        byEntity.set(String(restaurant.id), {
          ownerId: String(restaurant.ownerId || req.user.id),
          entityId: String(restaurant.id),
          entityType,
          profileViews: 0,
          discoveryImpressions: 0,
          ctaClicks: 0,
          shareOpens: 0,
          highIntentActions: 0,
          completionActionClicks: 0,
          completionActionsRaw: new Map<string, number>(),
          completionStatus: {
            ...compatibilityCompletionStatus,
            menu: completionTruth?.menuState === "approved_current",
            photos: completionTruth?.mediaState === "ready",
            hours: completionTruth?.availabilityReady === true,
            publication:
              completionTruth?.publicRouteState === "published",
          },
          topSourcesRaw: new Map<string, number>(),
          lastActivityAt: null as string | null,
        });
      }

      const highIntentActionTypes = new Set([
        "call_click",
        "directions_click",
        "order_click",
        "delivery_click",
        "deal_click",
        "catering_click",
        "truck_booking_click",
      ]);

      for (const row of rows as any[]) {
        const entityId = String(row.entityId || "");
        if (!byEntity.has(entityId)) continue;
        const item = byEntity.get(entityId)!;
        const metadata = (row.metadata || {}) as Record<string, any>;
        const createdAt = row.createdAt ? new Date(row.createdAt).toISOString() : null;
        if (createdAt && (!item.lastActivityAt || new Date(createdAt) > new Date(item.lastActivityAt))) {
          item.lastActivityAt = createdAt;
        }

        if (String(row.surface) === "public_profile") {
          if (String(row.eventType) === "profile_view") item.profileViews += 1;
          const actionType = String(metadata.actionType || "");
          if (actionType === "share_click" || actionType.startsWith("qr_")) item.shareOpens += 1;
          if (highIntentActionTypes.has(actionType)) item.highIntentActions += 1;
          const sourceLabel = String(metadata.source || "direct");
          item.topSourcesRaw.set(sourceLabel, (item.topSourcesRaw.get(sourceLabel) || 0) + 1);
        } else if (String(row.surface) === "public_discovery") {
          const discoveryEventType = String(metadata.discoveryEventType || "");
          const sourcePageType = String(metadata.sourcePageType || "unknown");
          if (discoveryEventType === "discovery_page_view") item.discoveryImpressions += 1;
          if (discoveryEventType === "discovery_cta_click") {
            item.ctaClicks += 1;
            item.highIntentActions += 1;
          }
          if (
            discoveryEventType === "discovery_card_click" ||
            discoveryEventType === "discovery_profile_click"
          ) {
            item.highIntentActions += 1;
          }
          const sourceLabel = `discovery:${sourcePageType}`;
          item.topSourcesRaw.set(sourceLabel, (item.topSourcesRaw.get(sourceLabel) || 0) + 1);
        } else if (String(row.surface) === "owner_dashboard_profile_completion") {
          const actionType = String(metadata.actionType || "");
          if (actionType === "profile_completion_cta_click") {
            item.completionActionClicks += 1;
            const missingItemKey = String(metadata.missingItemKey || "unknown");
            item.completionActionsRaw.set(
              missingItemKey,
              (item.completionActionsRaw.get(missingItemKey) || 0) + 1,
            );
          }
        }
      }

      const entities = Array.from(byEntity.values()).map((item) => ({
        ownerId: item.ownerId,
        entityId: item.entityId,
        entityType: item.entityType,
        profileViews: item.profileViews,
        discoveryImpressions: item.discoveryImpressions,
        ctaClicks: item.ctaClicks,
        shareOpens: item.shareOpens,
        highIntentActions: item.highIntentActions,
        completionActionClicks: item.completionActionClicks,
        completionActions: (Array.from(item.completionActionsRaw.entries()) as Array<[string, number]>)
          .sort((a, b) => b[1] - a[1])
          .map(([missingItemKey, count]) => ({ missingItemKey, count })),
        completionActionReconciliation: (Array.from(item.completionActionsRaw.entries()) as Array<[string, number]>)
          .sort((a, b) => b[1] - a[1])
          .map(([missingItemKey, clicked]) => {
            const nowComplete = Boolean(item.completionStatus?.[missingItemKey]);
            return {
              missingItemKey,
              clicked,
              nowComplete: nowComplete ? clicked : 0,
              stillMissing: nowComplete ? 0 : clicked,
            };
          }),
        topSources: (Array.from(item.topSourcesRaw.entries()) as Array<[string, number]>)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([source, count]) => ({ source, count })),
        lastActivityAt: item.lastActivityAt,
      }));

      return res.json({
        window: windowParam as "7d" | "30d",
        generatedAt: now.toISOString(),
        ownerId: String(req.query.ownerId || req.user.id),
        entities,
      });
    } catch (error) {
      console.error("Error fetching owner value attribution:", error);
      return res.status(500).json({ message: "Failed to fetch owner value attribution" });
    }
  });

  const ownerProfileCompletionActionSchema = z.object({
    entityId: z.string().min(1),
    entityType: z.enum(["restaurant", "truck", "bar"]),
    missingItemKey: z.enum([
      "menu",
      "photos",
      "hours",
      "service-area",
      "contact",
      "social",
      "catering-events",
      "deal",
      "publication",
    ]),
  });

  app.post("/api/owner/profile-completion-action", isAuthenticated, async (req: any, res) => {
    try {
      const parsed = ownerProfileCompletionActionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid profile completion action payload" });
      }

      const context = await getBusinessAccessContext(req.user.id);
      const ownerRestaurantIds = new Set(
        context.restaurants.map((row: any) => String(row.id)),
      );
      if (!ownerRestaurantIds.has(String(parsed.data.entityId))) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const metadata = {
        actionType: "profile_completion_cta_click",
        missingItemKey: parsed.data.missingItemKey,
        source: "owner_dashboard_profile_completion",
        ownerId: String(req.user.id),
        entityId: String(parsed.data.entityId),
        entityType: String(parsed.data.entityType),
      };

      await db.insert(requestLogs).values({
        method: "EVENT",
        path: "/restaurant-owner-dashboard",
        statusCode: 202,
        durationMs: 0,
        userId: String(req.user.id),
        sessionId: String(req.sessionID || ""),
        actorType: "human",
        sourceType: "internal",
        eventType: "owner_action",
        surface: "owner_dashboard_profile_completion",
        entityId: String(parsed.data.entityId),
        entityType: String(parsed.data.entityType),
        ip: String(req.ip || ""),
        userAgent: String(req.get("user-agent") || ""),
        metadata,
      } as any);

      return res.json({
        ok: true,
        actionType: "profile_completion_cta_click",
        missingItemKey: parsed.data.missingItemKey,
      });
    } catch (error) {
      console.error("Error recording owner profile completion action:", error);
      return res.status(500).json({ message: "Failed to record profile completion action" });
    }
  });

  app.get(
    "/api/restaurants/:restaurantId/analytics/summary",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const { startDate, endDate } = req.query;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "viewAnalytics",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const analyticsAccess = await validateProfileAnalyticsAccess(req.user.id);
        if (!analyticsAccess.hasAccess) {
          return res.status(402).json({
            message: analyticsAccess.error,
            subscriptionTier: analyticsAccess.subscriptionTier,
          });
        }

        let dateRange: { start: Date; end: Date } | undefined;
        if (startDate && endDate) {
          dateRange = {
            start: new Date(startDate as string),
            end: new Date(endDate as string),
          };
        }

        const summary = await storage.getRestaurantAnalyticsSummary(
          restaurantId,
          dateRange,
        );
        res.json(summary);
      } catch (error) {
        console.error("Error fetching analytics summary:", error);
        res.status(500).json({ message: "Failed to fetch analytics summary" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/analytics/timeseries",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const {
          startDate,
          endDate,
          start,
          end,
          interval = "day",
        } = req.query as Record<string, string | undefined>;
        const normalizedStart = startDate || start;
        const normalizedEnd = endDate || end;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "viewAnalytics",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const analyticsAccess = await validateProfileAnalyticsAccess(req.user.id);
        if (!analyticsAccess.hasAccess) {
          return res.status(402).json({
            message: analyticsAccess.error,
            subscriptionTier: analyticsAccess.subscriptionTier,
          });
        }

        if (!normalizedStart || !normalizedEnd) {
          return res
            .status(400)
            .json({ message: "startDate and endDate are required" });
        }

        const timeseries = await storage.getRestaurantAnalyticsTimeseries(
          restaurantId,
          {
            start: new Date(normalizedStart),
            end: new Date(normalizedEnd),
          },
          interval as "day" | "week",
        );
        res.json(timeseries);
      } catch (error) {
        console.error("Error fetching analytics timeseries:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch analytics timeseries" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/analytics/customers",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const { startDate, endDate } = req.query;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "viewAnalytics",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const analyticsAccess = await validateProfileAnalyticsAccess(req.user.id);
        if (!analyticsAccess.hasAccess) {
          return res.status(402).json({
            message: analyticsAccess.error,
            subscriptionTier: analyticsAccess.subscriptionTier,
          });
        }

        let dateRange: { start: Date; end: Date } | undefined;
        if (startDate && endDate) {
          dateRange = {
            start: new Date(startDate as string),
            end: new Date(endDate as string),
          };
        }

        const insights = await storage.getRestaurantCustomerInsights(
          restaurantId,
          dateRange,
        );
        res.json(insights);
      } catch (error) {
        console.error("Error fetching customer insights:", error);
        res.status(500).json({ message: "Failed to fetch customer insights" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/analytics/compare",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const { currentStart, currentEnd, previousStart, previousEnd } =
          req.query;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "viewAnalytics",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const analyticsAccess = await validateProfileAnalyticsAccess(req.user.id);
        if (!analyticsAccess.hasAccess) {
          return res.status(402).json({
            message: analyticsAccess.error,
            subscriptionTier: analyticsAccess.subscriptionTier,
          });
        }

        if (!currentStart || !currentEnd || !previousStart || !previousEnd) {
          return res.status(400).json({
            message:
              "currentStart, currentEnd, previousStart, and previousEnd are required",
          });
        }

        const [currentPeriod, previousPeriod] = await Promise.all([
          storage.getRestaurantAnalyticsSummary(restaurantId, {
            start: new Date(currentStart as string),
            end: new Date(currentEnd as string),
          }),
          storage.getRestaurantAnalyticsSummary(restaurantId, {
            start: new Date(previousStart as string),
            end: new Date(previousEnd as string),
          }),
        ]);

        res.json({
          current: currentPeriod,
          previous: previousPeriod,
          changes: {
            viewsChange:
              previousPeriod.totalViews > 0
                ? ((currentPeriod.totalViews - previousPeriod.totalViews) /
                    previousPeriod.totalViews) *
                  100
                : 0,
            claimsChange:
              previousPeriod.totalClaims > 0
                ? ((currentPeriod.totalClaims - previousPeriod.totalClaims) /
                    previousPeriod.totalClaims) *
                  100
                : 0,
            revenueChange:
              previousPeriod.totalRevenue > 0
                ? ((currentPeriod.totalRevenue - previousPeriod.totalRevenue) /
                    previousPeriod.totalRevenue) *
                  100
                : 0,
            conversionRateChange:
              currentPeriod.conversionRate - previousPeriod.conversionRate,
          },
        });
      } catch (error) {
        console.error("Error fetching analytics comparison:", error);
        res
          .status(500)
          .json({ message: "Failed to fetch analytics comparison" });
      }
    },
  );

  app.get(
    "/api/restaurants/:restaurantId/analytics/export",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const { startDate, endDate, format = "csv" } = req.query;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "viewAnalytics",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const analyticsAccess = await validateProfileAnalyticsAccess(req.user.id);
        if (!analyticsAccess.hasAccess) {
          return res.status(402).json({
            message: analyticsAccess.error,
            subscriptionTier: analyticsAccess.subscriptionTier,
          });
        }

        if (!startDate || !endDate) {
          return res
            .status(400)
            .json({ message: "startDate and endDate are required" });
        }

        const exportData = await storage.getRestaurantAnalyticsExport(
          restaurantId,
          {
            start: new Date(startDate as string),
            end: new Date(endDate as string),
          },
        );

        if (format === "csv") {
          const csvHeader = "Deal Title,Date,Views,Claims,Revenue\n";
          const csvRows = exportData
            .map((row: any) => {
              const sanitizeCSV = (value: any): string => {
                if (value === null || value === undefined) return "";
                const str = String(value);
                if (/^[=+@-]/.test(str)) {
                  return `"'${str.replace(/"/g, '""')}"`;
                }
                return `"${str.replace(/"/g, '""')}"`;
              };

              return [
                sanitizeCSV(row.dealTitle),
                sanitizeCSV(row.date),
                sanitizeCSV(row.views),
                sanitizeCSV(row.claims),
                sanitizeCSV(row.revenue),
              ].join(",");
            })
            .join("\n");

          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="analytics-${encodeURIComponent(
              restaurantId,
            )}-${encodeURIComponent(startDate as string)}-${encodeURIComponent(
              endDate as string,
            )}.csv"`,
          );
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          return res.send(csvHeader + csvRows);
        }

        res.json(exportData);
      } catch (error) {
        console.error("Error exporting analytics:", error);
        res.status(500).json({ message: "Failed to export analytics" });
      }
    },
  );
}
