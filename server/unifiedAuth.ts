import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import session from "express-session";
import connectPg from "connect-pg-simple";
import type { Express } from "express";
import { storage } from "./storage";
import { hasBusinessPermissionForRestaurant } from "./services/businessTeamAccess";
import { getBusinessAccessContext } from "./services/businessTeamAccess";
import { resolveUserContinuation } from "./services/loginContinuation";
import { emailService } from "./emailService";
import { sendSms } from "./smsService";
import type {
  GoogleUserData,
  EmailUserData,
  FacebookUserData,
  TradeScoutUserData,
  User,
} from "@shared/schema";
import crypto from "crypto";
import { sanitizeUser } from "./utils/sanitize";
import {
  isPasswordStrong,
  PASSWORD_REQUIREMENTS,
} from "./utils/passwordPolicy";
import { db } from "./db";
import { emailSequenceSends, users } from "@shared/schema";
import { and, eq, or, sql } from "drizzle-orm";
import {
  ensureAffiliateTag,
  resolveAffiliateUserId,
} from "./affiliateTagService";
import {
  isAdminUserType,
  isDuperAdminUserType,
  isRootAdminUserType,
  shouldAssignAffiliateTagForUserType,
} from "./roleAccess";
import { authLog } from "./utils/authLog";
import { normalizeSafeInternalPath } from "@shared/safeInternalPath";
import { resolveBusinessAuthProvisioningUserType } from "@shared/businessSignupIntent";
import {
  ACCOUNT_SETUP_ALREADY_COMPLETED_CODE,
  completeAccountSetupTransaction,
} from "./services/accountSetupCompletion";
import { distributedRateLimit } from "./middleware/distributedRateLimit";

type UnifiedAuthDependencies = {
  hashAccountSetupPassword?: (password: string) => Promise<string>;
};

const completeAccountSetupLimiter = distributedRateLimit({
  scope: "auth:complete-account-setup",
  limit: 5,
  windowMs: 15 * 60 * 1000,
  // Setup links are unauthenticated and must be limited by caller IP, never by
  // a user-controlled token or a session that happens to be present.
  key: (req) => String(req.ip || "unknown"),
});

// Extend session to include app context for multi-app OAuth
declare module "express-session" {
  interface SessionData {
    fbAppContext?: "mealscout" | "tradescout";
    googleAppContext?: "mealscout" | "tradescout";
    oauthUserType?: User["userType"];
    oauthRedirectPath?: string;
    pendingPhoneSignupMethod?: string;
    pendingPhoneRedirectPath?: string;
    adminMarketSelection?: {
      marketKey?: string | null;
      city?: string | null;
      state?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      updatedAt?: string | null;
    };
    deviceLocationContext?: {
      marketKey?: string | null;
      city?: string | null;
      state?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      updatedAt?: string | null;
    };
    savedLocationContext?: {
      marketKey?: string | null;
      city?: string | null;
      state?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      updatedAt?: string | null;
    };
  }
}

// Session configuration (moved from facebookAuth.ts)
export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const isProduction = process.env.NODE_ENV === "production";
  const cookieDomain = String(process.env.SESSION_COOKIE_DOMAIN || "").trim();
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    name: "tradescout.sid",
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    // Trust reverse proxy for secure cookies (Render/Vercel)
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      domain: cookieDomain || undefined,
      maxAge: sessionTtl,
    },
  });
}

function getSessionCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
    path: "/",
  };
}

function establishAuthenticatedSession(req: any, user: User) {
  return new Promise<void>((resolve, reject) => {
    const finalizeLogin = () => {
      req.login(user, (loginErr: unknown) => {
        if (loginErr) {
          reject(loginErr);
          return;
        }
        req.session.save((saveErr: unknown) => {
          if (saveErr) {
            reject(saveErr);
            return;
          }
          resolve();
        });
      });
    };

    if (!req.session || typeof req.session.regenerate !== "function") {
      finalizeLogin();
      return;
    }

    req.session.regenerate((regenerateErr: unknown) => {
      if (regenerateErr) {
        reject(regenerateErr);
        return;
      }
      finalizeLogin();
    });
  });
}

export async function setupUnifiedAuth(
  app: Express,
  dependencies: UnifiedAuthDependencies = {},
) {
  const hashAccountSetupPassword =
    dependencies.hashAccountSetupPassword ||
    ((password: string) => bcrypt.hash(password, 12));
  const normalizeBaseUrl = (raw: string): string | null => {
    const trimmed = raw.trim().replace(/^["']|["']$/g, "");
    if (!trimmed) return null;
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    try {
      const parsed = new URL(withProtocol);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      const port = parsed.port ? `:${parsed.port}` : "";
      return `${parsed.protocol}//${parsed.hostname}${port}`;
    } catch {
      return null;
    }
  };

  const resolveConfiguredBaseUrl = (
    rawValue: string | undefined,
  ): string | null => {
    if (!rawValue) return null;
    const candidates = rawValue
      .split(/[,\n;]/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      const normalized = normalizeBaseUrl(candidate);
      if (normalized) {
        if (candidates.length > 1) {
          console.warn(
            `[oauth] PUBLIC_BASE_URL includes multiple values; using ${normalized}`,
          );
        }
        return normalized;
      }
    }
    return null;
  };

  // Get canonical base URL for OAuth callbacks - must be set for multi-user access
  const getBaseUrl = () => {
    const configured = resolveConfiguredBaseUrl(process.env.PUBLIC_BASE_URL);
    if (configured) {
      return configured;
    }
    if (process.env.PUBLIC_BASE_URL) {
      console.warn(
        "[oauth] PUBLIC_BASE_URL is set but invalid; expected a single absolute URL.",
      );
    }
    // Fallback for local development
    if (process.env.NODE_ENV === "development") {
      return "http://localhost:5000";
    }
    throw new Error(
      "PUBLIC_BASE_URL must be set for OAuth to work with multiple users",
    );
  };
  const baseUrl = getBaseUrl().replace(/\/+$/, ""); // Remove trailing slashes to prevent double slashes in callback URLs
  const tradeScoutBaseUrl =
    resolveConfiguredBaseUrl(process.env.TRADESCOUT_PUBLIC_BASE_URL) ||
    "https://www.thetradescout.com";
  const getOAuthAppContext = (
    req: any,
    fallback: "mealscout" | "tradescout" = "mealscout",
  ) => {
    const appContext = String(req?.query?.app || fallback).toLowerCase();
    return appContext === "tradescout" ? "tradescout" : "mealscout";
  };

  const isAccountSetupPathWithoutToken = (path: string): boolean => {
    try {
      const parsed = new URL(path, "https://www.mealscout.us");
      return (
        parsed.pathname === "/account-setup" &&
        !parsed.searchParams.get("token")
      );
    } catch {
      return path === "/account-setup";
    }
  };

  const getSafeRedirectPath = (value: unknown): string | null => {
    const path = normalizeSafeInternalPath(value);
    if (!path) return null;
    if (isAccountSetupPathWithoutToken(path)) return null;
    return path;
  };

  const normalizePhone = (phone: string) => phone.replace(/\D/g, "");
  const hasRequiredPhone = (user: Pick<User, "phone"> | null | undefined) =>
    normalizePhone(String(user?.phone || "")).length >= 10;
  const buildPhoneRequiredSetupPath = (redirectPath: string | null) => {
    const params = new URLSearchParams({ phoneRequired: "1" });
    const safeRedirect = getSafeRedirectPath(redirectPath);
    if (safeRedirect) {
      params.set("redirect", safeRedirect);
    }
    return `/account-setup?${params.toString()}`;
  };

  const getOAuthRedirectPath = (req: any): string | null =>
    getSafeRedirectPath(req.session?.oauthRedirectPath);

  const buildOAuthSuccessRedirect = (
    redirectBase: string,
    redirectPath: string | null,
  ): string => {
    const safePath = getSafeRedirectPath(redirectPath) || "/";
    const separator = safePath.includes("?") ? "&" : "?";
    return `${redirectBase}${safePath}${separator}auth=success&t=${Date.now()}`;
  };

  const buildOAuthErrorRedirect = (
    redirectPath: unknown,
    errorCode: string,
    fallbackPath: string,
  ): string => {
    const safePath = getSafeRedirectPath(redirectPath) || fallbackPath;
    const parsed = new URL(safePath, "https://www.mealscout.us");
    parsed.searchParams.set("error", errorCode);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  };

  const consumeOAuthErrorRedirect = (
    req: any,
    errorCode: string,
    fallbackPath: string,
  ): string => {
    const redirect = buildOAuthErrorRedirect(
      req.session?.oauthRedirectPath,
      errorCode,
      fallbackPath,
    );
    req.session.oauthRedirectPath = undefined;
    return redirect;
  };

  const getDefaultPostVerificationRedirect = (
    user: Pick<User, "userType">,
  ): string => {
    switch (user.userType) {
      case "host":
        return "/host-signup";
      case "event_coordinator":
        return "/event-coordinator/dashboard?setup=onboarding";
      case "restaurant_owner":
        return "/restaurant-signup?businessType=restaurant&source=post-verification";
      case "food_truck":
        return "/restaurant-signup?businessType=food_truck&intent=create&source=post-verification";
      case "caterer":
        return "/restaurant-signup?businessType=caterer&source=post-verification";
      case "private_chef":
        return "/restaurant-signup?businessType=private_chef&source=post-verification";
      case "supplier":
        return "/supplier/dashboard";
      case "staff":
        return "/staff";
      case "duper_admin":
      case "admin":
      case "super_admin":
        return "/admin";
      case "customer":
      default:
        return "/scout";
    }
  };

  const createEmailVerificationUrl = async (
    user: User,
    req: any,
    intendedNextPath?: string | null,
  ) => {
    if (!user.email) return null;
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await storage.createEmailVerificationToken({
      userId: user.id,
      tokenHash,
      expiresAt,
      requestIp: req.ip || req.connection.remoteAddress || undefined,
      userAgent: req.get("User-Agent") || undefined,
    });

    const reqHost = req.get("host");
    const inferredBaseUrl = reqHost ? `${req.protocol}://${reqHost}` : null;
    const apiBaseUrl = (
      resolveConfiguredBaseUrl(process.env.PUBLIC_BASE_URL) ||
      resolveConfiguredBaseUrl(inferredBaseUrl || undefined) ||
      "http://localhost:5000"
    ).replace(/\/+$/, "");
    const params = new URLSearchParams({ token });
    const safeRedirect = getSafeRedirectPath(intendedNextPath);
    if (safeRedirect) {
      params.set("redirect", safeRedirect);
    }
    const verifyUrl = `${apiBaseUrl}/api/auth/verify-email?${params.toString()}`;
    return verifyUrl;
  };

  const sendWelcomeOrVerification = async (
    user: User,
    req: any,
    welcomeLabel: string,
    intendedNextPath?: string | null,
  ): Promise<boolean> => {
    try {
      const verifyUrl =
        user.email && !user.emailVerified
          ? await createEmailVerificationUrl(user, req, intendedNextPath)
          : null;
      const supportsWelcome =
        user.userType === "customer" ||
        user.userType === "restaurant_owner" ||
        user.userType === "food_truck" ||
        user.userType === "duper_admin" ||
        user.userType === "super_admin" ||
        user.userType === "admin";

      if (supportsWelcome) {
        const ok = await emailService.sendWelcomeEmail(
          user,
          verifyUrl ?? undefined,
        );
        if (!ok) {
          console.error(`Failed to send ${welcomeLabel} welcome email`, {
            userId: user.id,
            email: user.email,
            userType: user.userType,
          });
        }
        return ok;
      }

      if (verifyUrl) {
        const ok = await emailService.sendEmailVerificationEmail(
          user,
          verifyUrl,
        );
        if (!ok) {
          console.error("Failed to send email verification", {
            userId: user.id,
            email: user.email,
            userType: user.userType,
          });
        }
        return ok;
      }

      console.warn("[auth] No account email sent for signup", {
        userId: user.id,
        email: user.email,
        userType: user.userType,
        hasVerifyUrl: Boolean(verifyUrl),
        supportsWelcome,
      });
      return false;
    } catch (error) {
      console.error(`Failed to prepare ${welcomeLabel} welcome email:`, error);
      return false;
    }
  };

  const isBusinessCapableForContinuation = (userType: unknown) => {
    const normalized = String(userType || "").toLowerCase();
    return (
      normalized === "food_truck" ||
      normalized === "restaurant_owner" ||
      normalized === "bar_owner" ||
      normalized === "caterer" ||
      normalized === "private_chef"
    );
  };

  const resolveOAuthContinuationPath = async (user: User): Promise<string> => {
    if (!isBusinessCapableForContinuation(user.userType)) {
      return getDefaultPostVerificationRedirect(user);
    }

    let businessAccessSummary: {
      linkState?: "linked" | "not_attached";
      guidance?: string | null;
      restaurantCount?: number;
      primaryRestaurantId?: string | null;
    } | null = null;

    try {
      const businessAccess = await getBusinessAccessContext(user.id);
      businessAccessSummary = {
        linkState:
          businessAccess.linkState === "not_attached" ? "not_attached" : "linked",
        guidance: businessAccess.guidance,
        restaurantCount: Array.isArray(businessAccess.restaurants)
          ? businessAccess.restaurants.length
          : 0,
        primaryRestaurantId: businessAccess.primaryRestaurant?.id || null,
      };
    } catch (error) {
      console.warn("Unable to resolve OAuth business access context:", error);
    }

    const continuation = await resolveUserContinuation({
      user,
      businessAccessSummary,
    });

    const continuationPath = getSafeRedirectPath(continuation.continuationPath);
    return continuationPath || getDefaultPostVerificationRedirect(user);
  };

  const normalizeEmailForLookup = (value: unknown): string | null => {
    const email = String(value || "")
      .trim()
      .toLowerCase();
    return email.includes("@") ? email : null;
  };

  const findExistingOAuthUser = async (
    provider: "google" | "facebook",
    providerId: string | null | undefined,
    email: string | null | undefined,
  ): Promise<User | null> => {
    const normalizedEmail = normalizeEmailForLookup(email);
    const clauses = [];
    if (provider === "google" && providerId) {
      clauses.push(eq(users.googleId, providerId));
    }
    if (provider === "facebook" && providerId) {
      clauses.push(eq(users.facebookId, providerId));
    }
    if (normalizedEmail) {
      clauses.push(sql`lower(${users.email}) = ${normalizedEmail}`);
    }
    if (clauses.length === 0) return null;

    const [existing] = await db
      .select()
      .from(users)
      .where(clauses.length === 1 ? clauses[0] : or(...clauses))
      .limit(1);
    return existing || null;
  };

  const reserveAccountCreationEmail = async (
    user: User,
    metadata: Record<string, unknown>,
  ): Promise<boolean> => {
    const inserted = await db
      .insert(emailSequenceSends)
      .values({
        userId: user.id,
        sequence: "account_creation",
        step: 1,
        metadata,
      } as any)
      .onConflictDoNothing()
      .returning({ id: emailSequenceSends.id });
    return inserted.length > 0;
  };

  const hasAccountCreationEmailReservation = async (
    user: User,
  ): Promise<boolean> => {
    const existing = await db
      .select({ id: emailSequenceSends.id })
      .from(emailSequenceSends)
      .where(
        and(
          eq(emailSequenceSends.userId, user.id),
          eq(emailSequenceSends.sequence, "account_creation"),
          eq(emailSequenceSends.step, 1),
        ),
      )
      .limit(1);
    return existing.length > 0;
  };

  const sendAccountCreationEmails = async (
    user: User,
    req: any,
    params: {
      welcomeLabel: string;
      signupMethod: string;
      intendedNextPath?: string | null;
      notifyAdmin?: boolean;
      skipAgeGate?: boolean;
    },
  ) => {
    try {
      const createdAtMs = user.createdAt
        ? new Date(user.createdAt).getTime()
        : NaN;
      const accountAgeMs = Number.isFinite(createdAtMs)
        ? Date.now() - createdAtMs
        : Number.POSITIVE_INFINITY;
      if (!params.skipAgeGate && accountAgeMs > 10 * 60 * 1000) {
        console.log("[auth] Existing account login; skipping creation emails", {
          userId: user.id,
          signupMethod: params.signupMethod,
          createdAt: user.createdAt,
        });
        return;
      }

      if (await hasAccountCreationEmailReservation(user)) {
        console.log("[auth] Account creation email already sent; skipping", {
          userId: user.id,
          signupMethod: params.signupMethod,
        });
        return;
      }

      const userEmailSent = await sendWelcomeOrVerification(
        user,
        req,
        params.welcomeLabel,
        params.intendedNextPath,
      );
      if (!userEmailSent) {
        console.error("[auth] Account creation email failed; not marking sent", {
          userId: user.id,
          email: user.email,
          signupMethod: params.signupMethod,
        });
      } else {
        await reserveAccountCreationEmail(user, {
          signupMethod: params.signupMethod,
          welcomeLabel: params.welcomeLabel,
          source: "unified_auth",
        });
      }
      if (params.notifyAdmin === false) {
        return;
      }
      emailService
        .sendAdminSignupNotification(user, {
          signupMethod: params.signupMethod,
        })
        .catch((err) =>
          console.error("Failed to send admin signup notification:", err),
        );
    } catch (error) {
      console.error("[auth] Failed to queue account creation emails:", error);
    }
  };

  const oauthUserTypeAllowList = new Set<User["userType"]>([
    "customer",
    "restaurant_owner",
    "food_truck",
    "host",
    "event_coordinator",
  ]);

  const getOauthUserType = (
    req: any,
    fallback: User["userType"],
  ): User["userType"] => {
    const desired = req?.session?.oauthUserType;
    if (desired && oauthUserTypeAllowList.has(desired)) {
      return desired;
    }
    return fallback;
  };

  // Ensure configured super admin email is upgraded
  const superAdminEmail = process.env.ADMIN_EMAIL || "info.mealscout@gmail.com";
  if (superAdminEmail) {
    try {
      const existing = await storage.getUserByEmail(superAdminEmail);
      if (existing && existing.userType !== "super_admin") {
        await storage.updateUserType(existing.id, "super_admin");
      }
    } catch (err) {
      console.warn("⚠️  Failed startup super admin auto-upgrade:", err);
    }
  }

  // Set up passport serialization for email/password auth
  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      // Handle cases where id might not be a string (old session format)
      if (!id || typeof id !== "string") {
        return done(null, false);
      }
      let user = await storage.getUser(id);
      if (!user) {
        return done(null, false);
      }

      // Auto-upgrade the configured super admin email to super_admin role
      const SUPER_ADMIN_EMAIL =
        process.env.ADMIN_EMAIL || "info.mealscout@gmail.com";
      if (
        user &&
        user.email === SUPER_ADMIN_EMAIL &&
        user.userType !== "super_admin"
      ) {
        try {
          user = await storage.updateUserType(user.id, "super_admin");
        } catch (err) {
          console.warn("⚠️  Failed to auto-upgrade super admin role:", err);
        }
      }

      if (user && !user.emailVerified && isAdminUserType(user.userType)) {
        try {
          user = await storage.updateUser(user.id, { emailVerified: true });
        } catch (err) {
          console.warn("⚠️  Failed to auto-verify admin account email:", err);
        }
      }

      done(null, user);
    } catch (error) {
      // For user not found or other errors, return false to clear the session
      done(null, false);
    }
  });

  // Google Strategy and routes for all users (only enabled if credentials are configured)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    console.log("Setting up Google OAuth strategies...");
    console.log(
      "🔵 Google OAuth customer callback URL:",
      `${baseUrl}/api/auth/google/customer/callback`,
    );
    console.log(
      "🔵 Google OAuth restaurant callback URL:",
      `${baseUrl}/api/auth/google/restaurant/callback`,
    );

    passport.use(
      "google-customer",
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${baseUrl}/api/auth/google/customer/callback`,
          passReqToCallback: true,
        },
        async (
          req: any,
          accessToken: string,
          refreshToken: string,
          profile: any,
          done: any,
        ) => {
          try {
            console.log("[oauth] Google customer profile received", {
              hasProviderId: Boolean(profile?.id),
              hasEmail:
                Boolean(profile?.emails?.[0]?.value) ||
                Boolean(profile?._json?.email),
              hasName:
                Boolean(profile?.name?.givenName) ||
                Boolean(profile?.displayName),
              hasPhoto:
                Boolean(profile?.photos?.[0]?.value) ||
                Boolean(profile?._json?.picture),
            });

            const userData: GoogleUserData = {
              googleId: profile.id,
              email: profile.emails?.[0]?.value || profile._json?.email || null,
              firstName:
                profile.name?.givenName ||
                profile._json?.given_name ||
                profile.displayName?.split(" ")[0] ||
                "Google",
              lastName:
                profile.name?.familyName ||
                profile._json?.family_name ||
                profile.displayName?.split(" ").slice(1).join(" ") ||
                "User",
              profileImageUrl:
                profile.photos?.[0]?.value || profile._json?.picture || null,
              googleAccessToken: accessToken,
            };

            console.log("[oauth] Processed Google customer user data", {
              hasEmail: Boolean(userData.email),
              hasProfileImage: Boolean(userData.profileImageUrl),
            });

            const existingOAuthUser = await findExistingOAuthUser(
              "google",
              userData.googleId,
              userData.email,
            );
            const user = await storage.upsertUserByAuth(
              "google",
              userData,
              "customer",
            );
            kickAffiliateTag(user);
            await applyAffiliateReferral(req, user);
            req.session.oauthUserType = undefined;
            console.log(
              "✅ Google customer user created/updated successfully:",
              { userId: user.id, hasEmail: Boolean(user.email) },
            );

            // LISA Phase 4A: Emit claim for OAuth login
            storage
              .emitClaim({
                subjectType: "user",
                subjectId: user.id,
                app: "mealscout",
                claimType: "oauth_provider_used",
                claimValue: { provider: "google", email: userData.email },
                source: "oauth",
              })
              .catch((err) => console.error("Failed to emit LISA claim:", err));

            if (!existingOAuthUser && hasRequiredPhone(user)) {
              void sendAccountCreationEmails(user, req, {
                welcomeLabel: "customer",
                signupMethod: "google",
                notifyAdmin: false,
              });
            } else if (!existingOAuthUser) {
              req.session.pendingPhoneSignupMethod = "google";
            }
            return done(null, user);
          } catch (error) {
            console.error("❌ Google customer authentication error:", error);
            console.error("[oauth] Google customer profile metadata:", {
              hasProviderId: Boolean(profile?.id),
              hasEmail:
                Boolean(profile?.emails?.[0]?.value) ||
                Boolean(profile?._json?.email),
            });
            return done(error, null);
          }
        },
      ),
    );

    passport.use(
      "google-restaurant",
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${baseUrl}/api/auth/google/restaurant/callback`,
          passReqToCallback: true,
        },
        async (
          req: any,
          accessToken: string,
          refreshToken: string,
          profile: any,
          done: any,
        ) => {
          try {
            console.log("[oauth] Google restaurant profile received", {
              hasProviderId: Boolean(profile?.id),
              hasEmail:
                Boolean(profile?.emails?.[0]?.value) ||
                Boolean(profile?._json?.email),
              hasName:
                Boolean(profile?.name?.givenName) ||
                Boolean(profile?.displayName),
              hasPhoto:
                Boolean(profile?.photos?.[0]?.value) ||
                Boolean(profile?._json?.picture),
            });

            const userData: GoogleUserData = {
              googleId: profile.id,
              email: profile.emails?.[0]?.value || profile._json?.email || null,
              firstName:
                profile.name?.givenName ||
                profile._json?.given_name ||
                profile.displayName?.split(" ")[0] ||
                "Google",
              lastName:
                profile.name?.familyName ||
                profile._json?.family_name ||
                profile.displayName?.split(" ").slice(1).join(" ") ||
                "User",
              profileImageUrl:
                profile.photos?.[0]?.value || profile._json?.picture || null,
              googleAccessToken: accessToken,
            };

            console.log("[oauth] Processed Google restaurant user data", {
              hasEmail: Boolean(userData.email),
              hasProfileImage: Boolean(userData.profileImageUrl),
            });

            const userType = getOauthUserType(req, "restaurant_owner");
            const existingOAuthUser = await findExistingOAuthUser(
              "google",
              userData.googleId,
              userData.email,
            );
            const provisioningUserType = resolveBusinessAuthProvisioningUserType({
              requestedUserType: userType,
              existingUserType: existingOAuthUser?.userType,
            }) as User["userType"];
            const user = await storage.upsertUserByAuth(
              "google",
              userData,
              provisioningUserType,
            );
            kickAffiliateTag(user);
            await applyAffiliateReferral(req, user);
            req.session.oauthUserType = undefined;
            console.log(
              "✅ Google restaurant user created/updated successfully:",
              { userId: user.id, hasEmail: Boolean(user.email) },
            );

            // LISA Phase 4A: Emit claim for OAuth login
            storage
              .emitClaim({
                subjectType: "user",
                subjectId: user.id,
                app: "mealscout",
                claimType: "oauth_provider_used",
                claimValue: {
                  provider: "google",
                  email: userData.email,
                  userType: user.userType,
                },
                source: "oauth",
              })
              .catch((err) => console.error("Failed to emit LISA claim:", err));

            if (!existingOAuthUser && hasRequiredPhone(user)) {
              void sendAccountCreationEmails(user, req, {
                welcomeLabel:
                  userType === "food_truck"
                    ? "food truck owner"
                    : "restaurant owner",
                signupMethod: "google",
                notifyAdmin: false,
              });
            } else if (!existingOAuthUser) {
              req.session.pendingPhoneSignupMethod = "google";
            }
            return done(null, user);
          } catch (error) {
            console.error("❌ Google restaurant authentication error:", error);
            console.error("[oauth] Google restaurant profile metadata:", {
              hasProviderId: Boolean(profile?.id),
              hasEmail:
                Boolean(profile?.emails?.[0]?.value) ||
                Boolean(profile?._json?.email),
            });
            return done(error, null);
          }
        },
      ),
    );

    // Google OAuth routes for customers
    app.get("/api/auth/google/customer", (req, res, next) => {
      req.session.googleAppContext = getOAuthAppContext(req);
      req.session.oauthUserType = "customer";
      req.session.oauthRedirectPath = getSafeRedirectPath(req.query.redirect) || undefined;
      passport.authenticate("google-customer", {
        scope: ["profile", "email"],
      })(req, res, next);
    });

    app.get("/api/auth/google/customer/callback", (req, res, next) => {
      authLog("google_customer_oauth_callback", {
        hasError: !!req.query.error,
        error: req.query.error || null,
      });

      passport.authenticate("google-customer", (err: any, user: User | false) => {
        if (err) {
          const message = String(err?.message || "").toLowerCase();
          const code = String(err?.code || "").toLowerCase();
          const isInvalidGrant =
            code === "invalid_grant" ||
            message.includes("invalid_grant") ||
            message.includes("malformed auth code");
          if (isInvalidGrant) {
            console.warn("[oauth] Google customer callback invalid grant", {
              code: err?.code,
              message: err?.message,
            });
            return res.redirect(
              consumeOAuthErrorRedirect(req, "auth_invalid_grant", "/"),
            );
          }
          console.error("❌ Google customer callback error:", err);
          return res.redirect(
            consumeOAuthErrorRedirect(req, "auth_failed", "/"),
          );
        }
        if (!user) {
          return res.redirect(
            consumeOAuthErrorRedirect(req, "auth_failed", "/"),
          );
        }
        req.logIn(user, async (loginErr: unknown) => {
          if (loginErr) {
            console.error("❌ Google customer login error:", loginErr);
            return res.redirect(
              consumeOAuthErrorRedirect(req, "session_error", "/"),
            );
          }
          const appContext = req.session.googleAppContext || "mealscout";
          const redirectBase =
            appContext === "tradescout" ? tradeScoutBaseUrl : baseUrl;
          const redirectPath =
            getOAuthRedirectPath(req) || (await resolveOAuthContinuationPath(user));
          if (appContext === "mealscout" && !hasRequiredPhone(user)) {
            req.session.pendingPhoneSignupMethod =
              req.session.pendingPhoneSignupMethod || "google";
            req.session.pendingPhoneRedirectPath = redirectPath;
            req.session.oauthRedirectPath = undefined;
            return req.session.save((saveErr: unknown) => {
              if (saveErr) {
                console.error("❌ Session save error:", saveErr);
                return res.redirect(
                  buildOAuthErrorRedirect(redirectPath, "session_error", "/"),
                );
              }
              return res.redirect(buildPhoneRequiredSetupPath(redirectPath));
            });
          }
          req.session.oauthRedirectPath = undefined;
          req.session.save((saveErr: unknown) => {
            if (saveErr) {
              console.error("❌ Session save error:", saveErr);
              return res.redirect(
                buildOAuthErrorRedirect(redirectPath, "session_error", "/"),
              );
            }
            console.log(
              "✅ Google customer OAuth success, session saved, redirecting...",
            );
            return res.redirect(
              buildOAuthSuccessRedirect(redirectBase, redirectPath),
            );
          });
        });
      })(req, res, next);
    });

    // Google OAuth routes for restaurant owners
    app.get("/api/auth/google/restaurant", (req, res, next) => {
      req.session.googleAppContext = getOAuthAppContext(req);
      const desiredType =
        typeof req.query.userType === "string"
          ? req.query.userType
          : "restaurant_owner";
      req.session.oauthUserType = oauthUserTypeAllowList.has(
        desiredType as User["userType"],
      )
        ? (desiredType as User["userType"])
        : "restaurant_owner";
      req.session.oauthRedirectPath =
        getSafeRedirectPath(req.query.redirect) ||
        (req.session.oauthUserType === "food_truck"
          ? "/restaurant-signup?businessType=food_truck&intent=create&source=google"
          : undefined);
      passport.authenticate("google-restaurant", {
        scope: ["profile", "email"],
      })(req, res, next);
    });

    app.get("/api/auth/google/restaurant/callback", (req, res, next) => {
      authLog("google_restaurant_oauth_callback", {
        hasError: !!req.query.error,
        error: req.query.error || null,
      });

      passport.authenticate("google-restaurant", (err: any, user: User | false) => {
        if (err) {
          const message = String(err?.message || "").toLowerCase();
          const code = String(err?.code || "").toLowerCase();
          const isInvalidGrant =
            code === "invalid_grant" ||
            message.includes("invalid_grant") ||
            message.includes("malformed auth code");
          if (isInvalidGrant) {
            console.warn("[oauth] Google restaurant callback invalid grant", {
              code: err?.code,
              message: err?.message,
            });
            return res.redirect(
              consumeOAuthErrorRedirect(
                req,
                "auth_invalid_grant",
                "/restaurant-signup",
              ),
            );
          }
          console.error("❌ Google restaurant callback error:", err);
          return res.redirect(
            consumeOAuthErrorRedirect(req, "auth_failed", "/restaurant-signup"),
          );
        }
        if (!user) {
          return res.redirect(
            consumeOAuthErrorRedirect(req, "auth_failed", "/restaurant-signup"),
          );
        }
        req.logIn(user, async (loginErr: unknown) => {
          if (loginErr) {
            console.error("❌ Google restaurant login error:", loginErr);
            return res.redirect(
              consumeOAuthErrorRedirect(
                req,
                "session_error",
                "/restaurant-signup",
              ),
            );
          }
          const appContext = req.session.googleAppContext || "mealscout";
          const redirectBase =
            appContext === "tradescout" ? tradeScoutBaseUrl : baseUrl;
          const redirectPath =
            getOAuthRedirectPath(req) || (await resolveOAuthContinuationPath(user));
          if (appContext === "mealscout" && !hasRequiredPhone(user)) {
            req.session.pendingPhoneSignupMethod =
              req.session.pendingPhoneSignupMethod || "google";
            req.session.pendingPhoneRedirectPath = redirectPath;
            req.session.oauthRedirectPath = undefined;
            return req.session.save((saveErr: unknown) => {
              if (saveErr) {
                console.error("❌ Session save error:", saveErr);
                return res.redirect(
                  buildOAuthErrorRedirect(
                    redirectPath,
                    "session_error",
                    "/restaurant-signup",
                  ),
                );
              }
              return res.redirect(buildPhoneRequiredSetupPath(redirectPath));
            });
          }
          req.session.oauthRedirectPath = undefined;
          req.session.save((saveErr: unknown) => {
            if (saveErr) {
              console.error("❌ Session save error:", saveErr);
              return res.redirect(
                buildOAuthErrorRedirect(
                  redirectPath,
                  "session_error",
                  "/restaurant-signup",
                ),
              );
            }
            console.log(
              "✅ Google restaurant OAuth success, session saved, redirecting...",
            );
            return res.redirect(
              buildOAuthSuccessRedirect(redirectBase, redirectPath),
            );
          });
        });
      })(req, res, next);
    });
  } else {
    console.log(
      "Google OAuth not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are missing",
    );

    // Add error handling routes for when Google OAuth is not configured
    app.get("/api/auth/google/customer", (req, res) => {
      res.status(503).json({
        error: "Google OAuth not configured",
        message: "Google authentication is not available at this time",
      });
    });

    app.get("/api/auth/google/restaurant", (req, res) => {
      res.status(503).json({
        error: "Google OAuth not configured",
        message: "Google authentication is not available at this time",
      });
    });

    app.get("/api/auth/google/customer/callback", (req, res) => {
      res.redirect(
        buildOAuthErrorRedirect(
          req.query.redirect,
          "google_not_configured",
          "/",
        ),
      );
    });

    app.get("/api/auth/google/restaurant/callback", (req, res) => {
      res.redirect(
        buildOAuthErrorRedirect(
          req.query.redirect,
          "google_not_configured",
          "/restaurant-signup",
        ),
      );
    });
  }

  // Facebook Strategy (shared with TradeScout)
  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    console.log(
      "Setting up Facebook OAuth strategy (shared with TradeScout)...",
    );
    passport.use(
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_APP_ID,
          clientSecret: process.env.FACEBOOK_APP_SECRET,
          callbackURL: (() => {
            const callbackUrl = `${baseUrl}/api/auth/facebook/callback`;
            console.log("🔵 Facebook OAuth callback URL:", callbackUrl);
            return callbackUrl;
          })(),
          profileFields: [
            "id",
            "displayName",
            "emails",
            "photos",
            "first_name",
            "last_name",
          ],
          passReqToCallback: true, // Enable req access to retrieve app param from session
        },
        async (
          req: any,
          accessToken: string,
          refreshToken: string,
          profile: any,
          done: any,
        ) => {
          try {
            console.log("[oauth] Facebook profile received", {
              hasProviderId: Boolean(profile?.id),
              hasEmail:
                Boolean(profile?.emails?.[0]?.value) ||
                Boolean(profile?._json?.email),
              hasName:
                Boolean(profile?.name?.givenName) ||
                Boolean(profile?.displayName),
              hasPhoto: Boolean(profile?.photos?.[0]?.value),
              appContext: req.session?.fbAppContext || "mealscout",
            });

            const userData: FacebookUserData = {
              facebookId: profile.id,
              email: profile.emails?.[0]?.value || profile._json?.email || null,
              firstName:
                profile.name?.givenName ||
                profile._json?.first_name ||
                profile.displayName?.split(" ")[0] ||
                "Facebook",
              lastName:
                profile.name?.familyName ||
                profile._json?.last_name ||
                profile.displayName?.split(" ").slice(1).join(" ") ||
                "User",
              profileImageUrl: profile.photos?.[0]?.value || null,
              facebookAccessToken: accessToken,
            };

            console.log("[oauth] Processed Facebook user data", {
              hasEmail: Boolean(userData.email),
              appContext: req.session?.fbAppContext || "mealscout",
              hasProfileImage: Boolean(userData.profileImageUrl),
            });

            // Retrieve app context from session (set in /api/auth/facebook route)
            const appContext = (req.session?.fbAppContext || "mealscout") as
              | "mealscout"
              | "tradescout";
            const userType = getOauthUserType(req, "customer");
            const existingOAuthUser = await findExistingOAuthUser(
              "facebook",
              userData.facebookId,
              userData.email,
            );
            const user = await storage.upsertUserByAuth(
              "facebook",
              userData,
              userType,
              appContext,
            );
            kickAffiliateTag(user);
            await applyAffiliateReferral(req, user);
            req.session.oauthUserType = undefined;
            console.log("✅ Facebook user created/updated successfully:", {
              userId: user.id,
              hasEmail: Boolean(user.email),
              appContext,
            });

            // LISA Phase 4A: Emit claim for OAuth login
            storage
              .emitClaim({
                subjectType: "user",
                subjectId: user.id,
                app: appContext,
                claimType: "oauth_provider_used",
                claimValue: { provider: "facebook", email: userData.email },
                source: "oauth",
              })
              .catch((err) => console.error("Failed to emit LISA claim:", err));

            if (!existingOAuthUser && hasRequiredPhone(user)) {
              void sendAccountCreationEmails(user, req, {
                welcomeLabel: "customer",
                signupMethod: "facebook",
                notifyAdmin: false,
              });
            } else if (!existingOAuthUser) {
              req.session.pendingPhoneSignupMethod = "facebook";
            }
            return done(null, user);
          } catch (error) {
            console.error("❌ Facebook authentication error:", error);
            console.error("[oauth] Facebook profile metadata:", {
              hasProviderId: Boolean(profile?.id),
              hasEmail:
                Boolean(profile?.emails?.[0]?.value) ||
                Boolean(profile?._json?.email),
            });
            return done(error, null);
          }
        },
      ),
    );

    // Facebook auth routes with multi-app support
    app.get(
      "/api/auth/facebook",
      (req, res, next) => {
        // Capture app parameter from query string (default: mealscout)
        const appContext = (req.query.app as string) || "mealscout";

        // Validate app context
        if (appContext !== "mealscout" && appContext !== "tradescout") {
          return res.status(400).json({
            error: 'Invalid app parameter. Must be "mealscout" or "tradescout"',
          });
        }

        // Store app context in session for callback retrieval
        req.session.fbAppContext = appContext as "mealscout" | "tradescout";
        const desiredUserType =
          typeof req.query.userType === "string"
            ? req.query.userType
            : "customer";
        req.session.oauthUserType = oauthUserTypeAllowList.has(
          desiredUserType as User["userType"],
        )
          ? (desiredUserType as User["userType"])
          : "customer";
        req.session.oauthRedirectPath =
          getSafeRedirectPath(req.query.redirect) || undefined;
        console.log(
          `🔵 Starting Facebook OAuth flow with app context: ${appContext}`,
        );
        next();
      },
      passport.authenticate("facebook", {
        scope: ["email", "public_profile"],
      }),
    );

    app.get(
      "/api/auth/facebook/callback",
      (req, res, next) => {
        authLog("facebook_oauth_callback", {
          hasError: !!req.query.error,
          error: req.query.error || null,
          appContext: req.session.fbAppContext || null,
        });
        next();
      },
      passport.authenticate("facebook", {
        failureRedirect: "/?error=auth_failed&source=facebook",
      }),
      async (req, res) => {
        const user = req.user as User;
        const appContext = req.session.fbAppContext || "mealscout";
        const fallbackRedirectPath = await resolveOAuthContinuationPath(user);
        const resolvedRedirectPath =
          getOAuthRedirectPath(req) || fallbackRedirectPath;
        if (appContext === "mealscout" && !hasRequiredPhone(user)) {
          req.session.pendingPhoneSignupMethod =
            req.session.pendingPhoneSignupMethod || "facebook";
          req.session.pendingPhoneRedirectPath = resolvedRedirectPath;
          req.session.oauthRedirectPath = undefined;
          return req.session.save((err) => {
            if (err) {
              console.error("❌ Session save error:", err);
              return res.redirect("/?error=session_error");
            }
            return res.redirect(
              buildPhoneRequiredSetupPath(resolvedRedirectPath),
            );
          });
        }

        console.log("✅ Facebook OAuth callback success:", {
          userId: user?.id,
          appContext,
          userAppContext: user?.appContext,
        });

        // Save session
        req.session.save((err) => {
          if (err) {
            console.error("❌ Session save error:", err);
            return res.redirect("/?error=session_error");
          }

          // Redirect to appropriate domain
          const frontendBase =
            process.env.PUBLIC_BASE_URL || "http://localhost:5000";

          const redirectUrls = {
            mealscout: buildOAuthSuccessRedirect(
              frontendBase,
              resolvedRedirectPath,
            ),
            tradescout:
              "https://www.thetradescout.com/?auth=success&t=" + Date.now(),
          };
          req.session.oauthRedirectPath = undefined;

          const redirectUrl =
            redirectUrls[appContext as "mealscout" | "tradescout"];
          console.log(`✅ Redirecting to: ${redirectUrl}`);
          res.redirect(redirectUrl);
        });
      },
    );
    console.log(
      "✅ Facebook OAuth strategy configured successfully (multi-app enabled)",
    );
  } else {
    console.log(
      "Facebook OAuth not configured: FACEBOOK_APP_ID and FACEBOOK_APP_SECRET environment variables are missing",
    );
  }

  const requirePhoneVerification = false;

  const verifyPhoneCode = async (phone: string, code: string) => {
    const tokenHash = crypto.createHash("sha256").update(code).digest("hex");
    const token = await storage.getPhoneVerificationTokenByHash(
      phone,
      tokenHash,
    );
    if (!token) {
      return false;
    }
    await storage.markPhoneVerificationTokenUsed(token.id);
    return true;
  };

  app.post("/api/auth/phone/send-code", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone || typeof phone !== "string") {
        return res.status(400).json({ error: "Phone number is required" });
      }

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length < 10) {
        return res
          .status(400)
          .json({ error: "Valid phone number is required" });
      }

      const existingUser = await storage.getUserByPhone(normalizedPhone);
      if (existingUser) {
        return res.status(400).json({ error: "Phone number already in use" });
      }

      await storage.deleteExpiredPhoneVerificationTokens();
      await storage.deletePhoneVerificationTokens(normalizedPhone);

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const tokenHash = crypto.createHash("sha256").update(code).digest("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await storage.createPhoneVerificationToken({
        phone: normalizedPhone,
        tokenHash,
        expiresAt,
        requestIp: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.get("User-Agent") || undefined,
      });

      const smsSent = await sendSms(
        normalizedPhone,
        `Your MealScout verification code is ${code}. It expires in 10 minutes.`,
      );

      if (!smsSent) {
        return res
          .status(500)
          .json({ error: "Failed to send verification code" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Phone verification send error:", error);
      res.status(500).json({ error: "Unable to send verification code" });
    }
  });

  app.post("/api/auth/phone/verify-code", async (req, res) => {
    try {
      const { phone, code } = req.body;
      if (!phone || !code) {
        return res.status(400).json({ error: "Phone and code are required" });
      }

      const normalizedPhone = normalizePhone(phone);
      const ok = await verifyPhoneCode(normalizedPhone, String(code));
      if (!ok) {
        return res.status(400).json({ error: "Invalid or expired code" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Phone verification error:", error);
      res.status(500).json({ error: "Unable to verify code" });
    }
  });

  // Email/password registration for customers
  app.post("/api/auth/customer/register", async (req, res) => {
    try {
      const { email, firstName, lastName, phone, password, otpCode } = req.body;
      const requestedAccountType = String(
        req.body?.accountType || req.body?.userType || "",
      ).trim();
      const registrationUserType =
        requestedAccountType === "host"
          ? "host"
          : requestedAccountType === "event_coordinator" ||
              requestedAccountType === "event_organizer"
            ? "event_coordinator"
            : "customer";

      if (!email || !firstName || !lastName || !phone || !password) {
        return res.status(400).json({ error: "All fields are required" });
      }

      if (!isPasswordStrong(password)) {
        return res.status(400).json({ error: PASSWORD_REQUIREMENTS });
      }

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length < 10) {
        return res
          .status(400)
          .json({ error: "Valid phone number is required" });
      }

      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res
          .status(409)
          .json({
            code: existingUser.emailVerified
              ? "email_already_verified"
              : "email_already_registered",
            error: existingUser.emailVerified
              ? "This email already has a verified MealScout account. Log in to continue."
              : "This email already has a MealScout account. Log in or resend verification to continue.",
          });
      }
      const existingPhone = await storage.getUserByPhone(normalizedPhone);
      if (existingPhone) {
        return res.status(400).json({ error: "Phone number already in use" });
      }

      if (requirePhoneVerification) {
        if (!otpCode) {
          return res
            .status(400)
            .json({ error: "Verification code is required" });
        }
        const phoneVerified = await verifyPhoneCode(
          normalizedPhone,
          String(otpCode),
        );
        if (!phoneVerified) {
          return res.status(400).json({ error: "Phone verification failed" });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const userData: EmailUserData = {
        email,
        firstName,
        lastName,
        phone: normalizedPhone,
        passwordHash,
      };

      const user = await storage.upsertUserByAuth(
        "email",
        userData,
        registrationUserType,
      );
      kickAffiliateTag(user);
      await applyAffiliateReferral(req, user);

      const intendedNextPath =
        getSafeRedirectPath(req.body?.intendedNextPath) || "/scout";

      void sendAccountCreationEmails(user, req, {
        welcomeLabel: "customer",
        signupMethod: "email",
        intendedNextPath,
      });

      // Require email verification before first login/session.
      res.status(201).json({
        message: "Account created. Please verify your email before logging in.",
        requiresEmailVerification: true,
      });
    } catch (error) {
      console.error("Customer registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Email/password registration for restaurant owners
  app.post("/api/auth/restaurant/register", async (req, res) => {
    try {
      const { email, firstName, lastName, phone, password, otpCode, acceptTerms } =
        req.body;
      const businessType = String(req.body?.businessType || "").trim();
      const requestedRegistrationUserType =
        businessType === "food_truck"
          ? "food_truck"
          : businessType === "caterer"
            ? "caterer"
            : businessType === "private_chef"
              ? "private_chef"
              : "restaurant_owner";
      const registrationUserType = resolveBusinessAuthProvisioningUserType({
        requestedUserType: requestedRegistrationUserType,
      }) as User["userType"];

      if (!email || !firstName || !lastName || !phone || !password) {
        return res.status(400).json({ error: "All fields are required" });
      }

      if (acceptTerms !== true) {
        return res.status(400).json({ error: "You must accept the terms" });
      }

      if (!isPasswordStrong(password)) {
        return res.status(400).json({ error: PASSWORD_REQUIREMENTS });
      }

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length < 10) {
        return res
          .status(400)
          .json({ error: "Valid phone number is required" });
      }

      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res
          .status(409)
          .json({
            code: existingUser.emailVerified
              ? "email_already_verified"
              : "email_already_registered",
            error: existingUser.emailVerified
              ? "This email already has a verified MealScout account. Log in to continue."
              : "This email already has a MealScout account. Log in or resend verification to continue.",
          });
      }
      const existingPhone = await storage.getUserByPhone(normalizedPhone);
      if (existingPhone) {
        return res.status(400).json({ error: "Phone number already in use" });
      }

      if (requirePhoneVerification) {
        if (!otpCode) {
          return res
            .status(400)
            .json({ error: "Verification code is required" });
        }
        const phoneVerified = await verifyPhoneCode(
          normalizedPhone,
          String(otpCode),
        );
        if (!phoneVerified) {
          return res.status(400).json({ error: "Phone verification failed" });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const userData: EmailUserData = {
        email,
        firstName,
        lastName,
        phone: normalizedPhone,
        passwordHash,
      };

      const user = await storage.upsertUserByAuth(
        "email",
        userData,
        registrationUserType,
      );
      kickAffiliateTag(user);
      await applyAffiliateReferral(req, user);

      const intendedNextPath =
        getSafeRedirectPath(req.body?.intendedNextPath) ||
        (businessType === "food_truck"
          ? "/restaurant-signup?businessType=food_truck&intent=create&source=email"
          : "/restaurant-signup");

      const verificationAccountLabel =
        businessType === "food_truck"
          ? "food truck"
          : businessType === "caterer"
            ? "caterer"
            : businessType === "private_chef"
              ? "private chef"
              : businessType === "bar"
                ? "bar"
                : "restaurant owner";

      void sendAccountCreationEmails(user, req, {
        welcomeLabel: verificationAccountLabel,
        signupMethod: "email",
        intendedNextPath,
      });

      // Require email verification before first login/session.
      res.status(201).json({
        message:
          "Business account created. Please verify your email before logging in.",
        requiresEmailVerification: true,
      });
    } catch (error) {
      console.error("Restaurant registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Email/password registration for suppliers
  app.post("/api/auth/supplier/register", async (req, res) => {
    try {
      const { email, firstName, lastName, phone, password, otpCode } = req.body;

      if (!email || !firstName || !lastName || !phone || !password) {
        return res.status(400).json({ error: "All fields are required" });
      }

      if (!isPasswordStrong(password)) {
        return res.status(400).json({ error: PASSWORD_REQUIREMENTS });
      }

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length < 10) {
        return res
          .status(400)
          .json({ error: "Valid phone number is required" });
      }

      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res
          .status(409)
          .json({
            code: existingUser.emailVerified
              ? "email_already_verified"
              : "email_already_registered",
            error: existingUser.emailVerified
              ? "This email already has a verified MealScout account. Log in to continue."
              : "This email already has a MealScout account. Log in or resend verification to continue.",
          });
      }
      const existingPhone = await storage.getUserByPhone(normalizedPhone);
      if (existingPhone) {
        return res.status(400).json({ error: "Phone number already in use" });
      }

      if (requirePhoneVerification) {
        if (!otpCode) {
          return res
            .status(400)
            .json({ error: "Verification code is required" });
        }
        const phoneVerified = await verifyPhoneCode(
          normalizedPhone,
          String(otpCode),
        );
        if (!phoneVerified) {
          return res.status(400).json({ error: "Phone verification failed" });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const userData: EmailUserData = {
        email,
        firstName,
        lastName,
        phone: normalizedPhone,
        passwordHash,
      };

      const user = await storage.upsertUserByAuth(
        "email",
        userData,
        "supplier",
      );
      kickAffiliateTag(user);
      await applyAffiliateReferral(req, user);

      const intendedNextPath =
        getSafeRedirectPath(req.body?.intendedNextPath) ||
        "/supplier/dashboard";

      void sendAccountCreationEmails(user, req, {
        welcomeLabel: "supplier",
        signupMethod: "email",
        intendedNextPath,
      });

      // Require email verification before first login/session.
      res.status(201).json({
        message:
          "Supplier account created. Please verify your email before logging in.",
        requiresEmailVerification: true,
      });
    } catch (error) {
      console.error("Supplier registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Email/password login for restaurant owners
  app.post("/api/auth/restaurant/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res
          .status(400)
          .json({ error: "Email and password are required" });
      }

      const user = await storage.getUserByEmail(email);
      if (
        !user ||
        (user.userType !== "customer" &&
          !isBusinessCapableForContinuation(user.userType))
      ) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      if (!user.passwordHash && user.googleId) {
        return res.status(409).json({
          error: "This account uses Google sign-in. Continue with Google.",
          code: "google_auth_required",
          provider: "google",
          authUrl: `/api/auth/google/restaurant?userType=${encodeURIComponent(
            user.userType === "food_truck"
              ? "food_truck"
              : "restaurant_owner",
          )}`,
        });
      }

      if (
        !user.passwordHash ||
        !(await bcrypt.compare(password, user.passwordHash))
      ) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      if (!user.emailVerified) {
        return res.status(403).json({
          error: "Please verify your email before logging in.",
          code: "email_not_verified",
        });
      }

      await establishAuthenticatedSession(req, user);
      res.json({ user: sanitizeUser(user), message: "Login successful" });
    } catch (error) {
      console.error("Restaurant login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Email/password login for all users
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res
          .status(400)
          .json({ error: "Email and password are required" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      if (!user.passwordHash && user.googleId) {
        const businessGoogleUser = isBusinessCapableForContinuation(
          user.userType,
        );
        const authUrl = businessGoogleUser
          ? `/api/auth/google/restaurant?userType=${encodeURIComponent(
              user.userType === "food_truck"
                ? "food_truck"
                : "restaurant_owner",
            )}`
          : "/api/auth/google/customer";
        return res.status(409).json({
          error: "This account uses Google sign-in. Continue with Google.",
          code: "google_auth_required",
          provider: "google",
          authUrl,
        });
      }

      if (!user.passwordHash) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const passwordMatch = await bcrypt.compare(password, user.passwordHash);

      if (!passwordMatch) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      if (!user.emailVerified) {
        return res.status(403).json({
          error: "Please verify your email before logging in.",
          code: "email_not_verified",
        });
      }

      await establishAuthenticatedSession(req, user);
      res.json({ user: sanitizeUser(user), message: "Login successful" });
    } catch (error) {
      console.error("❌ Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Resend verification email (public, non-enumerating)
  app.post("/api/auth/resend-verification", async (req, res) => {
    try {
      const emailRaw =
        typeof req.body?.email === "string" ? req.body.email : "";
      const email = emailRaw.trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const user = await storage.getUserByEmail(email);
      if (user && user.email && !user.emailVerified) {
        const intendedNextPath =
          getSafeRedirectPath(req.body?.intendedNextPath) ||
          getDefaultPostVerificationRedirect(user);
        const verifyUrl = await createEmailVerificationUrl(
          user,
          req,
          intendedNextPath,
        );
        if (verifyUrl) {
          await emailService.sendEmailVerificationEmail(user, verifyUrl);
        }
      }

      // Always respond success to avoid account enumeration.
      res.json({
        message:
          "If an account exists for that email, a verification link has been sent.",
      });
    } catch (error) {
      console.error("Resend verification error:", error);
      res.status(500).json({ error: "Unable to resend verification email" });
    }
  });

  // Check email verification status (public, non-enumerating)
  app.post("/api/auth/verification-status", async (req, res) => {
    try {
      const emailRaw =
        typeof req.body?.email === "string" ? req.body.email : "";
      const email = emailRaw.trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.json({ verified: false });
      }

      res.json({ verified: user.emailVerified === true });
    } catch (error) {
      console.error("Verification status check error:", error);
      res.status(500).json({ error: "Unable to check verification status" });
    }
  });

  // TradeScout SSO endpoint - accepts a signed JWT from TradeScout and
  // creates/links a MealScout user, then establishes a session.
  app.post("/api/auth/tradescout/sso", async (req, res) => {
    try {
      const secret = process.env.TRADESCOUT_JWT_SECRET;
      if (!secret) {
        return res.status(503).json({
          error: "TradeScout SSO not configured",
          message: "TRADESCOUT_JWT_SECRET is not set on the MealScout server",
        });
      }

      const authHeader = req.headers["authorization"];
      const bearerToken =
        typeof authHeader === "string" && authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length)
          : undefined;

      const token = (req.body && (req.body as any).token) || bearerToken;
      if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "SSO token is required" });
      }

      let decoded: any;
      try {
        decoded = jwt.verify(token, secret);
      } catch (err) {
        console.error("TradeScout SSO token verification failed:", err);
        return res.status(401).json({ error: "Invalid SSO token" });
      }

      const rawSubject =
        decoded && typeof decoded === "object" && !Array.isArray(decoded)
          ? decoded.sub || decoded.id || decoded.userId
          : undefined;
      if (
        (typeof rawSubject !== "string" || rawSubject.trim().length === 0) &&
        (typeof rawSubject !== "number" || !Number.isFinite(rawSubject))
      ) {
        return res
          .status(400)
          .json({ error: "SSO token missing subject (sub)" });
      }

      const roles: string[] | undefined = Array.isArray(decoded.roles)
        ? decoded.roles
        : typeof decoded.role === "string"
          ? [decoded.role]
          : undefined;

      const mapRolesToUserType = (r?: string[]): User["userType"] => {
        if (!r || r.length === 0) return "customer";
        if (r.includes("mealscout_super_admin")) return "super_admin";
        if (r.includes("mealscout_duper_admin")) return "duper_admin";
        if (r.includes("mealscout_admin") || r.includes("admin"))
          return "admin";
        if (
          r.includes("restaurant_owner") ||
          r.includes("merchant") ||
          r.includes("vendor")
        )
          return "restaurant_owner";
        return "customer";
      };

      const userType = mapRolesToUserType(roles);

      const tsUserData: TradeScoutUserData = {
        tradescoutId: String(rawSubject),
        email: decoded.email ?? null,
        firstName:
          decoded.given_name ||
          decoded.firstName ||
          (decoded.name ? String(decoded.name).split(" ")[0] : null),
        lastName:
          decoded.family_name ||
          decoded.lastName ||
          (decoded.name
            ? String(decoded.name).split(" ").slice(1).join(" ") || null
            : null),
        roles: roles ?? null,
      };

      const user = await storage.upsertUserByAuth(
        "tradescout",
        tsUserData,
        userType === "super_admin"
          ? "admin"
          : (userType as
              | "customer"
              | "restaurant_owner"
              | "admin"
              | "duper_admin"),
      );
      kickAffiliateTag(user);
      await applyAffiliateReferral(req, user);

      await establishAuthenticatedSession(req, user);
      res.json({
        user: sanitizeUser(user),
        message: "TradeScout SSO login successful",
      });
    } catch (error) {
      console.error("TradeScout SSO error:", error);
      res.status(500).json({ error: "Unable to complete SSO login" });
    }
  });

  // Unified logout route
  app.post("/api/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to logout" });
      }
      const finish = () => {
        res.clearCookie("tradescout.sid", getSessionCookieOptions());
        res.json({ message: "Logout successful" });
      };

      if (!req.session || typeof req.session.destroy !== "function") {
        finish();
        return;
      }

      req.session.destroy((destroyErr: unknown) => {
        if (destroyErr) {
          console.error("Logout session destroy error:", destroyErr);
          return res.status(500).json({ error: "Failed to destroy session" });
        }
        finish();
      });
    });
  });

  // Change password (for users with temp passwords or general password change)
  app.post("/api/auth/change-password", async (req, res) => {
    try {
      if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { oldPassword, newPassword } = req.body;

      if (!oldPassword || !newPassword) {
        return res
          .status(400)
          .json({ error: "Old and new passwords are required" });
      }

      if (!isPasswordStrong(newPassword)) {
        return res.status(400).json({ error: PASSWORD_REQUIREMENTS });
      }

      const user = req.user as User;
      if (!user.passwordHash) {
        return res.status(400).json({ error: "User has no password set" });
      }

      const passwordMatch = await bcrypt.compare(
        oldPassword,
        user.passwordHash,
      );
      if (!passwordMatch) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      const newPasswordHash = await bcrypt.hash(newPassword, 12);
      await storage.updateUserPassword(user.id, newPasswordHash, false);

      res.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("Change password error:", error);
      res.status(500).json({ error: "Failed to change password" });
    }
  });

  // Password reset routes
  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      // Find user by email
      const user = await storage.getUserByEmail(email);
      if (!user) {
        // Don't reveal whether email exists - always return success
        return res.json({
          message:
            "If an account with that email exists, a password reset link has been sent.",
        });
      }

      // Only allow password reset for users with email/password authentication.
      if (!user.passwordHash) {
        return res.json({
          message:
            "If an account with that email exists, a password reset link has been sent.",
        });
      }

      // If email is not configured, still return success to prevent enumeration.
      if (!emailService.isAvailable()) {
        return res.json({
          message:
            "If an account with that email exists, a password reset link has been sent.",
        });
      }

      // Generate secure token: tokenId.verifier
      const tokenId = crypto.randomBytes(16).toString("hex");
      const verifier = crypto.randomBytes(32).toString("hex");
      const resetToken = `${tokenId}.${verifier}`;

      // Store only a hash of the verifier for lookup (not the full token).
      const tokenHash = crypto
        .createHash("sha256")
        .update(verifier)
        .digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Clean up existing tokens for this user
      await storage.deleteUserResetTokens(user.id);

      // Create new reset token
      await storage.createPasswordResetToken({
        userId: user.id,
        tokenHash,
        expiresAt,
        requestIp: req.ip || req.connection.remoteAddress || undefined,
        userAgent: req.get("User-Agent") || undefined,
      });

      // Generate reset URL
      const baseUrl = getBaseUrl();
      const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(
        resetToken,
      )}`;

      // Send reset email
      await emailService.sendPasswordResetEmail(user, resetUrl);

      res.json({
        message:
          "If an account with that email exists, a password reset link has been sent.",
      });
    } catch (error) {
      console.error("Forgot password error:", error);
      res
        .status(500)
        .json({ error: "Unable to process password reset request" });
    }
  });

  // Validate reset token
  app.get("/api/auth/reset-password/validate", async (req, res) => {
    try {
      const { token } = req.query;

      if (!token || typeof token !== "string") {
        return res.json({ valid: false, error: "Invalid token" });
      }

      // Prefer tokenId.verifier, but accept legacy tokens that were hashed as a whole.
      const tokenParts = token.split(".");
      const tokenHash =
        tokenParts.length === 2 && tokenParts[1]
          ? crypto.createHash("sha256").update(tokenParts[1]).digest("hex")
          : crypto.createHash("sha256").update(token).digest("hex");

      // Find token in database
      const resetToken =
        await storage.getPasswordResetTokenByTokenHash(tokenHash);

      if (!resetToken) {
        return res.json({
          valid: false,
          error: "Token not found or already used",
        });
      }

      // Check if token has expired
      if (new Date() > resetToken.expiresAt) {
        return res.json({ valid: false, error: "Token has expired" });
      }

      res.json({ valid: true });
    } catch (error) {
      console.error("Token validation error:", error);
      res.json({ valid: false, error: "Unable to validate token" });
    }
  });

  // Reset password with token
  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res
          .status(400)
          .json({ error: "Token and password are required" });
      }

      if (!isPasswordStrong(password)) {
        return res.status(400).json({ error: PASSWORD_REQUIREMENTS });
      }

      // Prefer tokenId.verifier, but accept legacy tokens that were hashed as a whole.
      const tokenParts = String(token).split(".");
      const tokenHash =
        tokenParts.length === 2 && tokenParts[1]
          ? crypto.createHash("sha256").update(tokenParts[1]).digest("hex")
          : crypto.createHash("sha256").update(String(token)).digest("hex");

      // Find and validate token
      const resetToken =
        await storage.getPasswordResetTokenByTokenHash(tokenHash);

      if (!resetToken) {
        return res
          .status(400)
          .json({ error: "Invalid or expired reset token" });
      }

      // Check if token has expired
      if (new Date() > resetToken.expiresAt) {
        return res.status(400).json({ error: "Reset token has expired" });
      }

      // Get user
      const user = await storage.getUser(resetToken.userId);
      if (!user) {
        return res.status(400).json({ error: "User not found" });
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(password, 12);

      // Update user password (and clear temporary-password flag if present)
      await storage.updateUserPassword(user.id, passwordHash, false);

      // Mark token as used
      await storage.markPasswordResetTokenUsed(resetToken.id);

      res.json({ message: "Password updated successfully" });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ error: "Unable to reset password" });
    }
  });

  // Validate account setup token
  app.get("/api/auth/validate-setup-token", async (req, res) => {
    try {
      const { token } = req.query;

      if (!token || typeof token !== "string") {
        return res.json({ valid: false, error: "Invalid token" });
      }

      // Hash the token to compare with stored hash
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      // Find token in database
      const setupToken =
        await storage.getAccountSetupTokenByTokenHash(tokenHash);

      if (!setupToken) {
        return res.json({
          valid: false,
          error: "Token not found or already used",
        });
      }

      // Check if token has expired
      if (new Date() > setupToken.expiresAt) {
        return res.json({ valid: false, error: "Token has expired" });
      }

      // Get user info
      const user = await storage.getUser(setupToken.userId);
      if (!user) {
        return res.json({ valid: false, error: "User not found" });
      }

      res.json({
        valid: true,
        userEmail: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
      });
    } catch (error) {
      console.error("Token validation error:", error);
      res.json({ valid: false, error: "Unable to validate token" });
    }
  });

  // Complete account setup with token
  app.post(
    "/api/auth/complete-setup",
    completeAccountSetupLimiter,
    async (req, res) => {
      try {
        const { token, password, firstName, lastName, phone } = req.body;

        if (!token || !password || !phone || !firstName || !lastName) {
          return res
            .status(400)
            .json({ error: "Profile details and password are required" });
        }

        const normalizedSetupPhone = normalizePhone(String(phone));
        if (normalizedSetupPhone.length < 10) {
          return res
            .status(400)
            .json({ error: "Valid phone number is required" });
        }

        if (!isPasswordStrong(password)) {
          return res.status(400).json({ error: PASSWORD_REQUIREMENTS });
        }

        // Hash the token to compare with stored hash
        const tokenHash = crypto
          .createHash("sha256")
          .update(token)
          .digest("hex");

        // Avoid the deliberately expensive password hash for invalid,
        // expired, or already-used links. The transaction below still
        // revalidates the token and wins the per-user compare-and-set race.
        const activeSetupToken =
          await storage.getAccountSetupTokenByTokenHash(tokenHash);
        if (!activeSetupToken) {
          return res.status(409).json({
            error: "Account setup has already been completed or the link is no longer available.",
            code: ACCOUNT_SETUP_ALREADY_COMPLETED_CODE,
          });
        }

        // Hash before taking the per-user row lock so password work never
        // extends the shared database critical section.
        const passwordHash = await hashAccountSetupPassword(password);

        const updatedUser = await completeAccountSetupTransaction({
          tokenHash,
          passwordHash,
          firstName,
          lastName,
          phone: normalizedSetupPhone,
        });

        const continuationPath =
          getSafeRedirectPath(req.body?.redirect) ||
          getDefaultPostVerificationRedirect(updatedUser);

        // Send welcome email with the validated continuation used by setup.
        void sendWelcomeOrVerification(
          updatedUser,
          req,
          "account setup",
          continuationPath,
        );

        res.json({
          message: "Account setup completed successfully",
          redirect: continuationPath,
        });
      } catch (error: any) {
        console.error("Account setup error:", error);
        if (error?.code === ACCOUNT_SETUP_ALREADY_COMPLETED_CODE) {
          return res.status(409).json({
            error: "Account setup has already been completed or the link is no longer available.",
            code: ACCOUNT_SETUP_ALREADY_COMPLETED_CODE,
          });
        }
        res.status(500).json({ error: "Unable to complete account setup" });
      }
    },
  );

  app.post("/api/auth/complete-phone-setup", async (req: any, res) => {
    try {
      if (!req.isAuthenticated?.() || !req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const normalizedSetupPhone = normalizePhone(String(req.body?.phone || ""));
      if (normalizedSetupPhone.length < 10) {
        return res
          .status(400)
          .json({ error: "Valid phone number is required" });
      }
      const existingPhoneUser =
        await storage.getUserByPhone(normalizedSetupPhone);
      if (existingPhoneUser && existingPhoneUser.id !== req.user.id) {
        return res.status(400).json({ error: "Phone number already in use" });
      }

      const redirectPath =
        getSafeRedirectPath(req.body?.redirect) ||
        getSafeRedirectPath(req.session?.pendingPhoneRedirectPath) ||
        (await resolveOAuthContinuationPath(req.user as User));

      const updatedUser = await storage.updateUser(req.user.id, {
        phone: normalizedSetupPhone,
      });
      const userForEmail = (updatedUser || {
        ...(req.user as User),
        phone: normalizedSetupPhone,
      }) as User;

      if (updatedUser) {
        req.login(updatedUser, (loginErr: unknown) => {
          if (loginErr) {
            console.error("Phone setup session refresh error:", loginErr);
          }
        });
      }

      const pendingSignupMethod =
        req.session?.pendingPhoneSignupMethod || "phone_setup";
      void sendAccountCreationEmails(userForEmail, req, {
        welcomeLabel: "phone setup",
        signupMethod: `${pendingSignupMethod}_phone_setup`,
        intendedNextPath: redirectPath,
        skipAgeGate: true,
      });

      req.session.pendingPhoneSignupMethod = undefined;
      req.session.pendingPhoneRedirectPath = undefined;
      req.session.save((saveErr: unknown) => {
        if (saveErr) {
          console.error("Phone setup session save error:", saveErr);
        }
      });

      res.json({
        message: "Phone number saved",
        user: userForEmail,
        redirect: redirectPath,
      });
    } catch (error) {
      console.error("Phone setup error:", error);
      res.status(500).json({ error: "Unable to save phone number" });
    }
  });

  // Verify email address
  app.get("/api/auth/verify-email", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "Invalid token" });
      }

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const verificationToken =
        await storage.getEmailVerificationTokenByTokenHash(tokenHash);

      if (!verificationToken) {
        return res.status(400).json({ error: "Invalid or expired token" });
      }

      const user = await storage.getUser(verificationToken.userId);
      if (!user) {
        return res.status(400).json({ error: "User not found" });
      }

      await storage.updateUser(user.id, { emailVerified: true });
      await storage.markEmailVerificationTokenUsed(verificationToken.id);

      const redirectBase =
        process.env.CLIENT_ORIGIN ||
        process.env.PUBLIC_BASE_URL ||
        "http://localhost:5000";

      // After verification, send users to the durable intent embedded in the
      // verification link, then fall back to their role default.
      const defaultRedirectPath =
        getSafeRedirectPath(req.query.redirect) ||
        getDefaultPostVerificationRedirect(user);

      const redirectUrl = `${redirectBase}/login?verified=1&redirect=${encodeURIComponent(
        defaultRedirectPath,
      )}`;
      res.redirect(redirectUrl);
    } catch (error) {
      console.error("Email verification error:", error);
      res.status(500).json({ error: "Unable to verify email" });
    }
  });
}

async function applyAffiliateReferral(req: any, user: User) {
  try {
    if (isAdminUserType(user.userType)) return;
    const ref =
      typeof req.body?.referralId === "string"
        ? req.body.referralId.trim()
        : typeof req.cookies?.referralId === "string"
        ? req.cookies.referralId.trim()
        : "";
    if (!ref) return;
    if (user.affiliateCloserUserId) return;
    const affiliateUserId = await resolveAffiliateUserId(ref);
    if (!affiliateUserId || affiliateUserId === user.id) return;

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
  } catch (error) {
    console.error("[affiliate] Failed to apply referral:", error);
  }
}

function kickAffiliateTag(user: User) {
  if (!shouldAssignAffiliateTagForUserType(user.userType)) return;
  if (user.affiliateTag) return;
  ensureAffiliateTag(user.id).catch((error) =>
    console.error("[affiliate] Failed to assign tag:", error),
  );
}

// Middleware to check if user is authenticated
export const isAuthenticated = (req: any, res: any, next: any) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
};

// Middleware to check if user is authenticated restaurant owner
export const isRestaurantOwner = (req: any, res: any, next: any) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (
    req.user.userType !== "restaurant_owner" &&
    !isAdminUserType(req.user.userType)
  ) {
    return res.status(403).json({ error: "Restaurant owner access required" });
  }

  next();
};

// Role-based access control middleware
type UserRole =
  | "customer"
  | "restaurant_owner"
  | "supplier"
  | "staff"
  | "admin"
  | "duper_admin"
  | "super_admin";

export const requireRole =
  (allowedRoles: UserRole[]) => (req: any, res: any, next: any) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Block disabled accounts
    if (req.user?.isDisabled) {
      return res.status(403).json({ error: "Account disabled" });
    }

    const userRole = req.user?.userType as UserRole;
    if (isRootAdminUserType(userRole)) {
      return next();
    }

    if (
      isDuperAdminUserType(userRole) &&
      allowedRoles.some((role) => role !== "super_admin")
    ) {
      return next();
    }

    if (
      userRole === "admin" &&
      allowedRoles.some((role) => role !== "super_admin")
    ) {
      return next();
    }

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: "Forbidden",
        message: `This action requires one of the following roles: ${allowedRoles.join(
          ", ",
        )}`,
        userRole,
      });
    }

    next();
  };

// Convenience middleware for admin-only endpoints
export const isAdmin = requireRole(["admin", "duper_admin", "super_admin"]);

// Convenience middleware for super admin only
export const isSuperAdmin = requireRole(["super_admin"]);

// Convenience middleware for staff or admin
export const isStaffOrAdmin = requireRole([
  "staff",
  "admin",
  "duper_admin",
  "super_admin",
]);

// Convenience middleware for restaurant owner or admin
export const isRestaurantOwnerOrAdmin = requireRole([
  "restaurant_owner",
  "admin",
  "duper_admin",
  "super_admin",
]);

export const isSupplierOrAdmin = requireRole([
  "supplier",
  "admin",
  "duper_admin",
  "super_admin",
]);

// API Key authentication middleware
export const apiKeyAuth = async (req: any, res: any, next: any) => {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey) {
    return res
      .status(401)
      .json({ error: "API key required", header: "X-API-Key" });
  }

  if (typeof apiKey !== "string") {
    return res.status(400).json({ error: "Invalid API key format" });
  }

  try {
    // Get all active API keys to check against (in production, use cache)
    const apiKeys = await storage.getActiveApiKeys();

    let validKey = null;
    for (const key of apiKeys) {
      // Compare hashed key
      if (await bcrypt.compare(apiKey, key.keyHash)) {
        validKey = key;
        break;
      }
    }

    if (!validKey) {
      return res.status(401).json({ error: "Invalid API key" });
    }

    if (validKey.expiresAt && new Date(validKey.expiresAt) < new Date()) {
      return res.status(401).json({ error: "API key expired" });
    }

    // Attach user to request
    const user = await storage.getUser(validKey.userId);
    if (!user) {
      return res.status(401).json({ error: "API key user not found" });
    }

    req.user = user;
    req.apiKey = validKey;

    // Update last used time (async, don't await)
    storage
      .updateApiKeyLastUsed(validKey.id)
      .catch((err) => console.error("Failed to update API key usage:", err));

    next();
  } catch (error) {
    console.error("API key authentication error:", error);
    res.status(500).json({ error: "Authentication error" });
  }
};

// Resource ownership verification middleware
// Ensures user can only modify their own restaurant or data
export const verifyResourceOwnership = (
  resourceType: "restaurant" | "deal",
) => {
  return async (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { restaurantId, dealId } = req.params;

    try {
      if (resourceType === "restaurant" && restaurantId) {
        // Check if user owns this restaurant
        const restaurant = await storage.getRestaurant(restaurantId);
        if (!restaurant) {
          return res.status(404).json({ error: "Restaurant not found" });
        }

        // Allow if user is owner or admin
        if (
          restaurant.ownerId !== req.user.id &&
          !isAdminUserType(req.user.userType)
        ) {
          return res
            .status(403)
            .json({ error: "You do not own this restaurant" });
        }
      } else if (resourceType === "deal" && dealId) {
        // Check if user's restaurant owns this deal
        const deal = await storage.getDeal(dealId);
        if (!deal) {
          return res.status(404).json({ error: "Deal not found" });
        }

        const restaurant = await storage.getRestaurant(deal.restaurantId);
        if (!restaurant) {
          return res.status(404).json({ error: "Deal's restaurant not found" });
        }

        // Allow if user is restaurant owner or admin
        const isAdmin = isAdminUserType(req.user.userType);
        const canManageDeals =
          restaurant.ownerId === req.user.id
            ? true
            : await hasBusinessPermissionForRestaurant(
                req.user.id,
                restaurant.id,
                "manageDeals",
              );

        if (!canManageDeals && !isAdmin) {
          return res.status(403).json({ error: "You do not own this deal" });
        }
      }

      next();
    } catch (error) {
      console.error("Resource ownership verification error:", error);
      res.status(500).json({ error: "Authorization error" });
    }
  };
};

