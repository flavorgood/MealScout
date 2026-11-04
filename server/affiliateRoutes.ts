/**
 * Affiliate Routes
 * 
 * Public routes for:
 * - Affiliate link tracking (ref param)
 * - Commission dashboards
 * - Withdrawal requests
 * - Commission history
 */

import { Router } from 'express';
import { db } from './db';
import { isAuthenticated } from './unifiedAuth';
import affiliateService from './affiliateService';
import shareService from './shareService';
import emptyCountyService from './emptyCountyService';
import { logAudit } from './auditLogger';
import { eq, desc, sql, and, isNull, sum } from 'drizzle-orm';
import {
  affiliateWithdrawals,
  affiliateLinks,
  affiliateCommissions,
  affiliateWallet,
  affiliateShareEvents,
  creditLedger,
  referralClicks,
  referrals,
} from '@shared/schema';
import { ensureAffiliateTag, setAffiliateTag } from "./affiliateTagService";
import { appendReferralParam } from "./referralService";
import { getUserCreditBalance } from "./creditService";

const router = Router();

/**
 * GET /api/affiliate/tag
 * Get or create the user's affiliate tag
 */
router.get('/tag', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const tag = await ensureAffiliateTag(userId);
    res.json({ tag, sharePath: `/ref/${tag}` });
  } catch (error: any) {
    console.error('Failed to fetch affiliate tag:', error);
    // Non-critical endpoint: never block app boot for affiliate-tag fetch failures.
    res.status(200).json({
      tag: null,
      sharePath: null,
      degraded: true,
      error: 'affiliate_tag_unavailable',
    });
  }
});

/**
 * PUT /api/affiliate/tag
 * Update the user's affiliate tag
 */
router.put('/tag', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { tag } = req.body;
    if (!userId || !tag) {
      return res.status(400).json({ error: 'Tag is required' });
    }

    const updated = await setAffiliateTag(userId, tag);
    res.json({ tag: updated, sharePath: `/ref/${updated}` });
  } catch (error: any) {
    console.error('Failed to update affiliate tag:', error);
    res.status(400).json({ error: error.message || 'Failed to update tag' });
  }
});

/**
 * POST /api/affiliate/generate-link
 * Create an affiliate link for any shared resource
 */
router.post('/generate-link', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { baseUrl, resourceType, resourceId } = req.body;

    if (!userId || !baseUrl || !resourceType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const link = await affiliateService.createAffiliateLink(
      userId,
      resourceType,
      baseUrl,
      resourceId,
    );

    await logAudit(
      userId,
      'affiliate_link_created',
      'affiliate_link',
      link.id,
      req.ip || 'unknown',
      req.get('user-agent') || 'unknown',
      { resourceType, baseUrl },
    );

    res.json(link);
  } catch (error) {
    console.error('Failed to generate affiliate link:', error);
    res.status(500).json({ error: 'Failed to generate link' });
  }
});

/**
 * GET /api/affiliate/click/:code
 * Track click on affiliate link (public, no auth required)
 * Stores tracking data and redirects to original URL
 */
router.get('/click/:code', async (req, res) => {
  try {
    const { code } = req.params;
    // One stable visitor identity per browser (cookie-backed, see
    // affiliateService). The old fallback fabricated a fresh id on every
    // request for a visitor without a persisted session, so that visitor's
    // clicks were each recorded under a different identity and signup
    // attribution could never match the first click.
    const visitorIdentity = affiliateService.ensureAffiliateVisitorIdentity(
      req as any,
      res as any,
    );

    // Track the click
    const click = await affiliateService.trackAffiliateClick(
      code,
      req.ip || 'unknown',
      req.get('user-agent') || 'unknown',
      req.get('referer') || 'direct',
      visitorIdentity,
    );

    if (!click) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Get the affiliate link
    const link = (await db
      .select()
      .from(affiliateLinks)
      .where(eq(affiliateLinks.id, click.affiliateLinkId))
      .limit(1))[0];

    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Bridge to the newer referral/commission pipeline:
    // - set cookie so signup/login can attribute `affiliateCloserUserId`
    // - also record a referral click row for analytics
    let referralRecordId: string | null = null;
    try {
      const { recordReferralClick } = await import("./referralService");
      const result = await recordReferralClick(
        String(link.affiliateUserId),
        req.originalUrl || "/",
        req.get("user-agent") || undefined,
        req.ip || undefined,
      );
      referralRecordId = result?.referralId || null;
    } catch (error) {
      console.error("[affiliate] Failed to record referral click:", error);
    }

    res.cookie("referralId", code, {
      maxAge: 1000 * 60 * 60 * 24 * 365,
      httpOnly: false,
      sameSite: "lax",
    });
    if (referralRecordId) {
      res.cookie("referralRecordId", referralRecordId, {
        maxAge: 1000 * 60 * 60 * 24 * 365,
        httpOnly: true,
        sameSite: "lax",
      });
    }

    // Redirect to original URL
    res.redirect(link.sourceUrl);
  } catch (error) {
    console.error('Failed to track affiliate click:', error);
    res.status(500).json({ error: 'Failed to track click' });
  }
});

/**
 * GET /api/affiliate/stats
 * Get affiliate dashboard stats for logged-in user
 */
router.get('/stats', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const stats = await affiliateService.getAffiliateStats(userId);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const affiliateTag = await ensureAffiliateTag(userId);

    const creditBalance = await getUserCreditBalance(userId);
    const totalEarnedRows = await db
      .select({ total: sum(creditLedger.amount) })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId));
    const totalEarnedRaw = totalEarnedRows[0]?.total
      ? parseFloat(totalEarnedRows[0].total.toString())
      : 0;
    const totalEarned = Math.max(0, totalEarnedRaw);

    const totalWithdrawnRows = await db
      .select({ total: sum(creditLedger.amount) })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, userId),
          eq(creditLedger.redeemedFor, "cash_payout"),
        ),
      );
    const totalWithdrawnRaw = totalWithdrawnRows[0]?.total
      ? parseFloat(totalWithdrawnRows[0].total.toString())
      : 0;
    const totalWithdrawn = Math.abs(Math.min(0, totalWithdrawnRaw));

    const pendingWithdrawalsRows = await db
      .select({ total: sum(creditLedger.amount) })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, userId),
          eq(creditLedger.redeemedFor, "cash_payout_request"),
        ),
      );
    const pendingWithdrawalsRaw = pendingWithdrawalsRows[0]?.total
      ? parseFloat(pendingWithdrawalsRows[0].total.toString())
      : 0;
    const pendingWithdrawals = Math.abs(Math.min(0, pendingWithdrawalsRaw));

    const totalSpentRows = await db
      .select({ total: sum(creditLedger.amount) })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, userId),
          eq(creditLedger.redeemedFor, "restaurant"),
        ),
      );
    const totalSpentRaw = totalSpentRows[0]?.total
      ? parseFloat(totalSpentRows[0].total.toString())
      : 0;
    const totalSpent = Math.abs(Math.min(0, totalSpentRaw));

    const referralClicksCount = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(referralClicks)
      .where(eq(referralClicks.affiliateUserId, userId));
    const referralConversions = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(referrals)
      .where(
        and(
          eq(referrals.affiliateUserId, userId),
          sql`${referrals.status} in ('signed_up','activated','paid')`,
        ),
      );

    const shareCountRows = await db
      .select({
        count: sql<number>`count(distinct ${affiliateShareEvents.destinationUrl})`.mapWith(Number),
      })
      .from(affiliateShareEvents)
      .where(eq(affiliateShareEvents.affiliateUserId, userId));
    const shareCount = shareCountRows[0]?.count ?? 0;

    const shareRows = await db
      .select({
        id: affiliateShareEvents.id,
        destinationUrl: affiliateShareEvents.destinationUrl,
        createdAt: affiliateShareEvents.createdAt,
      })
      .from(affiliateShareEvents)
      .where(eq(affiliateShareEvents.affiliateUserId, userId))
      .orderBy(desc(affiliateShareEvents.createdAt))
      .limit(5);

    const shareLinks = shareRows.map((row: { id: string; destinationUrl: string; createdAt: Date | null }) => {
      const path = row.destinationUrl.startsWith("/")
        ? row.destinationUrl
        : `/${row.destinationUrl}`;
      const fullUrl = appendReferralParam(`${baseUrl}${path}`, affiliateTag);
      return {
        id: row.id,
        code: row.destinationUrl,
        resourceType: "page",
        resourceId: null,
        sourceUrl: path,
        fullUrl,
        clickCount: 0,
        conversions: 0,
        createdAt: row.createdAt,
      };
    });

    stats.wallet = {
      totalEarned,
      availableBalance: creditBalance,
      pendingCommissions: pendingWithdrawals,
      totalWithdrawn,
      totalSpent,
    };

    stats.stats.totalLinks = Math.max(stats.stats.totalLinks, shareCount);
    stats.stats.totalClicks = referralClicksCount[0]?.count ?? stats.stats.totalClicks;
    stats.stats.totalConversions = referralConversions[0]?.count ?? stats.stats.totalConversions;
    stats.stats.conversionRate =
      stats.stats.totalClicks > 0
        ? ((stats.stats.totalConversions / stats.stats.totalClicks) * 100).toFixed(2)
        : "0";

    if (shareLinks.length > 0) {
      stats.recentLinks = shareLinks;
    }

    res.json(stats);
  } catch (error) {
    console.error('Failed to fetch affiliate stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/affiliate/withdrawals
 * Get withdrawal history for the logged-in affiliate
 */
router.get('/withdrawals', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(
      Math.max(parseInt(req.query.limit as string, 10) || 25, 1),
      100,
    );

    const withdrawals = await db
      .select({
        id: affiliateWithdrawals.id,
        amount: affiliateWithdrawals.amount,
        method: affiliateWithdrawals.method,
        status: affiliateWithdrawals.status,
        methodDetails: affiliateWithdrawals.methodDetails,
        requestedAt: affiliateWithdrawals.requestedAt,
        approvedAt: affiliateWithdrawals.approvedAt,
        paidAt: affiliateWithdrawals.paidAt,
        rejectedAt: affiliateWithdrawals.rejectedAt,
        notes: affiliateWithdrawals.notes,
      })
      .from(affiliateWithdrawals)
      .where(eq(affiliateWithdrawals.userId, userId))
      .orderBy(desc(affiliateWithdrawals.requestedAt))
      .limit(limit);

    res.json({ withdrawals });
  } catch (error) {
    console.error('Failed to fetch affiliate withdrawals:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

/**
 * GET /api/affiliate/commissions
 * Get commission history with pagination
 */
router.get('/commissions', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const offset = (page - 1) * limit;

    const commissions = await db
      .select()
      .from(affiliateCommissions)
      .where(eq(affiliateCommissions.affiliateUserId, userId))
      .orderBy(desc(affiliateCommissions.createdAt))
      .offset(offset)
      .limit(limit);

    const total = await db
      .select()
      .from(affiliateCommissions)
      .where(eq(affiliateCommissions.affiliateUserId, userId));

    res.json({
      commissions,
      pagination: {
        page,
        limit,
        total: total.length,
        pages: Math.ceil(total.length / limit),
      },
    });
  } catch (error) {
    console.error('Failed to fetch commissions:', error);
    res.status(500).json({ error: 'Failed to fetch commissions' });
  }
});

/**
 * POST /api/affiliate/withdraw
 * Request a withdrawal (cash out)
 */
router.post('/withdraw', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { amount, method, methodDetails, notes } = req.body;

    if (!userId || !amount || !method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate amount
    const amountNum = parseFloat(amount);
    if (amountNum < 5) {
      return res.status(400).json({ error: 'Minimum withdrawal is $5' });
    }

    if (!['paypal', 'ach', 'other'].includes(method)) {
      return res.status(400).json({ error: 'Invalid payout method' });
    }

    if (!methodDetails || typeof methodDetails !== "object") {
      return res.status(400).json({ error: 'Payout method details required' });
    }

    // Check available balance
    const balance = await getUserCreditBalance(userId);
    if (balance < amountNum) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const withdrawal = await db.transaction(async (tx: any) => {
      const [created] = await tx
        .insert(affiliateWithdrawals)
        .values({
          userId,
          amount: amountNum.toString(),
          method,
          methodDetails,
          status: "pending",
          notes: notes || null,
        })
        .returning();

      const [ledgerEntry] = await tx
        .insert(creditLedger)
        .values({
          userId,
          amount: (-amountNum).toString(),
          sourceType: "cash_payout",
          sourceId: created.id,
          redeemedAt: new Date(),
          redeemedFor: "cash_payout_request",
        })
        .returning();

      await tx
        .update(affiliateWithdrawals)
        .set({ creditLedgerId: ledgerEntry.id })
        .where(eq(affiliateWithdrawals.id, created.id));

      return { ...created, creditLedgerId: ledgerEntry.id };
    });

    await logAudit(
      userId,
      'affiliate_withdrawal_requested',
      'withdrawal',
      withdrawal.id,
      req.ip || 'unknown',
      req.get('user-agent') || 'unknown',
      { amount: amountNum, method },
    );

    res.json(withdrawal);
  } catch (error) {
    console.error('Failed to create withdrawal:', error);
    res.status(500).json({ error: 'Failed to create withdrawal' });
  }
});

/**
 * POST /api/affiliate/submit-restaurant
 * Community submission for empty counties
 */
router.post('/submit-restaurant', async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const {
      restaurantName,
      address,
      county,
      state,
      website,
      phoneNumber,
      category,
      latitude,
      longitude,
      description,
      photoUrl,
    } = req.body;

    if (!restaurantName || !county || !state) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await emptyCountyService.submitRestaurant(
      userId,
      restaurantName,
      address,
      county,
      state,
      {
        website,
        phoneNumber,
        category,
        latitude,
        longitude,
        description,
        photoUrl,
      },
    );

    if (userId) {
      await logAudit(
        userId,
        'restaurant_submitted',
        'submission',
        result.submission.id,
        req.ip || 'unknown',
        req.get('user-agent') || 'unknown',
        { restaurantName, county },
      );
    }

    res.json(result);
  } catch (error) {
    console.error('Failed to submit restaurant:', error);
    res.status(500).json({ error: 'Failed to submit restaurant' });
  }
});

/**
 * GET /api/affiliate/county/empty-check
 * Check if a county has content (no affiliate auth needed)
 */
router.get('/county/empty-check', async (req, res) => {
  const county = encodeURIComponent(String(req.query.county || '').trim());
  const state = encodeURIComponent(String(req.query.state || '').trim());
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'This legacy county endpoint has been retired.',
    replacementPath:
      county && state
        ? `/api/counties/${state}/${county}/empty-experience`
        : '/api/counties/:state/:county/empty-experience',
  });
});

/**
 * GET /api/affiliate/county/fallback
 * Get content fallback chain for empty county
 */
router.get('/county/fallback', async (req, res) => {
  const county = encodeURIComponent(String(req.query.county || '').trim());
  const state = encodeURIComponent(String(req.query.state || '').trim());
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'This legacy county endpoint has been retired.',
    replacementPath:
      county && state
        ? `/api/counties/${state}/${county}/fallback`
        : '/api/counties/:state/:county/fallback',
  });
});

export default router;
