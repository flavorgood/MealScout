import type { Express } from "express";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db";
import { emailService } from "../emailService";
import { storage } from "../storage";
import { emitMealScoutEvent, buildMealScoutEventInput } from "../services/merlinEventEmitter";
import { isPasswordStrong, PASSWORD_REQUIREMENTS } from "../utils/passwordPolicy";
import { vacEvaluateRestaurantSignup } from "../vacLite";
import {
  BusinessPromotionError,
  promoteBusinessSetupToProfile,
} from "../services/businessOnboardingPromotion";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import {
  fetchWebsiteProfilePreview,
  WebsiteImportError,
} from "../utils/websiteProfileImport";
import {
  users,
  telemetryEvents,
  publicInsertRestaurantSchema,
  type User,
} from "@shared/schema";
import { isStaffOrAdminUserType } from "@shared/profileAccessPolicy";
import {
  buildRestaurantSignupPath,
  resolveBusinessAuthProvisioningUserType,
} from "@shared/businessSignupIntent";

type RestaurantSignupRouteDependencies = {
  ensureTrialForUser: (user: User) => Promise<User | null | undefined>;
  queueSocialPost: (payload: {
    platform: string;
    target?: string | null;
    message: string;
    link?: string | null;
    metadata?: Record<string, any>;
    scheduledAt?: Date | null;
  }) => Promise<any>;
};

const restaurantSignupUserSchema = z.object({
  email: z.string({ required_error: "Email is required" }).email("Valid email is required"),
  firstName: z
    .string({ required_error: "First name is required" })
    .min(1, "First name is required"),
  lastName: z
    .string({ required_error: "Last name is required" })
    .min(1, "Last name is required"),
  phone: z
    .string({ required_error: "Phone number is required" })
    .refine(
      (value) => value.replace(/\D/g, "").length >= 10,
      "Valid phone number is required",
    ),
  password: z
    .string({
      required_error: "Create a password to finish your free profile.",
    })
    .min(1, PASSWORD_REQUIREMENTS)
    .refine(isPasswordStrong, PASSWORD_REQUIREMENTS),
  phoneContactConsent: z.boolean().optional(),
});

const LEGAL_ACCEPTANCE_REQUIRED_MESSAGE = "You must accept the terms";

function getFriendlySignupValidationMessage(error: z.ZodError): string {
  const { fieldErrors, formErrors } = error.flatten();

  if (fieldErrors.password?.length) {
    return fieldErrors.password[0] || "Create a password to finish your free profile.";
  }

  if (fieldErrors.email?.length) {
    return fieldErrors.email[0] || "Please complete the required fields.";
  }

  if (fieldErrors.firstName?.length) {
    return fieldErrors.firstName[0] || "Please complete the required fields.";
  }

  if (fieldErrors.lastName?.length) {
    return fieldErrors.lastName[0] || "Please complete the required fields.";
  }

  if (fieldErrors.phone?.length) {
    return fieldErrors.phone[0] || "Please complete the required fields.";
  }

  return formErrors[0] || "Please complete the required fields.";
}

const importFromUrlLimiter = distributedRateLimit({
  scope: "restaurants:import-from-url",
  limit: 8,
  windowMs: 10 * 60 * 1000,
});

const restaurantSignupLimiter = distributedRateLimit({
  scope: "restaurants:signup",
  limit: 6,
  windowMs: 60 * 60 * 1000,
});

export function registerRestaurantSignupRoutes(
  app: Express,
  { ensureTrialForUser, queueSocialPost }: RestaurantSignupRouteDependencies,
) {
  app.post(
    "/api/restaurants/import-from-url",
    importFromUrlLimiter,
    async (req: any, res) => {
      const parseResult = z
        .object({ url: z.string().url("Enter a valid website link.") })
        .safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          message: parseResult.error.issues[0]?.message || "Enter a valid website link.",
        });
      }
      try {
        const preview = await fetchWebsiteProfilePreview(parseResult.data.url);
        res.json(preview);
      } catch (error: any) {
        if (error instanceof WebsiteImportError) {
          return res.status(422).json({ message: error.message });
        }
        console.error("Error importing website profile:", error);
        res.status(422).json({
          message: "Couldn't read that website. You can still fill in the details manually.",
        });
      }
    },
  );

  app.post(
    "/api/restaurants/signup",
    restaurantSignupLimiter,
    async (req: any, res) => {
    try {
      const { userData, restaurantData } = req.body;
      if (restaurantData?.acceptTerms !== true) {
        return res.status(400).json({
          message: LEGAL_ACCEPTANCE_REQUIRED_MESSAGE,
        });
      }
      let user: User;

      if (req.isAuthenticated && req.isAuthenticated() && req.user) {
        user = req.user as User;
        console.log("Using authenticated user for restaurant signup:", {
          userId: user.id,
          userType: user.userType,
        });

        if (
          !user.emailVerified &&
          !isStaffOrAdminUserType(user.userType)
        ) {
          return res.status(403).json({
            message: "Please verify your email before continuing.",
            code: "email_not_verified",
          });
        }

        if (user.userType === "customer") {
          console.log(
            "Deferring customer account role update until profile promotion succeeds:",
            user.id,
          );
        }
      } else {
        const userParseResult = restaurantSignupUserSchema.safeParse(
          userData || {},
        );
        if (!userParseResult.success) {
          return res.status(400).json({
            message: getFriendlySignupValidationMessage(
              userParseResult.error,
            ),
          });
        }
        const validatedUserData = userParseResult.data;

        const existingUser = await storage.getUserByEmail(
          validatedUserData.email,
        );
        if (existingUser) {
          return res
            .status(400)
            .json({ message: "User with this email already exists" });
        }

        const passwordHash = await bcrypt.hash(validatedUserData.password, 10);
        const normalizedPhone = validatedUserData.phone.replace(/\D/g, "");
        const { phoneContactConsent, ...emailUserData } = validatedUserData;
        const isFoodTruckRegistration =
          String(restaurantData?.businessType || "") === "food_truck";
        const provisioningUserType = resolveBusinessAuthProvisioningUserType({
          requestedUserType: isFoodTruckRegistration
            ? "food_truck"
            : "restaurant_owner",
        }) as User["userType"];
        user = await storage.upsertUserByAuth(
          "email",
          { ...emailUserData, phone: normalizedPhone, passwordHash },
          provisioningUserType,
        );

        // The consent checkbox on the signup form ("MealScout may call or
        // text me about onboarding") wasn't persisted anywhere before this;
        // record it so support/legal can look it up per user.
        try {
          await db.insert(telemetryEvents).values({
            eventName: "restaurant_signup_phone_contact_consent",
            userId: user.id,
            properties: { consent: phoneContactConsent !== false },
          });
        } catch (error) {
          console.warn("Failed to record phone contact consent telemetry:", error);
        }

        const token = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await storage.createEmailVerificationToken({
          userId: user.id,
          tokenHash,
          expiresAt,
          requestIp: req.ip || req.connection?.remoteAddress || undefined,
          userAgent: req.get("User-Agent") || undefined,
        });

        const apiBaseUrl = (
          process.env.PUBLIC_BASE_URL ||
          (req.get("host") ? `${req.protocol}://${req.get("host")}` : null) ||
          "http://localhost:5000"
        ).replace(/\/+$/, "");
        const verifyParams = new URLSearchParams({
          token,
          redirect: isFoodTruckRegistration
            ? buildRestaurantSignupPath({
                businessType: "food_truck",
                intent: "create",
                source: "email",
              })
            : "/restaurant-signup",
        });
        const verifyUrl = `${apiBaseUrl}/api/auth/verify-email?${verifyParams.toString()}`;
        await emailService.sendEmailVerificationEmail(user, verifyUrl);

        return res.status(201).json({
          message:
            "Account created. Please verify your email before completing signup.",
          requiresEmailVerification: true,
        });
      }

      const restaurantParseResult = publicInsertRestaurantSchema.safeParse(
        restaurantData || {},
      );
      if (!restaurantParseResult.success) {
        return res.status(400).json({
          message: "Please complete the required fields.",
        });
      }
      const validatedRestaurantData = restaurantParseResult.data;
      const promotionMetadataResult = z
        .object({
          onboardingAttemptId: z.string().uuid().optional().nullable(),
          targetRestaurantId: z.string().uuid().optional().nullable(),
          placeEvidence: z
            .object({
              placeId: z.string().trim().max(240).optional().nullable(),
              formattedAddress: z.string().trim().max(500).optional().nullable(),
              latitude: z.number().min(-90).max(90).optional().nullable(),
              longitude: z.number().min(-180).max(180).optional().nullable(),
            })
            .optional()
            .nullable(),
        })
        .superRefine((metadata, ctx) => {
          if (!metadata.targetRestaurantId && !metadata.onboardingAttemptId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["onboardingAttemptId"],
              message: "A stable onboarding attempt is required.",
            });
          }
          if (metadata.targetRestaurantId && metadata.onboardingAttemptId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["onboardingAttemptId"],
              message: "A resume target and a new onboarding attempt cannot be combined.",
            });
          }
        })
        .safeParse({
          onboardingAttemptId: restaurantData?.onboardingAttemptId || null,
          targetRestaurantId: restaurantData?.targetRestaurantId || null,
          placeEvidence: restaurantData?.placeEvidence || null,
        });
      if (!promotionMetadataResult.success) {
        return res.status(400).json({
          message: "Invalid business setup metadata.",
        });
      }
      const promoted = await promoteBusinessSetupToProfile(user.id, {
        onboardingAttemptId:
          promotionMetadataResult.data.onboardingAttemptId || null,
        targetRestaurantId:
          promotionMetadataResult.data.targetRestaurantId || null,
        businessName: validatedRestaurantData.name,
        businessType: validatedRestaurantData.businessType,
        address: validatedRestaurantData.address,
        city: validatedRestaurantData.city,
        state: validatedRestaurantData.state,
        phone: validatedRestaurantData.phone,
        cuisineType: validatedRestaurantData.cuisineType,
        description: validatedRestaurantData.description || null,
        websiteUrl: validatedRestaurantData.websiteUrl || null,
        instagramUrl: validatedRestaurantData.instagramUrl || null,
        facebookPageUrl: validatedRestaurantData.facebookPageUrl || null,
        logoUrl: validatedRestaurantData.logoUrl || null,
        coverImageUrl: validatedRestaurantData.coverImageUrl || null,
        menuItems:
          restaurantData?.menuItems ||
          restaurantData?.menu ||
          restaurantData?.menuDraft ||
          restaurantData?.truck?.menu ||
          [],
        placeEvidence: promotionMetadataResult.data.placeEvidence || null,
      });
      const restaurant = promoted.restaurant as any;

      if (String((restaurant as any)?.businessType || "") === "food_truck") {
        user = (await storage.getUserById(user.id)) || user;
      } else if (user.userType === "customer") {
        try {
          await storage.updateUserType(user.id, "restaurant_owner");
          user = (await storage.getUserById(user.id)) || user;
        } catch (error) {
          console.warn(
            "Unable to synchronize the account role after business onboarding",
            error,
          );
        }
      }

      if (
        promoted.created &&
        String((restaurant as any)?.businessType || "") === "food_truck"
      ) {
        try {
          const { maybeTriggerPensacolaFoodTruckDrip } =
            await import("../services/pensacolaFoodTruckDrip");
          await maybeTriggerPensacolaFoodTruckDrip({
            userId: user.id,
            restaurant,
          });
        } catch (error) {
          console.warn("[drip] Unable to trigger Pensacola food truck drip:", error);
        }
      }

      if (promoted.created) {
        try {
          const enabled =
            String(
              process.env.VAC_AUTO_VERIFY_ENABLED || "false",
            ).toLowerCase() !== "false";
          if (enabled) {
            const vac = await vacEvaluateRestaurantSignup({
              user,
              restaurant,
              req,
            });
            console.log("🔍 VAC-lite evaluation:", {
              restaurantId: restaurant.id,
              restaurantName: (restaurant as any).name,
              score: vac.score,
              threshold: vac.threshold,
              shouldAutoVerify: vac.shouldAutoVerify,
              signals: vac.signals,
            });

            if (vac.shouldAutoVerify) {
              console.log("✅ Auto-verifying restaurant:", restaurant.id);
              await storage.setRestaurantVerified(restaurant.id, true);
              (restaurant as any).isVerified = true;
              try {
                user = (await ensureTrialForUser(user)) || user;
              } catch (error) {
                console.warn("ensureTrialForUser failed after auto-verify:", error);
              }
            } else {
              console.log(
                "⚠️  Creating manual verification request for:",
                restaurant.id,
              );
              const hasPending = await storage.hasPendingVerificationRequest(
                restaurant.id,
              );
              if (!hasPending) {
                await storage.createVerificationRequest({
                  restaurantId: restaurant.id,
                  documents: [],
                });
              } else {
                console.log("ℹ️  Pending verification request already exists");
              }
            }
          }
        } catch (error) {
          console.warn("VAC-lite failed", error);
        }
      }

      if (
        promoted.created &&
        (restaurant as any).businessType === "food_truck"
      ) {
        try {
          const baseUrl = (
            process.env.PUBLIC_BASE_URL || "https://www.mealscout.us"
          ).replace(/\/+$/, "");
          await queueSocialPost({
            platform: "facebook",
            target: "mealscout_page",
            message: `Welcome ${restaurant.name} to MealScout! Catch them on the map and follow their schedule.`,
            link: `${baseUrl}/restaurant/${restaurant.id}`,
          });
        } catch (error) {
          console.error("Failed to queue social post:", error);
        }
      }

      if (promoted.created) {
        const referralId =
          req.body?.referralId ||
          req.query?.referralId ||
          req.cookies?.referralRecordId ||
          req.cookies?.referralId;

        if (referralId) {
          try {
            const { attachReferralToSignup } = await import("../referralService");
            await attachReferralToSignup(referralId, restaurant.id);
            console.log("[Phase 2] Referral attached:", {
              referralId,
              restaurantId: restaurant.id,
            });
          } catch (error) {
            console.error("[Phase 2] Error attaching referral:", error);
          }
        }

        if (referralId && user?.id) {
          try {
            const { resolveAffiliateUserId } =
              await import("../affiliateTagService");
            const affiliateUserId = await resolveAffiliateUserId(referralId);
            if (affiliateUserId && affiliateUserId !== user.id) {
              const [existingUser] = await db
                .select({ affiliateCloserUserId: users.affiliateCloserUserId })
                .from(users)
                .where(eq(users.id, user.id))
                .limit(1);

              if (!existingUser?.affiliateCloserUserId) {
                const [affiliate] = await db
                  .select({ affiliatePercent: users.affiliatePercent })
                  .from(users)
                  .where(eq(users.id, affiliateUserId))
                  .limit(1);
                const percentSnapshot = Math.max(
                  Number(affiliate?.affiliatePercent ?? 5),
                  0,
                );

                await db
                  .update(users)
                  .set({
                    affiliateCloserUserId: affiliateUserId,
                    affiliateCloserPercent: percentSnapshot,
                    updatedAt: new Date(),
                  })
                  .where(eq(users.id, user.id));
              }
            }
          } catch (error) {
            console.error("[Phase 2] Error attaching user referral:", error);
          }
        }

        // Affiliate first-click attribution (affiliateClicks): convert the
        // first click recorded under this visitor's stable identity. The
        // click route persists that identity in a cookie, so it survives
        // the gap between click and signup; a bare session id does not,
        // because sessions are not persisted for anonymous visitors.
        if (user?.id) {
          try {
            const {
              attributeSignupToAffiliate,
              resolveAffiliateVisitorIdentity,
            } = await import("../affiliateService");
            const visitorIdentity = resolveAffiliateVisitorIdentity(
              req as any,
            );
            if (visitorIdentity) {
              await attributeSignupToAffiliate(visitorIdentity, user.id);
            }
          } catch (error) {
            console.error(
              "[Phase 2] Error attributing affiliate first click:",
              error,
            );
          }
        }

        try {
          const event = buildMealScoutEventInput({
            entity_id: restaurant.id,
            event_type: "restaurant_onboarded",
            user,
            restaurant,
            payload: {
              business_name: (restaurant as any).name,
              city: (restaurant as any).city,
              county: (restaurant as any).county,
              location:
                `${(restaurant as any).city || ""} ${(restaurant as any).state || ""}`.trim() || undefined
            }
          });
          await emitMealScoutEvent(event).catch(() => {});
        } catch (error) {
          console.warn("[Merlin emitter] restaurant signup emit failed:", error);
        }
      }

      res.json({
        user,
        restaurant,
        created: promoted.created,
        completionKind: "create",
        menuInsertedCount: promoted.menuInsertedCount,
        message: "Restaurant owner account created successfully",
      });
    } catch (error: any) {
      console.error("Error in restaurant signup:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: getFriendlySignupValidationMessage(error),
        });
      }
      if (error instanceof BusinessPromotionError) {
        return res.status(error.statusCode).json({
          ...(error.code ? { code: error.code } : {}),
          message: error.message,
        });
      }
      // An unexpected failure here (DB error, a downstream service throwing,
      // etc.) is not the same as "you filled out the form wrong" — reporting
      // it as a 400 validation message left owners with no way to tell a
      // typo apart from a real outage. Be honest that it's our side.
      res.status(500).json({
        message:
          "Something went wrong creating your account. Please try again in a moment, and contact support if it keeps happening.",
      });
    }
    },
  );
}
