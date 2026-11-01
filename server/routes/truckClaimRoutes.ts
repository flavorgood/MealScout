import type { Express } from "express";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import { emailService } from "../emailService";
import { storage } from "../storage";
import { enrichClaimedRestaurant } from "../services/claimEnrichment";
import { isAuthenticated } from "../unifiedAuth";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { sendAccountSetupInvite } from "../utils/accountSetup";
import { sendEmailVerificationIfNeeded } from "../utils/emailVerification";
import { sendSignInContinuationEmail } from "../utils/signInContinuation";
import { buildFoodTruckClaimContinuationPath } from "@shared/businessSignupIntent";
import {
  acquireFoodTruckIdentityLock,
  buildFoodTruckIdentity,
  normalizeFoodTruckIdentityText,
  normalizedFoodTruckImportIdentityPredicate,
  normalizedFoodTruckRestaurantIdentityPredicate,
} from "../services/foodTruckIdentity";
import { buildRestaurantOwnerTransferReset } from "../services/restaurantOrderingAuthorityReset";
import { lockRestaurantForOwnerTransfer } from "../services/restaurantOwnerTransferSafety";
import {
  publicInsertRestaurantSchema,
  restaurants,
  truckClaimRequests,
  truckImportListings,
  users,
} from "@shared/schema";

const publicClaimSearchLimiter = distributedRateLimit({
  scope: "truck-claims:public-search",
  limit: 40,
  windowMs: 10 * 60 * 1000,
});

const claimReminderLimiter = distributedRateLimit({
  scope: "truck-claims:request",
  limit: 5,
  windowMs: 60 * 60 * 1000,
});

const escapeLikePattern = (value: string) => value.replace(/[\\%_]/g, "\\$&");

const decorateTruckClaimRows = (
  rows: any[],
  opts?: { currentUserId?: string | null },
) => {
  const now = Date.now();
  const COOLDOWN_MS = 6 * 60 * 60 * 1000;

  return rows.map((row) => {
    const hasEmail = Boolean(String(row.email || "").trim());
    const hasInviteUser = Boolean(row.invitedUserId);
    const isInviteOwner =
      row.invitedUserId &&
      opts?.currentUserId &&
      String(row.invitedUserId) === String(opts.currentUserId);

    const lastInviteSentAtMs = row.lastInviteSentAt
      ? new Date(row.lastInviteSentAt).getTime()
      : 0;
    const cooldownRemainingMs = lastInviteSentAtMs
      ? Math.max(0, lastInviteSentAtMs + COOLDOWN_MS - now)
      : 0;

    const status = String(row.status || "");
    const isUnclaimed = status === "unclaimed";
    const isLegacyInviteReady =
      status === "claim_requested" &&
      Boolean(isInviteOwner) &&
      !Boolean(row.hasPendingClaim);
    const canClaim =
      (isUnclaimed || isLegacyInviteReady) &&
      (hasInviteUser ? Boolean(isInviteOwner) : true);
    const canRequest =
      hasEmail &&
      !isInviteOwner &&
      ["unclaimed", "claim_requested"].includes(status);

    const common = {
      id: row.id,
      name: row.name,
      address: row.address,
      city: row.city,
      state: row.state,
      invited: Boolean(hasInviteUser || row.status === "claim_requested"),
      canClaim,
      canRequest,
      requestCooldownMinutes: cooldownRemainingMs
        ? Math.ceil(cooldownRemainingMs / 60000)
        : 0,
    };

    return {
      ...common,
      phone: row.phone,
      externalId: row.externalId,
      confidenceScore: row.confidenceScore,
    };
  });
};

type TruckClaimRouteDependencies = {
  sendSetupInvite?: typeof sendAccountSetupInvite;
  sendVerificationInvite?: typeof sendEmailVerificationIfNeeded;
  sendSignInInvite?: typeof sendSignInContinuationEmail;
  enrichClaimedProfile?: typeof enrichClaimedRestaurant;
  sendClaimVerification?: typeof sendEmailVerificationIfNeeded;
  sendClaimAdminNotice?: typeof emailService.sendBasicEmail;
};

export function registerTruckClaimRoutes(
  app: Express,
  {
    sendSetupInvite = sendAccountSetupInvite,
    sendVerificationInvite = sendEmailVerificationIfNeeded,
    sendSignInInvite = sendSignInContinuationEmail,
    enrichClaimedProfile = enrichClaimedRestaurant,
    sendClaimVerification = sendEmailVerificationIfNeeded,
    sendClaimAdminNotice = (...args) => emailService.sendBasicEmail(...args),
  }: TruckClaimRouteDependencies = {},
) {
  app.get("/api/truck-claims/search", isAuthenticated, async (req: any, res) => {
    try {
      const query = String(req.query?.q || "").trim().slice(0, 120);
      const listingId = String(req.query?.listingId || "").trim().slice(0, 80);
      if (!query && !listingId) {
        return res.json([]);
      }

      if (listingId) {
        const exactListing = await db
          .select({
            id: truckImportListings.id,
            name: truckImportListings.name,
            address: truckImportListings.address,
            city: truckImportListings.city,
            state: truckImportListings.state,
            phone: truckImportListings.phone,
            externalId: truckImportListings.externalId,
            confidenceScore: truckImportListings.confidenceScore,
            email: truckImportListings.email,
            status: truckImportListings.status,
            hasPendingClaim: sql<boolean>`exists (
              select 1 from ${truckClaimRequests}
              where ${truckClaimRequests.listingId} = ${truckImportListings.id}
                and ${truckClaimRequests.status} = 'pending'
            )`,
            invitedUserId: truckImportListings.invitedUserId,
            lastInviteSentAt: truckImportListings.lastInviteSentAt,
          })
          .from(truckImportListings)
          .where(
            and(
              eq(truckImportListings.id, listingId),
              inArray(truckImportListings.status, [
                "unclaimed",
                "claim_requested",
              ] as any),
            ),
          )
          .limit(1);

        return res.json(
          decorateTruckClaimRows(exactListing, {
            currentUserId: req.user?.id,
          }),
        );
      }

      const externalMatch = await db
        .select({
          id: truckImportListings.id,
          name: truckImportListings.name,
          address: truckImportListings.address,
          city: truckImportListings.city,
          state: truckImportListings.state,
          phone: truckImportListings.phone,
          externalId: truckImportListings.externalId,
          confidenceScore: truckImportListings.confidenceScore,
          email: truckImportListings.email,
          status: truckImportListings.status,
          hasPendingClaim: sql<boolean>`exists (
            select 1 from ${truckClaimRequests}
            where ${truckClaimRequests.listingId} = ${truckImportListings.id}
              and ${truckClaimRequests.status} = 'pending'
          )`,
          invitedUserId: truckImportListings.invitedUserId,
          lastInviteSentAt: truckImportListings.lastInviteSentAt,
        })
        .from(truckImportListings)
        .where(
          and(
            eq(truckImportListings.externalId, query),
            inArray(truckImportListings.status, [
              "unclaimed",
              "claim_requested",
            ] as any),
          ),
        )
        .limit(10);

      if (externalMatch.length > 0) {
        return res.json(
          decorateTruckClaimRows(externalMatch, {
            currentUserId: req.user?.id,
          }),
        );
      }

      const searchValue = `%${escapeLikePattern(query.toLowerCase())}%`;
      const matches = await db
        .select({
          id: truckImportListings.id,
          name: truckImportListings.name,
          address: truckImportListings.address,
          city: truckImportListings.city,
          state: truckImportListings.state,
          phone: truckImportListings.phone,
          externalId: truckImportListings.externalId,
          confidenceScore: truckImportListings.confidenceScore,
          email: truckImportListings.email,
          status: truckImportListings.status,
          hasPendingClaim: sql<boolean>`exists (
            select 1 from ${truckClaimRequests}
            where ${truckClaimRequests.listingId} = ${truckImportListings.id}
              and ${truckClaimRequests.status} = 'pending'
          )`,
          invitedUserId: truckImportListings.invitedUserId,
          lastInviteSentAt: truckImportListings.lastInviteSentAt,
        })
        .from(truckImportListings)
        .where(
          and(
            inArray(truckImportListings.status, [
              "unclaimed",
              "claim_requested",
            ] as any),
            or(
              sql`lower(${truckImportListings.name}) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.address}, '')) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.city}, '')) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.state}, '')) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.externalId}, '')) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.phone}, '')) like ${searchValue} escape E'\\\\'`,
            ),
          ),
        )
        .orderBy(desc(truckImportListings.confidenceScore))
        .limit(10);

      res.json(
        decorateTruckClaimRows(matches, { currentUserId: req.user?.id }),
      );
    } catch (error) {
      console.error("Error searching truck listings:", error);
      res.status(500).json({ message: "Failed to search truck listings" });
    }
  });

  app.get(
    "/api/truck-claims/public-search",
    publicClaimSearchLimiter,
    async (req: any, res) => {
    try {
      const query = String(req.query?.q || "").trim().slice(0, 120);
      if (query.length < 2) return res.json([]);

      const searchValue = `%${escapeLikePattern(query.toLowerCase())}%`;
      const rows = await db
        .select({
          id: truckImportListings.id,
          name: truckImportListings.name,
          address: truckImportListings.address,
          city: truckImportListings.city,
          state: truckImportListings.state,
        })
        .from(truckImportListings)
        .where(
          and(
            inArray(truckImportListings.status, [
              "unclaimed",
              "claim_requested",
            ] as any),
            or(
              sql`lower(${truckImportListings.name}) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.address}, '')) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.city}, '')) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.state}, '')) like ${searchValue} escape E'\\\\'`,
              sql`lower(coalesce(${truckImportListings.externalId}, '')) like ${searchValue} escape E'\\\\'`,
            ),
          ),
        )
        .orderBy(desc(truckImportListings.confidenceScore))
        .limit(15);

      res.json(rows);
    } catch (error) {
      console.error("Error public-searching truck listings:", error);
      res.status(500).json({ message: "Failed to search truck listings" });
    }
    },
  );

  app.post(
    "/api/truck-claims/request",
    isAuthenticated,
    claimReminderLimiter,
    async (req: any, res) => {
    try {
      const payloadSchema = z.object({ listingId: z.string().min(1) });
      const { listingId } = payloadSchema.parse(req.body);

      const [listing] = await db
        .select()
        .from(truckImportListings)
        .where(eq(truckImportListings.id, listingId))
        .limit(1);

      if (
        !listing ||
        !["unclaimed", "claim_requested"].includes(String(listing.status))
      ) {
        return res
          .status(404)
          .json({ message: "Truck listing is not available." });
      }

      const inviteEmail = String(listing.email || "")
        .trim()
        .toLowerCase();
      if (!listing.invitedUserId && !inviteEmail) {
        return res.status(202).json({
          success: true,
          message: "If setup can be sent for this listing, the owner will receive it.",
        });
      }

      const COOLDOWN_MS = 6 * 60 * 60 * 1000;
      if (listing.lastInviteSentAt) {
        const lastMs = new Date(listing.lastInviteSentAt).getTime();
        if (Date.now() - lastMs < COOLDOWN_MS) {
          const minutes = Math.ceil(
            (COOLDOWN_MS - (Date.now() - lastMs)) / 60000,
          );
          return res.status(429).json({
            message: `A reminder was already sent recently. Try again in about ${minutes} minutes.`,
            cooldownMinutes: minutes,
          });
        }
      }

      const reminderSentAt = new Date();
      const reminderThreshold = new Date(reminderSentAt.getTime() - COOLDOWN_MS);
      const [reminderReservation] = await db
        .update(truckImportListings)
        .set({
          lastInviteSentAt: reminderSentAt,
          updatedAt: reminderSentAt,
        })
        .where(
          and(
            eq(truckImportListings.id, listing.id),
            or(
              isNull(truckImportListings.lastInviteSentAt),
              lt(truckImportListings.lastInviteSentAt, reminderThreshold),
            ),
          ),
        )
        .returning({ id: truckImportListings.id });

      if (!reminderReservation) {
        return res.status(429).json({
          message: "A reminder was already sent recently. Try again later.",
          cooldownMinutes: 360,
        });
      }

      let attachedInviteUserId: string | null = null;
      const recoverFailedDelivery = async () => {
        const guards = [
          eq(truckImportListings.id, listing.id),
          eq(truckImportListings.lastInviteSentAt, reminderSentAt),
        ];
        if (attachedInviteUserId) {
          guards.push(
            eq(truckImportListings.invitedUserId, attachedInviteUserId),
          );
        }
        await db
          .update(truckImportListings)
          .set({
            lastInviteSentAt: null,
            ...(attachedInviteUserId ? { invitedUserId: null } : {}),
            updatedAt: new Date(),
          })
          .where(and(...guards));
      };

      try {
        let inviteUser: any | null = null;
        if (listing.invitedUserId) {
          inviteUser = await storage.getUser(listing.invitedUserId);
        }
        if (!inviteUser && inviteEmail) {
          inviteUser = await storage.getUserByEmail(inviteEmail);
          if (!inviteUser) {
            inviteUser = await storage.createUserInvite({
              email: inviteEmail,
              firstName: null,
              lastName: null,
              phone: null,
              userType: "customer",
            });
          }
          const [attached] = await db
            .update(truckImportListings)
            .set({ invitedUserId: inviteUser.id, updatedAt: new Date() })
            .where(
              and(
                eq(truckImportListings.id, listing.id),
                isNull(truckImportListings.invitedUserId),
              ),
            )
            .returning({ invitedUserId: truckImportListings.invitedUserId });
          if (String(attached?.invitedUserId || "") === String(inviteUser.id)) {
            attachedInviteUserId = String(inviteUser.id);
          }
        }

        if (!inviteUser) throw new Error("Invite user is unavailable");
        const continuationPath = buildFoodTruckClaimContinuationPath({
          listingId: listing.id,
          q: listing.name,
          source: "setup-invite",
        });
        if (!continuationPath) throw new Error("Claim continuation is unavailable");

        let deliveryAccepted = false;
        if (!inviteUser.passwordHash) {
          const inviteResult = await sendSetupInvite({
            user: inviteUser,
            createdBy: null,
            req,
            continuationPath,
          });
          deliveryAccepted = inviteResult.emailSent;
        } else if (!inviteUser.emailVerified) {
          const verification = await sendVerificationInvite(
            inviteUser,
            req,
            continuationPath,
          );
          deliveryAccepted = verification.sent;
        } else {
          deliveryAccepted = await sendSignInInvite(
            inviteUser,
            req,
            continuationPath,
          );
        }
        if (!deliveryAccepted) {
          throw new Error("Claim continuation delivery was not accepted");
        }
      } catch (deliveryError) {
        await recoverFailedDelivery();
        console.error("Truck claim reminder delivery failed", {
          listingId: listing.id,
          error:
            deliveryError instanceof Error
              ? deliveryError.message
              : String(deliveryError),
        });
      }

      res.status(202).json({
        success: true,
        message: "If setup can be sent for this listing, the owner will receive it.",
      });
    } catch (error: any) {
      console.error("Error requesting truck setup reminder:", error);
      res.status(400).json({
        message: error.message || "Failed to request reminder",
      });
    }
    },
  );

  app.post("/api/truck-claims", isAuthenticated, async (req: any, res) => {
    try {
      const payloadSchema = z.object({
        listingId: z.string().min(1),
        restaurantData: publicInsertRestaurantSchema.partial(),
      });
      if (req.body?.restaurantData?.acceptTerms !== true) {
        return res.status(400).json({
          message: "You must accept the terms before claiming this listing.",
        });
      }
      const { listingId, restaurantData } = payloadSchema.parse(req.body);

      const claimOutcome = await db.transaction(async (tx: any) => {
        // Reserving the listing is the first write in the transaction. PostgreSQL
        // rechecks the status predicate after a competing row lock is released,
        // so exactly one claimant can move an unclaimed row forward.
        const [listing] = await tx
          .update(truckImportListings)
          .set({ status: "claim_processing", updatedAt: new Date() })
          .where(
            and(
              eq(truckImportListings.id, listingId),
              or(
                and(
                  eq(truckImportListings.status, "unclaimed"),
                  or(
                    isNull(truckImportListings.invitedUserId),
                    eq(truckImportListings.invitedUserId, req.user.id),
                  ),
                ),
                and(
                  eq(truckImportListings.status, "claim_requested"),
                  eq(truckImportListings.invitedUserId, req.user.id),
                  sql`not exists (
                    select 1 from ${truckClaimRequests}
                    where ${truckClaimRequests.listingId} = ${truckImportListings.id}
                      and ${truckClaimRequests.status} = 'pending'
                  )`,
                ),
              ),
            ),
          )
          .returning();

        if (!listing) {
          const error: any = new Error(
            "This truck listing is no longer available to claim.",
          );
          error.statusCode = 409;
          throw error;
        }

        const identity = buildFoodTruckIdentity({
          name: listing.name,
          address: listing.address,
        });
        if (!identity) {
          const error: any = new Error(
            "The selected listing does not have a usable name and address.",
          );
          error.statusCode = 409;
          error.code = "food_truck_listing_identity_unavailable";
          throw error;
        }

        const suppliedName = restaurantData.name;
        const suppliedAddress = restaurantData.address;
        const suppliedIdentityDiffers =
          (suppliedName !== undefined &&
            normalizeFoodTruckIdentityText(suppliedName) !==
              identity.normalizedName) ||
          (suppliedAddress !== undefined &&
            normalizeFoodTruckIdentityText(suppliedAddress) !==
              identity.normalizedAddress);
        if (suppliedIdentityDiffers) {
          const error: any = new Error(
            "The submitted name and address must match the selected truck listing.",
          );
          error.statusCode = 409;
          error.code = "food_truck_claim_identity_mismatch";
          throw error;
        }

        const mergedRestaurant = {
          // The listing owns claim identity. Same-normalized cosmetic edits may
          // be stored, while a materially different identity is rejected above.
          name: suppliedName !== undefined ? suppliedName : listing.name,
          address:
            suppliedAddress !== undefined ? suppliedAddress : listing.address,
          city: restaurantData.city || listing.city,
          state: restaurantData.state || listing.state,
          phone: restaurantData.phone || listing.phone,
          cuisineType: restaurantData.cuisineType || listing.cuisineType,
          websiteUrl: restaurantData.websiteUrl || listing.websiteUrl,
          instagramUrl: restaurantData.instagramUrl || listing.instagramUrl,
          facebookPageUrl:
            restaurantData.facebookPageUrl || listing.facebookPageUrl,
          latitude: restaurantData.latitude || listing.latitude,
          longitude: restaurantData.longitude || listing.longitude,
          description: restaurantData.description || null,
          amenities: restaurantData.amenities || null,
        };

        if (!mergedRestaurant.name || !mergedRestaurant.address) {
          const error: any = new Error(
            "Name and address are required to claim this listing",
          );
          error.statusCode = 400;
          throw error;
        }

        await acquireFoodTruckIdentityLock(tx, identity);

        // Import rows can represent the same real truck more than once and
        // their statuses may diverge over time. Resolve every sibling from the
        // authoritative listing identity while holding the shared identity
        // lock, then treat any restaurant linked to a sibling as a candidate
        // even when that restaurant has stale profile fields/classification.
        const siblingListings = await tx
          .select({ id: truckImportListings.id })
          .from(truckImportListings)
          .where(
            normalizedFoodTruckImportIdentityPredicate(identity, {
              name: truckImportListings.name,
              address: truckImportListings.address,
            }),
          );
        const siblingListingIds = [
          ...new Set([
            String(listing.id),
            ...siblingListings.map((candidate: any) => String(candidate.id)),
          ]),
        ];

        const importSystemEmail =
          process.env.IMPORT_SYSTEM_EMAIL || "system-import@mealscout.us";
        const [importSystemUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            sql`lower(trim(coalesce(${users.email}, ''))) = ${importSystemEmail
              .trim()
              .toLowerCase()}`,
          )
          .limit(1);
        const existingRestaurants = await tx
          .select()
          .from(restaurants)
          .where(
            or(
              inArray(restaurants.claimedFromImportId, siblingListingIds),
              normalizedFoodTruckRestaurantIdentityPredicate(identity),
            ),
          )
          .orderBy(asc(restaurants.createdAt), asc(restaurants.id));

        const differentlyLinkedRestaurant = existingRestaurants.find(
          (candidate: any) =>
            candidate.claimedFromImportId &&
            String(candidate.claimedFromImportId) !== String(listing.id),
        );
        if (differentlyLinkedRestaurant) {
          const error: any = new Error(
            "This food truck profile is already linked to a different import listing.",
          );
          error.statusCode = 409;
          error.code = "food_truck_identity_already_linked";
          throw error;
        }

        if (existingRestaurants.length > 1) {
          const error: any = new Error(
            "Multiple food truck profiles match this listing. Support must resolve the duplicate records before it can be claimed.",
          );
          error.statusCode = 409;
          error.code = "food_truck_identity_ambiguous";
          throw error;
        }

        const existingRestaurant = existingRestaurants[0] || null;
        const existingOwnerId = String(existingRestaurant?.ownerId || "");
        const reusableOwnerIds = new Set(
          [String(req.user.id), String(importSystemUser?.id || "")].filter(
            Boolean,
          ),
        );

        if (existingRestaurant && !reusableOwnerIds.has(existingOwnerId)) {
          const error: any = new Error(
            "This food truck profile already belongs to another owner.",
          );
          error.statusCode = 409;
          error.code = "food_truck_identity_owned";
          throw error;
        }

        if (existingRestaurant) {
          const transferSafety = await lockRestaurantForOwnerTransfer(tx, {
            restaurantId: existingRestaurant.id,
            nextOwnerId: req.user.id,
          });
          if (transferSafety.outcome === "missing") {
            const error: any = new Error(
              "The food truck profile changed before it could be claimed.",
            );
            error.statusCode = 409;
            error.code = "food_truck_identity_changed";
            throw error;
          }
          const lockedOwnerId = String(
            transferSafety.restaurant.ownerId || "",
          );
          if (!reusableOwnerIds.has(lockedOwnerId)) {
            const error: any = new Error(
              "This food truck profile already belongs to another owner.",
            );
            error.statusCode = 409;
            error.code = "food_truck_identity_owned";
            throw error;
          }
          if (transferSafety.outcome === "active_order") {
            const error: any = new Error(
              "This food truck has an unresolved customer order. Support must finish that order before ownership can change.",
            );
            error.statusCode = 409;
            error.code = "active_order_handoff_required";
            throw error;
          }
        }

        const restaurantValues = {
          ownerId: req.user.id,
          name: mergedRestaurant.name,
          address: mergedRestaurant.address,
          phone: mergedRestaurant.phone || null,
          businessType: "food_truck",
          cuisineType: mergedRestaurant.cuisineType || null,
          city: mergedRestaurant.city || null,
          state: mergedRestaurant.state || null,
          websiteUrl: mergedRestaurant.websiteUrl || null,
          instagramUrl: mergedRestaurant.instagramUrl || null,
          facebookPageUrl: mergedRestaurant.facebookPageUrl || null,
          latitude: mergedRestaurant.latitude || null,
          longitude: mergedRestaurant.longitude || null,
          description: mergedRestaurant.description || null,
          amenities: mergedRestaurant.amenities || null,
          isFoodTruck: true,
          isActive: false,
          isVerified: false,
          ...buildRestaurantOwnerTransferReset(),
          claimedFromImportId: listing.id,
          updatedAt: new Date(),
        };

        const [restaurant] = existingRestaurant
          ? await tx
              .update(restaurants)
              .set(restaurantValues)
              .where(eq(restaurants.id, existingRestaurant.id))
              .returning()
          : await tx
              .insert(restaurants)
              .values(restaurantValues)
              .returning();

        if (["customer", "restaurant_owner"].includes(req.user?.userType)) {
          await tx
            .update(users)
            .set({ userType: "food_truck", updatedAt: new Date() })
            .where(eq(users.id, req.user.id));
        }

        const [claimRequest] = await tx
          .insert(truckClaimRequests)
          .values({
            listingId: listing.id,
            restaurantId: restaurant.id,
            userId: req.user.id,
          })
          .returning();

        await tx
          .update(truckImportListings)
          .set({ status: "claim_requested", updatedAt: new Date() })
          .where(
            and(
              eq(truckImportListings.id, listing.id),
              eq(truckImportListings.status, "claim_processing"),
            ),
          );

        return {
          listing,
          restaurant,
          claimRequest,
          usedSeededRestaurant: Boolean(existingRestaurant),
        };
      });

      const { listing, restaurant, claimRequest, usedSeededRestaurant } =
        claimOutcome;

      try {
        const { rememberProfileSalesAssistant } = await import(
          "../services/profileSalesAssistantStore"
        );
        rememberProfileSalesAssistant("truck", restaurant.id, "claim");
      } catch (error) {
        console.warn("[profile-sales-assistant] claim ensure failed", error);
      }

      // Claim-time Google enrichment (fill missing map coordinates). Fire-and-forget:
      // paid Google usage now scales with real claims, and it never blocks the response.
      void enrichClaimedProfile(restaurant.id);

      const verification = await sendClaimVerification(
        req.user,
        req,
      ).catch((error) => {
        console.error(
          "[email] Failed to send verification after truck claim:",
          error,
        );
        return {
          sent: false,
          skippedReason: "provider_not_configured" as const,
        };
      });

      await sendClaimAdminNotice(
        "notifications@mealscout.us",
        "Food Truck Claim Submitted",
        `
          <p>A food truck claim was submitted.</p>
          <p><strong>Truck:</strong> ${restaurant.name}</p>
          <p><strong>Listing ID:</strong> ${listing.id}</p>
          <p><strong>User ID:</strong> ${req.user.id}</p>
          <p><strong>Email:</strong> ${req.user.email || "Unknown"}</p>
        `,
      ).catch((error) => {
        console.error("[email] Failed to send truck-claim admin notice:", error);
        return false;
      });

      res.json({
        restaurant,
        created: true,
        completionKind: "claim",
        claimRequestId: claimRequest?.id,
        usedSeededRestaurant,
        emailVerificationSent: verification.sent,
      });
    } catch (error: any) {
      console.error("Error creating truck claim:", error);
      res.status(Number(error?.statusCode) || 400).json({
        message: error.message || "Failed to claim truck listing",
        ...(error?.code ? { code: String(error.code) } : {}),
      });
    }
  });
}
