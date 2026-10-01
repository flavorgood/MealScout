import { runNativeOwnerSourceReviews } from "../services/ownerAiNativeProfiles";
import { summarizeOwnerAiSourceReviewReasons } from "../services/ownerAiSourceReviews";
import { sourceCheckDay } from "../services/publicProfileSourceChecks";
/**
 * registerSchedulers.ts
 *
 * Central home for all cron / recurring-job wiring.
 * Extracted from server/routes.ts as part of backend refactor Phase 1.
 *
 * Rule: no Express route registration here — only scheduler setup.
 * Each scheduler imports its own domain service lazily to keep startup fast.
 */

import type { Express } from "express";
import cron from "node-cron";
import { publicSourceCheckSchedule, runPublicProfileSourceChecks } from "../services/publicProfileSourceChecks";
import { ownerAiSourceReviewSchedule, runOwnerAiSourceReviews } from "../services/ownerAiSourceReviews";
import { DigestService } from "../digestService";
import { DinerDigestService } from "../dinerDigestService";
import { OnboardingDripService } from "../onboardingDripService";
import { RestaurantActivationService } from "../restaurantActivationService";
import { notifyUnbookedEvents } from "../eventNotificationCron";
import { remindIncompleteParkingPassHosts } from "../parkingPassReminder";
import { runLocationDemandActivationCron } from "../services/locationDemandActivation";
import { runSupplyMarketIntelCron } from "../services/supplyMarketIntel";
import { runHostPartnerLeadDripCron } from "../services/hostPartnerLeadDrip";
import { runSocialQueueProcessor } from "../services/socialQueueProcessor";
import { submitIndexNowUrls, getIndexNowConfig } from "../services/indexNow";
import { registerStoryCronJobs } from "../storiesCronJobs";
import { registerFeaturedVideoCronJobs } from "../featuredVideoCron";
import {
  MARKETING_EMAIL_TIMEZONE,
  MARKETING_EMAIL_WINDOW_END_HOUR,
  MARKETING_EMAIL_WINDOW_START_HOUR,
  areAutomatedMarketingEmailsEnabled,
  describeAutomatedMarketingEmailFlag,
  isWithinMarketingEmailWindow,
} from "../utils/marketingEmailWindow";
import { db } from "../db";
import { requestLogs, adminDailyReports } from "@shared/schema";
import { and, gte, lt, desc, or, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMissingColumnError(err: unknown, column: string): boolean {
  const msg = String((err as any)?.message || "");
  return (
    msg.includes(column) &&
    (msg.includes("does not exist") || msg.includes("Unknown column"))
  );
}

const getParkingPassHoldTtlMs = () => {
  const raw = Number(process.env.PARKING_PASS_HOLD_TTL_MINUTES ?? 7);
  const minutes = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 60)) : 7;
  return minutes * 60 * 1000;
};

const SCHEDULER_TIMEZONE = MARKETING_EMAIL_TIMEZONE;

function scheduleCron(expression: string, task: () => void | Promise<void>) {
  return cron.schedule(expression, task, { timezone: SCHEDULER_TIMEZONE });
}

function shouldRunMarketingEmailJobs(now = new Date()): boolean {
  return isWithinMarketingEmailWindow(now);
}

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

export async function registerSchedulers(app: Express): Promise<void> {
  const sourceReviews = ownerAiSourceReviewSchedule();
  try { console.info("[official-source-review-reasons] receipts", await summarizeOwnerAiSourceReviewReasons(sourceCheckDay(new Date()))); }
  catch { console.error("[official-source-review-reasons] receipt aggregate unavailable; no customer content changed"); }
  console.info("[official-source-reviews] scheduled", sourceReviews);
  cron.schedule(sourceReviews.expression, async () => {
    try { const run = await runOwnerAiSourceReviews(); console.info("[official-source-reviews] completed", { day: run.day, profiles: run.results.length, proposals: run.results.filter(r => r.status === "proposal_ready").length, held: run.results.filter(r => r.status.startsWith("held")).length, publishes: false, createsOwnerDrafts: false });
      const native = await runNativeOwnerSourceReviews(); console.info("[native-official-source-reviews] completed", { day: native.day, profiles: native.results.length, proposals: native.results.filter(r => r.status === "proposal_ready").length, held: native.results.filter(r => r.status.startsWith("held")).length, publishes: false, createsOwnerDrafts: false });
      console.info("[official-source-review-reasons] receipts", await summarizeOwnerAiSourceReviewReasons(run.day)); }
    catch { console.error("[official-source-reviews] failed; no owner approval or canonical changes"); }
  }, { timezone: sourceReviews.timezone });
  const sourceChecks = publicSourceCheckSchedule();
  console.info("[public-source-checks] scheduled", sourceChecks);
  cron.schedule(sourceChecks.expression, async () => {
    try { console.info("[public-source-checks] completed", await runPublicProfileSourceChecks()); }
    catch { console.error("[public-source-checks] failed; no profile changes published"); }
  }, { timezone: sourceChecks.timezone });
  console.log(
    `[schedulers] timezone=${SCHEDULER_TIMEZONE} marketing_email_window=${MARKETING_EMAIL_WINDOW_START_HOUR}:00-${MARKETING_EMAIL_WINDOW_END_HOUR}:00`,
  );
  if (!areAutomatedMarketingEmailsEnabled()) {
    console.log(
      `[schedulers] automated marketing/drip emails disabled (${describeAutomatedMarketingEmailFlag()} not set)`,
    );
  }

  // Story cleanup and level recalculation
  registerStoryCronJobs(app);

  // Featured video cron endpoint
  await registerFeaturedVideoCronJobs(app);

  // Weekly Digest — Monday 8:00 AM
  scheduleCron("0 8 * * 1", async () => {
    if (!shouldRunMarketingEmailJobs()) return;
    console.log("⏰ Triggering Weekly Digest Cron Job");
    try {
      await DigestService.getInstance().sendWeeklyDigests();
      console.log("✅ Weekly Digest Cron Job Completed");
    } catch (error) {
      console.error("❌ Weekly Digest Cron Job Failed:", error);
    }
  });

  // Monthly profile activity summary — 1st of the month, 8:30 AM.
  scheduleCron("30 8 1 * *", async () => {
    if (!areAutomatedMarketingEmailsEnabled() || !shouldRunMarketingEmailJobs()) {
      return;
    }
    console.log("⏰ Triggering Profile Activity Monthly Summary Cron");
    try {
      const { users, restaurants } = await import(
        "@shared/schema",
      );
      const { and, eq, isNotNull, inArray } = await import("drizzle-orm");
      const { emailService } = await import("../emailService");
      const { telemetryEvents } = await import("@shared/schema");
      // Profile activity summaries are available to every active business
      // profile and never depend on legacy subscription rows.
      const activeProfiles = await db
        .selectDistinct({ userId: restaurants.ownerId })
        .from(restaurants)
        .where(
          and(
            eq(restaurants.isActive, true),
            isNotNull(restaurants.ownerId),
          ),
        );
      const activeUserIds = activeProfiles
        .map((r: { userId: string | null }) => String(r.userId || "").trim())
        .filter(Boolean);
      if (activeUserIds.length === 0) {
        console.log("[profile-monthly] No active business profiles — skipping");
        return;
      }
      const activeUsers = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName, accountSettings: users.accountSettings })
        .from(users)
        .where(
          and(
            inArray(users.id, activeUserIds),
            eq(users.isDisabled, false),
          ),
        );
      const now = new Date();
      // Cron fires on the 1st, so "this month" is the just-completed month.
      const idempotencyKey = `${now.getFullYear()}-M${String(now.getMonth() + 1).padStart(2, "0")}`;
      let sentCount = 0;
      let skippedCount = 0;
      for (const user of activeUsers) {
        const email = String(user.email || "").trim();
        if (!email) { skippedCount++; continue; }
        // Respect opt-out
        const settings = user.accountSettings as any;
        if (settings?.notifications?.channels?.email === false ||
            settings?.notifications?.topics?.profileActivitySummary !== true) {
          skippedCount++; continue;
        }
        // Idempotency check
        const alreadySent = await db.query.telemetryEvents.findFirst({
          where: and(
            eq(telemetryEvents.eventName, "premium_summary_auto_emailed"),
            eq(telemetryEvents.userId, user.id),
            sql`properties->>'period' = ${idempotencyKey}`,
          ),
        });
        if (alreadySent) { skippedCount++; continue; }
        // Build summary inline (same logic as buildProfileActivitySummary)
        try {
          const { restaurants: restaurantsTable, truckManualSchedules, truckParkingReports } = await import("@shared/schema");
          // Full previous calendar month (cron runs on the 1st).
          const windowStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          windowStart.setHours(0, 0, 0, 0);
          const ownedRestaurants = await db
            .select({ id: restaurantsTable.id })
            .from(restaurantsTable)
            .where(eq(restaurantsTable.ownerId, user.id));
          const restaurantIds = ownedRestaurants.map((r: { id: string }) => r.id);
          if (restaurantIds.length === 0) { skippedCount++; continue; }
          const [manualSchedules, parkingReports, liveLocEvents] = await Promise.all([
            db.select({ id: truckManualSchedules.id, date: truckManualSchedules.date, address: truckManualSchedules.address })
              .from(truckManualSchedules)
              .where(and(inArray(truckManualSchedules.truckId, restaurantIds), gte(truckManualSchedules.createdAt, windowStart))),
            db.select({ id: truckParkingReports.id, date: truckParkingReports.date, address: truckParkingReports.address, locationName: truckParkingReports.locationName })
              .from(truckParkingReports)
              .where(and(inArray(truckParkingReports.truckId, restaurantIds), gte(truckParkingReports.createdAt, windowStart))),
            db.select({ id: telemetryEvents.id })
              .from(telemetryEvents)
              .where(and(eq(telemetryEvents.eventName, "premium_live_location_used"), eq(telemetryEvents.userId, user.id), gte(telemetryEvents.createdAt, windowStart))),
          ]);
          const stopKeys = new Set<string>();
          for (const s of manualSchedules) stopKeys.add(`${s.date?.toISOString().split("T")[0]}:${s.address}`);
          for (const r of parkingReports) stopKeys.add(`${r.date?.toISOString().split("T")[0]}:${r.address || r.locationName}`);
          const operatorName = String(user.firstName || "").trim() || "MealScout operator";
          await emailService.sendProfileActivitySummaryEmail(email, operatorName, {
            weekStart: windowStart.toLocaleDateString(),
            weekEnd: now.toLocaleDateString(),
            stopsCovered: stopKeys.size,
            liveLocationActivations: liveLocEvents.length,
            manualScheduleUsage: manualSchedules.length,
            parkingReportsCompleted: parkingReports.length,
            period: "month",
          });
          await db.insert(telemetryEvents).values({
            eventName: "premium_summary_auto_emailed",
            userId: user.id,
            properties: { period: idempotencyKey, stopsCovered: stopKeys.size },
          });
          sentCount++;
        } catch (userError) {
          console.error(`[profile-monthly] Failed for user ${user.id}:`, userError);
          skippedCount++;
        }
      }
      console.log(`✅ Profile Monthly Summary: sent=${sentCount} skipped=${skippedCount}`);
    } catch (error) {
      console.error("❌ Profile Monthly Summary Cron Failed:", error);
    }
  });

  // Diner Deals Digest — Wednesday 9:00 AM
  scheduleCron("0 9 * * 3", async () => {
    if (!shouldRunMarketingEmailJobs()) return;
    console.log("⏰ Triggering Diner Deals Digest");
    try {
      const stats = await DinerDigestService.getInstance().sendDinerDigests();
      console.log("✅ Diner Deals Digest Completed:", stats);
    } catch (error) {
      console.error("❌ Diner Deals Digest Failed:", error);
    }
  });

  // Post-signup onboarding drip — daily 10:00 AM local time
  scheduleCron("0 10 * * *", async () => {
    if (!shouldRunMarketingEmailJobs()) return;
    try {
      const stats = await OnboardingDripService.getInstance().run();
      if ((stats as any).skippedDisabled) {
        return;
      }
      if (stats.day3Sent + stats.day7Sent > 0) {
        console.log("[onboarding-drip] sent:", stats);
      }
    } catch (error) {
      console.error("❌ Onboarding Drip Failed:", error);
    }
  });

  // Restaurant deal-creation nudge — daily 10:30 AM local time
  scheduleCron("30 10 * * *", async () => {
    if (!shouldRunMarketingEmailJobs()) return;
    try {
      const stats = await RestaurantActivationService.getInstance().run();
      if (stats.nudge7Sent + stats.nudge14Sent > 0) {
        console.log("[restaurant-activation] sent:", stats);
      }
    } catch (error) {
      console.error("❌ Restaurant Activation Nudge Failed:", error);
    }
  });

  // Pensacola food truck onboarding/upsell drip — every 30 min (feature-flagged)
  if (
    String(process.env.PENSACOLA_FOOD_TRUCK_DRIP_ENABLED || "")
      .trim()
      .toLowerCase() === "true"
  ) {
    scheduleCron("*/30 * * * *", async () => {
      if (!shouldRunMarketingEmailJobs()) return;
      try {
        const { runPensacolaFoodTruckDripCron } =
          await import("../services/pensacolaFoodTruckDrip");
        const result = await runPensacolaFoodTruckDripCron();
        if ((result as any)?.sent) {
          console.log("[drip] Pensacola food truck sequence sent:", result);
        }
      } catch (error) {
        console.error("[drip] Pensacola food truck sequence failed:", error);
      }
    });
  }

  // Location demand activation — every 30 min (configurable, on by default)
  if (
    String(process.env.LOCATION_DEMAND_ACTIVATION_ENABLED || "true")
      .trim()
      .toLowerCase() !== "false"
  ) {
    const expression = String(
      process.env.LOCATION_DEMAND_ACTIVATION_CRON || "*/30 * * * *",
    );
    scheduleCron(expression, async () => {
      if (!shouldRunMarketingEmailJobs()) return;
      try {
        const stats = await runLocationDemandActivationCron();
        if (Number((stats as any)?.sent || 0) > 0) {
          console.log("[location-demand-activation] sent", stats);
        }
      } catch (error) {
        console.error("[location-demand-activation] cron failed:", error);
      }
    });
  }

  // Supply market intel refresh — creates localized snapshots + alerts and emits LISA-compatible lane claims.
  if (
    String(process.env.SUPPLY_MARKET_INTEL_ENABLED || "true")
      .trim()
      .toLowerCase() !== "false"
  ) {
    const expression = String(
      process.env.SUPPLY_MARKET_INTEL_CRON || "*/20 * * * *",
    );
    scheduleCron(expression, async () => {
      try {
        const stats = await runSupplyMarketIntelCron();
        if (Number((stats as any)?.alertsCreated || 0) > 0) {
          console.log("[supply-market-intel] alerts generated", stats);
        }
      } catch (error) {
        console.error("[supply-market-intel] cron failed:", error);
      }
    });
  }

  // Pensacola report lead drip — every 30 min (feature-flagged)
  if (
    String(process.env.PENSACOLA_REPORT_ENABLED || "")
      .trim()
      .toLowerCase() === "true"
  ) {
    scheduleCron("*/30 * * * *", async () => {
      if (!shouldRunMarketingEmailJobs()) return;
      try {
        const { runPensacolaReportLeadDripCron } =
          await import("../services/pensacolaReportDrip");
        const result = await runPensacolaReportLeadDripCron();
        if ((result as any)?.sent) {
          console.log("[drip] Pensacola report lead sequence sent:", result);
        }
      } catch (error) {
        console.error("[drip] Pensacola report lead sequence failed:", error);
      }
    });
  }

  // Host partner lead drip — every 30 min (feature-flagged, enabled by default)
  if (
    String(process.env.HOST_PARTNER_DRIP_ENABLED || "true")
      .trim()
      .toLowerCase() !== "false"
  ) {
    scheduleCron("*/30 * * * *", async () => {
      if (!shouldRunMarketingEmailJobs()) return;
      try {
        const result = await runHostPartnerLeadDripCron();
        if ((result as any)?.sent) {
          console.log("[drip] Host partner lead sequence sent:", result);
        }
      } catch (error) {
        console.error("[drip] Host partner lead sequence failed:", error);
      }
    });
  }

  // Parking Pass completion reminders — 1st of each month at 9:00 AM
  scheduleCron("0 9 1 * *", async () => {
    console.log("⏰ Triggering Parking Pass Completion Reminders");
    try {
      const stats = await remindIncompleteParkingPassHosts();
      console.log("✅ Parking Pass Completion Reminders Completed:", stats);
    } catch (error) {
      console.error("❌ Parking Pass Completion Reminders Failed:", error);
    }
  });

  // Social post queue processor — every 10 minutes (enabled by default)
  if (
    String(process.env.SOCIAL_QUEUE_PROCESSOR_ENABLED || "true")
      .trim()
      .toLowerCase() !== "false"
  ) {
    const expression = String(
      process.env.SOCIAL_QUEUE_PROCESSOR_CRON || "*/10 * * * *",
    );
    scheduleCron(expression, async () => {
      try {
        const stats = await runSocialQueueProcessor(
          Number(process.env.SOCIAL_QUEUE_PROCESSOR_BATCH || 25),
        );
        if (stats.attempted > 0) {
          console.log("[social-queue] processed:", stats);
        }
      } catch (error) {
        console.error("[social-queue] processor failed:", error);
      }
    });
  }

  // Notify unbooked events — hourly (growth/lead-gen outreach to trucks)
  scheduleCron("0 * * * *", async () => {
    if (!shouldRunMarketingEmailJobs()) return;
    try {
      const stats = await notifyUnbookedEvents();
      if ((stats as any)?.sent > 0) {
        console.log("[event-notifications] unbooked events notified:", stats);
      }
    } catch (error) {
      console.error("[event-notifications] failed:", error);
    }
  });

  // Daily request log summary — 6:05 AM
  scheduleCron("5 6 * * *", async () => {
    try {
      const end = new Date();
      end.setMinutes(0, 0, 0);
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

      const [totals] = await db
        .select({
          total: sql<number>`count(*)`,
          uniqueUsers: sql<number>`count(distinct ${requestLogs.userId})`,
          avgDurationMs: sql<number>`avg(${requestLogs.durationMs})`,
        })
        .from(requestLogs)
        .where(
          and(
            gte(requestLogs.createdAt, start),
            lt(requestLogs.createdAt, end),
          ),
        );

      const statusBuckets: Array<{ statusCode: number; count: number }> =
        await db
          .select({
            statusCode: requestLogs.statusCode,
            count: sql<number>`count(*)`,
          })
          .from(requestLogs)
          .where(
            and(
              gte(requestLogs.createdAt, start),
              lt(requestLogs.createdAt, end),
            ),
          )
          .groupBy(requestLogs.statusCode)
          .orderBy(desc(sql`count(*)`));

      let topPaths: Array<{
        path: string;
        count: number;
        avgDurationMs: number;
      }> = [];
      try {
        topPaths = await db
          .select({
            path: requestLogs.path,
            count: sql<number>`count(*)`,
            avgDurationMs: sql<number>`avg(${requestLogs.durationMs})`,
          })
          .from(requestLogs)
          .where(
            and(
              gte(requestLogs.createdAt, start),
              lt(requestLogs.createdAt, end),
            ),
          )
          .groupBy(requestLogs.path)
          .orderBy(desc(sql`count(*)`))
          .limit(25);
      } catch (topPathsError: any) {
        if (isMissingColumnError(topPathsError, "duration_ms")) {
          const rows = await db
            .select({ path: requestLogs.path, count: sql<number>`count(*)` })
            .from(requestLogs)
            .where(
              and(
                gte(requestLogs.createdAt, start),
                lt(requestLogs.createdAt, end),
              ),
            )
            .groupBy(requestLogs.path)
            .orderBy(desc(sql`count(*)`))
            .limit(25);
          topPaths = rows.map((row: any) => ({
            path: row.path,
            count: Number(row.count || 0),
            avgDurationMs: 0,
          }));
        } else {
          throw topPathsError;
        }
      }

      const topErrors: Array<{
        path: string;
        statusCode: number;
        count: number;
      }> = await db
        .select({
          path: requestLogs.path,
          statusCode: requestLogs.statusCode,
          count: sql<number>`count(*)`,
        })
        .from(requestLogs)
        .where(
          and(
            gte(requestLogs.createdAt, start),
            lt(requestLogs.createdAt, end),
            gte(requestLogs.statusCode, 400),
          ),
        )
        .groupBy(requestLogs.path, requestLogs.statusCode)
        .orderBy(desc(sql`count(*)`))
        .limit(25);

      await db.insert(adminDailyReports).values({
        reportDate: start,
        reportType: "request_summary",
        summary: {
          range: { start: start.toISOString(), end: end.toISOString() },
          totals: {
            totalRequests: Number(totals?.total || 0),
            uniqueUsers: Number(totals?.uniqueUsers || 0),
            avgDurationMs: Number(totals?.avgDurationMs || 0),
          },
          statusBuckets: statusBuckets.map((row) => ({
            statusCode: row.statusCode,
            count: Number(row.count || 0),
          })),
          topPaths: topPaths.map((row) => ({
            path: row.path,
            count: Number(row.count || 0),
            avgDurationMs: Number(row.avgDurationMs || 0),
          })),
          topErrors: topErrors.map((row) => ({
            path: row.path,
            statusCode: row.statusCode,
            count: Number(row.count || 0),
          })),
        },
      });
      console.log("✅ Daily Request Log Summary Saved");
    } catch (error) {
      console.error("❌ Daily Request Log Summary Failed:", error);
    }
  });

  // Request log cleanup — every 15 min. General request logs keep the existing
  // 48-hour window. Only allowlisted observatory rows, whose writer strips IP,
  // user agent, user/session IDs, URL queries, and private payloads, keep 180 d.
  scheduleCron("15 * * * *", async () => {
    try {
      const operationalCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const observatoryCutoff = new Date(
        Date.now() - 180 * 24 * 60 * 60 * 1000,
      );
      const sanitizedObservatoryRow = sql<boolean>`coalesce((
        ${requestLogs.surface} = 'discovery_observatory'
        and ${requestLogs.method} = 'EVENT'
        and ${requestLogs.userId} is null
        and ${requestLogs.sessionId} is null
        and ${requestLogs.ip} is null
        and ${requestLogs.userAgent} is null
        and position('?' in ${requestLogs.path}) = 0
        and ${requestLogs.metadata}->>'discoveryContractVersion' = '1'
      ), false)`;
      await db.delete(requestLogs).where(
        or(
          and(
            lt(requestLogs.createdAt, operationalCutoff),
            sql`not (${sanitizedObservatoryRow})`,
          ),
          and(
            lt(requestLogs.createdAt, observatoryCutoff),
            sanitizedObservatoryRow,
          ),
        ),
      );
    } catch (error) {
      console.error("❌ Request log cleanup failed:", error);
    }
  });

  // Sweep verified unpaid holds without discarding uncertain payment evidence.
  let holdExpiryRunning = false;
  let holdExpiryCursor: string | null = null;
  scheduleCron("* * * * *", async () => {
    if (holdExpiryRunning) return;
    holdExpiryRunning = true;
    try {
      const { expireParkingPassHolds } = await import("../services/parkingHoldExpiry");
      const Stripe = (await import("stripe")).default;
      const key = process.env.STRIPE_SECRET_KEY;
      const provider = key ? new Stripe(key, { timeout: 8000, maxNetworkRetries: 0 }).paymentIntents : null;
      const outcome = await expireParkingPassHolds(provider, {
        ttlMs: getParkingPassHoldTtlMs(), afterIntentId: holdExpiryCursor,
      });
      holdExpiryCursor = outcome.nextCursor;
      if (outcome.expired || outcome.deferred || outcome.errors) console.info("[parking-pass] hold expiry", { scanned: outcome.scanned, expired: outcome.expired, deferred: outcome.deferred, errors: outcome.errors });
    } catch { console.error("[parking-pass] Hold expiry could not be verified; reservations retained."); }
    finally { holdExpiryRunning = false; }
  });

  // IndexNow daily sitemap submission — 4:00 AM (feature-flagged)
  if (
    String(process.env.INDEXNOW_ENABLED || "")
      .trim()
      .toLowerCase() === "true"
  ) {
    scheduleCron("0 4 * * *", async () => {
      try {
        const cfg = getIndexNowConfig();
        if (!cfg.enabled || !cfg.key) return;
        const baseUrl = `https://${cfg.host}`;
        // Keep automated submissions to this reviewed static allowlist. Dynamic
        // city/profile membership is published through the eligible sitemaps.
        const staticUrls = [
          baseUrl,
          `${baseUrl}/scout`,
          `${baseUrl}/deals/featured`,
          `${baseUrl}/for-restaurants`,
          `${baseUrl}/for-food-trucks`,
          `${baseUrl}/for-bars`,
          `${baseUrl}/for-events`,
          `${baseUrl}/for-hosts`,
          `${baseUrl}/host-location-partner`,
        ];
        const result = await submitIndexNowUrls(staticUrls);
        const detail = result.ok || !result.body ? "" : ` body=${result.body.slice(0, 240)}`;
        console.log(`[indexnow] daily submission: ${result.submitted} URLs, status ${result.status}${detail}`);
      } catch (error) {
        console.error("[indexnow] daily cron failed:", error);
      }
    });
  }

  // VAC Pending Review Digest — daily 9:00 AM (only when there are pending reviews)
  scheduleCron("0 9 * * *", async () => {
    try {
      const { securityAuditLog, restaurants, users } = await import("@shared/schema");
      const { eq, and, isNull } = await import("drizzle-orm");
      const { emailService } = await import("../emailService");
      const {
        formatOwnerEmailDisplay,
        formatSignalsDisplay,
        formatSignupDateDisplay,
        formatVacScoreDisplay,
        getAdminSmokeRowStatus,
      } = await import("@shared/adminSmokeDisplay");

      // Find all trucks that have a vac:evaluate log entry with outcome = 'manual_review'
      // and are still unverified (isVerified = false)
      const pendingRows = await db
        .select({
          restaurantId: restaurants.id,
          restaurantName: restaurants.name,
          ownerEmail: users.email,
          vacScore: securityAuditLog.metadata,
          createdAt: restaurants.createdAt,
        })
        .from(restaurants)
        .innerJoin(users, eq(restaurants.ownerId, users.id))
        .innerJoin(
          securityAuditLog,
          and(
            eq(securityAuditLog.resourceId, restaurants.id),
            eq(securityAuditLog.action, "vac:evaluate"),
          ),
        )
        .where(eq(restaurants.isVerified, false))
        .orderBy(restaurants.createdAt)
        .limit(100);

      if (pendingRows.length === 0) {
        console.log("[vac-digest] No pending manual reviews — skipping digest");
        return;
      }

      const entries = pendingRows.map((row: any) => {
        const meta = (row.vacScore as any) || {};
        const ownerEmail = formatOwnerEmailDisplay(row.ownerEmail);
        return {
          restaurantId: String(row.restaurantId || ""),
          restaurantName: String(row.restaurantName || "Unknown"),
          ownerEmail,
          vacScoreDisplay: formatVacScoreDisplay(meta.score, meta.threshold),
          signals: formatSignalsDisplay(meta.signalSummary || meta.signals),
          createdAt: formatSignupDateDisplay(row.createdAt),
          rowStatus: getAdminSmokeRowStatus({
            name: row.restaurantName,
            ownerEmail: row.ownerEmail,
          }),
        };
      });

      await emailService.sendVacPendingDigest({
        pendingCount: entries.length,
        entries,
      });
      console.log(`✅ [vac-digest] Sent digest for ${entries.length} pending review(s)`);
    } catch (error) {
      console.error("❌ [vac-digest] Daily digest failed:", error);
    }
  });

  console.log("✅ All schedulers registered");
}
