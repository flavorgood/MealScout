import type { Express } from "express";
import { eq, and, or, sql, desc, isNull } from "drizzle-orm";
import Stripe from "stripe";
import { isAuthenticated, isStaffOrAdmin } from "../../unifiedAuth";
import { db } from "../../db";
import {
  users,
  restaurants,
  hosts,
  eventBookings,
  affiliateShareEvents,
  affiliateCommissionLedger,
  affiliateWithdrawals,
  creditLedger,
  userPayoutPreferences,
} from "@shared/schema";

// Same module-level Stripe client pattern as the host payout admin routes
// (server/routes/hostPayoutAdminRoutes.ts).
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// The provider reference for a sent affiliate payout is recorded on the
// withdrawal row itself, appended to its notes as a `stripe_transfer:<id>`
// token — the same audit convention the host payout flow uses on
// hostPayoutRequests.notes. Notes are preserved; the token is appended,
// never overwritten in.
const STRIPE_TRANSFER_REF_PATTERN = /stripe_transfer:(tr_[A-Za-z0-9]+)/;

function extractStripeTransferId(
  notes: string | null | undefined,
): string | null {
  if (!notes) return null;
  const match = notes.match(STRIPE_TRANSFER_REF_PATTERN);
  return match ? match[1] : null;
}

function appendStripeTransferRef(
  notes: string | null | undefined,
  transferId: string,
): string {
  const ref = `stripe_transfer:${transferId}`;
  return notes ? `${notes} ${ref}` : ref;
}

// Payout execution safety (audit fix, 2026-11-04):
//
// A withdrawal row is the only authority for its own payment. The affiliate
// picks a method + details when requesting; at APPROVAL time the admin's
// action snapshots the executable destination (the affiliate's Stripe
// Connect account id as it stands at that moment) onto the row itself as
// methodDetails.approvedExecution. Mark-paid may only execute against that
// snapshot — never against the affiliate's live payout preferences, which
// the affiliate can edit after approval (the preferences' stripeConnectedId
// is free text with no ownership verification anywhere in this codebase, so
// whatever is snapshotted at approval is the last point where a human
// reviewed the destination).
//
// Before any provider call, mark-paid atomically claims the row
// approved -> processing (guarded update). While a row is processing, no
// other action can move it: a second mark-paid reconciles instead of
// paying again, and reject refuses. The claim records its own snapshot
// (methodDetails.executionClaim, including the Stripe idempotency key), so
// a retry after a crash replays the SAME transfer instead of creating a
// second one, and the recorded transfer id in notes finalizes the row
// without any new provider call.
type ApprovedExecution = {
  rail: "stripe_transfer";
  destination: string | null;
  amount: string;
  currency: "usd";
  approvedBy: string;
  approvedAt: string;
};

type ExecutionClaim = {
  rail: "stripe_transfer";
  destination: string;
  amountCents: number;
  currency: "usd";
  idempotencyKey: string;
  claimedBy: string;
  claimedAt: string;
};

function methodDetailsRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
}

function readApprovedExecution(existing: any): ApprovedExecution | null {
  const exec = methodDetailsRecord(existing?.methodDetails).approvedExecution;
  if (
    !exec ||
    typeof exec !== "object" ||
    exec.rail !== "stripe_transfer" ||
    typeof exec.amount !== "string"
  ) {
    return null;
  }
  return exec as ApprovedExecution;
}

function readExecutionClaim(existing: any): ExecutionClaim | null {
  const claim = methodDetailsRecord(existing?.methodDetails).executionClaim;
  if (
    !claim ||
    typeof claim !== "object" ||
    claim.rail !== "stripe_transfer" ||
    typeof claim.destination !== "string" ||
    !claim.destination ||
    typeof claim.amountCents !== "number" ||
    typeof claim.idempotencyKey !== "string" ||
    !claim.idempotencyKey
  ) {
    return null;
  }
  return claim as ExecutionClaim;
}

type RequireAdminUser = (req: any, res: any) => boolean;

export function registerAffiliateAdminRoutes(
  app: Express,
  deps: {
    requireAdminUser: RequireAdminUser;
  },
) {
  const { requireAdminUser } = deps;

  app.get(
    "/api/admin/affiliates/users",
    isAuthenticated,
    isStaffOrAdmin,
    async (_req: any, res) => {
      try {
        const allUsers = await db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            userType: users.userType,
            affiliateTag: users.affiliateTag,
            affiliatePercent: users.affiliatePercent,
            affiliateCloserUserId: users.affiliateCloserUserId,
            affiliateBookerUserId: users.affiliateBookerUserId,
            stripeSubscriptionId: users.stripeSubscriptionId,
          })
          .from(users)
          .where(or(eq(users.isDisabled, false), isNull(users.isDisabled)))
          .orderBy(users.createdAt);

        const shareCounts = await db
          .select({
            affiliateUserId: affiliateShareEvents.affiliateUserId,
            count: sql<number>`count(*)`,
          })
          .from(affiliateShareEvents)
          .groupBy(affiliateShareEvents.affiliateUserId);

        type ShareCountRow = {
          affiliateUserId: string | null;
          count: number | string | null;
        };
        const shareCountMap = new Map(
          (shareCounts as ShareCountRow[]).map((row) => [
            row.affiliateUserId,
            Number(row.count ?? 0),
          ]),
        );

        const commissionSums = await db
          .select({
            affiliateUserId: affiliateCommissionLedger.affiliateUserId,
            earnedCents: sql<number>`coalesce(sum(${affiliateCommissionLedger.amount}), 0)`,
            revenueCents: sql<number>`coalesce(sum(${affiliateCommissionLedger.sourceAmountCents}), 0)`,
            subscriptionRevenueCents: sql<number>`coalesce(sum(case when ${affiliateCommissionLedger.commissionSource} = 'subscription_payment' then ${affiliateCommissionLedger.sourceAmountCents} else 0 end), 0)`,
            bookingRevenueCents: sql<number>`coalesce(sum(case when ${affiliateCommissionLedger.commissionSource} in ('booking_fee_host', 'booking_fee_truck') then ${affiliateCommissionLedger.sourceAmountCents} else 0 end), 0)`,
          })
          .from(affiliateCommissionLedger)
          .groupBy(affiliateCommissionLedger.affiliateUserId);

        type CommissionSumRow = {
          affiliateUserId: string | null;
          earnedCents: number | string | null;
          revenueCents: number | string | null;
          subscriptionRevenueCents: number | string | null;
          bookingRevenueCents: number | string | null;
        };
        const commissionMap = new Map(
          (commissionSums as CommissionSumRow[]).map((row) => [
            row.affiliateUserId,
            row,
          ]),
        );

        const referralRows = await db
          .select({
            id: users.id,
            affiliateCloserUserId: users.affiliateCloserUserId,
            affiliateBookerUserId: users.affiliateBookerUserId,
            stripeSubscriptionId: users.stripeSubscriptionId,
          })
          .from(users)
          .where(
            and(
              or(eq(users.isDisabled, false), isNull(users.isDisabled)),
              or(
                sql`${users.affiliateCloserUserId} is not null`,
                sql`${users.affiliateBookerUserId} is not null`,
              ),
            ),
          );

        const truckOwnerRows = await db
          .select({ ownerId: restaurants.ownerId })
          .from(eventBookings)
          .innerJoin(restaurants, eq(eventBookings.truckId, restaurants.id));

        const hostOwnerRows = await db
          .select({ ownerId: hosts.userId })
          .from(eventBookings)
          .innerJoin(hosts, eq(eventBookings.hostId, hosts.id));

        const bookingOwnerIds = new Set<string>();
        for (const row of truckOwnerRows) {
          if (row.ownerId) bookingOwnerIds.add(row.ownerId);
        }
        for (const row of hostOwnerRows) {
          if (row.ownerId) bookingOwnerIds.add(row.ownerId);
        }

        const referredMap = new Map<string, Set<string>>();
        const paidMap = new Map<string, Set<string>>();
        for (const row of referralRows) {
          const referrerIds = [
            row.affiliateCloserUserId,
            row.affiliateBookerUserId,
          ].filter((value): value is string => Boolean(value));
          if (referrerIds.length === 0) continue;

          for (const referrerId of referrerIds) {
            if (!referredMap.has(referrerId)) {
              referredMap.set(referrerId, new Set());
            }
            referredMap.get(referrerId)?.add(row.id);

            const isPaid =
              Boolean(row.stripeSubscriptionId) || bookingOwnerIds.has(row.id);
            if (isPaid) {
              if (!paidMap.has(referrerId)) {
                paidMap.set(referrerId, new Set());
              }
              paidMap.get(referrerId)?.add(row.id);
            }
          }
        }

        const payload = allUsers.map((user: (typeof allUsers)[number]) => {
          const commissions = commissionMap.get(user.id as string);
          const referred = referredMap.get(user.id);
          const paid = paidMap.get(user.id);

          return {
            ...user,
            linksShared: shareCountMap.get(user.id) ?? 0,
            peopleReferred: referred?.size ?? 0,
            paidReferrals: paid?.size ?? 0,
            affiliateEarningsCents: Number(commissions?.earnedCents ?? 0),
            mealScoutRevenueCents: Number(commissions?.revenueCents ?? 0),
            subscriptionRevenueCents: Number(
              commissions?.subscriptionRevenueCents ?? 0,
            ),
            bookingRevenueCents: Number(commissions?.bookingRevenueCents ?? 0),
          };
        });

        res.json(payload);
      } catch (error: any) {
        console.error("Error fetching affiliate users:", error);
        res.status(500).json({ message: "Failed to fetch affiliate users" });
      }
    },
  );

  app.patch(
    "/api/admin/affiliates/users/:id",
    isAuthenticated,
    isStaffOrAdmin,
    async (req: any, res) => {
      if (!requireAdminUser(req, res)) return;
      try {
        const targetUserId = req.params.id;
        const {
          affiliatePercent,
          affiliateCloserUserId,
          affiliateBookerUserId,
        } = req.body || {};

        const updates: any = {};
        if (affiliatePercent !== undefined) {
          const parsed = Number(affiliatePercent);
          if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
            return res
              .status(400)
              .json({ message: "affiliatePercent must be 0-100" });
          }
          updates.affiliatePercent = parsed;
        }

        if (affiliateCloserUserId !== undefined) {
          const closerId =
            affiliateCloserUserId === null || affiliateCloserUserId === ""
              ? null
              : String(affiliateCloserUserId);
          updates.affiliateCloserUserId = closerId;

          if (closerId) {
            const [closer] = await db
              .select({ affiliatePercent: users.affiliatePercent })
              .from(users)
              .where(eq(users.id, closerId))
              .limit(1);
            updates.affiliateCloserPercent = Math.max(
              Number(closer?.affiliatePercent ?? 5),
              0,
            );
          } else {
            updates.affiliateCloserPercent = null;
          }
        }

        if (affiliateBookerUserId !== undefined) {
          const bookerId =
            affiliateBookerUserId === null || affiliateBookerUserId === ""
              ? null
              : String(affiliateBookerUserId);
          updates.affiliateBookerUserId = bookerId;

          if (bookerId) {
            const [booker] = await db
              .select({ affiliatePercent: users.affiliatePercent })
              .from(users)
              .where(eq(users.id, bookerId))
              .limit(1);
            updates.affiliateBookerPercent = Math.max(
              Number(booker?.affiliatePercent ?? 5),
              0,
            );
          } else {
            updates.affiliateBookerPercent = null;
          }
        }

        if (Object.keys(updates).length === 0) {
          return res
            .status(400)
            .json({ message: "No affiliate fields to update" });
        }

        updates.updatedAt = new Date();

        const [updated] = await db
          .update(users)
          .set(updates)
          .where(eq(users.id, targetUserId))
          .returning();

        if (!updated) {
          return res.status(404).json({ message: "User not found" });
        }

        res.json({
          id: updated.id,
          affiliatePercent: updated.affiliatePercent,
          affiliateCloserUserId: updated.affiliateCloserUserId,
          affiliateBookerUserId: updated.affiliateBookerUserId,
          affiliateCloserPercent: (updated as any).affiliateCloserPercent ?? null,
          affiliateBookerPercent: (updated as any).affiliateBookerPercent ?? null,
        });
      } catch (error: any) {
        console.error("Error updating affiliate settings:", error);
        res
          .status(500)
          .json({ message: "Failed to update affiliate settings" });
      }
    },
  );

  app.get(
    "/api/admin/affiliate-payouts",
    isAuthenticated,
    isStaffOrAdmin,
    async (req: any, res) => {
      if (!requireAdminUser(req, res)) return;
      try {
        const status =
          typeof req.query?.status === "string" ? req.query.status : null;
        const baseQuery = db
          .select({
            id: affiliateWithdrawals.id,
            userId: affiliateWithdrawals.userId,
            amount: affiliateWithdrawals.amount,
            method: affiliateWithdrawals.method,
            status: affiliateWithdrawals.status,
            methodDetails: affiliateWithdrawals.methodDetails,
            creditLedgerId: affiliateWithdrawals.creditLedgerId,
            requestedAt: affiliateWithdrawals.requestedAt,
            processedAt: affiliateWithdrawals.processedAt,
            approvedAt: affiliateWithdrawals.approvedAt,
            approvedBy: affiliateWithdrawals.approvedBy,
            paidAt: affiliateWithdrawals.paidAt,
            rejectedAt: affiliateWithdrawals.rejectedAt,
            notes: affiliateWithdrawals.notes,
            userEmail: users.email,
            userFirstName: users.firstName,
            userLastName: users.lastName,
          })
          .from(affiliateWithdrawals)
          .innerJoin(users, eq(affiliateWithdrawals.userId, users.id));

        const rows = status
          ? await baseQuery
              .where(eq(affiliateWithdrawals.status, status))
              .orderBy(desc(affiliateWithdrawals.requestedAt))
          : await baseQuery.orderBy(desc(affiliateWithdrawals.requestedAt));

        res.json(rows);
      } catch (error: any) {
        console.error("Error fetching affiliate payouts:", error);
        res.status(500).json({ message: "Failed to fetch payout requests" });
      }
    },
  );

  app.post(
    "/api/admin/affiliate-payouts/:id/approve",
    isAuthenticated,
    isStaffOrAdmin,
    async (req: any, res) => {
      if (!requireAdminUser(req, res)) return;
      try {
        const payoutId = req.params.id;
        const [existing] = await db
          .select()
          .from(affiliateWithdrawals)
          .where(eq(affiliateWithdrawals.id, payoutId))
          .limit(1);

        if (!existing) {
          return res.status(404).json({ message: "Payout request not found" });
        }
        if (existing.status !== "pending") {
          return res.status(409).json({ message: "Payout is not pending" });
        }

        // Snapshot the execution terms onto the request itself at the
        // moment of approval: the amount as approved and the affiliate's
        // Stripe destination as it stands NOW. Mark-paid executes only
        // against this snapshot, so a later edit to the affiliate's payout
        // preferences cannot redirect an already-approved payout. The
        // destination may be null (affiliate has no Stripe destination on
        // file); approval still stands, and mark-paid will refuse with the
        // reason rather than paying an unverified destination.
        const [prefs] = await db
          .select({
            stripeConnectedId: userPayoutPreferences.stripeConnectedId,
          })
          .from(userPayoutPreferences)
          .where(eq(userPayoutPreferences.userId, existing.userId))
          .limit(1);
        const approvedAt = new Date();
        const execution: ApprovedExecution = {
          rail: "stripe_transfer",
          destination: prefs?.stripeConnectedId?.trim() || null,
          amount: String(existing.amount),
          currency: "usd",
          approvedBy: String(req.user.id),
          approvedAt: approvedAt.toISOString(),
        };

        const [updated] = await db
          .update(affiliateWithdrawals)
          .set({
            status: "approved",
            approvedAt,
            approvedBy: req.user.id,
            methodDetails: {
              ...methodDetailsRecord(existing.methodDetails),
              approvedExecution: execution,
            },
          })
          .where(
            and(
              eq(affiliateWithdrawals.id, payoutId),
              eq(affiliateWithdrawals.status, "pending"),
            ),
          )
          .returning();

        if (!updated) {
          return res.status(409).json({ message: "Payout is not pending" });
        }

        res.json(updated);
      } catch (error: any) {
        console.error("Error approving affiliate payout:", error);
        res.status(500).json({ message: "Failed to approve payout" });
      }
    },
  );

  app.post(
    "/api/admin/affiliate-payouts/:id/mark-paid",
    isAuthenticated,
    isStaffOrAdmin,
    async (req: any, res) => {
      if (!requireAdminUser(req, res)) return;
      try {
        const payoutId = req.params.id;
        const [existing] = await db
          .select()
          .from(affiliateWithdrawals)
          .where(eq(affiliateWithdrawals.id, payoutId))
          .limit(1);

        if (!existing) {
          return res.status(404).json({ message: "Payout request not found" });
        }
        if (existing.status === "paid") {
          return res
            .status(409)
            .json({ message: "Payout already marked paid" });
        }
        if (existing.status === "rejected") {
          return res.status(409).json({ message: "Payout was rejected" });
        }

        // Resolve the claim this call executes against. Two entry states:
        //  - "approved": first attempt. Execution terms come from the
        //    approval snapshot on the row itself. Without one there is no
        //    verified destination on the request, and this action refuses
        //    rather than falling back to the affiliate's live (mutable,
        //    unverified) payout preferences — legacy approvals predate the
        //    snapshot; reject them to restore the affiliate's credit, or
        //    settle them outside this action.
        //  - "processing": a previous attempt claimed the row and its
        //    outcome is unknown (crash, timeout, provider error). The
        //    claim recorded on the row governs the retry.
        let claim = readExecutionClaim(existing);
        let working = existing;

        if (existing.status === "approved") {
          const execution = readApprovedExecution(existing);
          if (!execution) {
            return res.status(409).json({
              message:
                "Cannot pay: no execution snapshot was recorded at approval for this payout, so there is no verified destination on the request itself",
            });
          }
          if (!execution.destination) {
            return res.status(409).json({
              message:
                "Cannot pay: no Stripe payout destination was recorded at approval for this affiliate",
            });
          }
          if (String(existing.amount) !== execution.amount) {
            return res.status(409).json({
              message:
                "Cannot pay: the payout amount no longer matches the amount recorded at approval",
            });
          }
          const amountCents = Math.round(
            parseFloat(execution.amount || "0") * 100,
          );
          if (!Number.isFinite(amountCents) || amountCents <= 0) {
            return res
              .status(400)
              .json({ message: "Payout amount is invalid" });
          }
          claim = {
            rail: "stripe_transfer",
            destination: execution.destination,
            amountCents,
            currency: execution.currency,
            idempotencyKey: `affiliate_withdrawal_${existing.id}`,
            claimedBy: String(req.user?.id || ""),
            claimedAt: new Date().toISOString(),
          };
          // Atomically claim the row BEFORE any provider call. If another
          // action already moved it (a second mark-paid claimed it, or a
          // reject landed), this update matches nothing and the call stops
          // here — money can never be sent twice, and credit can never be
          // restored for a payout that is being sent.
          const [claimed] = await db
            .update(affiliateWithdrawals)
            .set({
              status: "processing",
              methodDetails: {
                ...methodDetailsRecord(existing.methodDetails),
                executionClaim: claim,
              },
            })
            .where(
              and(
                eq(affiliateWithdrawals.id, payoutId),
                eq(affiliateWithdrawals.status, "approved"),
              ),
            )
            .returning();
          if (!claimed) {
            return res.status(409).json({
              message:
                "Payout state changed before payment could start — reload and retry",
            });
          }
          working = claimed;
        } else if (existing.status === "processing") {
          if (!claim) {
            return res.status(409).json({
              message:
                "Cannot pay: this payout is marked processing but carries no execution claim — reconcile it manually before retrying",
            });
          }
        } else {
          return res.status(409).json({ message: "Payout is not approved" });
        }

        if (!claim) {
          // Unreachable by construction (both entry branches above either
          // set the claim or return); kept as a fail-closed guard.
          return res.status(409).json({
            message: "Cannot pay: payout carries no execution claim",
          });
        }

        // Reconcile before sending: a transfer reference already recorded
        // on the row means the money was already sent (a previous attempt
        // crashed between the provider call and finalizing). Finalize from
        // the record — never send again.
        let transferId = extractStripeTransferId(working.notes);
        if (!transferId) {
          if (!stripe) {
            return res.status(503).json({
              message: "Stripe is not configured on this server",
            });
          }
          // Send against the CLAIM snapshot only: destination, amount,
          // currency and idempotency key all come from the row, never from
          // live preferences. The idempotency key is the withdrawal id, so
          // if a previous attempt created the transfer but crashed before
          // recording it, Stripe replays that same transfer here instead
          // of paying twice. A provider failure leaves the row processing
          // (outcome uncertain): reject stays refused and a mark-paid
          // retry reconciles — the row is never silently returned to
          // approved.
          let transfer: Stripe.Transfers.Transfer;
          try {
            transfer = await stripe.transfers.create(
              {
                amount: claim.amountCents,
                currency: claim.currency,
                destination: claim.destination,
                description: `MealScout affiliate payout — withdrawal ${working.id}`,
                metadata: {
                  affiliateWithdrawalId: working.id,
                  affiliateUserId: working.userId,
                  adminUserId: String(req.user?.id || ""),
                },
              },
              { idempotencyKey: claim.idempotencyKey },
            );
          } catch (transferErr: any) {
            console.error(
              `Error creating Stripe transfer for affiliate payout ${working.id}:`,
              transferErr,
            );
            return res.status(502).json({
              message: `Stripe transfer failed: ${transferErr?.message || "unknown error"} — the payout stays in processing; retry mark-paid to reconcile before taking any other action`,
            });
          }
          transferId = transfer.id;
        }

        const paidAt = new Date();
        const [updated] = await db
          .update(affiliateWithdrawals)
          .set({
            status: "paid",
            paidAt,
            processedAt: paidAt,
            notes: extractStripeTransferId(working.notes)
              ? working.notes
              : appendStripeTransferRef(working.notes, transferId),
          })
          .where(
            and(
              eq(affiliateWithdrawals.id, payoutId),
              eq(affiliateWithdrawals.status, "processing"),
            ),
          )
          .returning();

        if (!updated) {
          // The money moved but the row is no longer processing. Surface
          // the transfer id loudly rather than pretending success or
          // failure — a human reconciles this row against Stripe.
          return res.status(409).json({
            message: `Stripe transfer ${transferId} was sent for this payout, but the payout row changed state before it could be marked paid — reconcile it manually in Stripe`,
          });
        }

        if (working.creditLedgerId) {
          await db
            .update(creditLedger)
            .set({
              redeemedFor: "cash_payout",
              redeemedAt: new Date(),
            })
            .where(eq(creditLedger.id, working.creditLedgerId));
        }

        res.json(updated);
      } catch (error: any) {
        console.error("Error marking affiliate payout paid:", error);
        res.status(500).json({ message: "Failed to mark payout paid" });
      }
    },
  );

  app.post(
    "/api/admin/affiliate-payouts/:id/reject",
    isAuthenticated,
    isStaffOrAdmin,
    async (req: any, res) => {
      if (!requireAdminUser(req, res)) return;
      try {
        const payoutId = req.params.id;
        const reason =
          typeof req.body?.reason === "string" ? req.body.reason : null;
        const [existing] = await db
          .select()
          .from(affiliateWithdrawals)
          .where(eq(affiliateWithdrawals.id, payoutId))
          .limit(1);

        if (!existing) {
          return res.status(404).json({ message: "Payout request not found" });
        }
        if (existing.status === "paid") {
          return res.status(409).json({ message: "Payout already paid" });
        }
        if (existing.status === "rejected") {
          return res.status(409).json({ message: "Payout already rejected" });
        }
        // A payout whose payment has started — or whose outcome is still
        // unknown — must never be rejected: rejection restores the
        // affiliate's credit, and credit restored on top of a sent (or
        // possibly sent) transfer pays the affiliate twice.
        if (existing.status === "processing") {
          return res.status(409).json({
            message:
              "Payout is being processed — it cannot be rejected until the payment outcome is known",
          });
        }
        const recordedTransferId = extractStripeTransferId(existing.notes);
        if (recordedTransferId) {
          return res.status(409).json({
            message: `Cannot reject: a Stripe transfer (${recordedTransferId}) is already recorded for this payout`,
          });
        }

        const amountNum = parseFloat(existing.amount?.toString() || "0");

        let stateChanged = false;
        await db.transaction(async (tx: any) => {
          // Guarded claim for rejection, in the same transaction as the
          // credit reversal below: only a request still pending or
          // approved can be rejected. If a mark-paid claim (processing) or
          // a payment landed after the read above, this update matches
          // nothing, the transaction writes nothing else, and the caller
          // answers 409 — the reversal can no longer race a payment.
          const [rejectedRow] = await tx
            .update(affiliateWithdrawals)
            .set({
              status: "rejected",
              rejectedAt: new Date(),
              notes: reason || existing.notes,
            })
            .where(
              and(
                eq(affiliateWithdrawals.id, payoutId),
                or(
                  eq(affiliateWithdrawals.status, "pending"),
                  eq(affiliateWithdrawals.status, "approved"),
                ),
              ),
            )
            .returning();
          if (!rejectedRow) {
            stateChanged = true;
            return;
          }

          const reversalExists = (
            await tx
              .select({ id: creditLedger.id })
              .from(creditLedger)
              .where(
                and(
                  eq(creditLedger.userId, existing.userId),
                  eq(creditLedger.sourceType, "cash_payout_reversal"),
                  eq(creditLedger.sourceId, payoutId),
                ),
              )
              .limit(1)
          )[0];

          if (!reversalExists && amountNum > 0) {
            await tx.insert(creditLedger).values({
              userId: existing.userId,
              amount: amountNum.toString(),
              sourceType: "cash_payout_reversal",
              sourceId: payoutId,
            });
          }

          if (existing.creditLedgerId) {
            await tx
              .update(creditLedger)
              .set({ redeemedFor: "cash_payout_rejected" })
              .where(eq(creditLedger.id, existing.creditLedgerId));
          }
        });

        if (stateChanged) {
          return res.status(409).json({
            message:
              "Payout state changed before it could be rejected — reload and retry",
          });
        }

        res.json({ success: true });
      } catch (error: any) {
        console.error("Error rejecting affiliate payout:", error);
        res.status(500).json({ message: "Failed to reject payout" });
      }
    },
  );
}
