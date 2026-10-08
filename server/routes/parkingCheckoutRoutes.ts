import type { Express } from "express";
import type Stripe from "stripe";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { eventBookings, events, users } from "@shared/schema";
import { db } from "../db";
import { storage } from "../storage";
import { isAuthenticated } from "../unifiedAuth";

type Hold = typeof eventBookings.$inferSelect;
type CancellationTarget = Pick<Hold, "id" | "truckId" | "eventId"> & {
  eventType: (typeof events.$inferSelect)["eventType"] | null;
};
type IntentReader = Pick<Stripe["paymentIntents"], "retrieve" | "cancel">;
class CancellationDeferred extends Error {
  constructor(readonly status: 409 | 503, message: string) { super(message); }
}
const unavailable = () => new CancellationDeferred(503, "Cancellation is not verified. Your booking hold was retained. Check its status before paying again.");
const conflict = () => new CancellationDeferred(409, "Payment or booking status requires reconciliation. The existing booking was not released.");
const unpaid = (intent: Stripe.PaymentIntent) => intent.amount_received === 0 && intent.amount_capturable === 0;
const safeMoney = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const cancelable = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);
const requestOptions: Stripe.RequestOptions = { timeout: 6000, maxNetworkRetries: 0 };

function assertIntentBinding(intent: Stripe.PaymentIntent, id: string, rows: Hold[]) {
  const first = rows[0];
  const total = rows.reduce((n, r) => n + r.totalCents, 0);
  const fee = rows.reduce((n, r) => n + r.platformFeeCents, 0);
  const destination = first?.stripeTransferDestination || null;
  const actualDestination = typeof intent?.transfer_data?.destination === "string"
    ? intent.transfer_data.destination : intent?.transfer_data?.destination?.id || null;
  if (!first || intent?.id !== id || intent.currency !== "usd" || !safeMoney(total) || total <= 0 || intent.amount !== total ||
      intent.metadata?.truckId !== first.truckId || intent.metadata?.hostId !== first.hostId ||
      intent.metadata?.totalCents !== String(total) || !rows.some(r => r.eventId === intent.metadata?.passId) ||
      !rows.every(r => r.truckId === first.truckId && r.hostId === first.hostId &&
        safeMoney(r.totalCents) && safeMoney(r.hostPriceCents) && safeMoney(r.platformFeeCents) &&
        r.totalCents === r.hostPriceCents + r.platformFeeCents && (r.stripeTransferDestination || null) === destination) ||
      actualDestination !== destination || (intent.application_fee_amount ?? null) !== (destination ? fee : null)) throw conflict();
}

async function positivelyCancel(provider: IntentReader, id: string, rows: Hold[]) {
  // Parking Pass creates platform-owned destination charges. A host's transfer
  // destination is not the Stripe account that owns the PaymentIntent.
  let intent: Stripe.PaymentIntent;
  try { intent = await provider.retrieve(id, {}, requestOptions); } catch { throw unavailable(); }
  assertIntentBinding(intent, id, rows);
  if (!unpaid(intent) || ["succeeded", "processing", "requires_capture"].includes(intent.status)) throw conflict();
  if (intent.status !== "canceled") {
    if (!cancelable.has(intent.status)) throw conflict();
    try {
      intent = await provider.cancel(id, { cancellation_reason: "requested_by_customer" }, {
        ...requestOptions,
        idempotencyKey: `parking-pass-checkout-cancel:${createHash("sha256").update(id).digest("hex")}`,
      });
    } catch {
      // Never retry the mutation after uncertain delivery. A fresh read may
      // establish cancellation or a payment that won the race.
      try { intent = await provider.retrieve(id, {}, requestOptions); } catch { throw unavailable(); }
    }
    assertIntentBinding(intent, id, rows);
  }
  if (!unpaid(intent) || ["succeeded", "processing", "requires_capture"].includes(intent.status)) throw conflict();
  if (intent.status !== "canceled") throw unavailable();
}

/** Intercept only Parking Pass checkout cancellations on the existing endpoint.
 * Ordinary event cancellation and all other booking routes remain unchanged.
 * This registration must precede registerBookingRoutes in the canonical registry.
 */
export function registerParkingCheckoutRoutes(app: Express, { stripe }: { stripe: Stripe | null }) {
  app.post("/api/bookings/payment-intent/:paymentIntentId/cancel", isAuthenticated, async (req: any, res, next) => {
    try {
      const id = String(req.params.paymentIntentId || "").trim();
      const truckId = String(req.query?.truckId || "").trim();
      if (!/^pi_[A-Za-z0-9_-]{1,240}$/.test(id) || !truckId || truckId.length > 255) {
        return res.status(400).json({ message: "A valid PaymentIntent and truck are required." });
      }
      const authorized = await storage.verifyRestaurantOwnership(truckId, req.user.id, "manageParkingPass");
      const admin = ["admin", "duper_admin", "super_admin", "staff"].includes(req.user?.userType || "");
      if (!authorized && !admin) return res.status(403).json({ message: "Not authorized" });
      const initial: CancellationTarget[] = await db.select({ id: eventBookings.id, truckId: eventBookings.truckId, eventId: eventBookings.eventId, eventType: events.eventType })
        .from(eventBookings).leftJoin(events, eq(events.id, eventBookings.eventId))
        .where(eq(eventBookings.stripePaymentIntentId, id));
      if (!initial.some(row => row.eventType === "parking_pass")) return next();
      if (initial.some(row => row.truckId !== truckId)) return res.status(403).json({ message: "Not authorized" });
      if (initial.some(row => row.eventType !== "parking_pass")) throw conflict();
      if (!stripe) throw unavailable();
      const initialIds = initial.map(row => row.id).sort();
      const eventIds = [...new Set(initial.map(row => row.eventId))].sort();
      const outcome = await db.transaction(async (tx: any) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
        // Same payment lock and event-before-hold ordering as webhook settlement.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`payment_intent_credit:${id}`}))`);
        const selectedEvents = await tx.select().from(events).where(inArray(events.id, eventIds)).orderBy(asc(events.id)).for("update");
        const rows: Hold[] = await tx.select().from(eventBookings).where(eq(eventBookings.stripePaymentIntentId, id)).orderBy(asc(eventBookings.id)).for("update");
        if (rows.length !== initialIds.length || rows.some((r, i) => r.id !== initialIds[i] || r.truckId !== truckId) ||
            selectedEvents.length !== eventIds.length || selectedEvents.some((e: any) => e.eventType !== "parking_pass" || rows.some(r => r.eventId === e.id && r.hostId !== e.hostId))) throw conflict();
        if (rows.some(r => r.paidAt || r.bookingConfirmedAt || r.status === "confirmed" ||
          ["succeeded", "processing", "requires_capture", "bypassed"].includes(r.stripePaymentStatus || "") ||
          (r.refundStatus && r.refundStatus !== "none"))) throw conflict();
        const pending = rows.every(r => r.status === "pending" && !r.cancelledAt);
        const cancelled = rows.every(r => r.status === "cancelled" && ["canceled", "cancelled"].includes(r.stripePaymentStatus || ""));
        if (!pending && !cancelled) throw conflict();
        await positivelyCancel(stripe.paymentIntents, id, rows);
        // A replay never rewrites timestamps, cancellation reasons, or ledgers.
        if (cancelled) return { ok: true, status: "cancelled", cancelledBookings: 0 };
        const changed = await tx.update(eventBookings).set({
          status: "cancelled", stripePaymentStatus: "canceled", cancelledAt: sql`now()`,
          cancellationReason: "Checkout cancelled", updatedAt: sql`now()`,
        }).where(and(inArray(eventBookings.id, initialIds), eq(eventBookings.status, "pending"),
          eq(eventBookings.stripePaymentIntentId, id), isNull(eventBookings.paidAt), isNull(eventBookings.bookingConfirmedAt)))
          .returning({ id: eventBookings.id });
        if (changed.length !== rows.length) throw conflict();
        // Release only this caller's matching, unredeemed promo reservation,
        // atomically with its positively cancelled holds; preserve other settings.
        const [user] = await tx.select().from(users).where(eq(users.id, req.user.id)).for("update");
        const settings = user?.accountSettings || {}, promos = settings.promos || {}, promo = promos.bookingFee10 || {};
        if (promo.pendingPaymentIntentId === id && !promo.redeemedPaymentIntentId) {
          await tx.update(users).set({ accountSettings: { ...settings, promos: { ...promos, bookingFee10: { ...promo, pendingPaymentIntentId: null, pendingAt: null } } } }).where(eq(users.id, req.user.id));
        }
        return { ok: true, status: "cancelled", cancelledBookings: changed.length };
      });
      return res.json(outcome);
    } catch (error) {
      const deferred = error instanceof CancellationDeferred ? error : unavailable();
      console.error("[parking-cancel] Cancellation not verified; original booking retained", { status: deferred.status });
      return res.status(deferred.status).json({ code: "booking_cancel_unresolved", message: deferred.message });
    }
  });
}
