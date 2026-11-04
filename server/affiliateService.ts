/**
 * Affiliate Service
 * 
 * Manages affiliate link generation, tracking, click attribution, and commission calculation.
 * Every user is automatically an affiliate - any shared link becomes trackable.
 */

import { randomUUID } from 'crypto';
import { db } from './db';
import {
  affiliateLinks,
  affiliateClicks,
  affiliateCommissions,
  affiliateWallet,
} from '@shared/schema';
import { eq, and, sql, asc } from 'drizzle-orm';

const AFFILIATE_CODE_LENGTH = 8;

export const AFFILIATE_VISITOR_COOKIE = 'affiliateVisitorId';

const AFFILIATE_VISITOR_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365;

type AffiliateVisitorRequest = {
  cookies?: Record<string, string | undefined>;
  sessionID?: string;
};

type AffiliateVisitorResponse = {
  cookie: (
    name: string,
    value: string,
    options: Record<string, unknown>,
  ) => void;
};

/**
 * Resolve the stable identity affiliate first-click attribution is keyed by.
 *
 * Express sessions are configured with saveUninitialized: false, so an
 * anonymous visitor's sessionID is not persisted between requests: keying
 * clicks by it (or by a per-request fabricated id) gives the first click,
 * later clicks, and the eventual signup three different identities, and
 * first-click attribution can never match. The visitor-id cookie is set
 * once and read back on every later request, so one browser keeps one
 * identity across clicks and signup.
 */
export function resolveAffiliateVisitorIdentity(
  req: AffiliateVisitorRequest,
): string | null {
  const cookieId = String(
    req?.cookies?.[AFFILIATE_VISITOR_COOKIE] || '',
  ).trim();
  if (cookieId) return cookieId;
  const sessionId = String(req?.sessionID || '').trim();
  if (sessionId) return sessionId;
  return null;
}

/**
 * Return the request's stable affiliate visitor identity, minting and
 * persisting one (cookie, one year — the same lifetime the click route
 * already uses for its attribution cookies) when the visitor has none.
 */
export function ensureAffiliateVisitorIdentity(
  req: AffiliateVisitorRequest,
  res: AffiliateVisitorResponse,
): string {
  const visitorId = resolveAffiliateVisitorIdentity(req) || randomUUID();
  if (String(req?.cookies?.[AFFILIATE_VISITOR_COOKIE] || '') !== visitorId) {
    res.cookie(AFFILIATE_VISITOR_COOKIE, visitorId, {
      maxAge: AFFILIATE_VISITOR_COOKIE_MAX_AGE_MS,
      httpOnly: true,
      sameSite: 'lax',
    });
  }
  return visitorId;
}

/**
 * Generate random 8-character affiliate code
 * Format: UX72A91 (mix of letters and numbers)
 */
function generateAffiliateCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < AFFILIATE_CODE_LENGTH; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Create an affiliate link for a shared resource
 * If the user shares a deal, restaurant, or page, their ID is automatically tracked
 */
export async function createAffiliateLink(
  userId: string,
  resourceType: 'deal' | 'restaurant' | 'page' | 'collection' | 'search',
  sourceUrl: string,
  resourceId?: string,
) {
  // Generate unique code
  let code: string;
  let attempts = 0;
  do {
    code = generateAffiliateCode();
    const existing = (await db
      .select()
      .from(affiliateLinks)
      .where(eq(affiliateLinks.code, code))
      .limit(1))[0];
    if (!existing) break;
    attempts++;
  } while (attempts < 10);

  if (attempts >= 10) {
    throw new Error('Failed to generate unique affiliate code');
  }

  // Build full URL with ref parameter
  const separator = sourceUrl.includes('?') ? '&' : '?';
  const fullUrl = `${sourceUrl}${separator}ref=${code}`;

  const link = await db
    .insert(affiliateLinks)
    .values({
      affiliateUserId: userId,
      code,
      resourceType,
      resourceId,
      sourceUrl,
      fullUrl,
    })
    .returning();

  return link[0];
}

/**
 * Track a click on an affiliate link
 * First-click attribution: only count if no previous conversion for this
 * visitor. `visitorIdentity` is the stable affiliate visitor identity (see
 * ensureAffiliateVisitorIdentity); it is stored in the clicks table's
 * sessionId column, which is the attribution key signup later reads back.
 */
export async function trackAffiliateClick(
  code: string,
  visitorIp: string,
  visitorUserAgent: string,
  referrerSource: string,
  visitorIdentity: string,
) {
  // Find the affiliate link
  const link = (await db
    .select()
    .from(affiliateLinks)
    .where(eq(affiliateLinks.code, code))
    .limit(1))[0];

  if (!link) {
    return null;
  }

  // Check if this visitor already converted for this link (prevent double-counting)
  const existingClick = (await db
    .select()
    .from(affiliateClicks)
    .where(
      and(eq(affiliateClicks.affiliateLinkId, link.id), eq(affiliateClicks.sessionId, visitorIdentity)),
    )
    .limit(1))[0];

  if (existingClick) {
    return existingClick; // Return existing, don't create duplicate
  }

  // Record the click
  const click = await db
    .insert(affiliateClicks)
    .values({
      affiliateLinkId: link.id,
      visitorIp,
      visitorUserAgent,
      referrerSource,
      sessionId: visitorIdentity,
    })
    .returning();

  // Increment click count on affiliate link
  await db.update(affiliateLinks)
    .set({ clickCount: sql`${affiliateLinks.clickCount} + 1` })
    .where(eq(affiliateLinks.id, link.id));

  return click[0];
}

/**
 * Attribute a signup to an affiliate link via first-click
 * Called when a restaurant completes signup after clicking an affiliate link.
 * `visitorIdentity` must be the stable affiliate visitor identity resolved
 * the same way the click route records it (resolveAffiliateVisitorIdentity);
 * a bare per-request session id cannot match the click that was recorded
 * before signup.
 */
export async function attributeSignupToAffiliate(
  visitorIdentity: string,
  restaurantUserId: string,
) {
  if (!visitorIdentity) {
    return null;
  }

  // Find first click for this visitor (first-click wins)
  const firstClick = (await db
    .select()
    .from(affiliateClicks)
    .where(and(eq(affiliateClicks.sessionId, visitorIdentity), sql`${affiliateClicks.convertedAt} IS NULL`))
    .orderBy(asc(affiliateClicks.clickedAt))
    .limit(1))[0];

  if (!firstClick) {
    return null;
  }

  // Update click with conversion
  const converted = await db.update(affiliateClicks)
    .set({
      convertedAt: new Date(),
      restaurantSignupId: restaurantUserId,
    })
    .where(eq(affiliateClicks.id, firstClick.id))
    .returning();

  // Increment conversions on the link
  const click = (await db
    .select()
    .from(affiliateClicks)
    .where(eq(affiliateClicks.id, firstClick.id))
    .limit(1))[0];

  if (click) {
    await db.update(affiliateLinks)
      .set({ conversions: sql`${affiliateLinks.conversions} + 1` })
      .where(eq(affiliateLinks.id, click.affiliateLinkId));
  }

  return converted[0];
}

/**
 * Process pending transaction commissions to available balance.
 */
export async function processPendingCommissions(forMonth: string) {
  // Find all pending commissions for this month
  const pending = await db
    .select()
    .from(affiliateCommissions)
    .where(and(eq(affiliateCommissions.forMonth, forMonth), eq(affiliateCommissions.status, 'pending')));

  const updated = [];

  for (const commission of pending) {
    // Update commission status
    const updatedCommission = await db.update(affiliateCommissions)
      .set({
        status: 'paid',
        paidAt: new Date(),
      })
      .where(eq(affiliateCommissions.id, commission.id))
      .returning();

    // Move from pending to available in wallet
    const amount = parseFloat(commission.commissionAmount.toString());
    await updateAffiliateWallet(commission.affiliateUserId, {
      pendingCommissions: -amount,
      availableBalance: amount,
      totalEarned: amount,
    });

    updated.push(updatedCommission[0]);
  }

  return updated;
}

/**
 * Update affiliate wallet balances
 */
export async function updateAffiliateWallet(
  userId: string,
  updates: {
    availableBalance?: number;
    pendingCommissions?: number;
    totalEarned?: number;
    totalWithdrawn?: number;
    totalSpent?: number;
  },
) {
  // Ensure wallet exists
  let wallet = (await db
    .select()
    .from(affiliateWallet)
    .where(eq(affiliateWallet.userId, userId))
    .limit(1))[0];

  if (!wallet) {
    const created = await db.insert(affiliateWallet).values({
      userId,
    }).returning();
    wallet = created[0];
  }

  // Build update object
  const updateData: any = { updatedAt: new Date() };

  if (updates.availableBalance !== undefined) {
    const current = parseFloat(wallet.availableBalance?.toString() || '0');
    updateData.availableBalance = (current + updates.availableBalance).toString();
  }

  if (updates.pendingCommissions !== undefined) {
    const current = parseFloat(wallet.pendingCommissions?.toString() || '0');
    updateData.pendingCommissions = (current + updates.pendingCommissions).toString();
  }

  if (updates.totalEarned !== undefined) {
    const current = parseFloat(wallet.totalEarned?.toString() || '0');
    updateData.totalEarned = (current + updates.totalEarned).toString();
  }

  if (updates.totalWithdrawn !== undefined) {
    const current = parseFloat(wallet.totalWithdrawn?.toString() || '0');
    updateData.totalWithdrawn = (current + updates.totalWithdrawn).toString();
  }

  if (updates.totalSpent !== undefined) {
    const current = parseFloat(wallet.totalSpent?.toString() || '0');
    updateData.totalSpent = (current + updates.totalSpent).toString();
  }

  const updated = await db
    .update(affiliateWallet)
    .set(updateData)
    .where(eq(affiliateWallet.userId, userId))
    .returning();

  return updated[0];
}

/**
 * Get affiliate stats for a user
 */
export async function getAffiliateStats(userId: string) {
  const wallet = (await db
    .select()
    .from(affiliateWallet)
    .where(eq(affiliateWallet.userId, userId))
    .limit(1))[0];

  const links = await db
    .select()
    .from(affiliateLinks)
    .where(eq(affiliateLinks.affiliateUserId, userId));

  const totalClicks = links.reduce((sum: number, link: any) => sum + Number(link.clickCount || 0), 0);
  const totalConversions = links.reduce((sum: number, link: any) => sum + Number(link.conversions || 0), 0);

  // Get pending commissions for next 30 days
  const pendingCommissions = await db
    .select()
    .from(affiliateCommissions)
    .where(and(eq(affiliateCommissions.affiliateUserId, userId), eq(affiliateCommissions.status, 'pending')));

  return {
    wallet: wallet || {
      totalEarned: 0,
      availableBalance: 0,
      pendingCommissions: 0,
      totalWithdrawn: 0,
      totalSpent: 0,
    },
    stats: {
      totalLinks: links.length,
      totalClicks,
      totalConversions,
      conversionRate: totalClicks > 0 ? (totalConversions / totalClicks * 100).toFixed(2) : '0',
      pendingMonthlyCount: pendingCommissions.length,
    },
    recentLinks: links.slice(-5),
  };
}

export default {
  generateAffiliateCode,
  createAffiliateLink,
  trackAffiliateClick,
  attributeSignupToAffiliate,
  resolveAffiliateVisitorIdentity,
  ensureAffiliateVisitorIdentity,
  processPendingCommissions,
  updateAffiliateWallet,
  getAffiliateStats,
};
