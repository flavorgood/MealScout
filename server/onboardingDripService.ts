/**
 * onboardingDripService.ts
 *
 * Automated post-signup email drip for new customer-type users.
 *
 * Day 3 email: "Find your next deal" — discovery nudge.
 * Day 7 email: "Find deals near you this week" — content-discovery nudge.
 *
 * Runs via daily cron (3:00 AM). Idempotency via telemetryEvents per user per step.
 * Respects accountSettings.notifications.channels.email opt-out.
 */

import { db } from "./db";
import { users, telemetryEvents, userAddresses } from "@shared/schema";
import { and, eq, gte, lte, sql, isNotNull } from "drizzle-orm";
import { emailService } from "./emailService";
import {
  areAutomatedMarketingEmailsEnabled,
  describeAutomatedMarketingEmailFlag,
} from "./utils/marketingEmailWindow";

type NotifPrefs = {
  notifications?: {
    channels?: { email?: boolean };
  };
};

function isEmailEnabled(user: { accountSettings?: unknown }): boolean {
  const s = user.accountSettings as NotifPrefs | undefined;
  if (!s || typeof s !== "object") return true;
  if (s.notifications?.channels?.email === false) return false;
  return true;
}

async function alreadySent(userId: string, step: string): Promise<boolean> {
  const existing = await db.query.telemetryEvents.findFirst({
    where: and(
      eq(telemetryEvents.eventName, "onboarding_drip_sent"),
      eq(telemetryEvents.userId, userId),
      sql`properties->>'step' = ${step}`,
    ),
  });
  return Boolean(existing);
}

async function markSent(userId: string, step: string): Promise<void> {
  await db.insert(telemetryEvents).values({
    eventName: "onboarding_drip_sent",
    userId,
    properties: { step },
  });
}

export class OnboardingDripService {
  private static instance: OnboardingDripService;

  private constructor() {}

  static getInstance(): OnboardingDripService {
    if (!OnboardingDripService.instance) {
      OnboardingDripService.instance = new OnboardingDripService();
    }
    return OnboardingDripService.instance;
  }

  async run(): Promise<{
    day3Sent: number;
    day7Sent: number;
    errors: number;
    skippedDisabled?: boolean;
  }> {
    if (!areAutomatedMarketingEmailsEnabled()) {
      console.log(
        `[OnboardingDrip] skipped: automated marketing emails disabled (${describeAutomatedMarketingEmailFlag()} set)`,
      );
      return { day3Sent: 0, day7Sent: 0, errors: 0, skippedDisabled: true };
    }
    console.log("[OnboardingDrip] Running post-signup drip...");
    const now = new Date();
    let day3Sent = 0;
    let day7Sent = 0;
    let errors = 0;

    // Day-3 window: created 3–4 days ago
    const day3Start = new Date(now.getTime() - 4 * 86_400_000);
    const day3End = new Date(now.getTime() - 3 * 86_400_000);

    // Day-7 window: created 7–8 days ago
    const day7Start = new Date(now.getTime() - 8 * 86_400_000);
    const day7End = new Date(now.getTime() - 7 * 86_400_000);

    // Fetch customers created in either window
    const candidates = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        accountSettings: users.accountSettings,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        and(
          eq(users.userType, "customer"),
          gte(users.createdAt, day7Start),
          lte(users.createdAt, day3End),
        ),
      );

    for (const user of candidates) {
      const email = String(user.email || "").trim();
      if (!email) continue;
      if (!isEmailEnabled({ accountSettings: user.accountSettings })) continue;

      const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;

      // Day 3 window check
      if (createdAt >= day3Start.getTime() && createdAt < day3End.getTime()) {
        if (!(await alreadySent(user.id, "day3_referral"))) {
          try {
            await this.sendDay3ReferralEmail(
              email,
              user.firstName,
            );
            await markSent(user.id, "day3_referral");
            day3Sent++;
          } catch (err) {
            console.error(`[OnboardingDrip] day3 failed for ${email}:`, err);
            errors++;
          }
        }
      }

      // Day 7 window check
      if (createdAt >= day7Start.getTime() && createdAt < day7End.getTime()) {
        if (!(await alreadySent(user.id, "day7_discovery"))) {
          try {
            await this.sendDay7DiscoveryEmail(email, user.firstName, user.id);
            await markSent(user.id, "day7_discovery");
            day7Sent++;
          } catch (err) {
            console.error(`[OnboardingDrip] day7 failed for ${email}:`, err);
            errors++;
          }
        }
      }
    }

    console.log(
      `[OnboardingDrip] Done. Day3=${day3Sent} Day7=${day7Sent} Errors=${errors}`,
    );
    return { day3Sent, day7Sent, errors };
  }

  private async sendDay3ReferralEmail(
    to: string,
    firstName: string | null,
  ): Promise<boolean> {
    const name = firstName || "Food Explorer";
    const scoutUrl = "https://www.mealscout.us/scout";
    const dealsUrl = "https://www.mealscout.us/search";
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Find New Deals</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f8f9fa;color:#333;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#ff6b35 0%,#f7931e 100%);color:#fff;padding:30px 40px;text-align:center;">
      <h1 style="margin:0;font-size:28px;">🍽️ MealScout</h1>
      <div style="margin:8px 0 0;font-size:16px;opacity:0.9;">Discover Amazing Food Deals</div>
    </div>
    <div style="padding:40px;">
      <h2 style="color:#ff6b35;font-size:24px;margin:0 0 16px;">Fresh deals are waiting this week 🔥</h2>
      <p>Hey ${name}!</p>
      <p>You've been with MealScout for a few days now. New restaurants and food trucks post limited-time deals throughout the week.</p>
      <p>Scout to see what is active right now, or jump straight into search to browse current offers.</p>
      <div style="text-align:center;margin:30px 0;">
        <a href="${scoutUrl}" style="background:linear-gradient(135deg,#ff6b35 0%,#f7931e 100%);color:white;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;">Scout</a>
      </div>
      <p style="text-align:center;margin-top:0;">
        <a href="${dealsUrl}" style="color:#ff6b35;text-decoration:underline;">Browse all current deals</a>
      </p>
      <p style="font-size:13px;color:#999;">To unsubscribe, update your <a href="https://www.mealscout.us/profile" style="color:#ff6b35;">notification settings</a>.</p>
    </div>
    <div style="background:#f8f9fa;padding:20px 40px;text-align:center;border-top:1px solid #e9ecef;font-size:13px;color:#666;">
      <p style="margin:0;">© 2025 MealScout. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
    const text = `Hey ${name}! Fresh deals are posted all week on MealScout. Scout: ${scoutUrl} or browse deals: ${dealsUrl}`;
    return emailService.sendBasicEmail(
      to,
      "🍽️ Fresh MealScout deals this week",
      html,
      text,
      "marketing",
    );
  }

  private async sendDay7DiscoveryEmail(
    to: string,
    firstName: string | null,
    userId: string,
  ): Promise<boolean> {
    const name = firstName || "Food Explorer";

    // Get city from user's default address if available
    let cityLabel = "your area";
    try {
      const [addr] = await db
        .select({ city: userAddresses.city, state: userAddresses.state })
        .from(userAddresses)
        .where(
          and(
            eq(userAddresses.userId, userId),
            eq(userAddresses.isDefault, true),
          ),
        )
        .limit(1);
      if (addr?.city) {
        cityLabel = addr.state ? `${addr.city}, ${addr.state}` : addr.city;
      }
    } catch {
      /* non-fatal */
    }

    const searchUrl = `https://www.mealscout.us/search?q=${encodeURIComponent(cityLabel + " food trucks deals")}`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Find Deals Near You</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f8f9fa;color:#333;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#ff6b35 0%,#f7931e 100%);color:#fff;padding:30px 40px;text-align:center;">
      <h1 style="margin:0;font-size:28px;">🍽️ MealScout</h1>
      <div style="margin:8px 0 0;font-size:16px;opacity:0.9;">Discover Amazing Food Deals</div>
    </div>
    <div style="padding:40px;">
      <h2 style="color:#ff6b35;font-size:24px;margin:0 0 16px;">New deals in ${cityLabel} this week 🔥</h2>
      <p>Hey ${name}!</p>
      <p>It's been a week since you joined MealScout. Local restaurants and food trucks post new deals every week — here's the fastest way to find what's active near you right now.</p>
      <div style="text-align:center;margin:30px 0;">
        <a href="${searchUrl}" style="background:linear-gradient(135deg,#ff6b35 0%,#f7931e 100%);color:white;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;">Find Deals Near Me</a>
      </div>
      <p>You can also <a href="https://www.mealscout.us/scout" style="color:#ff6b35;">scout</a> to see active food trucks, menus, deals, and local food activity.</p>
      <p style="font-size:13px;color:#999;">To unsubscribe, update your <a href="https://www.mealscout.us/profile" style="color:#ff6b35;">notification settings</a>.</p>
    </div>
    <div style="background:#f8f9fa;padding:20px 40px;text-align:center;border-top:1px solid #e9ecef;font-size:13px;color:#666;">
      <p style="margin:0;">© 2025 MealScout. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
    const text = `Hey ${name}! New deals in ${cityLabel} this week. Find them: ${searchUrl} — or scout: https://www.mealscout.us/scout`;
    return emailService.sendBasicEmail(
      to,
      `🔥 New deals in ${cityLabel} this week`,
      html,
      text,
      "marketing",
    );
  }
}

export const onboardingDripService = OnboardingDripService.getInstance();
