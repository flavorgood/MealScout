/**
 * PHASE 1 + 2: Referral Service
 *
 * Tracks referrals:
 * 1. Records every click on affiliate link (Phase 1)
 * 2. Attaches referral to restaurant signup (Phase 2)
 * 3. Creates commissions when restaurant pays (Phase 3)
 */

import { db } from "./db";
import {
  referrals,
  referralClicks,
  restaurants,
  affiliateCommissionLedger,
} from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { resolveAffiliateUserId } from "./affiliateTagService";
import { mirrorInfinitySignup } from "./integrations/infinityShadow";

/**
 * PHASE 1: Record a click on an affiliate link
 *
 * Called when:
 * - User clicks shared link with ?ref=<affiliateTag>
 * - Link leads to restaurant signup page
 *
 * Returns referral ID (stored in cookie or session)
 */
export async function recordReferralClick(
  affiliateUserId: string,
  url: string,
  userAgent?: string,
  ip?: string,
) {
  try {
    const clickRecord = await db
      .insert(referralClicks)
      .values({
        affiliateUserId,
        url,
        userAgent,
        ip,
      })
      .returning();

    if (!clickRecord[0]) {
      throw new Error("Failed to record referral click");
    }

    // Also create a referral record in 'clicked' status
    const referralRecord = await db
      .insert(referrals)
      .values({
        affiliateUserId,
        clickedAt: new Date(),
        status: "clicked",
      })
      .returning();

    return {
      clickId: clickRecord[0].id,
      referralId: referralRecord[0].id,
    };
  } catch (error) {
    console.error("[referralService] Error recording click:", error);
    throw error;
  }
}

/**
 * PHASE 2: Attach referral to restaurant signup
 *
 * Called when a restaurant completes their signup/registration
 *
 * @param referralIdOrTag - referral ID or affiliate tag
 * @param newRestaurantId - ID of the newly created restaurant account
 */
export async function attachReferralToSignup(
  referralIdOrTag: string,
  newRestaurantId: string,
) {
  try {
    // If this is an actual referral ID, attach it directly.
    const referral = (
      await db
        .select()
        .from(referrals)
        .where(eq(referrals.id, referralIdOrTag))
        .limit(1)
    )[0];

    if (referral) {
      const updated = await db
        .update(referrals)
        .set({
          referredRestaurantId: newRestaurantId,
          signedUpAt: new Date(),
          status: "signed_up",
        })
        .where(eq(referrals.id, referral.id))
        .returning();

      void mirrorInfinitySignup({
        partnerId: referral.affiliateUserId,
        referralProofId: referral.id,
        restaurantId: newRestaurantId,
      });

      return updated[0];
    }

    const affiliateUserId = await resolveAffiliateUserId(referralIdOrTag);
    if (!affiliateUserId) {
      console.warn(`[referralService] Referral ${referralIdOrTag} not found`);
      return null;
    }

    const [restaurant] = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.id, newRestaurantId))
      .limit(1);

    if (!restaurant) {
      console.warn(
        `[referralService] Restaurant ${newRestaurantId} not found`,
      );
      return null;
    }

    const created = await db
      .insert(referrals)
      .values({
        affiliateUserId,
        referredRestaurantId: newRestaurantId,
        clickedAt: new Date(),
        signedUpAt: new Date(),
        status: "signed_up",
      })
      .returning();

    if (created[0]) {
      void mirrorInfinitySignup({
        partnerId: affiliateUserId,
        referralProofId: created[0].id,
        restaurantId: newRestaurantId,
      });
    }

    return created[0];
  } catch (error) {
    console.error("[referralService] Error attaching referral to signup:", error);
    throw error;
  }
}

/**
 * PHASE 1: Parse referral ID from URL
 *
 * Extracts ?ref=<affiliateTag> from any shared URL
 */
export function extractReferralIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url, "http://localhost"); // Use base URL if relative
    return urlObj.searchParams.get("ref");
  } catch {
    return null;
  }
}

/**
 * PHASE 1: Append referral parameter to any URL
 *
 * Used by share middleware (Phase 7)
 */
export function appendReferralParam(url: string, affiliateTag: string): string {
  if (!affiliateTag) return url;

  try {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}ref=${affiliateTag}`;
  } catch (error) {
    console.error("[referralService] Error appending referral param:", error);
    return url;
  }
}

/**
 * Get referral stats for an affiliate user
 */
export async function getAffiliateReferralStats(affiliateUserId: string) {
  try {
    // Get all referrals for this user
    const allReferrals = await db
      .select()
      .from(referrals)
      .where(eq(referrals.affiliateUserId, affiliateUserId));

    const stats = {
      totalClicks: 0,
      signedUp: 0,
      activated: 0,
      paid: 0,
      referrals: allReferrals,
    };

    allReferrals.forEach((ref: any) => {
      if (ref.status === "clicked") stats.totalClicks++;
      if (ref.status === "signed_up" || ["activated", "paid"].includes(ref.status))
        stats.signedUp++;
      if (ref.status === "activated" || ref.status === "paid") stats.activated++;
      if (ref.status === "paid") stats.paid++;
    });

    return stats;
  } catch (error) {
    console.error("[referralService] Error getting referral stats:", error);
    throw error;
  }
}

/**
 * PHASE 3: Create commission when restaurant becomes a paying customer
 *
 * Called by Stripe webhook when invoice.payment_succeeded
 *
 * @param restaurantId - ID of the restaurant that paid
 * @param invoiceAmount - Amount paid on the invoice (in cents, converted to dollars)
 * @param invoiceId - Stripe invoice ID for tracking
 * @returns Commission details or null if no referral found
 */
export async function createCommissionForRestaurantPayment(
  restaurantId: string,
  invoiceAmount: number,
  invoiceId: string,
) {
  try {
    // Find the referral for this restaurant
    const referral = (
      await db
        .select()
        .from(referrals)
        .where(eq(referrals.referredRestaurantId, restaurantId))
        .limit(1)
    )[0];

    if (!referral) {
      console.log(`[Phase 3] No referral found for restaurant ${restaurantId}`);
      return null;
    }

    // Calculate 10% commission
    const commissionAmount = (invoiceAmount / 100) * 0.1; // invoiceAmount is in cents, convert and take 10%

    // Idempotency guard, the same one the bookings path uses in
    // affiliateCommissionService: Stripe delivers events at least once, so
    // a redelivered invoice.payment_succeeded must not create a second
    // commission (and a second credit). Serialize on the same key the
    // dedupe check uses — affiliate, commission source, Stripe invoice id —
    // because a read-then-insert check alone races under concurrent
    // deliveries of the same event.
    const commission = await db.transaction(async (tx: any) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`affiliate_commission:${referral.affiliateUserId}:subscription_payment:${invoiceId}`}))`,
      );

      const existing = await tx
        .select({ id: affiliateCommissionLedger.id })
        .from(affiliateCommissionLedger)
        .where(
          and(
            eq(affiliateCommissionLedger.affiliateUserId, referral.affiliateUserId),
            eq(affiliateCommissionLedger.commissionSource, "subscription_payment"),
            eq(affiliateCommissionLedger.stripeInvoiceId, invoiceId),
          ),
        )
        .limit(1);

      if (existing.length > 0) return null;

      const [inserted] = await tx
        .insert(affiliateCommissionLedger)
        .values({
          affiliateUserId: referral.affiliateUserId,
          referralId: referral.id,
          restaurantId,
          amount: commissionAmount.toString(),
          commissionSource: "subscription_payment",
          stripeInvoiceId: invoiceId,
        })
        .returning();
      return inserted;
    });

    if (!commission) {
      console.log(
        `[Phase 3] Duplicate subscription commission skipped for invoice ${invoiceId}`,
      );
      return null;
    }

    // Update referral status to 'paid'
    await db
      .update(referrals)
      .set({
        activatedAt: new Date(),
        commissionEligibleAt: new Date(),
        status: "paid",
      })
      .where(eq(referrals.id, referral.id));

    // PHASE 3 + 4 Integration: Create credit from commission
    try {
      const { createCreditFromCommission } = await import("./creditService");
      await createCreditFromCommission(
        referral.affiliateUserId,
        commission.id,
        commissionAmount,
      );
    } catch (creditError) {
      console.error(
        "[Phase 4] Error creating credit from commission:",
        creditError,
      );
      // Don't fail if credit creation fails
    }

    console.log("[Phase 3] Commission created:", {
      affiliateUserId: referral.affiliateUserId,
      restaurantId,
      amount: commissionAmount,
      invoiceId,
    });

    return commission;
  } catch (error) {
    console.error("[referralService] Error creating commission:", error);
    throw error;
  }
}

export default {
  recordReferralClick,
  attachReferralToSignup,
  extractReferralIdFromUrl,
  appendReferralParam,
  getAffiliateReferralStats,
  createCommissionForRestaurantPayment,
};
