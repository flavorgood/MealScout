/**
 * Pickup Checkout page
 * Customer fills in contact info and completes verified pickup card payment.
 */
import { useState, useEffect, useRef } from "react";
import { Link, useParams, useLocation } from "wouter";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { PublicOrderingTopBar } from "@/components/public-ordering/PublicOrderingTopBar";
import { normalizeOrderContactPhone } from "@shared/orderContact";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Loader2,
  ShoppingCart,
  AlertCircle,
  CreditCard,
  ArrowLeft,
  MapPin,
} from "lucide-react";
import type { CartItem } from "./online-menu";
import PaymentBrowserGate from "@/components/payment-browser-gate";
import { isPaymentHostileBrowser } from "@/lib/inAppBrowser";
import {
  toAuthoritativePaymentOrder,
  type AuthoritativePaymentOrder,
} from "@/lib/pickupCheckoutTruth";
import {
  clearPickupCheckoutRecovery,
  readPickupCheckoutRecovery,
  writePickupCheckoutRecovery,
  type PickupCheckoutReplayPayload,
  type PickupCheckoutServerTotals,
} from "@/lib/pickupCheckoutRecovery";

const stripePublicKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY || "";
const stripePromise = stripePublicKey ? loadStripe(stripePublicKey) : null;

const CART_KEY = "mealscout_cart";
const TERMINAL_CHECKOUT_RECOVERY_CODES = new Set([
  "CHECKOUT_EXPIRED",
  "PAYMENT_SETUP_MISMATCH",
  "ORDERING_CHANGED",
]);
const formatMoney = (cents: number) =>
  `$${(Number(cents || 0) / 100).toFixed(2)}`;

const generateCustomerAccessToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");

function getCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // Storage can contain valid JSON with the wrong shape after a stale tab
    // or extension write. Fail closed instead of crashing before recovery.
    return Array.isArray(parsed) && parsed.every((item) =>
      item && typeof item === "object" && typeof item.restaurantId === "string" &&
      typeof item.menuId === "string" && typeof item.menuItemId === "string"
    ) ? parsed : [];
  } catch {
    return [];
  }
}

function clearCartForRestaurant(restaurantId: string) {
  try {
    const cart = getCart().filter((i) => i.restaurantId !== restaurantId);
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // ignore
  }
}

interface MenuInfo {
  cardPaymentsEnabled: boolean;
  hidePlatformFee: boolean;
  pricesIncludeTax: boolean;
}

interface OrderingReadiness {
  blockingReasons: string[];
  restaurantName?: string | null;
  restaurantCity?: string | null;
  restaurantState?: string | null;
  pickupAddressLabel?: string | null;
  paymentMethods?: {
    card: boolean;
    cash: boolean;
  };
  checks: Array<{
    id: string;
    label: string;
    ok: boolean;
    action: string;
  }>;
}

export default function CheckoutPage() {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  // Wouter can reuse this route component for another merchant. A new key
  // isolates cart, access token, replay identity and in-flight payment state.
  return <CheckoutSession key={restaurantId ?? ""} />;
}

function CheckoutSession() {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  const [, navigate] = useLocation();
  const [cart, setCart] = useState<CartItem[]>(() =>
    getCart().filter((item) => item.restaurantId === restaurantId),
  );
  const [menuInfo, setMenuInfo] = useState<MenuInfo | null>(null);
  const [menuInfoError, setMenuInfoError] = useState(false);
  const [menuNotFound, setMenuNotFound] = useState(false);
  const [menuInfoLoading, setMenuInfoLoading] = useState(true);
  const [menuInfoAttempt, setMenuInfoAttempt] = useState(0);
  const createOrderPendingRef = useRef(false);
  const checkoutActiveRef = useRef(true);
  useEffect(() => {
    checkoutActiveRef.current = true;
    return () => { checkoutActiveRef.current = false; };
  }, []);
  const [contactTouched, setContactTouched] = useState({
    name: false,
    email: false,
    phone: false,
  });
  const [readiness, setReadiness] = useState<OrderingReadiness | null>(null);
  const [orderingEnabled, setOrderingEnabled] = useState(false);
  const paymentMethod = "card" as const;
  const [orderType, setOrderType] = useState<"pickup" | null>(null);
  const [contact, setContact] = useState({
    name: "",
    email: "",
    phone: "",
  });
  const [orderError, setOrderError] = useState<string | null>(null);
  const [restoredCheckout] = useState(() =>
    readPickupCheckoutRecovery(restaurantId ?? ""),
  );
  // Reattach to the same request after an effect cleanup/setup cycle, rather
  // than leaving recovery stuck or submitting a second checkout request.
  const restoredCheckoutRequestRef = useRef<Promise<{
    response: Response;
    data: any;
  }> | null>(null);
  const [isCreating, setIsCreating] = useState(
    Boolean(restoredCheckout?.checkoutPayload),
  );
  const [checkoutPayload, setCheckoutPayload] =
    useState<PickupCheckoutReplayPayload | null>(
      restoredCheckout?.checkoutPayload ?? null,
    );
  const [orderId, setOrderId] = useState<string | null>(
    restoredCheckout?.orderId ?? null,
  );
  // A saved client secret is never trusted directly after reload. The server
  // must replay the durable request and revalidate status, expiry, binding,
  // and current ordering readiness before Stripe Elements is restored.
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [authoritativePaymentOrder, setAuthoritativePaymentOrder] =
    useState<AuthoritativePaymentOrder | null>(
      restoredCheckout?.authoritativePaymentOrder ?? null,
    );
  const [checkoutRequestId, setCheckoutRequestId] = useState(
    () => restoredCheckout?.checkoutRequestId || crypto.randomUUID(),
  );
  const [customerAccessToken, setCustomerAccessToken] = useState(
    () => restoredCheckout?.customerAccessToken || generateCustomerAccessToken(),
  );
  const [serverTotals, setServerTotals] =
    useState<PickupCheckoutServerTotals | null>(
      restoredCheckout?.serverTotals ?? null,
    );
  // Server-priced final total for the cart on this step (card fees
  // included), fetched from the totals preview before Continue unlocks.
  // Null until the server has priced the exact current cart — the client
  // never estimates fees, because the fee amounts live in server
  // configuration and only the server can state the real number.
  const [finalTotals, setFinalTotals] =
    useState<PickupCheckoutServerTotals | null>(null);
  const [finalTotalsError, setFinalTotalsError] = useState<string | null>(
    null,
  );
  const finalTotalsRequestRef = useRef(0);
  const hostileBrowser = isPaymentHostileBrowser();

  const resetCheckoutRecovery = () => {
    clearPickupCheckoutRecovery(restaurantId ?? "");
    setCheckoutPayload(null);
    setOrderId(null);
    setClientSecret(null);
    setAuthoritativePaymentOrder(null);
    setServerTotals(null);
    setCheckoutRequestId(crypto.randomUUID());
    setCustomerAccessToken(generateCustomerAccessToken());
  };

  useEffect(() => {
    // Ignore responses from a previous restaurant or retry. They must not
    // restore an outdated payment-enabled state after navigation.
    let cancelled = false;
    setMenuInfoLoading(true);
    setMenuInfoError(false);
    setMenuNotFound(false);
    setOrderingEnabled(false);
    setMenuInfo(null);
    setReadiness(null);
    const restaurantCart = getCart().filter(
      (i) => i.restaurantId === restaurantId,
    );
    setCart(restaurantCart);

    // Fetch the exact menu's card readiness and fee presentation.
    if (restaurantId) {
      setMenuInfoError(false);
      fetch(`/api/menus/${encodeURIComponent(restaurantId)}`)
        .then((r) => {
          // A 404 is a different fact from a failed lookup: the checkout
          // link itself is wrong, and retrying can never fix it.
          if (r.status === 404) return { menuNotFound: true } as any;
          if (!r.ok) throw new Error(`Menu lookup failed (${r.status})`);
          return r.json();
        })
        .then((payload: any) => {
          if (cancelled) return;
          if (payload?.menuNotFound) {
            setMenuNotFound(true);
            setMenuInfoError(false);
            setMenuInfo(null);
            setOrderingEnabled(false);
            return;
          }
          setReadiness(payload?.readiness || null);
          const menus = Array.isArray(payload?.menus) ? payload.menus : [];
          const cartMenuIds = new Set(
            restaurantCart.map((item) => item.menuId),
          );
          const cartMenuId =
            cartMenuIds.size === 1
              ? String(restaurantCart[0]?.menuId || "")
              : "";
          const activeMenu = menus.find(
            (menu: any) => menu.isActive && menu.id === cartMenuId,
          );
          if (activeMenu) {
            const cardPaymentsEnabled = Boolean(
              activeMenu?.paymentMethods?.card,
            );
            const pricesIncludeTax = activeMenu.pricesIncludeTax === true;
            setOrderingEnabled(
              Boolean(
                activeMenu.orderingEnabled &&
                cardPaymentsEnabled &&
                pricesIncludeTax,
              ),
            );
            setMenuInfo({
              cardPaymentsEnabled,
              hidePlatformFee: activeMenu.hidePlatformFee,
              pricesIncludeTax,
            });
          } else {
            setOrderingEnabled(false);
            setMenuInfo(null);
            setMenuInfoError(true);
          }
        })
        // A failed lookup must remain a visible, fail-closed checkout state.
        .catch(() => {
          if (!cancelled) {
            setMenuInfoError(true);
            setOrderingEnabled(false);
            setMenuInfo(null);
          }
        })
        .finally(() => {
          if (!cancelled) setMenuInfoLoading(false);
        });
    } else {
      setMenuInfoError(true);
      setMenuInfoLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [restaurantId, menuInfoAttempt]);

  useEffect(() => {
    if (!restoredCheckout?.checkoutPayload) return;
    let cancelled = false;

    const reconcileRestoredCheckout = async () => {
      setIsCreating(true);
      setOrderError(null);
      try {
        if (!restoredCheckoutRequestRef.current) {
          restoredCheckoutRequestRef.current = fetch("/api/pickup-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(restoredCheckout.checkoutPayload),
          }).then(async (response) => ({ response, data: await response.json() }));
        }
        const { response, data } = await restoredCheckoutRequestRef.current;
        if (cancelled) return;
        if (!response.ok) {
          const code = String(data.code || "");
          if (TERMINAL_CHECKOUT_RECOVERY_CODES.has(code)) {
            resetCheckoutRecovery();
          } else if (
            ["PAYMENT_PROCESSING", "CHECKOUT_REQUEST_MISMATCH"].includes(
              code,
            ) &&
            restoredCheckout.orderId
          ) {
            window.sessionStorage.setItem(
              `mealscout:order-access:${restoredCheckout.orderId}`,
              restoredCheckout.customerAccessToken,
            );
            navigate(`/order-confirmation/${restoredCheckout.orderId}`);
            return;
          }
          throw new Error(
            data.message || "The saved checkout could not be restored.",
          );
        }

        if (String(data.order?.status || "") !== "pending") {
          clearPickupCheckoutRecovery(restaurantId ?? "");
          if (data.customerAccessToken) {
            window.sessionStorage.setItem(
              `mealscout:order-access:${data.order.id}`,
              data.customerAccessToken,
            );
          }
          navigate(`/order-confirmation/${data.order.id}`);
          return;
        }
        if (!data.clientSecret) {
          throw new Error(
            "The saved payment could not be verified. Check the order status before trying again.",
          );
        }

        setOrderId(data.order.id);
        window.sessionStorage.setItem(
          `mealscout:order-access:${data.order.id}`,
          data.customerAccessToken || restoredCheckout.customerAccessToken,
        );
        setServerTotals({
          subtotalCents: Number(data.order.subtotalCents || 0),
          mealscoutFeeCents: Number(data.order.mealscoutFeeCents ?? 0),
          processingFeeCents: Number(data.order.processingFeeCents ?? 0),
          platformFeeCents: Number(data.order.platformFeeCents ?? 0),
          totalCents: Number(data.order.totalCents || 0),
          feePaidByBusiness: Boolean(data.order.feePaidByBusiness),
        });
        setAuthoritativePaymentOrder(toAuthoritativePaymentOrder(data.order));
        setClientSecret(data.clientSecret);
      } catch (error: any) {
        if (!cancelled) {
          setOrderError(
            String(error?.message || "The saved checkout could not be restored."),
          );
        }
      } finally {
        if (!cancelled) setIsCreating(false);
      }
    };

    void reconcileRestoredCheckout();
    return () => {
      cancelled = true;
    };
  }, [navigate, restaurantId, restoredCheckout]);

  useEffect(() => {
    if (!restaurantId) return;
    writePickupCheckoutRecovery({
      version: 1,
      restaurantId,
      checkoutRequestId,
      customerAccessToken,
      checkoutPayload,
      orderId,
      clientSecret,
      authoritativePaymentOrder,
      serverTotals,
      updatedAt: Date.now(),
    });
  }, [
    restaurantId,
    checkoutRequestId,
    customerAccessToken,
    checkoutPayload,
    orderId,
    clientSecret,
    authoritativePaymentOrder,
    serverTotals,
  ]);

  const cartMenuIds = new Set(cart.map((item) => item.menuId));
  const cartHasMixedMenus = cartMenuIds.size > 1;

  // Price the exact current cart on the server whenever it changes, so the
  // summary can show the final total (card fees included) and Continue can
  // stay disabled until that number exists. Any cart edit nulls the totals
  // and re-prices; a failed preview keeps Continue disabled with the
  // server's reason. Once an order exists (clientSecret set), the created
  // order's own totals are authoritative and no preview runs.
  const finalTotalsSignature =
    !clientSecret && menuInfo?.cardPaymentsEnabled && cart.length > 0
      ? JSON.stringify({
          restaurantId: restaurantId ?? "",
          menuId: cart[0]?.menuId ?? "",
          paymentMethod,
          items: cart.map((i) => ({
            menuItemId: i.menuItemId,
            quantity: i.quantity,
            selectedVariantId: i.selectedVariantId ?? null,
            selectedModifierIds: i.selectedModifierIds ?? [],
          })),
        })
      : null;

  useEffect(() => {
    if (!finalTotalsSignature || cartHasMixedMenus) {
      setFinalTotals(null);
      setFinalTotalsError(null);
      return;
    }
    const requestId = ++finalTotalsRequestRef.current;
    setFinalTotals(null);
    setFinalTotalsError(null);
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/pickup-orders/totals-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: finalTotalsSignature,
        });
        const data = await response.json().catch(() => null);
        if (cancelled || finalTotalsRequestRef.current !== requestId) return;
        if (!response.ok) {
          setFinalTotalsError(
            String(data?.message || "The final total could not be calculated."),
          );
          return;
        }
        setFinalTotals({
          subtotalCents: Number(data.subtotalCents || 0),
          mealscoutFeeCents: Number(data.mealscoutFeeCents ?? 0),
          processingFeeCents: Number(data.processingFeeCents ?? 0),
          platformFeeCents: Number(data.platformFeeCents ?? 0),
          totalCents: Number(data.totalCents || 0),
          feePaidByBusiness: Boolean(data.feePaidByBusiness),
        });
      } catch {
        if (cancelled || finalTotalsRequestRef.current !== requestId) return;
        setFinalTotalsError("The final total could not be calculated.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [finalTotalsSignature, cartHasMixedMenus]);

  // Saved checkout reconciliation takes priority over the current cart.
  // Another tab may have cleared/changed the cart after the order was created.
  // Never replace the durable replay payload with those current cart contents.
  const hasVerifiedPayment = Boolean(clientSecret && orderId && stripePromise);
  if (restoredCheckout?.checkoutPayload && checkoutPayload && !hasVerifiedPayment) {
    return (
      <div
        className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)]"
        data-public-checkout-shell="warm-food-led"
      >
        <PublicOrderingTopBar secondaryHref={`/menu/${restaurantId}`} secondaryLabel="Menu" />
        <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-8">
          <section className="profile-surface rounded-3xl p-6" aria-busy={isCreating}>
            <h1 className="text-2xl font-black text-[color:var(--profile-ink)]">
              {isCreating ? "Checking your saved checkout" : "Your checkout needs attention"}
            </h1>
            <p className="mt-3 text-sm text-[color:var(--profile-ink-soft)]" role="status">
              {isCreating
                ? "We are verifying the existing order and payment before you continue."
                : "Check the existing order before starting another payment. Your saved checkout has not been replaced."}
            </p>
            {orderError ? <p className="mt-3 text-sm text-destructive" role="alert">{orderError}</p> : null}
            {!isCreating && !stripePromise ? (
              <p className="mt-3 text-sm" role="alert">Secure card payment is unavailable in this browser session.</p>
            ) : null}
            {isCreating ? (
              <Loader2 className="mt-4 h-6 w-6 animate-spin" aria-hidden="true" />
            ) : (
              <div className="mt-5 flex flex-wrap gap-3">
                <Button type="button" variant="outline" onClick={() => window.location.reload()}>
                  Retry saved checkout
                </Button>
                {orderId ? (
                  <Button type="button" onClick={() => {
                    try {
                      window.sessionStorage.setItem(`mealscout:order-access:${orderId}`, customerAccessToken);
                      navigate(`/order-confirmation/${orderId}`);
                    } catch {
                      setOrderError("Order access could not be saved. Allow browser storage and retry this saved checkout.");
                    }
                  }}>
                    Check order status
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        </main>
      </div>
    );
  }

  if (menuNotFound && !hasVerifiedPayment) {
    return (
      <div
        className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)]"
        data-public-checkout-shell="warm-food-led"
      >
        <PublicOrderingTopBar secondaryHref="/scout" secondaryLabel="Scout" />
        <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center justify-center px-4 py-20">
          <section className="profile-surface w-full rounded-[2rem] p-7 text-center sm:p-10">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--profile-surface-strong)] text-destructive">
              <AlertCircle className="h-6 w-6" />
            </span>
            <h1 className="mt-4 text-2xl font-black tracking-tight text-[color:var(--profile-ink)]">
              Checkout not found
            </h1>
            <p className="mt-2 text-sm text-[color:var(--profile-muted)]">
              This checkout link doesn&apos;t match a business on MealScout,
              so there is nothing to check out here. The link may be mistyped
              or out of date.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                href="/scout"
                className="profile-action-primary inline-flex min-h-11 items-center rounded-full px-5 text-sm font-black"
              >
                Find food near you
              </Link>
              <Link
                href="/"
                className="profile-action-secondary inline-flex min-h-11 items-center rounded-full px-5 text-sm font-black"
              >
                MealScout home
              </Link>
            </div>
          </section>
        </main>
      </div>
    );
  }

  if (cart.length === 0 && !hasVerifiedPayment) {
    return (
      <div
        className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)]"
        data-public-checkout-shell="warm-food-led"
      >
        <PublicOrderingTopBar
          secondaryHref={`/menu/${restaurantId}`}
          secondaryLabel="Menu"
        />
        <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center justify-center px-4 py-20">
          <section className="profile-surface w-full rounded-[2rem] p-7 text-center sm:p-10">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--profile-surface-strong)] text-[color:var(--profile-accent)]">
              <ShoppingCart className="h-6 w-6" />
            </span>
            <h1 className="mt-4 text-2xl font-black tracking-tight text-[color:var(--profile-ink)]">
              Your cart is empty
            </h1>
            <p className="mt-2 text-sm text-[color:var(--profile-muted)]">
              Add something from the menu when online ordering is available.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                href={`/menu/${restaurantId}`}
                className="profile-action-secondary inline-flex min-h-11 items-center rounded-full px-5 text-sm font-black"
              >
                Return to menu
              </Link>
              <Link
                href="/scout"
                className="profile-action-primary inline-flex min-h-11 items-center rounded-full px-5 text-sm font-black"
              >
                Scout
              </Link>
            </div>
          </section>
        </main>
      </div>
    );
  }

  if (cartHasMixedMenus && !hasVerifiedPayment) {
    return (
      <div className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)]">
        <PublicOrderingTopBar
          secondaryHref={`/menu/${restaurantId}`}
          secondaryLabel="Menu"
        />
        <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center justify-center px-4 py-20">
          <section className="profile-surface w-full rounded-[2rem] p-7 text-center sm:p-10">
            <AlertCircle className="mx-auto h-10 w-10 text-destructive" />
            <h1 className="mt-4 text-2xl font-black tracking-tight text-[color:var(--profile-ink)]">
              Choose one menu per order
            </h1>
            <p className="mt-2 text-sm text-[color:var(--profile-muted)]">
              This saved cart contains items from different menus, so its
              payment rules and fees cannot be verified safely.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  clearCartForRestaurant(restaurantId ?? "");
                  setCart([]);
                }}
              >
                Clear saved cart
              </Button>
              <Link
                href={`/menu/${restaurantId}`}
                className="profile-action-primary inline-flex min-h-10 items-center rounded-full px-5 text-sm font-black"
              >
                Return to menu
              </Link>
            </div>
          </section>
        </main>
      </div>
    );
  }

  const subtotal = cart.reduce((sum, i) => sum + i.lineTotalCents, 0);
  const knownTotalBeforeCardFees = subtotal;
  // "Pending" means the server has not yet priced the final total for this
  // exact cart. While pending, the summary shows the pre-fee subtotal and
  // Continue stays disabled; once the preview lands, the summary shows the
  // itemized card fees and the final total.
  const customerCardFeesPending = Boolean(
    paymentMethod === "card" && menuInfo?.cardPaymentsEnabled && !finalTotals,
  );
  const finalSubtotal = finalTotals?.subtotalCents ?? subtotal;
  const finalMealscoutFee = finalTotals?.feePaidByBusiness
    ? 0
    : (finalTotals?.mealscoutFeeCents ?? 0);
  const finalProcessingFee = finalTotals?.feePaidByBusiness
    ? 0
    : (finalTotals?.processingFeeCents ?? 0);
  const finalTotal = finalTotals?.totalCents ?? knownTotalBeforeCardFees;
  const displayedSubtotal = serverTotals?.subtotalCents ?? subtotal;
  const displayedMealscoutFee = serverTotals?.feePaidByBusiness
    ? 0
    : (serverTotals?.mealscoutFeeCents ?? 0);
  const displayedProcessingFee = serverTotals?.feePaidByBusiness
    ? 0
    : (serverTotals?.processingFeeCents ?? 0);
  const displayedTotal = serverTotals?.totalCents ?? knownTotalBeforeCardFees;
  const menuId = cart[0]?.menuId ?? checkoutPayload?.menuId ?? "";
  const normalizedContactPhone = contact.phone.trim()
    ? normalizeOrderContactPhone(contact.phone)
    : null;

  const nameInvalid = contactTouched.name && !contact.name.trim();
  const phoneInvalid = contactTouched.phone && Boolean(contact.phone.trim()) && !normalizedContactPhone;
  const contactMissing = (contactTouched.email || contactTouched.phone) &&
    !contact.email.trim() && !contact.phone.trim();

  const createOrder = async () => {
    if (createOrderPendingRef.current || isCreating) return;
    if (menuInfoLoading || menuInfoError || !orderingEnabled || !menuInfo?.cardPaymentsEnabled) {
      setOrderError("Wait for payment availability to be verified before continuing.");
      return;
    }
    if (!finalTotals) {
      setOrderError(
        finalTotalsError || "Wait for the final total before continuing.",
      );
      return;
    }
    if (new Set(cart.map((item) => item.menuId)).size !== 1) {
      setOrderError("Choose items from one menu before checkout.");
      return;
    }
    if (!contact.name.trim()) {
      setOrderError("Please enter your name.");
      return;
    }
    if (!orderType) {
      setOrderError("Choose pickup.");
      return;
    }
    if (!contact.email.trim() && !contact.phone.trim()) {
      setOrderError(
        "Enter an email address or phone number so you can receive order updates.",
      );
      return;
    }
    if (contact.phone.trim() && !normalizedContactPhone) {
      setOrderError(
        "Enter a valid phone number that can receive order updates.",
      );
      return;
    }
    if (hostileBrowser) {
      setOrderError(
        "Open this page in Chrome or Safari to complete card payment.",
      );
      return;
    }
    if (!stripePromise) {
      setOrderError(
        "Secure card payment is not configured on this checkout. No order was created.",
      );
      return;
    }
    setOrderError(null);
    createOrderPendingRef.current = true;
    setIsCreating(true);
    try {
      const payload: PickupCheckoutReplayPayload = {
        restaurantId: restaurantId ?? "",
        menuId,
        customerName: contact.name.trim(),
        customerEmail: contact.email.trim() || undefined,
        customerPhone: normalizedContactPhone || undefined,
        orderType,
        checkoutRequestId,
        customerAccessToken,
        paymentMethod,
        promotionToken:
          window.localStorage.getItem(`mealscout:promotion:${restaurantId}`) ||
          undefined,
        items: cart.map((i) => ({
          menuItemId: i.menuItemId,
          quantity: i.quantity,
          selectedVariantId: i.selectedVariantId,
          selectedModifierIds: i.selectedModifierIds,
          specialInstructions: i.specialInstructions || undefined,
        })),
      };
      setCheckoutPayload(payload);
      // Persist the replay identity and exact request before the network call.
      // If the page reloads after the server creates the order but before this
      // response arrives, the next mount can only replay this same checkout.
      writePickupCheckoutRecovery({
        version: 1,
        restaurantId: restaurantId ?? "",
        checkoutRequestId,
        customerAccessToken,
        checkoutPayload: payload,
        orderId,
        clientSecret,
        authoritativePaymentOrder,
        serverTotals,
        updatedAt: Date.now(),
      });
      const res = await fetch("/api/pickup-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      // The request may still finish after leaving this merchant. Its saved
      // identity remains recoverable, but it must not redirect another page.
      if (!checkoutActiveRef.current) return;
      if (!res.ok) {
        const code = String(data.code || "");
        if (TERMINAL_CHECKOUT_RECOVERY_CODES.has(code)) {
          resetCheckoutRecovery();
        } else if (
          ["PAYMENT_PROCESSING", "CHECKOUT_REQUEST_MISMATCH"].includes(code) &&
          orderId
        ) {
          navigate(`/order-confirmation/${orderId}`);
          return;
        }
        throw new Error(data.message || "Failed to create order");
      }

      setOrderId(data.order.id);
      if (data.customerAccessToken) {
        window.sessionStorage.setItem(
          `mealscout:order-access:${data.order.id}`,
          data.customerAccessToken,
        );
      }
      if (String(data.order.status || "") !== "pending") {
        clearPickupCheckoutRecovery(restaurantId ?? "");
        navigate(`/order-confirmation/${data.order.id}`);
        return;
      }
      if (!data.clientSecret) {
        throw new Error(
          "Secure payment setup did not finish. No payment can be submitted from this checkout.",
        );
      }
      setServerTotals({
        subtotalCents: Number(data.order.subtotalCents || subtotal) || subtotal,
        mealscoutFeeCents: Number(data.order.mealscoutFeeCents ?? 0),
        processingFeeCents: Number(data.order.processingFeeCents ?? 0),
        platformFeeCents: Number(data.order.platformFeeCents ?? 0),
        totalCents:
          Number(data.order.totalCents || knownTotalBeforeCardFees) ||
          knownTotalBeforeCardFees,
        feePaidByBusiness: Boolean(data.order.feePaidByBusiness),
      });
      setAuthoritativePaymentOrder(toAuthoritativePaymentOrder(data.order));

      setClientSecret(data.clientSecret);
    } catch (err: any) {
      const message = String(err?.message || "Failed to create order");
      if (checkoutActiveRef.current) setOrderError(message);
    } finally {
      createOrderPendingRef.current = false;
      if (checkoutActiveRef.current) setIsCreating(false);
    }
  };

  // If we have a clientSecret, render the Stripe Elements form
  if (clientSecret && orderId && stripePromise) {
    return (
      <div
        className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)]"
        data-public-checkout-shell="warm-food-led"
      >
        <PublicOrderingTopBar
          secondaryHref={`/menu/${restaurantId}`}
          secondaryLabel="Menu"
        />
        <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-8">
          <p className="profile-section-label">Pickup order</p>
          <h1 className="mb-6 mt-1 text-3xl font-black tracking-tight text-[color:var(--profile-ink)]">
            Payment
          </h1>
          {authoritativePaymentOrder?.merchantNameSnapshot ? (
            <div className="mb-4 rounded-2xl border border-[color:var(--profile-border)] bg-white px-4 py-3 text-sm">
              <p className="font-black">
                {authoritativePaymentOrder.merchantNameSnapshot}
              </p>
              {authoritativePaymentOrder.pickupAddressSnapshot ? (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {authoritativePaymentOrder.pickupAddressSnapshot}
                </p>
              ) : null}
            </div>
          ) : null}
          {hostileBrowser ? (
            <div className="mb-4">
              <PaymentBrowserGate
                currentUrl={window.location.href}
                reason="Complete pickup checkout in Chrome or Safari."
                compact
              />
            </div>
          ) : null}
          <Card className="profile-surface mb-4 rounded-3xl">
            <CardContent className="pt-4 pb-3">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatMoney(displayedSubtotal)}</span>
              </div>
              {displayedMealscoutFee > 0 && (
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">MealScout fee</span>
                  <span>{formatMoney(displayedMealscoutFee)}</span>
                </div>
              )}
              {displayedProcessingFee > 0 && (
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Card processing</span>
                  <span>{formatMoney(displayedProcessingFee)}</span>
                </div>
              )}
              {authoritativePaymentOrder?.pricesIncludeTax ? (
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Tax</span>
                  <span>Included in item prices</span>
                </div>
              ) : null}
              <div className="mt-2 flex justify-between border-t border-[#ead7c7] pt-2 font-black">
                <span>Total</span>
                <span>{formatMoney(displayedTotal)}</span>
              </div>
            </CardContent>
          </Card>
          <Elements
            stripe={stripePromise}
            options={{ clientSecret, appearance: { theme: "stripe" } }}
          >
            <StripePaymentForm
              orderId={orderId}
              restaurantId={restaurantId ?? ""}
              onCheckStatus={() => {
                if (checkoutActiveRef.current) navigate(`/order-confirmation/${orderId}`);
              }}
              onSuccess={() => {
                if (!checkoutActiveRef.current) return;
                clearPickupCheckoutRecovery(restaurantId ?? "");
                clearCartForRestaurant(restaurantId ?? "");
                navigate(`/order-confirmation/${orderId}`);
              }}
            />
          </Elements>
        </main>
      </div>
    );
  }

  return (
    <div
      className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)] pb-12 text-[color:var(--profile-ink)]"
      data-public-checkout-shell="warm-food-led"
    >
      <PublicOrderingTopBar
        secondaryHref={`/menu/${restaurantId}`}
        secondaryLabel="Menu"
      />
      <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-8">
        <Link
          href={`/menu/${restaurantId}`}
          className="mb-5 inline-flex min-h-10 items-center gap-2 rounded-full bg-[color:var(--profile-surface-soft)] px-3 text-sm font-black text-[color:var(--profile-ink-soft)] transition-colors hover:text-[color:var(--profile-accent)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Return to menu
        </Link>
        <p className="profile-section-label">Pickup order</p>
        <h1 className="mb-6 mt-1 text-3xl font-black tracking-tight text-[color:var(--profile-ink)]">
          Checkout
        </h1>

        {menuInfoLoading ? (
          <div className="profile-surface mb-4 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm" role="status">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            Checking menu and payment availability…
          </div>
        ) : menuInfoError ? (
          <div className="profile-surface mb-4 rounded-2xl px-4 py-3 text-sm">
            <p className="font-black" role="alert">Payment availability could not be verified</p>
            <p className="mt-1">Retry the availability check. Your cart and contact details will stay here.</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => {
              setMenuInfoLoading(true);
              setMenuInfoAttempt((attempt) => attempt + 1);
            }}>
              Retry availability
            </Button>
          </div>
        ) : null}

        {!menuInfoLoading && !menuInfoError && !orderingEnabled && (
          <div className="mb-4 flex items-start gap-3 rounded-2xl border border-[#efc37b] bg-[#fff4d9] px-4 py-3 text-sm text-[#70470f]">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-black">Online ordering is not available</p>
              {readiness?.blockingReasons?.length ? (
                <p className="mt-1 text-xs">
                  Waiting on: {readiness.blockingReasons.join(", ")}.
                </p>
              ) : (
                <p className="mt-1 text-xs">Please order in person for now.</p>
              )}
            </div>
          </div>
        )}

        {readiness?.restaurantName ? (
          <Card className="profile-surface mb-4 rounded-3xl">
            <CardContent className="pt-4">
              <p className="font-black text-[color:var(--profile-ink)]">
                {readiness.restaurantName}
              </p>
              {readiness.pickupAddressLabel ? (
                <p className="mt-1 flex items-start gap-1.5 text-sm text-[color:var(--profile-muted)]">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                  {readiness.pickupAddressLabel}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-[color:var(--profile-muted)]">
                The status page will show when the business starts preparation
                and when the order is ready.
              </p>
            </CardContent>
          </Card>
        ) : null}

        {/* Order summary */}
        <Card className="profile-surface mb-6 rounded-3xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-black text-[color:var(--profile-ink)]">
              Order summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {cart.map((item, idx) => (
              <div key={idx} className="flex justify-between text-sm">
                <span>
                  {item.quantity}× {item.itemName}
                  {item.variantLabel && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {item.variantLabel}
                    </span>
                  )}
                </span>
                <span>{formatMoney(item.lineTotalCents)}</span>
              </div>
            ))}
            <div className="mt-2 space-y-1 border-t border-[color:var(--profile-border)] pt-2">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Subtotal</span>
                <span>{formatMoney(finalSubtotal)}</span>
              </div>
              {customerCardFeesPending ? (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Card fees</span>
                  <span>Calculated before payment</span>
                </div>
              ) : (
                <>
                  {finalMealscoutFee > 0 && (
                    <div className="flex justify-between text-sm text-muted-foreground">
                      <span>MealScout fee</span>
                      <span>{formatMoney(finalMealscoutFee)}</span>
                    </div>
                  )}
                  {finalProcessingFee > 0 && (
                    <div className="flex justify-between text-sm text-muted-foreground">
                      <span>Card processing</span>
                      <span>{formatMoney(finalProcessingFee)}</span>
                    </div>
                  )}
                </>
              )}
              <div className="flex justify-between pt-1 text-base font-black">
                <span>
                  {customerCardFeesPending ? "Before card fees" : "Total"}
                </span>
                <span>{formatMoney(finalTotal)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Contact info */}
        <Card className="profile-surface mb-4 rounded-3xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-black text-[color:var(--profile-ink)]">
              Your details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label
                htmlFor="customer-name"
                className="font-black text-[color:var(--profile-ink)]"
              >
                Name *
              </Label>
              <Input
                id="customer-name"
                autoComplete="name"
                aria-required="true"
                aria-invalid={nameInvalid || undefined}
                aria-describedby={nameInvalid ? "customer-name-error" : undefined}
                onBlur={() => setContactTouched((touched) => ({ ...touched, name: true }))}
                value={contact.name}
                onChange={(e) =>
                  setContact((c) => ({ ...c, name: e.target.value }))
                }
                placeholder="Your name"
                className="mt-1 border-[#d8bda8] bg-white"
              />
              {nameInvalid ? <p id="customer-name-error" className="mt-1 text-sm text-destructive">Enter your name.</p> : null}
            </div>
            <div>
              <Label
                htmlFor="customer-email"
                className="font-black text-[color:var(--profile-ink)]"
              >
                Email{" "}
                <span className="text-muted-foreground text-xs">
                  (email or phone required)
                </span>
              </Label>
              <Input
                id="customer-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                aria-describedby={contactMissing ? "customer-contact-error" : undefined}
                onBlur={() => setContactTouched((touched) => ({ ...touched, email: true }))}
                value={contact.email}
                onChange={(e) =>
                  setContact((c) => ({ ...c, email: e.target.value }))
                }
                placeholder="you@email.com"
                className="mt-1 border-[#d8bda8] bg-white"
              />
            </div>
            <div>
              <Label
                htmlFor="customer-phone"
                className="font-black text-[color:var(--profile-ink)]"
              >
                Phone{" "}
                <span className="text-muted-foreground text-xs">
                  (email or phone required)
                </span>
              </Label>
              <Input
                id="customer-phone"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                aria-invalid={phoneInvalid || undefined}
                aria-describedby={phoneInvalid ? "customer-phone-error" : contactMissing ? "customer-contact-error" : undefined}
                onBlur={() => setContactTouched((touched) => ({ ...touched, phone: true }))}
                maxLength={40}
                value={contact.phone}
                onChange={(e) =>
                  setContact((c) => ({ ...c, phone: e.target.value }))
                }
                placeholder="(555) 000-0000"
                className="mt-1 border-[#d8bda8] bg-white"
              />
              {phoneInvalid ? <p id="customer-phone-error" className="mt-1 text-sm text-destructive">Enter a valid phone number for order updates.</p> : null}
              {contactMissing ? <p id="customer-contact-error" className="mt-1 text-sm text-destructive">Add an email address or phone number for order updates.</p> : null}
            </div>
          </CardContent>
        </Card>

        {/* Order type */}
        <Card className="profile-surface mb-4 rounded-3xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-black text-[color:var(--profile-ink)]">
              Order type
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={orderType || ""}
              onValueChange={() => setOrderType("pickup")}
              className="flex flex-wrap gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="pickup" id="ot-pickup" />
                <Label
                  htmlFor="ot-pickup"
                  className="cursor-pointer font-normal"
                >
                  Pickup
                </Label>
              </div>
            </RadioGroup>
          </CardContent>
        </Card>

        {/* Payment method */}
        <Card className="profile-surface mb-6 rounded-3xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-black text-[color:var(--profile-ink)]">
              Payment method
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup value={paymentMethod} className="flex gap-4">
              {menuInfo?.cardPaymentsEnabled ? (
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="card" id="pm-card" />
                  <Label
                    htmlFor="pm-card"
                    className="cursor-pointer font-normal flex items-center gap-1"
                  >
                    <CreditCard className="w-4 h-4" /> Card
                  </Label>
                </div>
              ) : null}
            </RadioGroup>
            {menuInfoError && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                Use Retry availability above before placing an order.
              </p>
            )}
            {menuInfo?.cardPaymentsEnabled ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Menu availability, hours, pickup location, and payment readiness
                are checked again when payment completes. If they changed, the
                order is blocked from fulfillment and payment cancellation or
                refund reconciliation begins.
              </p>
            ) : null}
            {menuInfo && !menuInfo.cardPaymentsEnabled ? (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                This business has not enabled a safe online payment method yet.
              </p>
            ) : null}
            {menuInfo && !menuInfo.pricesIncludeTax ? (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                Checkout stays unavailable until this business confirms that
                displayed prices include applicable tax.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {orderError && (
          <div role="alert" className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 px-4 py-3 rounded-lg mb-4">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {orderError}
          </div>
        )}

        {hostileBrowser ? (
          <div className="mb-4">
            <PaymentBrowserGate currentUrl={window.location.href} reason="Open this checkout in your browser before continuing to payment." compact />
          </div>
        ) : null}
        {!stripePromise && !hostileBrowser ? (
          <p className="mb-4 text-sm text-destructive" role="alert">Secure card payment is unavailable. Return to the menu or try again later; no new payment can be submitted here.</p>
        ) : null}
        <p id="checkout-next-step" className="mb-3 text-sm text-[color:var(--profile-muted)]" role="status">
          {isCreating ? "Preparing your secure payment…"
            : menuInfoLoading ? "Checking availability before payment."
            : menuInfoError ? "Retry the availability check to continue."
            : !orderingEnabled ? "Online ordering is currently unavailable."
            : customerCardFeesPending ? (finalTotalsError ?? "Waiting for the final total…")
            : !contact.name.trim() ? "Add your name to continue."
            : !contact.email.trim() && !contact.phone.trim() ? "Add an email address or phone number to continue."
            : Boolean(contact.phone.trim()) && !normalizedContactPhone ? "Check your phone number to continue."
            : !orderType ? "Choose pickup to continue."
            : "Review your final total above before continuing to payment."}
        </p>
        <Button
          aria-describedby="checkout-next-step"
          aria-busy={isCreating}
          className="h-12 w-full rounded-full bg-[#d84a12] text-base font-black text-white shadow-[0_16px_35px_rgba(149,58,18,0.2)] hover:bg-[#b83a0a]"
          onClick={createOrder}
          disabled={
            isCreating ||
            menuInfoLoading ||
            menuInfoError ||
            customerCardFeesPending ||
            !contact.name.trim() ||
            (!contact.email.trim() && !contact.phone.trim()) ||
            (Boolean(contact.phone.trim()) && !normalizedContactPhone) ||
            !orderType ||
            !orderingEnabled ||
            !menuInfo?.cardPaymentsEnabled ||
            !stripePromise ||
            hostileBrowser
          }
        >
          {isCreating && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
          Continue to secure payment
        </Button>
      </main>
    </div>
  );
}

// ──────────────────────────── StripePaymentForm ───────────────────────────────
function StripePaymentForm({
  orderId,
  restaurantId,
  onSuccess,
  onCheckStatus,
}: {
  orderId: string;
  restaurantId: string;
  onSuccess: () => void;
  onCheckStatus: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsStatusCheck, setNeedsStatusCheck] = useState(false);
  const processingRef = useRef(false);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || processingRef.current || needsStatusCheck) return;

    processingRef.current = true;
    setIsProcessing(true);
    setError(null);

    try {
      const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/order-confirmation/${orderId}`,
        },
        redirect: "if_required",
      });

      if (!activeRef.current) return;
      if (stripeError) {
        setError(stripeError.message ?? "Payment could not be confirmed.");
        setNeedsStatusCheck(
          stripeError.type !== "card_error" && stripeError.type !== "validation_error",
        );
        return;
      }

      if (paymentIntent?.status === "succeeded") {
        onSuccess();
      } else if (paymentIntent?.status === "processing" || paymentIntent?.status === "requires_capture") {
        // Confirmation is not final settlement. Keep cart/replay access until
        // the existing order status is reconciled by the server.
        onCheckStatus();
      } else {
        setError("Payment status could not be confirmed. Check this order before trying again.");
        setNeedsStatusCheck(true);
      }
    } catch (err: any) {
      if (activeRef.current) {
        setError(err.message || "The connection was interrupted. Payment status is unknown.");
        setNeedsStatusCheck(true);
      }
    } finally {
      processingRef.current = false;
      if (activeRef.current) setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-busy={isProcessing}>
      <PaymentElement />
      {error && (
        <div role="alert" className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 px-4 py-3 rounded-lg">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}
      {needsStatusCheck ? (
        <div className="space-y-2">
          <p className="text-sm" role="status">
            Check the existing order before submitting another payment. Your checkout is preserved.
          </p>
          <Button type="button" variant="outline" className="w-full" onClick={onCheckStatus}>
            Check order status
          </Button>
        </div>
      ) : null}
      <Button
        type="submit"
        className="h-12 w-full rounded-full bg-[#d84a12] text-base font-black text-white hover:bg-[#b83a0a]"
        disabled={!stripe || !elements || isProcessing || needsStatusCheck}
      >
        {isProcessing && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
        Confirm Payment
      </Button>
    </form>
  );
}
