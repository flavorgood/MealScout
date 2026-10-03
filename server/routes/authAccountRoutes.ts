import type { Express } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

import { storage } from "../storage";
import { db } from "../db";
import { isAuthenticated } from "../unifiedAuth";
import { sanitizeUser } from "../utils/sanitize";
import {
  isPasswordStrong,
  PASSWORD_REQUIREMENTS,
} from "../utils/passwordPolicy";
import {
  upload,
  uploadToCloudinary,
  isCloudinaryConfigured,
} from "../imageUpload";
import {
  getBusinessAccessContext,
  hasBusinessPermissionForRestaurant,
} from "../services/businessTeamAccess";
import { resolveUserContinuation } from "../services/loginContinuation";
import {
  businessStaffMemberships,
  hosts,
  insertUserAddressSchema,
  restaurants,
  suppliers,
} from "@shared/schema";
import { resolveEffectiveLocationContext } from "../services/sessionLocationContext";
import { authLog } from "../utils/authLog";
import {
  isMealScoutPlatformHostname,
  normalizeCustomProfileHostname,
} from "../services/customProfileDomain";
import { clearPublicMapLocationsCache } from "./publicMapRoutes";

const FIRST_PARTNER_MESSAGE =
  "As an appreciation of being our first MealScout Partner, 3D Eats is recognized as a founding partner. Your complete profile remains included. Keep killin it.";

function isLikely3DEatsPartner(
  user: any,
  ownedRestaurants: Array<{ name?: string | null }>,
) {
  const firstName = String(user?.firstName || "")
    .trim()
    .toLowerCase();
  if (firstName !== "sean") return false;

  const hasExact3dEatsRestaurant = ownedRestaurants.some(
    (row) => String(row?.name || "").trim().toLowerCase() === "3d eats",
  );
  if (hasExact3dEatsRestaurant) return true;

  const allowlistedEmails = String(
    process.env.MEALSCOUT_FIRST_PARTNER_EMAILS || "",
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const email = String(user?.email || "")
    .trim()
    .toLowerCase();
  return email.length > 0 && allowlistedEmails.includes(email);
}

async function ensureFirstPartnerRecognition(user: any) {
  if (!user?.id) return user;
  if (!["restaurant_owner", "food_truck"].includes(String(user.userType || ""))) {
    return user;
  }

  const ownedRestaurants = await storage.getRestaurantsByOwner(String(user.id));
  if (!isLikely3DEatsPartner(user, ownedRestaurants as any[])) {
    return user;
  }

  const now = new Date();
  const currentSettings =
    user?.accountSettings && typeof user.accountSettings === "object"
      ? { ...(user.accountSettings as any) }
      : {};
  const existingPartnerProgram = currentSettings.partnerProgram || {};
  const existingAnnouncement = existingPartnerProgram.loginAnnouncement || null;
  const shouldQueueAnnouncement =
    !existingAnnouncement?.pending && !existingAnnouncement?.shownAt;
  const partnerProgram = {
    ...existingPartnerProgram,
    partnerKey: "3d-eats",
    foundingPartner: true,
    recognizedAt: existingPartnerProgram.recognizedAt || now.toISOString(),
    loginAnnouncement: shouldQueueAnnouncement
      ? {
          message: FIRST_PARTNER_MESSAGE,
          pending: true,
          queuedAt: now.toISOString(),
        }
      : existingAnnouncement,
  };

  if (
    JSON.stringify(partnerProgram) ===
    JSON.stringify(currentSettings.partnerProgram || {})
  ) {
    return user;
  }

  const updated = await storage.updateUser(String(user.id), {
    accountSettings: {
      ...currentSettings,
      partnerProgram,
    } as any,
  });

  return updated || user;
}

const toSlug = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

const buildPublicProfilePath = (
  entityType: "restaurant" | "location" | "supplier",
  id: string,
  name: string | null | undefined,
) => {
  const slug = `${toSlug(name) || id}--${id}`;
  if (entityType === "location") return `/location/${slug}`;
  if (entityType === "supplier") return `/supplier/${slug}`;
  return `/restaurant/${slug}`;
};

const publicProfileSettingsSchema = z.object({
  templatePreset: z.enum(["classic", "story", "bold", "minimal"]).optional(),
  theme: z.enum(["sunset", "slate", "forest", "amber"]).optional(),
  accentColor: z.string().max(32).optional(),
  fontFamily: z.enum(["system", "serif", "display", "mono"]).optional(),
  heroLayout: z.enum(["center", "left", "split"]).optional(),
  heroTitle: z.string().max(120).optional(),
  heroSubtitle: z.string().max(220).optional(),
  ctaLabel: z.string().max(50).optional(),
  ctaUrl: z.string().max(300).optional(),
  about: z.string().max(2000).optional(),
  highlights: z.array(z.string().max(120)).max(8).optional(),
  featuredLinks: z
    .array(
      z.object({
        label: z.string().max(40),
        url: z.string().max(300),
      }),
    )
    .max(8)
    .optional(),
  galleryUrls: z.array(z.string().max(500)).max(12).optional(),
  sectionOrder: z
    .array(
      z.enum([
        "about",
        "highlights",
        "links",
        "gallery",
        "contact",
        "location",
        "metrics",
      ]),
    )
    .max(12)
    .optional(),
  showAddress: z.boolean().optional(),
  showContact: z.boolean().optional(),
  showHours: z.boolean().optional(),
  hideProfileBadge: z.boolean().optional(),
});

const accountSettingsSchema = z.object({
  language: z.string().max(24).optional(),
  currency: z.string().max(12).optional(),
  locationServices: z.boolean().optional(),
  analytics: z.boolean().optional(),
  marketing: z.boolean().optional(),
  notifications: z
    .object({
      channels: z
        .object({
          push: z.boolean().optional(),
          email: z.boolean().optional(),
          sms: z.boolean().optional(),
        })
        .optional(),
      topics: z
        .object({
          dealAlerts: z.boolean().optional(),
          orderUpdates: z.boolean().optional(),
          newRestaurants: z.boolean().optional(),
          weeklyDigest: z.boolean().optional(),
          nearbyEvents: z.boolean().optional(),
          followedActivity: z.boolean().optional(),
          businessMessages: z.boolean().optional(),
          recommendations: z.boolean().optional(),
          account: z.boolean().optional(),
        })
        .optional(),
      location: z
        .object({
          enabled: z.boolean().optional(),
          radiusKm: z.number().min(0.5).max(50).optional(),
          maxPerDay: z.number().int().min(1).max(50).optional(),
        })
        .optional(),
    })
    .optional(),
  privacy: z
    .object({
      profileVisibility: z.enum(["public", "private", "connections"]).optional(),
      showEmail: z.boolean().optional(),
      showPhone: z.boolean().optional(),
    })
    .optional(),
  customDomain: z
    .object({
      hostname: z.string().max(255).optional(),
      restaurantId: z.string().uuid().optional(),
      canonicalPath: z.string().max(500).optional(),
      status: z.enum(["unverified", "verified", "mismatch", "error"]).optional(),
      lastCheckedAt: z.string().optional(),
      expectedTarget: z.string().optional(),
      diagnostics: z.string().optional(),
    })
    .optional(),
});

export function registerAuthAccountRoutes(app: Express) {
  app.get("/api/auth/user", async (req: any, res) => {
    try {
      authLog("auth_user_request", {
        isAuthenticated: req.isAuthenticated(),
        sessionId: req.sessionID || null,
        hasSession: Boolean(req.session),
      });

      if (!req.isAuthenticated()) {
        authLog("auth_user_unauthenticated", { isAuthenticated: false });
        return res.status(401).json({ error: "Not authenticated" });
      }

      let user = req.user;

      if (String(user?.userType || "") === "customer") {
        const ownedRestaurants = await storage.getRestaurantsByOwner(user.id);
        const hasFoodTruckProfile = ownedRestaurants.some(
          (row: any) =>
            Boolean(row?.isFoodTruck) ||
            String(row?.businessType || "").toLowerCase() === "food_truck",
        );

        if (hasFoodTruckProfile) {
          try {
            await storage.updateUserType(user.id, "food_truck");
            user = { ...user, userType: "food_truck" };
            req.user = user;
          } catch (roleFixError) {
            console.warn(
              "Unable to auto-correct userType to food_truck:",
              roleFixError,
            );
          }
        }
      }

      user = await ensureFirstPartnerRecognition(user);

      authLog("auth_user_authenticated", {
        userId: user.id,
        email: user.email || null,
        userType: user.userType || null,
      });

      const safeUser: any = sanitizeUser(user) || {};
      const partnerProgram =
        user?.accountSettings && typeof user.accountSettings === "object"
          ? (user.accountSettings as any).partnerProgram
          : null;
      const pendingAnnouncement = partnerProgram?.loginAnnouncement;

      if (
        pendingAnnouncement &&
        pendingAnnouncement.pending === true &&
        String(pendingAnnouncement.message || "").trim()
      ) {
        safeUser.loginAnnouncement = String(pendingAnnouncement.message);

        try {
          const nextAccountSettings = {
            ...(user.accountSettings || {}),
            partnerProgram: {
              ...(partnerProgram || {}),
              loginAnnouncement: {
                ...pendingAnnouncement,
                pending: false,
                shownAt: new Date().toISOString(),
              },
            },
          };
          const updated = await storage.updateUser(user.id, {
            accountSettings: nextAccountSettings as any,
          });
          if (updated) {
            req.user = updated;
          }
        } catch (announcementError) {
          console.warn(
            "Unable to mark partner login announcement as shown:",
            announcementError,
          );
        }
      }

      if (user.mustResetPassword) {
        return res.json({
          ...safeUser,
          requiresPasswordReset: true,
          accountOnboardingComplete: false,
          businessOnboardingRequired: false,
          businessOnboardingPath: null,
          businessAccessSummary: null,
          primaryBusinessId: null,
          profileComplete: false,
          verificationRequired: false,
          emailVerified: user?.emailVerified === true,
          businessInsuranceSubmitted: false,
          menuRequired: false,
          menuItemCount: 0,
          scheduleRequired: false,
          hasSchedule: false,
          nextRequiredStep: "account_onboarding",
          continuationPath: "/change-password",
          continuationReason: "Password reset is required before continuing.",
          effectiveLocationContext: resolveEffectiveLocationContext(req, user),
        });
      }

      let businessOnboardingRequired = false;
      let businessOnboardingPath: string | null = null;
      let businessAccessSummary: any = null;
      const normalizedUserType = String(user?.userType || "").toLowerCase();
      const isBusinessCapableUser =
        normalizedUserType === "food_truck" ||
        normalizedUserType === "restaurant_owner";
      if (isBusinessCapableUser) {
        try {
          const businessAccess = await getBusinessAccessContext(user.id);
          businessAccessSummary = {
            linkState: businessAccess.linkState,
            guidance: businessAccess.guidance,
            restaurantCount: Array.isArray(businessAccess.restaurants)
              ? businessAccess.restaurants.length
              : 0,
            primaryRestaurantId: businessAccess.primaryRestaurant?.id || null,
          };
          businessOnboardingRequired = businessAccess.linkState === "not_attached";
          if (businessOnboardingRequired) {
            businessOnboardingPath =
              normalizedUserType === "food_truck"
                ? "/restaurant-signup?businessType=food_truck&source=auth&claim=1"
                : "/restaurant-signup?businessType=restaurant&source=auth&claim=1";
          }
        } catch (businessAccessError) {
          console.warn(
            "Unable to resolve business access summary for auth payload:",
            businessAccessError,
          );
        }
      }

      const continuation = await resolveUserContinuation({
        user,
        businessAccessSummary,
      });
      res.json({
        ...safeUser,
        effectiveLocationContext: resolveEffectiveLocationContext(req, user),
        businessOnboardingRequired:
          continuation.businessOnboardingRequired || businessOnboardingRequired,
        businessOnboardingPath:
          continuation.nextRequiredStep === "business_setup"
            ? continuation.continuationPath
            : businessOnboardingPath,
        businessAccessSummary: continuation.businessAccessSummary,
        accountOnboardingComplete: continuation.accountOnboardingComplete,
        primaryBusinessId: continuation.primaryBusinessId,
        profileComplete: continuation.profileComplete,
        verificationRequired: continuation.verificationRequired,
        emailVerified: continuation.emailVerified,
        businessInsuranceSubmitted: continuation.businessInsuranceSubmitted,
        menuRequired: continuation.menuRequired,
        menuItemCount: continuation.menuItemCount,
        scheduleRequired: continuation.scheduleRequired,
        hasSchedule: continuation.hasSchedule,
        nextRequiredStep: continuation.nextRequiredStep,
        continuationPath: continuation.continuationPath,
        continuationReason: continuation.reason,
      });
    } catch (error) {
      console.error("❌ Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.get("/api/location/context", isAuthenticated, async (req: any, res) => {
    try {
      res.json({
        effectiveLocationContext: resolveEffectiveLocationContext(req, req.user),
        adminMarketSelection: req.session?.adminMarketSelection || null,
        deviceLocationContext: req.session?.deviceLocationContext || null,
      });
    } catch (error) {
      console.error("Error fetching session location context:", error);
      res.status(500).json({ message: "Failed to fetch location context" });
    }
  });

  app.patch("/api/location/context", isAuthenticated, async (req: any, res) => {
    try {
      const schema = z.object({
        mode: z.enum(["device", "admin_override", "clear_admin_override"]),
        location: z
          .object({
            marketKey: z.string().min(2).max(64),
            city: z.string().max(120).optional(),
            state: z.string().max(64).optional(),
            latitude: z.number().finite().optional(),
            longitude: z.number().finite().optional(),
          })
          .optional(),
      });
      const parsed = schema.parse(req.body || {});
      const updatedAt = new Date().toISOString();

      if (parsed.mode === "clear_admin_override") {
        req.session.adminMarketSelection = undefined;
      } else {
        const payload = {
          marketKey: parsed.location?.marketKey || "",
          city: parsed.location?.city || null,
          state: parsed.location?.state || null,
          latitude:
            typeof parsed.location?.latitude === "number"
              ? parsed.location.latitude
              : null,
          longitude:
            typeof parsed.location?.longitude === "number"
              ? parsed.location.longitude
              : null,
          updatedAt,
        };
        if (parsed.mode === "admin_override") {
          req.session.adminMarketSelection = payload;
        } else {
          req.session.deviceLocationContext = payload;
        }
      }

      req.session.save((err: unknown) => {
        if (err) {
          console.error("Failed to persist location context session:", err);
          return res
            .status(500)
            .json({ message: "Failed to save location context" });
        }
        return res.json({
          effectiveLocationContext: resolveEffectiveLocationContext(req, req.user),
          adminMarketSelection: req.session?.adminMarketSelection || null,
          deviceLocationContext: req.session?.deviceLocationContext || null,
        });
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ message: "Invalid location context payload", errors: error.errors });
      }
      console.error("Error updating session location context:", error);
      return res.status(500).json({ message: "Failed to update location context" });
    }
  });

  app.get("/api/settings/me", isAuthenticated, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.user.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const [ownedRestaurants, ownedHosts, ownedSuppliers] = await Promise.all([
        storage.getRestaurantsByOwner(user.id),
        storage.getHostsByUserId(user.id),
        db
          .select({
            id: suppliers.id,
            businessName: suppliers.businessName,
            isActive: suppliers.isActive,
          })
          .from(suppliers)
          .where(eq(suppliers.userId, user.id)),
      ]);

      const profileLinks = [
        ...ownedRestaurants
          .filter((row: any) => row?.isActive)
          .map((row: any) => ({
            entity: "restaurant",
            id: row.id,
            title: row.name,
            path: buildPublicProfilePath("restaurant", String(row.id), row.name),
          })),
        ...ownedHosts.map((row: any) => ({
          entity: "host",
          id: row.id,
          title: row.businessName,
          path: buildPublicProfilePath("location", String(row.id), row.businessName),
        })),
        ...ownedSuppliers
          .filter((row: any) => row?.isActive)
          .map((row: any) => ({
            entity: "supplier",
            id: row.id,
            title: row.businessName,
            path: buildPublicProfilePath("supplier", String(row.id), row.businessName),
          })),
      ];

      res.json({
        accountSettings: user.accountSettings || {},
        publicProfileSettings: user.publicProfileSettings || {},
        profileLinks,
        publicIdentityStatus: {
          standaloneUserProfile: {
            supported: false,
            public: false,
            reason: "role_scoped_entity_profiles_only",
          },
          linkedEntityProfileCount: profileLinks.length,
          linkedEntityProfilesAvailable: profileLinks.length > 0,
          discoveryParity: {
            tierNeutral: true,
            paidTierRequired: false,
          },
        },
        media: {
          provider: isCloudinaryConfigured() ? "cloudinary" : "none",
          configured: isCloudinaryConfigured(),
        },
      });
    } catch (error) {
      console.error("Error fetching user settings:", error);
      res.status(500).json({ message: "Failed to fetch settings" });
    }
  });

  app.patch("/api/settings/me", isAuthenticated, async (req: any, res) => {
    try {
      const payloadSchema = z.object({
        accountSettings: accountSettingsSchema.optional(),
        publicProfileSettings: publicProfileSettingsSchema.optional(),
      });
      const parsed = payloadSchema.parse(req.body || {});
      const current = await storage.getUser(req.user.id);
      if (!current) {
        return res.status(404).json({ message: "User not found" });
      }

      const nextAccountSettings = {
        ...(current.accountSettings || {}),
        ...(parsed.accountSettings || {}),
      };
      const nextPublicProfileSettings = {
        ...(current.publicProfileSettings || {}),
        ...(parsed.publicProfileSettings || {}),
      };

      const updated = await storage.updateUser(req.user.id, {
        accountSettings: nextAccountSettings as any,
        publicProfileSettings: nextPublicProfileSettings as any,
      });
      if (parsed.publicProfileSettings) {
        clearPublicMapLocationsCache();
      }

      res.json({
        accountSettings: updated.accountSettings || {},
        publicProfileSettings: updated.publicProfileSettings || {},
      });
    } catch (error: any) {
      console.error("Error updating user settings:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid settings payload",
          errors: error.errors,
        });
      }
      res.status(500).json({ message: "Failed to update settings" });
    }
  });

  app.post("/api/auth/onboarding/role-correction", isAuthenticated, async (req: any, res) => {
    try {
      const schema = z.object({
        targetRole: z.enum([
          "customer",
          "food_truck",
          "restaurant_owner",
          "host",
          "event_coordinator",
        ]),
        businessType: z
          .enum(["food_truck", "restaurant", "bar", "caterer", "private_chef"])
          .optional(),
        draft: z
          .object({
            businessName: z.string().max(120).optional(),
            phone: z.string().max(50).optional(),
            email: z.string().email().optional(),
            address: z.string().max(240).optional(),
            city: z.string().max(120).optional(),
            state: z.string().max(80).optional(),
            cuisineType: z.string().max(120).optional(),
            logoUrl: z.string().max(500).optional(),
            coverImageUrl: z.string().max(500).optional(),
            menuItems: z.array(z.any()).optional(),
          })
          .optional(),
      });
      const parsed = schema.parse(req.body || {});
      const userId = String(req.user?.id || "");
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User not found" });

      const [ownedRestaurants, hostProfiles, activeMemberships] = await Promise.all([
        storage.getRestaurantsByOwner(userId),
        db.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, userId)),
        db
          .select({ id: businessStaffMemberships.id })
          .from(businessStaffMemberships)
          .where(eq(businessStaffMemberships.userId, userId)),
      ]);
      const hasBusinessProfile = Array.isArray(ownedRestaurants) && ownedRestaurants.length > 0;
      const hasHostProfile = Array.isArray(hostProfiles) && hostProfiles.length > 0;
      const hasBusinessMembership =
        Array.isArray(activeMemberships) && activeMemberships.length > 0;

      const switchingIntoHost = parsed.targetRole === "host";
      const switchingIntoBusiness = ["food_truck", "restaurant_owner"].includes(
        parsed.targetRole,
      );
      if (switchingIntoHost && hasBusinessProfile) {
        return res.status(409).json({
          message:
            "Cannot switch to host after business profile creation without admin repair.",
          code: "profile_already_created",
        });
      }
      if (switchingIntoBusiness && hasHostProfile) {
        return res.status(409).json({
          message:
            "Cannot switch to business role after host profile creation without admin repair.",
          code: "profile_already_created",
        });
      }
      if (switchingIntoBusiness && hasBusinessMembership && !hasBusinessProfile) {
        return res.status(409).json({
          message:
            "This account is already linked to a business team. Use admin repair to convert role safely.",
          code: "already_linked_membership",
        });
      }

      const currentSettings =
        user?.accountSettings && typeof user.accountSettings === "object"
          ? ({ ...(user.accountSettings as any) } as any)
          : {};
      const existingDraft =
        currentSettings.businessDraft && typeof currentSettings.businessDraft === "object"
          ? ({ ...currentSettings.businessDraft } as any)
          : {};
      const nextDraft = {
        ...existingDraft,
        ...(parsed.draft || {}),
        businessType:
          parsed.businessType ||
          existingDraft.businessType ||
          (parsed.targetRole === "food_truck" ? "food_truck" : existingDraft.businessType),
        roleIntent: parsed.targetRole,
        updatedAt: new Date().toISOString(),
      };
      const nextSettings = {
        ...currentSettings,
        businessDraft: nextDraft,
      };

      let updatedUser = user;
      if (String(user.userType || "") !== parsed.targetRole) {
        await storage.updateUserType(userId, parsed.targetRole);
        updatedUser = (await storage.getUser(userId)) || user;
      }
      updatedUser =
        (await storage.updateUser(userId, {
          accountSettings: nextSettings as any,
        })) || updatedUser;

      const businessAccessSummary = ["food_truck", "restaurant_owner"].includes(
        String(updatedUser.userType || ""),
      )
        ? (() =>
            getBusinessAccessContext(updatedUser.id).then((ctx) => ({
              linkState: ctx.linkState as "linked" | "not_attached",
              guidance: ctx.guidance,
              restaurantCount: Array.isArray(ctx.restaurants)
                ? ctx.restaurants.length
                : 0,
              primaryRestaurantId: ctx.primaryRestaurant?.id || null,
            })))()
        : Promise.resolve(null);
      const continuation = await resolveUserContinuation({
        user: updatedUser,
        businessAccessSummary: await businessAccessSummary,
      });

      res.json({
        ok: true,
        userType: updatedUser.userType,
        accountSettings: updatedUser.accountSettings || {},
        nextRequiredStep: continuation.nextRequiredStep,
        continuationPath: continuation.continuationPath,
        continuationReason: continuation.reason,
      });
    } catch (error: any) {
      console.error("Error correcting onboarding role:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid role correction payload",
          errors: error.errors,
        });
      }
      res.status(500).json({ message: "Failed to correct onboarding role" });
    }
  });

  app.post(
    "/api/settings/public-profile/gallery",
    isAuthenticated,
    upload.single("image"),
    async (req: any, res) => {
      try {
        if (!isCloudinaryConfigured()) {
          return res
            .status(503)
            .json({ message: "Image upload service not configured" });
        }
        if (!req.file) {
          return res.status(400).json({ message: "No image file provided" });
        }
        const user = await storage.getUser(req.user.id);
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        const result = await uploadToCloudinary(
          req.file.buffer,
          "public-profiles",
          `profile-${user.id}-${Date.now()}`,
        );

        const current = (user.publicProfileSettings || {}) as any;
        const galleryUrls = Array.isArray(current.galleryUrls)
          ? current.galleryUrls
          : [];
        const nextGalleryUrls = [result.secureUrl, ...galleryUrls].slice(0, 12);

        await storage.updateUser(user.id, {
          publicProfileSettings: {
            ...current,
            galleryUrls: nextGalleryUrls,
          } as any,
        });

        res.json({
          url: result.secureUrl,
          thumbnailUrl: result.thumbnailUrl,
          galleryUrls: nextGalleryUrls,
        });
      } catch (error) {
        console.error("Error uploading public profile image:", error);
        res.status(500).json({ message: "Failed to upload image" });
      }
    },
  );

  app.post(
    "/api/settings/custom-domain/verify",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const payloadSchema = z.object({
          hostname: z
            .string()
            .trim()
            .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Invalid hostname"),
          restaurantId: z.string().uuid(),
        });
        const parsed = payloadSchema.parse(req.body || {});
        const hostname = normalizeCustomProfileHostname(parsed.hostname);
        if (isMealScoutPlatformHostname(hostname)) {
          return res
            .status(400)
            .json({ message: "Use a domain owned by this business" });
        }
        const user = await storage.getUser(req.user.id);
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }
        const [restaurant] = await db
          .select({ id: restaurants.id })
          .from(restaurants)
          .where(eq(restaurants.id, parsed.restaurantId))
          .limit(1);
        if (!restaurant) {
          return res.status(404).json({ message: "Business not found" });
        }
        const canManageProfile = await hasBusinessPermissionForRestaurant(
          req.user.id,
          parsed.restaurantId,
          "manageProfile",
        );
        if (!canManageProfile) {
          return res.status(403).json({ message: "Business access required" });
        }

        const dns = await import("dns/promises");
        const expectedTarget = String(
          process.env.PROFILE_DOMAIN_CNAME_TARGET ||
            process.env.RENDER_EXTERNAL_HOSTNAME ||
            (process.env.PUBLIC_BASE_URL || "mealscout.us")
              .replace(/^https?:\/\//, "")
              .replace(/\/+$/, ""),
        )
          .toLowerCase()
          .trim();
        let status: "unverified" | "verified" | "mismatch" | "error" =
          "unverified";
        let diagnostics = "";

        try {
          const cnames = await dns.resolveCname(hostname);
          const normalized = cnames.map((c) =>
            String(c || "")
              .toLowerCase()
              .replace(/\.$/, ""),
          );
          const expected = expectedTarget.replace(/\.$/, "");
          if (normalized.includes(expected)) {
            status = "verified";
          } else {
            status = "mismatch";
            diagnostics = `CNAME points to ${normalized.join(", ") || "none"}, expected ${expected}`;
          }
        } catch (e: any) {
          status = "error";
          diagnostics = e?.message || "DNS lookup failed";
        }

        const accountSettings = {
          ...(user.accountSettings || {}),
          customDomain: {
            hostname,
            restaurantId: parsed.restaurantId,
            canonicalPath: `/restaurant/${encodeURIComponent(
              parsed.restaurantId,
            )}`,
            status,
            lastCheckedAt: new Date().toISOString(),
            expectedTarget,
            diagnostics,
          },
        };
        await storage.updateUser(user.id, {
          accountSettings: accountSettings as any,
        });

        res.json(accountSettings.customDomain);
      } catch (error: any) {
        console.error("Error verifying custom domain:", error);
        if (error instanceof z.ZodError) {
          return res.status(400).json({
            message: "Invalid domain payload",
            errors: error.errors,
          });
        }
        res.status(500).json({ message: "Failed to verify custom domain" });
      }
    },
  );

  app.post(
    "/api/auth/change-temp-password",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const schema = z.object({
          currentPassword: z.string().min(1, "Current password is required"),
          newPassword: z
            .string()
            .min(1, PASSWORD_REQUIREMENTS)
            .refine(isPasswordStrong, PASSWORD_REQUIREMENTS),
        });

        const { currentPassword, newPassword } = schema.parse(req.body);
        const user = req.user;

        if (!user.passwordHash) {
          return res.status(400).json({
            success: false,
            error: "Account uses OAuth authentication",
          });
        }

        const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!isValid) {
          return res.status(400).json({
            success: false,
            error: "Current password is incorrect",
          });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await storage.upsertUser({
          id: user.id,
          userType: user.userType,
          email: user.email!,
          firstName: user.firstName,
          lastName: user.lastName,
          profileImageUrl: user.profileImageUrl,
          passwordHash: hashedPassword,
          emailVerified: user.emailVerified,
          facebookId: user.facebookId,
          facebookAccessToken: user.facebookAccessToken,
          googleId: user.googleId,
          googleAccessToken: user.googleAccessToken,
          stripeCustomerId: user.stripeCustomerId,
          stripeSubscriptionId: user.stripeSubscriptionId,
          subscriptionBillingInterval: user.subscriptionBillingInterval,
          birthYear: user.birthYear,
          gender: user.gender,
          postalCode: user.postalCode,
          mustResetPassword: false,
        });

        res.json({
          success: true,
          message: "Password has been successfully changed",
        });
      } catch (error) {
        console.error("Password change error:", error);
        if (error instanceof z.ZodError) {
          res.status(400).json({
            success: false,
            error: "Invalid request",
            details: error.errors,
          });
        } else {
          res.status(500).json({
            success: false,
            error: "Unable to change password",
          });
        }
      }
    },
  );

  app.get("/api/user/addresses", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const addresses = await storage.getUserAddresses(userId);
      res.json(addresses);
    } catch (error) {
      console.error("Error fetching user addresses:", error);
      res.status(500).json({ message: "Failed to fetch addresses" });
    }
  });

  app.post("/api/user/addresses", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const addressData = insertUserAddressSchema.parse({
        ...req.body,
        userId,
      });

      const address = await storage.createUserAddress(addressData);
      await storage.syncHostFromUserAddress(userId, address);
      res.status(201).json(address);
    } catch (error) {
      console.error("Error creating address:", error);
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ message: "Invalid address data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create address" });
      }
    }
  });

  app.put(
    "/api/user/addresses/:addressId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { addressId } = req.params;
        const userId = req.user.id;

        const existingAddress = await storage.getUserAddress(addressId);
        if (!existingAddress || existingAddress.userId !== userId) {
          return res.status(404).json({ message: "Address not found" });
        }

        const updates = insertUserAddressSchema.partial().parse(req.body);
        const updatedAddress = await storage.updateUserAddress(
          addressId,
          updates,
        );
        await storage.syncHostFromUserAddress(
          userId,
          updatedAddress,
          existingAddress,
        );
        res.json(updatedAddress);
      } catch (error) {
        console.error("Error updating address:", error);
        if (error instanceof z.ZodError) {
          res
            .status(400)
            .json({ message: "Invalid address data", errors: error.errors });
        } else {
          res.status(500).json({ message: "Failed to update address" });
        }
      }
    },
  );

  app.delete(
    "/api/user/addresses/:addressId",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { addressId } = req.params;
        const userId = req.user.id;

        const existingAddress = await storage.getUserAddress(addressId);
        if (!existingAddress || existingAddress.userId !== userId) {
          return res.status(404).json({ message: "Address not found" });
        }

        await storage.deleteUserAddress(addressId);
        await storage.deleteHostForUserAddress(userId, existingAddress);
        res.status(204).send();
      } catch (error) {
        console.error("Error deleting address:", error);
        res.status(500).json({ message: "Failed to delete address" });
      }
    },
  );

  app.post(
    "/api/user/addresses/:addressId/set-default",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { addressId } = req.params;
        const userId = req.user.id;

        const existingAddress = await storage.getUserAddress(addressId);
        if (!existingAddress || existingAddress.userId !== userId) {
          return res.status(404).json({ message: "Address not found" });
        }

        await storage.setDefaultAddress(userId, addressId);
        res.status(200).json({ message: "Default address updated" });
      } catch (error) {
        console.error("Error setting default address:", error);
        res.status(500).json({ message: "Failed to set default address" });
      }
    },
  );
}
