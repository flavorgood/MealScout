import {
  telemetryEvents,
  users,
  type User,
  type UpsertUser,
  type GoogleUserData,
  type EmailUserData,
  type FacebookUserData,
  type TradeScoutUserData,
} from "@shared/schema";
import { db, pool } from "../db";
import { eq, and, or, isNull, desc, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { syncUserToBrevo } from "../brevoCrm";
import { ensureAffiliateTag } from "../affiliateTagService";
import {
  isAdminUserType,
  shouldAssignAffiliateTagForUserType,
} from "../roleAccess";
import { isUniqueViolation } from "../utils/isUniqueViolation";

// ── Cached table-info (module-level singleton, matches the instance cache in DatabaseStorage) ──

let userTableInfoPromise: Promise<{
  schema: string;
  columns: Set<string>;
}> | null = null;

async function getUserTableInfo(): Promise<{
  schema: string;
  columns: Set<string>;
}> {
  if (userTableInfoPromise) return userTableInfoPromise;
  userTableInfoPromise = (async () => {
    try {
      if (!pool) return { schema: "public", columns: new Set<string>() };

      const schemaRes = await pool.query(
        `select table_schema from information_schema.tables
         where table_name = 'users'
         order by case when table_schema = 'public' then 0 else 1 end limit 1`,
      );
      const schema =
        String(schemaRes.rows?.[0]?.table_schema || "").trim() || "public";

      const colsRes = await pool.query(
        `select column_name from information_schema.columns
         where table_schema = $1 and table_name = 'users'`,
        [schema],
      );
      const columns = new Set<string>(
        (colsRes.rows || [])
          .map((row: any) => String(row.column_name || "").trim())
          .filter(Boolean),
      );
      return { schema, columns };
    } catch (error) {
      console.warn(
        "getUserTableInfo failed; using safe user projection:",
        error,
      );
      return { schema: "public", columns: new Set<string>() };
    }
  })();
  return userTableInfoPromise;
}

async function selectUsersSafe(
  whereSql: string,
  params: any[],
): Promise<any[]> {
  if (!pool) return [];
  const { schema, columns } = await getUserTableInfo();
  const has = (col: string) => columns.size === 0 || columns.has(col);
  const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

  if (columns.size > 0 && !columns.has("id")) return [];

  const select = [
    `${q("id")} as "id"`,
    `${has("user_type") ? `${q("user_type")} as "userType"` : `'customer' as "userType"`}`,
    `${has("email") ? `${q("email")} as "email"` : `null as "email"`}`,
    `${has("first_name") ? `${q("first_name")} as "firstName"` : `null as "firstName"`}`,
    `${has("last_name") ? `${q("last_name")} as "lastName"` : `null as "lastName"`}`,
    `${has("phone") ? `${q("phone")} as "phone"` : `null as "phone"`}`,
    `${has("password_hash") ? `${q("password_hash")} as "passwordHash"` : `null as "passwordHash"`}`,
    `${has("email_verified") ? `${q("email_verified")} as "emailVerified"` : `false as "emailVerified"`}`,
    `${has("must_reset_password") ? `${q("must_reset_password")} as "mustResetPassword"` : `false as "mustResetPassword"`}`,
    `${has("is_disabled") ? `${q("is_disabled")} as "isDisabled"` : `false as "isDisabled"`}`,
    `${has("is_active") ? `${q("is_active")} as "isActive"` : `null as "isActive"`}`,
    `${has("profile_image_url") ? `${q("profile_image_url")} as "profileImageUrl"` : `null as "profileImageUrl"`}`,
    `${has("affiliate_tag") ? `${q("affiliate_tag")} as "affiliateTag"` : `null as "affiliateTag"`}`,
    `${has("affiliate_percent") ? `${q("affiliate_percent")} as "affiliatePercent"` : `null as "affiliatePercent"`}`,
    `${has("affiliate_closer_user_id") ? `${q("affiliate_closer_user_id")} as "affiliateCloserUserId"` : `null as "affiliateCloserUserId"`}`,
    `${has("affiliate_booker_user_id") ? `${q("affiliate_booker_user_id")} as "affiliateBookerUserId"` : `null as "affiliateBookerUserId"`}`,
    `${has("affiliate_closer_percent") ? `${q("affiliate_closer_percent")} as "affiliateCloserPercent"` : `null as "affiliateCloserPercent"`}`,
    `${has("affiliate_booker_percent") ? `${q("affiliate_booker_percent")} as "affiliateBookerPercent"` : `null as "affiliateBookerPercent"`}`,
    `${has("stripe_customer_id") ? `${q("stripe_customer_id")} as "stripeCustomerId"` : `null as "stripeCustomerId"`}`,
    `${has("stripe_subscription_id") ? `${q("stripe_subscription_id")} as "stripeSubscriptionId"` : `null as "stripeSubscriptionId"`}`,
    `${has("subscription_billing_interval") ? `${q("subscription_billing_interval")} as "subscriptionBillingInterval"` : `null as "subscriptionBillingInterval"`}`,
    `${has("subscription_signup_date") ? `${q("subscription_signup_date")} as "subscriptionSignupDate"` : `null as "subscriptionSignupDate"`}`,
    `${has("trial_started_at") ? `${q("trial_started_at")} as "trialStartedAt"` : `null as "trialStartedAt"`}`,
    `${has("trial_ends_at") ? `${q("trial_ends_at")} as "trialEndsAt"` : `null as "trialEndsAt"`}`,
    `${has("trial_used") ? `${q("trial_used")} as "trialUsed"` : `false as "trialUsed"`}`,
    `${has("app_context") ? `${q("app_context")} as "appContext"` : `null as "appContext"`}`,
    `${has("public_profile_settings") ? `${q("public_profile_settings")} as "publicProfileSettings"` : `null as "publicProfileSettings"`}`,
    `${has("account_settings") ? `${q("account_settings")} as "accountSettings"` : `null as "accountSettings"`}`,
    `${has("created_at") ? `${q("created_at")} as "createdAt"` : `null as "createdAt"`}`,
    `${has("updated_at") ? `${q("updated_at")} as "updatedAt"` : `null as "updatedAt"`}`,
    `${has("business_name") ? `${q("business_name")} as "businessName"` : `null as "businessName"`}`,
    `${has("postal_code") ? `${q("postal_code")} as "postalCode"` : `null as "postalCode"`}`,
  ];

  const sqlText = `select ${select.join(", ")} from ${q(schema)}.${q("users")} ${whereSql}`;
  const result = await pool.query(sqlText, params);
  return result.rows || [];
}

function shouldAssignAffiliateTag(userType?: string | null): boolean {
  return shouldAssignAffiliateTagForUserType(userType);
}

function normalizeEmail(value: unknown): string | null {
  const email = String(value || "").trim().toLowerCase();
  return email || null;
}

function getSafePublicSignupUserType(userType: User["userType"]): User["userType"] {
  if (isAdminUserType(userType) || userType === "staff") return "customer";
  const allowed = new Set<string>([
    "customer",
    "restaurant_owner",
    "food_truck",
    "host",
    "event_coordinator",
    "supplier",
    "caterer",
    "private_chef",
  ]);
  return allowed.has(String(userType)) ? userType : "customer";
}

async function recordAuthLinkEvent(params: {
  userId: string;
  provider: string;
  matchedBy: "provider_id" | "normalized_email" | "duplicate_key";
  email?: string | null;
}) {
  try {
    await db.insert(telemetryEvents).values({
      eventName: "auth_account_linked",
      userId: params.userId,
      properties: {
        provider: params.provider,
        matchedBy: params.matchedBy,
        normalizedEmail: normalizeEmail(params.email),
      },
    });
  } catch {
    // Telemetry must never block login.
  }
}

// ── Repository factory ────────────────────────────────────────────────────────

export function createUsersRepository() {
  return {
    async updateUser(
      id: string,
      updates: Partial<
        Pick<
          User,
          | "subscriptionBillingInterval"
          | "stripeCustomerId"
          | "stripeSubscriptionId"
          | "passwordHash"
          | "subscriptionSignupDate"
          | "trialStartedAt"
          | "trialEndsAt"
          | "trialUsed"
          | "emailVerified"
          | "firstName"
          | "lastName"
          | "phone"
          | "email"
          | "postalCode"
          | "birthYear"
          | "gender"
          | "isActive"
          | "publicProfileSettings"
          | "accountSettings"
        >
      >,
    ): Promise<User> {
      const [user] = await db
        .update(users)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      return user;
    },

    async getUser(id: string): Promise<User | undefined> {
      const normalizedId = String(id || "").trim();
      if (!normalizedId) return undefined;
      try {
        const rows = await selectUsersSafe(`where "id" = $1 limit 1`, [
          normalizedId,
        ]);
        const row = (rows[0] as any) || undefined;
        if (!row) return undefined;
        if (row.isDisabled === true) return undefined;
        return row as any;
      } catch (error) {
        console.warn("getUser safe projection failed, falling back:", error);
        const [user] = await db
          .select()
          .from(users)
          .where(
            and(
              eq(users.id, normalizedId),
              or(eq(users.isDisabled, false), isNull(users.isDisabled)),
            ),
          );
        return user;
      }
    },

    async upsertUser(userData: UpsertUser): Promise<User> {
      const [user] = await db
        .insert(users)
        .values(userData)
        .onConflictDoUpdate({
          target: users.facebookId,
          set: { ...userData, updatedAt: new Date() },
        })
        .returning();
      return user;
    },

    async getUserByEmail(email: string): Promise<User | undefined> {
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) return undefined;
      try {
        const rows = await selectUsersSafe(`where lower("email") = $1 limit 1`, [
          normalizedEmail,
        ]);
        const row = (rows[0] as any) || undefined;
        if (!row) return undefined;
        if (row.isDisabled === true) return undefined;
        return row as any;
      } catch (error) {
        console.warn(
          "getUserByEmail safe projection failed, falling back:",
          error,
        );
        const [user] = await db
          .select()
          .from(users)
          .where(
            and(
              sql`lower(${users.email}) = ${normalizedEmail}`,
              or(eq(users.isDisabled, false), isNull(users.isDisabled)),
            ),
          );
        return user;
      }
    },

    async getUserByPhone(phone: string): Promise<User | undefined> {
      const normalizedPhone = String(phone || "").trim();
      if (!normalizedPhone) return undefined;
      try {
        const rows = await selectUsersSafe(`where "phone" = $1 limit 1`, [
          normalizedPhone,
        ]);
        const row = (rows[0] as any) || undefined;
        if (!row) return undefined;
        if (row.isDisabled === true) return undefined;
        return row as any;
      } catch (error) {
        console.warn(
          "getUserByPhone safe projection failed, falling back:",
          error,
        );
        const [user] = await db
          .select()
          .from(users)
          .where(
            and(
              eq(users.phone, normalizedPhone),
              or(eq(users.isDisabled, false), isNull(users.isDisabled)),
            ),
          );
        return user;
      }
    },

    async getUserById(id: string): Promise<User | undefined> {
      return this.getUser(id);
    },

    async updateUserType(
      id: string,
      userType:
        | "customer"
        | "restaurant_owner"
        | "food_truck"
        | "host"
        | "event_coordinator"
        | "staff"
        | "admin"
        | "duper_admin"
        | "super_admin",
    ): Promise<User> {
      const SUPER_ADMIN_EMAIL =
        process.env.ADMIN_EMAIL || "info.mealscout@gmail.com";
      const user = await this.getUser(id);
      if (user?.email === SUPER_ADMIN_EMAIL && userType !== "super_admin") {
        throw new Error("Cannot modify super admin account");
      }

      const affiliatePercent =
        userType === "staff" ? 25 : isAdminUserType(userType) ? 0 : undefined;
      const shouldAutoVerify = isAdminUserType(userType);
      const [updatedUser] = await db
        .update(users)
        .set({
          userType,
          ...(affiliatePercent !== undefined ? { affiliatePercent } : {}),
          ...(shouldAutoVerify ? { emailVerified: true } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning({
          id: users.id,
          userType: users.userType,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          emailVerified: users.emailVerified,
          isDisabled: users.isDisabled,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
          stripeCustomerId: users.stripeCustomerId,
          stripeSubscriptionId: users.stripeSubscriptionId,
          affiliatePercent: users.affiliatePercent,
        });
      void syncUserToBrevo(updatedUser).catch(() => {});
      return updatedUser;
    },

    // One shared identity (entry 30): stamp the resolved TradeScout id
    // onto a MealScout user row — the same column and semantics the SSO
    // upsert writes. Called by server/hubIdentityClient.ts after a
    // native signup resolves the shared profile.
    async setUserTradescoutId(id: string, tradescoutId: string): Promise<void> {
      await db
        .update(users)
        .set({ tradescoutId, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async upsertUserByAuth(
      authType: "google" | "email" | "facebook" | "tradescout",
      userData:
        | GoogleUserData
        | EmailUserData
        | FacebookUserData
        | TradeScoutUserData,
      userType: User["userType"] = "customer",
      appContext: "mealscout" | "tradescout" = "mealscout",
    ): Promise<User> {
      try {
        const insertUserType =
          authType === "tradescout"
            ? userType
            : getSafePublicSignupUserType(userType);
        if (authType === "tradescout") {
          const tsData = userData as TradeScoutUserData;
          const normalizedEmail = normalizeEmail(tsData.email);
          let existingUser = await db
            .select()
            .from(users)
            .where(eq(users.tradescoutId, tsData.tradescoutId))
            .limit(1);

          if (existingUser.length > 0) {
            const current = existingUser[0];
            const newAppContext =
              current.appContext && current.appContext !== appContext
                ? "both"
                : appContext;
            const [user] = await db
              .update(users)
              .set({
                email: normalizedEmail ?? current.email,
                // Verify-once (entry 31): stamp the email standing ONLY
                // when the SSO token's email_verified claim is exactly
                // true. An email on the token is not verification, and
                // a silent claim never lowers a standing already held.
                ...(tsData.emailVerified === true
                  ? { emailVerified: true }
                  : {}),
                firstName: tsData.firstName ?? current.firstName,
                lastName: tsData.lastName ?? current.lastName,
                appContext: newAppContext,
                updatedAt: new Date(),
              })
              .where(eq(users.id, current.id))
              .returning();
            void syncUserToBrevo(user).catch(() => {});
            return user;
          }

          if (normalizedEmail) {
            existingUser = await db
              .select()
              .from(users)
              .where(sql`lower(${users.email}) = ${normalizedEmail}`)
              .limit(1);
            if (existingUser.length > 0) {
              const current = existingUser[0];
              const newAppContext =
                current.appContext && current.appContext !== appContext
                  ? "both"
                  : appContext;
              const [user] = await db
                .update(users)
                .set({
                  tradescoutId: tsData.tradescoutId,
                  // Verify-once (entry 31): driven by the token's
                  // email_verified claim, exactly as on the linked-row
                  // update above — never assumed from the email itself.
                  ...(tsData.emailVerified === true
                    ? { emailVerified: true }
                    : {}),
                  firstName: tsData.firstName ?? current.firstName,
                  lastName: tsData.lastName ?? current.lastName,
                  appContext: newAppContext,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, current.id))
                .returning();
              void syncUserToBrevo(user).catch(() => {});
              void recordAuthLinkEvent({
                userId: user.id,
                provider: "tradescout",
                matchedBy: "normalized_email",
                email: normalizedEmail,
              });
              return user;
            }
          }

          const [user] = await db
            .insert(users)
            .values({
              userType: insertUserType,
              tradescoutId: tsData.tradescoutId,
              email: normalizedEmail ?? undefined,
              // Verify-once (entry 31): a first insert records the
              // token's email_verified claim exactly — false when the
              // claim is absent or false, never inferred from the
              // presence of an email address.
              emailVerified: tsData.emailVerified === true,
              firstName: tsData.firstName ?? undefined,
              lastName: tsData.lastName ?? undefined,
              appContext,
            })
            .returning();
          void syncUserToBrevo(user).catch(() => {});
          return user;
        } else if (authType === "google") {
          const googleData = userData as GoogleUserData;
          const normalizedEmail = normalizeEmail(googleData.email);
          let existingUser = await db
            .select()
            .from(users)
            .where(eq(users.googleId, googleData.googleId))
            .limit(1);

          if (existingUser.length > 0) {
            const current = existingUser[0];
            const newAppContext =
              current.appContext && current.appContext !== appContext
                ? "both"
                : appContext;
            const [user] = await db
              .update(users)
              .set({
                email: normalizedEmail,
                emailVerified: true,
                firstName: googleData.firstName,
                lastName: googleData.lastName,
                profileImageUrl: googleData.profileImageUrl,
                googleAccessToken: googleData.googleAccessToken,
                appContext: newAppContext,
                updatedAt: new Date(),
              })
              .where(eq(users.id, existingUser[0].id))
              .returning();
            void syncUserToBrevo(user).catch(() => {});
            return user;
          }

          if (normalizedEmail) {
            existingUser = await db
              .select()
              .from(users)
              .where(sql`lower(${users.email}) = ${normalizedEmail}`)
              .limit(1);
            if (existingUser.length > 0) {
              const current = existingUser[0];
              const newAppContext =
                current.appContext && current.appContext !== appContext
                  ? "both"
                  : appContext;
              const [user] = await db
                .update(users)
                .set({
                  googleId: googleData.googleId,
                  emailVerified: true,
                  firstName: googleData.firstName || existingUser[0].firstName,
                  lastName: googleData.lastName || existingUser[0].lastName,
                  profileImageUrl:
                    googleData.profileImageUrl ||
                    existingUser[0].profileImageUrl,
                  googleAccessToken: googleData.googleAccessToken,
                  appContext: newAppContext,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, existingUser[0].id))
                .returning();
              void syncUserToBrevo(user).catch(() => {});
              void recordAuthLinkEvent({
                userId: user.id,
                provider: "google",
                matchedBy: "normalized_email",
                email: normalizedEmail,
              });
              return user;
            }
          }

          const [user] = await db
            .insert(users)
            .values({
              userType: insertUserType,
              googleId: googleData.googleId,
              email: normalizedEmail,
              emailVerified: true,
              firstName: googleData.firstName,
              lastName: googleData.lastName,
              profileImageUrl: googleData.profileImageUrl,
              googleAccessToken: googleData.googleAccessToken,
              appContext,
            })
            .returning();
          void syncUserToBrevo(user).catch(() => {});
          return user;
        } else if (authType === "facebook") {
          const facebookData = userData as FacebookUserData;
          const normalizedEmail = normalizeEmail(facebookData.email);
          let existingUser = await db
            .select()
            .from(users)
            .where(eq(users.facebookId, facebookData.facebookId))
            .limit(1);

          if (existingUser.length > 0) {
            const current = existingUser[0];
            const newAppContext =
              current.appContext && current.appContext !== appContext
                ? "both"
                : appContext;
            const [user] = await db
              .update(users)
              .set({
                email: normalizedEmail,
                emailVerified: true,
                firstName: facebookData.firstName,
                lastName: facebookData.lastName,
                profileImageUrl: facebookData.profileImageUrl,
                facebookAccessToken: facebookData.facebookAccessToken,
                appContext: newAppContext,
                updatedAt: new Date(),
              })
              .where(eq(users.id, existingUser[0].id))
              .returning();
            void syncUserToBrevo(user).catch(() => {});
            return user;
          }

          if (normalizedEmail) {
            existingUser = await db
              .select()
              .from(users)
              .where(sql`lower(${users.email}) = ${normalizedEmail}`)
              .limit(1);
            if (existingUser.length > 0) {
              const current = existingUser[0];
              const newAppContext =
                current.appContext && current.appContext !== appContext
                  ? "both"
                  : appContext;
              const [user] = await db
                .update(users)
                .set({
                  facebookId: facebookData.facebookId,
                  emailVerified: true,
                  firstName:
                    facebookData.firstName || existingUser[0].firstName,
                  lastName: facebookData.lastName || existingUser[0].lastName,
                  profileImageUrl:
                    facebookData.profileImageUrl ||
                    existingUser[0].profileImageUrl,
                  facebookAccessToken: facebookData.facebookAccessToken,
                  appContext: newAppContext,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, existingUser[0].id))
                .returning();
              void syncUserToBrevo(user).catch(() => {});
              void recordAuthLinkEvent({
                userId: user.id,
                provider: "facebook",
                matchedBy: "normalized_email",
                email: normalizedEmail,
              });
              return user;
            }
          }

          const [user] = await db
            .insert(users)
            .values({
              userType: insertUserType,
              facebookId: facebookData.facebookId,
              email: normalizedEmail,
              emailVerified: true,
              firstName: facebookData.firstName,
              lastName: facebookData.lastName,
              profileImageUrl: facebookData.profileImageUrl,
              facebookAccessToken: facebookData.facebookAccessToken,
              appContext,
            })
            .returning();
          void syncUserToBrevo(user).catch(() => {});
          return user;
        } else {
          const emailData = userData as EmailUserData;
          const normalizedEmail = normalizeEmail(emailData.email);
          const [user] = await db
            .insert(users)
            .values({
              userType: insertUserType,
              email: normalizedEmail,
              firstName: emailData.firstName,
              lastName: emailData.lastName,
              phone: emailData.phone,
              passwordHash: emailData.passwordHash,
              emailVerified: false,
              appContext,
            })
            .returning();
          void syncUserToBrevo(user).catch(() => {});
          return user;
        }
      } catch (error: any) {
        if (isUniqueViolation(error)) {
          if (authType === "tradescout") {
            const tsData = userData as TradeScoutUserData;
            const normalizedEmail = normalizeEmail(tsData.email);
            const existingUser = await db
              .select()
              .from(users)
              .where(
                normalizedEmail
                  ? or(
                      eq(users.tradescoutId, tsData.tradescoutId),
                      sql`lower(${users.email}) = ${normalizedEmail}`,
                    )
                  : eq(users.tradescoutId, tsData.tradescoutId),
              )
              .limit(1);
            if (existingUser.length > 0) {
              const current = existingUser[0];
              const [user] = await db
                .update(users)
                .set({
                  tradescoutId: tsData.tradescoutId,
                  email: normalizedEmail ?? current.email,
                  // Verify-once (entry 31): same claim-driven rule as
                  // the primary update paths — the unique-violation
                  // recovery must not stamp what the claim never said.
                  ...(tsData.emailVerified === true
                    ? { emailVerified: true }
                    : {}),
                  firstName: tsData.firstName ?? current.firstName,
                  lastName: tsData.lastName ?? current.lastName,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, current.id))
                .returning();
              void syncUserToBrevo(user).catch(() => {});
              void recordAuthLinkEvent({
                userId: user.id,
                provider: "tradescout",
                matchedBy: "duplicate_key",
                email: normalizedEmail,
              });
              return user;
            }
          } else if (authType === "google") {
            const googleData = userData as GoogleUserData;
            const normalizedEmail = normalizeEmail(googleData.email);
            const existingUser = await db
              .select()
              .from(users)
              .where(
                normalizedEmail
                  ? or(
                      eq(users.googleId, googleData.googleId),
                      sql`lower(${users.email}) = ${normalizedEmail}`,
                    )
                  : eq(users.googleId, googleData.googleId),
              )
              .limit(1);
            if (existingUser.length > 0) {
              const [user] = await db
                .update(users)
                .set({
                  googleId: googleData.googleId,
                  email: normalizedEmail,
                  emailVerified: true,
                  firstName: googleData.firstName,
                  lastName: googleData.lastName,
                  profileImageUrl: googleData.profileImageUrl,
                  googleAccessToken: googleData.googleAccessToken,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, existingUser[0].id))
                .returning();
              void syncUserToBrevo(user).catch(() => {});
              void recordAuthLinkEvent({
                userId: user.id,
                provider: "google",
                matchedBy: "duplicate_key",
                email: normalizedEmail,
              });
              return user;
            }
          } else if (authType === "facebook") {
            const facebookData = userData as FacebookUserData;
            const normalizedEmail = normalizeEmail(facebookData.email);
            const existingUser = await db
              .select()
              .from(users)
              .where(
                normalizedEmail
                  ? or(
                      eq(users.facebookId, facebookData.facebookId),
                      sql`lower(${users.email}) = ${normalizedEmail}`,
                    )
                  : eq(users.facebookId, facebookData.facebookId),
              )
              .limit(1);
            if (existingUser.length > 0) {
              const [user] = await db
                .update(users)
                .set({
                  facebookId: facebookData.facebookId,
                  email: normalizedEmail,
                  emailVerified: true,
                  firstName: facebookData.firstName,
                  lastName: facebookData.lastName,
                  profileImageUrl: facebookData.profileImageUrl,
                  facebookAccessToken: facebookData.facebookAccessToken,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, existingUser[0].id))
                .returning();
              void syncUserToBrevo(user).catch(() => {});
              void recordAuthLinkEvent({
                userId: user.id,
                provider: "facebook",
                matchedBy: "duplicate_key",
                email: normalizedEmail,
              });
              return user;
            }
          }
        }
        throw error;
      }
    },

    async getAllUsers(): Promise<User[]> {
      try {
        const { columns } = await getUserTableInfo();
        const hasDisabled = columns.size === 0 || columns.has("is_disabled");
        const whereSql = hasDisabled
          ? `where coalesce("is_disabled"::boolean, false) = false`
          : "";
        return (await selectUsersSafe(
          `${whereSql} order by "created_at" desc`,
          [],
        )) as any;
      } catch (error) {
        console.warn(
          "getAllUsers safe projection failed, falling back:",
          error,
        );
        return await db
          .select()
          .from(users)
          .where(or(eq(users.isDisabled, false), isNull(users.isDisabled)))
          .orderBy(desc(users.createdAt));
      }
    },

    async updateUserStatus(userId: string, isActive: boolean): Promise<void> {
      await db
        .update(users)
        .set({ isDisabled: !isActive })
        .where(eq(users.id, userId));
    },

    async createUserManually(userData: {
      email: string;
      firstName: string;
      lastName: string;
      phone: string;
      userType: string;
      tempPassword: string;
    }): Promise<User> {
      const hashedPassword = await bcrypt.hash(userData.tempPassword, 10);
      const normalizedEmail = normalizeEmail(userData.email);
      if (!normalizedEmail) {
        throw new Error("Email is required");
      }
      const affiliatePercent =
        userData.userType === "staff"
          ? 25
          : isAdminUserType(userData.userType)
            ? 0
            : undefined;

      let user: User;
      try {
        const [created] = await db
          .insert(users)
          .values({
            email: normalizedEmail,
            firstName: userData.firstName,
            lastName: userData.lastName,
            phone: userData.phone,
            userType: userData.userType,
            passwordHash: hashedPassword,
            mustResetPassword: true,
            emailVerified: true,
            ...(affiliatePercent !== undefined ? { affiliatePercent } : {}),
          })
          .returning();
        user = created;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await this.getUserByEmail(normalizedEmail);
        if (!existing) throw error;
        const [updated] = await db
          .update(users)
          .set({
            firstName: userData.firstName || existing.firstName,
            lastName: userData.lastName || existing.lastName,
            phone: userData.phone || existing.phone,
            userType: isAdminUserType(userData.userType)
              ? existing.userType
              : userData.userType,
            passwordHash: hashedPassword,
            mustResetPassword: true,
            emailVerified: true,
            ...(affiliatePercent !== undefined ? { affiliatePercent } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id))
          .returning();
        user = updated;
        void recordAuthLinkEvent({
          userId: user.id,
          provider: "manual",
          matchedBy: "duplicate_key",
          email: normalizedEmail,
        });
      }

      if (shouldAssignAffiliateTag(user.userType)) {
        ensureAffiliateTag(user.id).catch((error) =>
          console.error("[affiliate] Failed to assign tag:", error),
        );
      }

      void syncUserToBrevo(user).catch(() => {});
      return user;
    },

    async createUserInvite(data: {
      email: string;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
      userType:
        | "customer"
        | "restaurant_owner"
        | "food_truck"
        | "host"
        | "event_coordinator"
        | "staff"
        | "admin"
        | "duper_admin"
        | "super_admin";
    }): Promise<User> {
      const affiliatePercent =
        data.userType === "staff"
          ? 25
          : isAdminUserType(data.userType)
            ? 0
            : undefined;
      const shouldAutoVerify = isAdminUserType(data.userType);
      const normalizedEmail = normalizeEmail(data.email);
      if (!normalizedEmail) {
        throw new Error("Email is required");
      }

      let user: User;
      try {
        const [created] = await db
          .insert(users)
          .values({
            email: normalizedEmail,
            firstName: data.firstName,
            lastName: data.lastName,
            phone: data.phone,
            userType: data.userType,
            passwordHash: null,
            mustResetPassword: false,
            emailVerified: shouldAutoVerify,
            ...(affiliatePercent !== undefined ? { affiliatePercent } : {}),
          })
          .returning();
        user = created;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await this.getUserByEmail(normalizedEmail);
        if (!existing) throw error;
        const [updated] = await db
          .update(users)
          .set({
            firstName: data.firstName || existing.firstName,
            lastName: data.lastName || existing.lastName,
            phone: data.phone || existing.phone,
            userType: isAdminUserType(data.userType)
              ? existing.userType
              : data.userType,
            emailVerified: shouldAutoVerify ? true : existing.emailVerified,
            ...(affiliatePercent !== undefined ? { affiliatePercent } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id))
          .returning();
        user = updated;
        void recordAuthLinkEvent({
          userId: user.id,
          provider: "invite",
          matchedBy: "duplicate_key",
          email: normalizedEmail,
        });
      }

      if (shouldAssignAffiliateTag(user.userType)) {
        ensureAffiliateTag(user.id).catch((error) =>
          console.error("[affiliate] Failed to assign tag:", error),
        );
      }

      void syncUserToBrevo(user).catch(() => {});
      return user;
    },
  };
}
