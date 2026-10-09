import { useState, useEffect, useRef } from "react";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import PaymentBrowserGate from "@/components/payment-browser-gate";
import { isPaymentHostileBrowser } from "@/lib/inAppBrowser";
import { apiUrl } from "@/lib/api";
import { getStripePromise } from "@/lib/stripeClient";
import { useAuth } from "@/hooks/useAuth";
import { loadParkingBookingRequest, prepareParkingBookingRequest, clearParkingBookingRequest, assertParkingBookingReplayAge, type ParkingBookingRequest } from "@/lib/parking-booking-request";

const buildTimeStripePublicKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY || "";

function recordRouteBookingConfirmed(passId: string) {
  try {
    const raw = sessionStorage.getItem("mealscout_route_booking_context");
    if (!raw) return;
    const context = JSON.parse(raw);
    sessionStorage.removeItem("mealscout_route_booking_context");
    void fetch(apiUrl("/api/parking-pass/routes/events"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName: "route_booking_confirmed",
        properties: { ...context, passId },
      }),
    }).catch(() => {
      // Telemetry failure must not interrupt a confirmed booking.
    });
  } catch {}
}

interface BookingPaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  passId: string;
  truckId: string;
  slotTypes: string[];
  selectedDates?: string[];
  eventDetails: {
    name: string;
    date: string;
    startTime: string;
    endTime: string;
    hostName: string;
    hostPrice?: number;
    slotSummary?: string;
  };
  bookingContext?: {
    weather: {
      summary: string;
      loading?: boolean;
    };
    footTraffic: {
      summary: string;
      loading?: boolean;
    };
    truckActivity: {
      summary: string;
    };
    truckReviews: {
      summary: string;
    };
  };
  onSuccess: (result: { outcome: "confirmed" | "pending" | "credited" }) => void;
}

type PaymentActivity = "idle" | "processing" | "uncertain";

interface PaymentFormProps {
  clientSecret: string;
  paymentIntentId: string;
  passId: string;
  truckId: string;
  totalCents: number;
  breakdown: {
    hostPrice: number;
    platformFee: number;
    creditsApplied?: number;
    promoDiscount?: number;
    promoCode?: string;
  };
  onSuccess: (outcome: "confirmed" | "pending" | "credited") => void;
  onCancel: () => void;
  onActivityChange: (activity: PaymentActivity) => void;
}

function PaymentForm({
  clientSecret,
  paymentIntentId,
  passId,
  truckId,
  totalCents,
  breakdown,
  onSuccess,
  onCancel,
  onActivityChange,
}: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);
  const [needsStatusCheck, setNeedsStatusCheck] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);
  const processingRef = useRef(false);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const waitForBookingConfirmation = async () => {
    const startedAt = Date.now();
    const timeoutMs = 25_000;

    while (activeRef.current && Date.now() - startedAt < timeoutMs) {
      try {
        const res = await fetch(
          apiUrl(
            `/api/bookings/payment-intent/${encodeURIComponent(
              paymentIntentId,
            )}?truckId=${encodeURIComponent(truckId)}`,
          ),
          {
            credentials: "include",
          },
        );
        if (res.ok) {
          const data = await res.json();
          if (data?.status === "confirmed") return "confirmed" as const;
          if (data?.status === "credited") return "credited" as const;
        }
      } catch {
        // ignore transient network issues; keep polling
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    return "pending" as const;
  };

  const completeBooking = (status: "confirmed" | "pending" | "credited") => {
    if (!activeRef.current) return;
    if (status === "credited") {
      toast({
        title: "Booking Unavailable",
        description:
          "Payment succeeded but the spot was no longer available. Credits were issued to your account.",
        variant: "destructive",
      });
    } else {
      toast({
        title: status === "confirmed" ? "Parking Pass Confirmed!" : "Booking confirmation pending",
        description: status === "confirmed"
          ? "Your parking spot has been reserved."
          : "Your booking is not confirmed yet. Check My Schedule before paying again.",
      });
      // Only a server-confirmed booking is a confirmed conversion.
      if (status === "confirmed") recordRouteBookingConfirmed(passId);
    }
    onSuccess(status);
  };

  const checkBookingStatus = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setIsProcessing(true);
    onActivityChange("processing");
    let settled = false;
    try {
      const status = await waitForBookingConfirmation();
      if (!activeRef.current) return;
      if (status === "confirmed" || status === "credited") {
        settled = true;
        completeBooking(status);
      } else {
        setPaymentMessage("Booking status is still pending. Check My Schedule before starting another payment.");
      }
    } finally {
      processingRef.current = false;
      if (activeRef.current) {
        setIsProcessing(false);
        onActivityChange(settled ? "idle" : "uncertain");
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || processingRef.current || needsStatusCheck) return;

    processingRef.current = true;
    setIsProcessing(true);
    setPaymentMessage(null);
    onActivityChange("processing");
    let unresolved = false;
    try {
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/parking-pass?booking=success`,
        },
        redirect: "if_required",
      });
      if (!activeRef.current) return;
      if (error) {
        unresolved = error.type !== "card_error" && error.type !== "validation_error";
        setNeedsStatusCheck(unresolved);
        setPaymentMessage(error.message || "Payment could not be confirmed.");
        return;
      }
      if (!paymentIntent || !["succeeded", "processing", "requires_capture"].includes(paymentIntent.status)) {
        unresolved = true;
        setNeedsStatusCheck(true);
        setPaymentMessage("Payment status is unknown. Check this booking before paying again.");
        return;
      }
      const status = await waitForBookingConfirmation();
      completeBooking(status);
    } catch (err: any) {
      unresolved = true;
      if (activeRef.current) {
        setNeedsStatusCheck(true);
        setPaymentMessage(err.message || "The connection was interrupted. Payment status is unknown.");
      }
    } finally {
      processingRef.current = false;
      if (activeRef.current) {
        setIsProcessing(false);
        onActivityChange(unresolved ? "uncertain" : "idle");
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-busy={isProcessing}>
      {/* Pricing Breakdown */}
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-2 text-sm">
        <div className="flex items-center justify-between text-[color:var(--text-secondary)]">
          <span>Host Location Fee</span>
          <span className="font-medium">
            ${(breakdown.hostPrice / 100).toFixed(2)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[color:var(--text-secondary)]">
          <span>MealScout Platform Fee</span>
          <span className="font-medium">
            ${(breakdown.platformFee / 100).toFixed(2)}
          </span>
        </div>
        {breakdown.creditsApplied ? (
          <div className="flex items-center justify-between text-[color:var(--status-success)]">
            <span>Credits Applied</span>
            <span className="font-medium">
              -${(breakdown.creditsApplied / 100).toFixed(2)}
            </span>
          </div>
        ) : null}
        {breakdown.promoDiscount ? (
          <div className="flex items-center justify-between text-[color:var(--status-success)]">
            <span>
              Promo Applied{breakdown.promoCode ? ` (${breakdown.promoCode})` : ""}
            </span>
            <span className="font-medium">
              -${(breakdown.promoDiscount / 100).toFixed(2)}
            </span>
          </div>
        ) : null}
        <div className="border-t border-[var(--border-subtle)] pt-2 flex items-center justify-between font-semibold text-[color:var(--text-primary)]">
          <span>Total</span>
          <span className="text-lg">${(totalCents / 100).toFixed(2)}</span>
        </div>
        <p className="text-xs text-[color:var(--text-muted)] pt-1">
          All fees included. No hidden charges.
        </p>
      </div>

      {/* Stripe Payment Element */}
      <div className="border border-[var(--border-subtle)] rounded-lg p-4 bg-[var(--bg-surface)]">
        <PaymentElement />
      </div>

      {paymentMessage ? <p role="alert" className="text-sm text-destructive">{paymentMessage}</p> : null}
      {isProcessing ? <p role="status" className="text-sm">Checking payment and booking status. Please keep this checkout open.</p> : null}
      {needsStatusCheck ? (
        <div className="space-y-2">
          <p className="text-sm" role="status">Do not submit another payment until the existing booking has been checked.</p>
          <Button type="button" variant="outline" className="w-full" disabled={isProcessing} onClick={checkBookingStatus}>
            Check booking status
          </Button>
        </div>
      ) : null}
      {/* Action Buttons */}
      <div className="flex gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={onCancel}
          disabled={isProcessing}
        >
          {needsStatusCheck ? "Close checkout" : "Cancel"}
        </Button>
        <Button
          type="submit"
          className="flex-1"
          disabled={!stripe || !elements || isProcessing || needsStatusCheck}
        >
          {isProcessing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing...
            </>
          ) : (
            `Pay $${(totalCents / 100).toFixed(2)}`
          )}
        </Button>
      </div>

      {/* Terms Notice */}
      <p className="text-xs text-[color:var(--text-muted)] text-center">
        By confirming payment, you acknowledge bookings are non-refundable once confirmed.
      </p>
    </form>
  );
}

export function BookingPaymentModal(props: BookingPaymentModalProps) {
  const { user } = useAuth();
  const userId = user?.id || "";
  // A closed checkout or a different actor/booking must not inherit a payment
  // form, in-flight callbacks, or mutable request refs from an earlier session.
  if (!props.open) return null;
  return <BookingPaymentSession key={JSON.stringify([userId, props.passId, props.truckId])} {...props} userId={userId} />;
}

function BookingPaymentSession({
  open,
  onOpenChange,
  passId,
  truckId,
  slotTypes,
  selectedDates = [],
  eventDetails,
  bookingContext,
  onSuccess,
  userId,
}: BookingPaymentModalProps & { userId: string }) {
  const { toast } = useToast();
  const requestScope = { userId, passId, truckId };
  const [savedRequest, setSavedRequest] = useState<ParkingBookingRequest | null>(null);
  const [requestMessage, setRequestMessage] = useState("");
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const requestScopeRef = useRef("");
  requestScopeRef.current = JSON.stringify([userId, passId, truckId, open]);
  useEffect(() => {
    requestScopeRef.current = JSON.stringify([userId, passId, truckId, open]);
    return () => { requestScopeRef.current = ""; };
  }, [userId, passId, truckId, open]);
  const [isLoading, setIsLoading] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [bookingData, setBookingData] = useState<{
    totalCents: number;
    breakdown: {
      hostPrice: number;
      platformFee: number;
      creditsApplied?: number;
      promoDiscount?: number;
      promoCode?: string;
    };
  } | null>(null);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [creditStatus, setCreditStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const creditRequestRef = useRef(0);
  const initiatePendingRef = useRef(false);
  const paymentActivityRef = useRef<PaymentActivity>("idle");
  const [creditsToApply, setCreditsToApply] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [stripePublishableKey, setStripePublishableKey] = useState(
    buildTimeStripePublicKey,
  );
  const [isStripeConfigLoading, setIsStripeConfigLoading] = useState(false);
  // true = host has Stripe Connect ready; false = payment held on platform, host payout deferred
  const [hostPaymentsReady, setHostPaymentsReady] = useState<boolean | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const stage: "review" | "pay" = clientSecret ? "pay" : "review";
  const stripePromise = getStripePromise(stripePublishableKey);
  const hostileBrowser = isPaymentHostileBrowser();

  useEffect(() => {
    let cancelled = false;
    if (open) {
      if (!stripePublishableKey) {
        setIsStripeConfigLoading(true);
        fetch(apiUrl("/api/payments/stripe-config"))
          .then(async (res) => {
            if (!res.ok) return null;
            return res.json();
          })
          .then((data) => {
            if (cancelled) return;
            const runtimeKey = String(data?.publishableKey || "").trim();
            if (runtimeKey) {
              setStripePublishableKey(runtimeKey);
            } else {
              toast({
                title: "Payments Unavailable",
                description: "Stripe is not configured for this environment.",
                variant: "destructive",
              });
              onOpenChange(false);
            }
          })
          .catch(() => {
            if (cancelled) return;
            toast({
              title: "Payments Unavailable",
              description: "Stripe configuration could not be loaded.",
              variant: "destructive",
            });
            onOpenChange(false);
          })
          .finally(() => {
            if (!cancelled) setIsStripeConfigLoading(false);
          });
      }
      loadCreditBalance();
    }
    return () => {
      cancelled = true;
      creditRequestRef.current++;
    };
  }, [open, stripePublishableKey, toast, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setSavedRequest(null);
    setRequestMessage("");
    setRecoveryBlocked(false);
    if (!userId) return;
    try {
      const saved = loadParkingBookingRequest({ userId, passId, truckId });
      setSavedRequest(saved);
      if (saved) {
        setCreditsToApply(saved.body.applyCreditsCents ? String(saved.body.applyCreditsCents / 100) : "");
        setPromoCode(saved.body.promoCode || "");
        assertParkingBookingReplayAge(saved);
      }
    } catch (error) {
      setRecoveryBlocked(true);
      setRequestMessage(error instanceof Error ? error.message : "Booking recovery is unavailable.");
    }
  }, [open, userId, passId, truckId]);

  const cancelCheckout = async (intentId: string) => {
    try {
      await fetch(
        apiUrl(
          `/api/bookings/payment-intent/${encodeURIComponent(intentId)}/cancel?truckId=${encodeURIComponent(
            truckId,
          )}`,
        ),
        { method: "POST", credentials: "include" },
      );
    } catch {
      // Keep the saved request: a lost response is not verified cancellation.
      // Even HTTP 200 from the legacy route does not prove provider cancellation.
    }
  };

  const loadCreditBalance = async () => {
    const request = ++creditRequestRef.current;
    setCreditBalance(null);
    setCreditStatus("loading");
    try {
      const res = await fetch(apiUrl("/api/payout/balance"), {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Credit balance unavailable");
      const data = await res.json();
      if (request !== creditRequestRef.current) return;
      const balance = Number(data.balance);
      if (data.balance == null || !Number.isFinite(balance) || balance < 0) {
        throw new Error("Credit balance unavailable");
      }
      setCreditBalance(balance);
      setCreditStatus("ready");
    } catch {
      if (request === creditRequestRef.current) setCreditStatus("unavailable");
    }
  };

  const clearSaved = () => {
    if (!idempotencyKeyRef.current) return;
    try {
      clearParkingBookingRequest(requestScope, idempotencyKeyRef.current);
      setSavedRequest(null);
    } catch { /* Retaining a receipt is safer than silently creating a new request. */ }
  };

  const initiateBooking = async () => {
    if (initiatePendingRef.current || isLoading || clientSecret || recoveryBlocked) return;
    if (!userId) { setRequestMessage("Sign in before starting this booking."); return; }
    if (hostileBrowser) {
      toast({
        title: "Open in browser to continue",
        description: "Checkout is blocked in this in-app browser.",
        variant: "destructive",
      });
      return;
    }
    initiatePendingRef.current = true;
    setIsLoading(true);
    setRequestMessage("");
    const activeScope = requestScopeRef.current;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    try {

      const creditCents = Math.max(
        0,
        Math.floor(Number(creditsToApply || 0) * 100),
      );
      const normalizedSelectedDates = Array.isArray(selectedDates)
        ? selectedDates
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .map((value) => {
              const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
              return match ? match[1] : value;
            })
            .filter((value) => value.length > 0)
        : [];
      const isReplay = loadParkingBookingRequest(requestScope) !== null;
      const request = prepareParkingBookingRequest(requestScope, {
        truckId, slotTypes, selectedDates: normalizedSelectedDates,
        applyCreditsCents: creditCents > 0 ? creditCents : undefined,
        promoCode: promoCode.trim() ? promoCode.trim() : undefined,
      });
      const requestIdempotencyKey = request.requestId;
      idempotencyKeyRef.current = requestIdempotencyKey;
      setSavedRequest(request);
      const controller = new AbortController();
      requestTimer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(apiUrl(`/api/parking-pass/${passId}/book`), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestIdempotencyKey,
        },
        signal: controller.signal,
        body: JSON.stringify(request.body),
      });

      if (requestScopeRef.current !== activeScope) return;
      if (!res.ok) {
        const data = await res.json();
        if (requestScopeRef.current !== activeScope) return;
        // A first-attempt input refusal permits correction. A replay refusal
        // cannot disprove work from an earlier accepted or interrupted attempt.
        if (!isReplay && [400, 404, 422].includes(res.status) && !data?.bookingId && typeof data?.message === "string") clearSaved();
        if (
          res.status === 409 &&
          (data?.code === "truck_profile_required" ||
            data?.code === "truck_verification_required")
        ) {
          if (!isReplay) clearSaved();
          toast({
            title:
              data?.code === "truck_verification_required"
                ? "Verification required"
                : "Complete truck profile",
            description:
              data?.message ||
              "Complete your food truck profile before booking Parking Pass spots.",
          });
          const nextPath = String(
            data?.onboardingPath ||
              "/restaurant-signup?businessType=food_truck&source=parking-pass&claim=1",
          );
          window.location.assign(nextPath);
          return;
        }
        throw new Error(data.message || "Failed to initiate booking");
      }

      const data = await res.json();
      if (requestScopeRef.current !== activeScope) return;
      if (data?.bookingRecovery === true) {
        const intent = String(data.paymentIntentId || "").trim();
        if (!intent.startsWith("pi_")) throw new Error("Recovered booking reference is invalid.");
        // Recovery identifies an existing payment; it is not itself settlement.
        const statusResponse = await fetch(apiUrl(`/api/bookings/payment-intent/${encodeURIComponent(intent)}?truckId=${encodeURIComponent(truckId)}`), {
          credentials: "include", signal: controller.signal,
        });
        if (requestScopeRef.current !== activeScope) return;
        if (statusResponse.ok) {
          const recovered = await statusResponse.json();
          if (requestScopeRef.current !== activeScope) return;
          if (recovered?.status === "confirmed" || recovered?.status === "credited") {
            handleSuccess(recovered.status);
            return;
          }
        }
        const params = new URLSearchParams({ booking: "success", payment_intent: intent, truckId });
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(data.bookingStartDate || ""))) params.set("date", data.bookingStartDate);
        window.location.assign(`/parking-pass?${params.toString()}`);
        return;
      }
      if (data?.paymentPending) {
        // A manual-review request is acknowledged, not completed. Retain its identity.
        toast({
          title: "Request received",
          description:
            "Your spot request was received. We'll send payment instructions.",
        });
        handleSuccess("pending");
        return;
      }
      if (data?.bypassed) {
        toast({
          title: "Parking Pass Confirmed!",
          description: "Your parking spot has been reserved.",
        });
        recordRouteBookingConfirmed(passId);
        handleSuccess("confirmed");
        return;
      }

      const nextClientSecret = String(data.clientSecret || "").trim();
      const nextPaymentIntentId = String(data.paymentIntentId || "").trim();
      if (!nextClientSecret || !nextPaymentIntentId) {
        throw new Error("Payment setup did not return a client secret.");
      }
      if (!stripePromise) {
        await cancelCheckout(nextPaymentIntentId);
        throw new Error("Stripe is not configured for this environment.");
      }
      // Setup is not settlement. Keep the original request through payment,
      // redirects, reloads, pending outcomes and unverified cancellation.
      setClientSecret(nextClientSecret);
      setPaymentIntentId(nextPaymentIntentId);
      setHostPaymentsReady(data.hostPaymentsReady !== false);
      setBookingData({
        totalCents: data.totalCents,
        breakdown: data.breakdown,
      });
    } catch (err: any) {
      if (requestScopeRef.current !== activeScope) return;
      setRequestMessage(err?.name === "AbortError"
        ? "The request timed out. Its outcome is unknown; retry the same request or check My Schedule."
        : err.message || "The booking response was interrupted. Retry the same request before starting another booking.");
    } finally {
      if (requestTimer !== undefined) clearTimeout(requestTimer);
      initiatePendingRef.current = false;
      if (requestScopeRef.current === activeScope) setIsLoading(false);
    }
  };

  const resetState = () => {
    setClientSecret(null);
    setPaymentIntentId(null);
    setBookingData(null);
    setCreditsToApply("");
    setPromoCode("");
    idempotencyKeyRef.current = null;
    paymentActivityRef.current = "idle";
  };

  const handleClose = () => {
    requestScopeRef.current = "";
    resetState();
    onOpenChange(false);
  };

  const handleCancel = () => {
    // Radix close, Escape and outside-click all use this same guard. A
    // connection error is not permission to cancel a potentially paid intent.
    if (initiatePendingRef.current || paymentActivityRef.current === "processing") return;
    if (paymentActivityRef.current === "uncertain") {
      toast({ title: "Check My Schedule", description: "Payment status is unresolved. Check the existing booking before paying again." });
      handleClose();
      return;
    }
    const intentId = paymentIntentId;
    if (intentId) {
      void cancelCheckout(intentId);
      toast({ title: "Request saved", description: "Cancellation is not yet verified. Check My Schedule before paying again." });
    }
    handleClose();
  };

  const handleSuccess = (outcome: "confirmed" | "pending" | "credited") => {
    if (requestScopeRef.current !== JSON.stringify([userId, passId, truckId, open])) return;
    // Only the server's settled outcomes retire this session's exact receipt.
    // Pending, unknown and merely acknowledged cancellations keep it recoverable.
    if (outcome === "confirmed" || outcome === "credited") clearSaved();
    handleClose();
    onSuccess({ outcome });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">Parking Pass Checkout</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-[11px]">
                <span
                  className={`rounded-full border px-2.5 py-1 font-semibold ${
                    stage === "review"
                      ? "border-orange-200 bg-orange-50 text-orange-900"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[color:var(--text-muted)]"
                  }`}
                >
                  1. Review
                </span>
                <span className="h-px flex-1 bg-[var(--bg-subtle)]" />
                <span
                  className={`rounded-full border px-2.5 py-1 font-semibold ${
                    stage === "pay"
                      ? "border-orange-200 bg-orange-50 text-orange-900"
                      : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[color:var(--text-muted)]"
                  }`}
                >
                  2. Pay
                </span>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-sm text-[color:var(--text-secondary)]">
                <p className="font-semibold text-[color:var(--text-primary)]">{eventDetails.hostName}</p>
                <p className="text-xs text-[color:var(--text-muted)]">
                  {eventDetails.date} · {eventDetails.startTime} - {eventDetails.endTime}
                </p>
                {eventDetails.slotSummary ? (
                  <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                    Slots: {eventDetails.slotSummary}
                  </p>
                ) : null}
              </div>

              {bookingContext ? (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                    Booking snapshot
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2">
                      <p className="text-[11px] font-semibold text-[color:var(--text-primary)]">Weather</p>
                      <p className="text-xs text-[color:var(--text-muted)]">
                        {bookingContext.weather.loading ? "Loading weather..." : bookingContext.weather.summary}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2">
                      <p className="text-[11px] font-semibold text-[color:var(--text-primary)]">Area activity</p>
                      <p className="text-xs text-[color:var(--text-muted)]">
                        {bookingContext.footTraffic.loading
                          ? "Loading area activity..."
                          : bookingContext.footTraffic.summary}
                      </p>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2">
                      <p className="text-[11px] font-semibold text-[color:var(--text-primary)]">Truck activity</p>
                      <p className="text-xs text-[color:var(--text-muted)]">{bookingContext.truckActivity.summary}</p>
                    </div>
                    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2">
                      <p className="text-[11px] font-semibold text-[color:var(--text-primary)]">Truck reviews</p>
                      <p className="text-xs text-[color:var(--text-muted)]">{bookingContext.truckReviews.summary}</p>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        {!clientSecret && (
          <>
            {hostileBrowser ? (
              <PaymentBrowserGate
                currentUrl={window.location.href}
                reason="Complete Parking Pass checkout in Chrome or Safari."
                compact
              />
            ) : null}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-3">
            {savedRequest ? (
              <section aria-label="Saved booking request" className="rounded-xl border border-[var(--border-subtle)] p-3 space-y-2">
                <p className="font-semibold">Unfinished booking request</p>
                <p className="text-sm">Retry uses the original truck, slots, dates, credits and promo code. A missing response does not mean the booking failed.</p>
                <p className="text-xs">Saved slots: {savedRequest.body.slotTypes.join(", ")}</p>
                <p className="text-xs">Saved dates: {savedRequest.body.selectedDates.join(", ") || "Original listing date"}</p>
                <p className="break-all text-xs">Request reference: {savedRequest.requestId}</p>
              </section>
            ) : null}
            {requestMessage ? <p role="alert" className="text-sm text-destructive">{requestMessage}</p> : null}
            {(savedRequest || recoveryBlocked) && userId ? <Button type="button" variant="outline" disabled={isLoading}
              onClick={() => window.location.assign(`/parking-pass?setup=schedule&truckId=${encodeURIComponent(truckId)}`)}>Check My Schedule</Button> : null}
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[color:var(--text-primary)]">Credits</p>
                <p className="text-xs text-[color:var(--text-muted)]">
                  Credits reduce the MealScout platform fee.
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] text-[color:var(--text-muted)]">Available</p>
                <p className="text-base font-semibold text-[color:var(--text-primary)]">
                  {creditStatus === "loading" ? "Checking credits…" : creditStatus === "unavailable" ? "Unavailable" : `$${(creditBalance ?? 0).toFixed(2)}`}
                </p>
              </div>
            </div>

            {creditStatus === "unavailable" ? (
              <div role="status" className="text-xs">
                Credit balance could not be loaded.
                <Button type="button" variant="outline" className="ml-2" onClick={() => void loadCreditBalance()}>Retry credits</Button>
              </div>
            ) : null}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="parking-pass-credits" className="text-xs font-semibold text-[color:var(--text-muted)]">
                  Apply credits
                </label>
                <button
                  type="button"
                  className="min-h-11 px-2 text-xs text-[color:var(--text-muted)] underline disabled:opacity-50"
                  disabled={creditStatus !== "ready" || isLoading || Boolean(savedRequest) || recoveryBlocked}
                  onClick={() =>
                    setCreditsToApply(String((creditBalance || 0).toFixed(2)))
                  }
                >
                  Use max
                </button>
              </div>
              <input
                id="parking-pass-credits"
                disabled={isLoading || Boolean(savedRequest) || recoveryBlocked}
                inputMode="decimal"
                type="number"
                min="0"
                step="0.01"
                value={creditsToApply}
                onChange={(e) => setCreditsToApply(e.target.value)}
                className="w-full rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm"
                placeholder="0.00"
              />
              <p className="text-[11px] text-[color:var(--text-muted)]">
                Continuing checks availability and may create a temporary hold. Before payment, cancelling requests release of that hold.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="parking-pass-promo" className="text-xs font-semibold text-[color:var(--text-muted)]">
                Promo code
              </label>
              <input
                id="parking-pass-promo"
                disabled={isLoading || Boolean(savedRequest) || recoveryBlocked}
                type="text"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                className="w-full rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm uppercase"
                placeholder="Enter promo code"
                autoCapitalize="characters"
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={handleCancel}
                disabled={isLoading}
              >
                {savedRequest ? "Close (request saved)" : "Cancel"}
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={initiateBooking}
                disabled={isLoading || isStripeConfigLoading || hostileBrowser || !userId || recoveryBlocked}
              >
                {isLoading ? "Checking booking request…" : savedRequest ? "Retry same booking request" : "Continue"}
              </Button>
            </div>
          </div>
          </>
        )}

        {clientSecret ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            Pricing locked. Complete payment to confirm your booking.
          </div>
        ) : null}

        {clientSecret && hostPaymentsReady === false ? (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
            <strong>Note:</strong> Host payout setup is still being finalized. Your spot is not reserved until the booking is confirmed.
          </div>
        ) : null}

        {(isLoading || isStripeConfigLoading) && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-orange-600" />
            <span className="ml-3 text-[color:var(--text-muted)]">
              Preparing payment...
            </span>
          </div>
        )}

        {!isLoading &&
          !isStripeConfigLoading &&
          stripePromise &&
          clientSecret &&
          paymentIntentId &&
          bookingData && (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret,
              appearance: {
                theme: "stripe",
                variables: {
                  colorPrimary: "#ea580c",
                },
              },
            }}
          >
            <PaymentForm
              clientSecret={clientSecret}
              paymentIntentId={paymentIntentId}
              passId={passId}
              truckId={truckId}
              totalCents={bookingData.totalCents}
              breakdown={bookingData.breakdown}
              onSuccess={handleSuccess}
              onCancel={handleCancel}
              onActivityChange={(activity) => { paymentActivityRef.current = activity; }}
            />
          </Elements>
        )}
      </DialogContent>
    </Dialog>
  );
}
