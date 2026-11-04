/**
 * growthRoutes.ts
 *
 * Admin-only growth telemetry endpoints.
 *
 * GET  /api/admin/growth/city-health
 *   Returns a per-city content health score (0–10) that summarises
 *   how well MealScout is populated for each city page.
 *
 * POST /api/admin/growth/diner-digest/run
 *   Manually triggers the diner deals digest (for testing / on-demand).
 *
 * Scoring rubric (max 10 points):
 *   trucks      0–3  (0 = none, 1 = 1–2, 2 = 3–9, 3 = 10+)
 *   restaurants 0–3  (0 = none, 1 = 1–2, 2 = 3–9, 3 = 10+)
 *   deals       0–2  (0 = none, 1 = 1–2, 2 = 3+)
 *   events      0–2  (0 = none, 1 = 1–2, 2 = 3+)
 */

import type { Express, Request, Response } from "express";
import { db } from "../db";
import {
  cities,
  restaurants,
  events,
  deals,
  telemetryEvents,
  pensacolaReportLeads,
  reportLeadSequenceSends,
  emailSequenceSends,
  users,
} from "@shared/schema";
import {
  and,
  eq,
  gte,
  isNull,
  lte,
  or,
  ilike,
  sql,
  desc,
  inArray,
} from "drizzle-orm";
import { z } from "zod";
import { DinerDigestService } from "../dinerDigestService";
import { OnboardingDripService } from "../onboardingDripService";
import { RestaurantActivationService } from "../restaurantActivationService";
import { runHostPartnerLeadDripCron } from "../services/hostPartnerLeadDrip";
import { runPensacolaReportLeadDripCron } from "../services/pensacolaReportDrip";
import { runPensacolaFoodTruckDripCron } from "../services/pensacolaFoodTruckDrip";
import { getIndexNowConfig, submitIndexNowUrls } from "../services/indexNow";
import {
  getSocialQueueStatus,
  runSocialQueueProcessor,
} from "../services/socialQueueProcessor";
import {
  describeMarketingEmailWindow,
  isWithinMarketingEmailWindow,
} from "../utils/marketingEmailWindow";
import { isAdminUserType } from "../roleAccess";

function bucketScore(
  count: number,
  t1: number,
  t2: number,
  t3: number,
): number {
  if (count >= t3) return 3;
  if (count >= t2) return 2;
  if (count >= t1) return 1;
  return 0;
}

function bucketScore2(count: number, t1: number, t2: number): number {
  if (count >= t2) return 2;
  if (count >= t1) return 1;
  return 0;
}

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  return user && isAdminUserType(user.userType);
}

function requireMarketingWindow(res: Response): boolean {
  if (isWithinMarketingEmailWindow()) return true;
  res.status(429).json({
    message: `Marketing email jobs are allowed only during ${describeMarketingEmailWindow()}.`,
    code: "marketing_window_closed",
  });
  return false;
}

export function registerGrowthRoutes(app: Express): void {
  const indexNowPayloadSchema = z.object({
    urls: z.array(z.string().url()).min(1).max(10000),
  });
  const socialQueueRunSchema = z.object({
    limit: z.number().int().min(1).max(200).optional(),
  });

  // City health scores
  app.get(
    "/api/admin/growth/city-health",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      try {
        const now = new Date();
        const allCities = await db.select().from(cities).orderBy(cities.name);

        const scored = await Promise.all(
          allCities.map(async (city: (typeof allCities)[number]) => {
            const cityLike = `%${city.name}%`;

            // Count trucks (businessType = 'food_truck' | 'truck')
            const [truckCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(restaurants)
              .where(
                and(
                  or(
                    ilike(restaurants.city, cityLike),
                    ilike(restaurants.address, cityLike),
                  ),
                  or(
                    eq(restaurants.businessType, "food_truck"),
                    eq(restaurants.businessType, "truck"),
                  ),
                ),
              );

            // Count restaurants (all non-truck types)
            const [restCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(restaurants)
              .where(
                and(
                  or(
                    ilike(restaurants.city, cityLike),
                    ilike(restaurants.address, cityLike),
                  ),
                ),
              );

            // Count active deals
            const [dealCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(deals)
              .innerJoin(restaurants, eq(deals.restaurantId, restaurants.id))
              .where(
                and(
                  eq(deals.isActive, true),
                  lte(deals.startDate, now),
                  or(isNull(deals.endDate), gte(deals.endDate, now)),
                  or(
                    ilike(restaurants.city, cityLike),
                    ilike(restaurants.address, cityLike),
                  ),
                ),
              );

            // Count upcoming events
            const [eventCount] = await db
              .select({ count: sql<number>`count(*)` })
              .from(events)
              .where(gte(events.date, now));

            const trucks = Number(truckCount?.count || 0);
            const rests = Number(restCount?.count || 0);
            const dealsN = Number(dealCount?.count || 0);
            const eventsN = Number(eventCount?.count || 0);

            const truckScore = bucketScore(trucks, 1, 3, 10);
            const restScore = bucketScore(rests, 1, 3, 10);
            const dealScore = bucketScore2(dealsN, 1, 3);
            const eventScore = bucketScore2(eventsN, 1, 3);
            const total = truckScore + restScore + dealScore + eventScore;

            return {
              city: {
                id: city.id,
                name: city.name,
                slug: city.slug,
                state: city.state,
              },
              score: total,
              maxScore: 10,
              breakdown: {
                trucks: { count: trucks, score: truckScore },
                restaurants: { count: rests, score: restScore },
                deals: { count: dealsN, score: dealScore },
                events: { count: eventsN, score: eventScore },
              },
              cityPageUrl: `https://www.mealscout.us/food-trucks/${city.slug}`,
            };
          }),
        );

        const sorted = scored.sort((a, b) => b.score - a.score);
        const summary = {
          generatedAt: now.toISOString(),
          totalCities: sorted.length,
          avgScore: sorted.length
            ? Math.round(
                (sorted.reduce((s, c) => s + c.score, 0) / sorted.length) * 10,
              ) / 10
            : 0,
          cities: sorted,
        };

        res.setHeader("Cache-Control", "no-cache");
        res.json(summary);
      } catch (err) {
        console.error("[growth/city-health] error:", err);
        res.status(500).json({ message: "Failed to compute city health" });
      }
    },
  );

  // Diner digest telemetry summary
  app.get(
    "/api/admin/growth/diner-digest-stats",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      try {
        const recent = await db
          .select({
            week: sql<string>`properties->>'week'`,
            city: sql<string>`properties->>'city'`,
            dealCount: sql<string>`properties->>'dealCount'`,
            userId: telemetryEvents.userId,
            createdAt: telemetryEvents.createdAt,
          })
          .from(telemetryEvents)
          .where(eq(telemetryEvents.eventName, "diner_digest_sent"))
          .orderBy(desc(telemetryEvents.createdAt))
          .limit(200);

        // Group by week
        const byWeek: Record<
          string,
          { week: string; sends: number; cities: Set<string> }
        > = {};
        for (const row of recent) {
          const w = row.week || "unknown";
          if (!byWeek[w]) byWeek[w] = { week: w, sends: 0, cities: new Set() };
          byWeek[w].sends++;
          if (row.city) byWeek[w].cities.add(row.city);
        }

        res.json({
          generatedAt: new Date().toISOString(),
          totalSends: recent.length,
          byWeek: Object.values(byWeek)
            .sort((a, b) => b.week.localeCompare(a.week))
            .map((w) => ({
              week: w.week,
              sends: w.sends,
              uniqueCities: w.cities.size,
            })),
        });
      } catch (err) {
        console.error("[growth/diner-digest-stats] error:", err);
        res.status(500).json({ message: "Failed to fetch diner digest stats" });
      }
    },
  );

  // Manual trigger for diner digest (admins / testing)
  app.post(
    "/api/admin/growth/diner-digest/run",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (!requireMarketingWindow(res)) return;

      try {
        const stats = await DinerDigestService.getInstance().sendDinerDigests();
        res.json({ ok: true, stats });
      } catch (err) {
        console.error("[growth/diner-digest/run] error:", err);
        res.status(500).json({ message: "Digest run failed" });
      }
    },
  );

  // Manual trigger for onboarding drip
  app.post(
    "/api/admin/growth/onboarding-drip/run",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (!requireMarketingWindow(res)) return;
      try {
        const stats = await OnboardingDripService.getInstance().run();
        res.json({ ok: true, stats });
      } catch (err) {
        console.error("[growth/onboarding-drip/run] error:", err);
        res.status(500).json({ message: "Onboarding drip run failed" });
      }
    },
  );

  // Manual trigger for restaurant activation nudge
  app.post(
    "/api/admin/growth/restaurant-activation/run",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (!requireMarketingWindow(res)) return;
      try {
        const stats = await RestaurantActivationService.getInstance().run();
        res.json({ ok: true, stats });
      } catch (err) {
        console.error("[growth/restaurant-activation/run] error:", err);
        res.status(500).json({ message: "Restaurant activation run failed" });
      }
    },
  );

  // Manual trigger for host partner lead drip
  app.post(
    "/api/admin/growth/host-partner-drip/run",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (!requireMarketingWindow(res)) return;
      try {
        const stats = await runHostPartnerLeadDripCron();
        res.json({ ok: true, stats });
      } catch (err) {
        console.error("[growth/host-partner-drip/run] error:", err);
        res.status(500).json({ message: "Host partner drip run failed" });
      }
    },
  );

  app.get(
    "/api/admin/growth/pensacola/ops",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      try {
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(
          now.getTime() - 30 * 24 * 60 * 60 * 1000,
        );

        const [reportLeads7dRow] = await db
          .select({ count: sql<number>`count(*)` })
          .from(pensacolaReportLeads)
          .where(gte(pensacolaReportLeads.createdAt, sevenDaysAgo));
        const [reportLeads30dRow] = await db
          .select({ count: sql<number>`count(*)` })
          .from(pensacolaReportLeads)
          .where(gte(pensacolaReportLeads.createdAt, thirtyDaysAgo));
        const [reportLeadsAllRow] = await db
          .select({ count: sql<number>`count(*)` })
          .from(pensacolaReportLeads);

        const reportStepRows = (await db
          .select({
            step: reportLeadSequenceSends.step,
            count: sql<number>`count(*)`,
          })
          .from(reportLeadSequenceSends)
          .where(eq(reportLeadSequenceSends.sequence, "pensacola_report_v1"))
          .groupBy(reportLeadSequenceSends.step)) as Array<{
          step: number | null;
          count: number | null;
        }>;
        const reportStepSends: Record<string, number> = {};
        for (const row of reportStepRows) {
          reportStepSends[`step${Number(row.step || 0)}`] = Number(
            row.count || 0,
          );
        }

        const pensacolaTruckRows = (await db
          .select({
            restaurantId: restaurants.id,
              ownerId: restaurants.ownerId,
              isActive: restaurants.isActive,
            emailVerified: users.emailVerified,
            isDisabled: users.isDisabled,
          })
          .from(restaurants)
          .innerJoin(users, eq(users.id, restaurants.ownerId))
          .where(
            and(
              eq(restaurants.businessType, "food_truck"),
              ilike(restaurants.city, "pensacola"),
              or(
                ilike(restaurants.state, "fl"),
                ilike(restaurants.state, "florida"),
              ),
            ),
          )) as Array<{
          restaurantId: string | null;
          ownerId: string | null;
          emailVerified: boolean | null;
          isDisabled: boolean | null;
          isActive: boolean | null;
        }>;

        const pensacolaRestaurantIds: string[] = Array.from(
          new Set(
            pensacolaTruckRows
              .map((row) => String(row.restaurantId || "").trim())
              .filter(Boolean),
          ),
        );
        const pensacolaOwnerIds: string[] = Array.from(
          new Set(
            pensacolaTruckRows
              .map((row) => String(row.ownerId || "").trim())
              .filter(Boolean),
          ),
        );

        const verifiedOwnerIds = new Set(
          pensacolaTruckRows
            .filter((row) => row.emailVerified && !row.isDisabled)
            .map((row) => String(row.ownerId || "").trim())
            .filter(Boolean),
        );

        const activeProfileCount = new Set(
          pensacolaTruckRows
            .filter((row) => row.isActive && !row.isDisabled)
            .map((row) => String(row.restaurantId || "").trim())
            .filter(Boolean),
        ).size;

        const [newTruckOwners7dRow] = pensacolaOwnerIds.length
          ? await db
              .select({ count: sql<number>`count(distinct ${users.id})` })
              .from(users)
              .where(
                and(
                  gte(users.createdAt, sevenDaysAgo),
                  inArray(users.id, pensacolaOwnerIds),
                ),
              )
          : [{ count: 0 }];

        const truckStepRows = (await db
          .select({
            step: emailSequenceSends.step,
            count: sql<number>`count(*)`,
          })
          .from(emailSequenceSends)
          .where(
            and(
              eq(
                emailSequenceSends.sequence,
                "pensacola_food_truck_onboarding_v1",
              ),
              pensacolaOwnerIds.length
                ? inArray(emailSequenceSends.userId, pensacolaOwnerIds)
                : sql`false`,
            ),
          )
          .groupBy(emailSequenceSends.step)) as Array<{
          step: number | null;
          count: number | null;
        }>;
        const truckStepSends: Record<string, number> = {};
        for (const row of truckStepRows) {
          truckStepSends[`step${Number(row.step || 0)}`] = Number(
            row.count || 0,
          );
        }

        return res.json({
          generatedAt: now.toISOString(),
          report: {
            leads7d: Number(reportLeads7dRow?.count || 0),
            leads30d: Number(reportLeads30dRow?.count || 0),
            leadsAllTime: Number(reportLeadsAllRow?.count || 0),
            stepSends: reportStepSends,
          },
          trucks: {
            pensacolaTrucks: pensacolaRestaurantIds.length,
            pensacolaOwners: pensacolaOwnerIds.length,
            verifiedOwners: verifiedOwnerIds.size,
            activeProfileTrucks: activeProfileCount,
            newOwners7d: Number(newTruckOwners7dRow?.count || 0),
            stepSends: truckStepSends,
          },
        });
      } catch (err) {
        console.error("[growth/pensacola/ops] error:", err);
        return res
          .status(500)
          .json({ message: "Failed to load Pensacola growth ops snapshot" });
      }
    },
  );

  app.post(
    "/api/admin/growth/pensacola/report-drip/run",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (!requireMarketingWindow(res)) return;
      try {
        const stats = await runPensacolaReportLeadDripCron();
        return res.json({ ok: true, stats });
      } catch (err) {
        console.error("[growth/pensacola/report-drip/run] error:", err);
        return res
          .status(500)
          .json({ message: "Pensacola report drip run failed" });
      }
    },
  );

  app.post(
    "/api/admin/growth/pensacola/truck-drip/run",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (!requireMarketingWindow(res)) return;
      try {
        const stats = await runPensacolaFoodTruckDripCron();
        return res.json({ ok: true, stats });
      } catch (err) {
        console.error("[growth/pensacola/truck-drip/run] error:", err);
        return res
          .status(500)
          .json({ message: "Pensacola truck drip run failed" });
      }
    },
  );

  app.get(
    "/api/admin/growth/indexnow/status",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      const cfg = getIndexNowConfig();
      res.json({
        ok: true,
        enabled: cfg.enabled,
        state: cfg.state,
        host: cfg.host,
        keyConfigured: Boolean(cfg.key),
        keyLocation: cfg.keyLocation || null,
      });
    },
  );

  app.post(
    "/api/admin/growth/indexnow/submit",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const parsed = indexNowPayloadSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid payload",
          errors: parsed.error.flatten(),
        });
      }

      try {
        const result = await submitIndexNowUrls(parsed.data.urls);
        if (!result.ok) {
          return res.status(502).json({
            ok: false,
            message: "IndexNow submission failed",
            result,
          });
        }
        res.json({ ok: true, result });
      } catch (err) {
        console.error("[growth/indexnow/submit] error:", err);
        res.status(500).json({ message: "IndexNow submission failed" });
      }
    },
  );

  app.get(
    "/api/admin/growth/social-queue/status",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      try {
        const status = await getSocialQueueStatus();
        res.json({ ok: true, status });
      } catch (err) {
        console.error("[growth/social-queue/status] error:", err);
        res.status(500).json({ message: "Failed to load social queue status" });
      }
    },
  );

  app.post(
    "/api/admin/growth/social-queue/run",
    async (req: Request, res: Response) => {
      if (!isAdmin(req)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      const parsed = socialQueueRunSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          message: "Invalid payload",
          errors: parsed.error.flatten(),
        });
      }

      try {
        const stats = await runSocialQueueProcessor(parsed.data.limit || 25);
        const status = await getSocialQueueStatus();
        res.json({ ok: true, stats, status });
      } catch (err) {
        console.error("[growth/social-queue/run] error:", err);
        res.status(500).json({ message: "Social queue run failed" });
      }
    },
  );
}
