import { readPublicMenuJson, menuRecoveryMessage, menuProfileReturnPath } from "@/lib/public-menu-recovery";
/**
 * Public Menu Page — Customer view of a restaurant/bar/truck's online menu.
 * Supports add-to-cart with variants + modifiers.
 * Cart state is stored in localStorage for simplicity.
 */
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useLocation, useSearch } from "wouter";
import { SEOHead } from "@/components/seo-head";
import { PublicOrderingTopBar } from "@/components/public-ordering/PublicOrderingTopBar";
import { buildPublicProfilePath } from "@/lib/public-profile-path";
import { getDishCategoryPhoto } from "@/lib/dishCategoryPhoto";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ShoppingCart,
  Plus,
  Minus,
  Loader2,
  AlertCircle,
  ChevronRight,
  ArrowLeft,
  MapPin,
} from "lucide-react";

const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// ─────────────────────────────────── types ────────────────────────────────────
interface Variant {
  id: string;
  label: string;
  additionalCents: number;
  isDefault: boolean;
}

interface Modifier {
  id: string;
  groupName: string;
  label: string;
  additionalCents: number;
  isRequired: boolean;
  maxSelections: number;
}

interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  itemType: "food" | "merchandise";
  imageUrl: string | null;
  isAvailable: boolean;
  calories: number | null;
  dietaryTags: string[] | null;
  allergens: string[] | null;
  variants: Variant[];
  modifiers: Modifier[];
}

interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  items: MenuItem[];
}

interface Menu {
  id: string;
  name: string;
  serviceType: string;
  isActive: boolean;
  acceptsCash: boolean;
  hidePlatformFee: boolean;
  pricesIncludeTax: boolean;
  orderingEnabled: boolean;
  orderingBlockingReasons: string[];
  paymentMethods: {
    card: boolean;
    cash: boolean;
  };
  categories: MenuCategory[];
  uncategorizedItems?: MenuItem[];
}

interface OrderingReadiness {
  orderingEnabled: boolean;
  blockingReasons: string[];
  paymentMethods?: {
    card: boolean;
    cash: boolean;
  };
  checks: Array<{
    id: string;
    label: string;
    ok: boolean;
    blocking: boolean;
    action: string;
  }>;
}

export interface CartItem {
  menuId: string;
  restaurantId: string;
  menuItemId: string;
  itemName: string;
  priceCents: number;
  quantity: number;
  selectedVariantId: string | null;
  variantLabel: string | null;
  variantAddCents: number;
  selectedModifierIds: string[];
  modifierLabels: string[];
  modifierAddCents: number;
  lineTotalCents: number;
  specialInstructions: string;
}

const CART_KEY = "mealscout_cart";

function getCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCart(cart: CartItem[]) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

export default function MenuPage() {
  const { restaurantId } = useParams<{ restaurantId: string }>();
  return <MenuView key={restaurantId ?? ""} restaurantId={restaurantId ?? ""} />;
}

function MenuView({ restaurantId }: { restaurantId: string }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [addingItem, setAddingItem] = useState<MenuItem | null>(null);
  const requestedMenuId = new URLSearchParams(search).get("menuId");
  const selectMenu = (menuId: string) => {
    setAddingItem(null);
    const url = new URL(window.location.href);
    url.searchParams.set("menuId", menuId);
    navigate(url.pathname + url.search + url.hash, { replace: true });
  };

  // Load cart from localStorage on mount
  useEffect(() => {
    setCart(getCart());
  }, []);

  const menusQuery = useQuery<{ menus: Menu[]; orderingEnabled: boolean; readiness?: OrderingReadiness; restaurantName?: string | null; restaurantCity?: string | null; isFoodTruck?: boolean; cuisineType?: string | null }>({
    queryKey: ["/api/menus", restaurantId],
    queryFn: ({ signal }) => readPublicMenuJson(
      `/api/menus/${encodeURIComponent(restaurantId)}`, signal,
    ),
    retry: false,
    enabled: !!restaurantId,
  });

  const menus = menusQuery.data?.menus ?? [];
  const activeMenus = menus.filter((m) => m.isActive);
  const restaurantName = menusQuery.data?.restaurantName ?? null;
  const restaurantCity = menusQuery.data?.restaurantCity ?? null;
  const isFoodTruck = menusQuery.data?.isFoodTruck ?? false;
  const cuisineType = menusQuery.data?.cuisineType ?? null;
  const entityType = isFoodTruck ? "Food Truck" : "Restaurant";
  const publicProfileHref = menuProfileReturnPath(new URLSearchParams(search).get("returnTo"), restaurantId) ??
    buildPublicProfilePath({
      entityType: isFoodTruck ? "truck" : "restaurant",
      id: restaurantId,
      name: restaurantName,
    }) ?? "/scout";
  const seoTitle = restaurantName
    ? `${restaurantName} Menu${restaurantCity ? ` - ${restaurantCity}` : ""} | MealScout`
    : `Online Menu | MealScout`;
  const seoDescription = restaurantName
    ? `Browse the menu from ${restaurantName}${restaurantCity ? ` in ${restaurantCity}` : ""}${cuisineType ? ` — ${cuisineType}` : ""}. Order for pickup when available on MealScout.`
    : `Browse the full menu and order for pickup when available on MealScout.`;

  const selectedMenu = activeMenus.find((menu) => menu.id === requestedMenuId) ?? activeMenus[0] ?? null;
  const selectedMenuId = selectedMenu?.id ?? null;
  const menuSections = (selectedMenu?.categories ?? []).map((category) => ({
    key: `category:${category.id}`,
    anchorId: `menu-category-${category.id}`,
    name: category.name,
    description: category.description,
    items: category.items,
  }));
  const seenItemIds = new Set(
    menuSections.flatMap((section) => section.items.map((item) => item.id)),
  );
  const uncategorizedItems = Array.isArray(selectedMenu?.uncategorizedItems)
    ? selectedMenu.uncategorizedItems.filter((item) => {
        if (seenItemIds.has(item.id)) return false;
        seenItemIds.add(item.id);
        return true;
      })
    : [];
  if (uncategorizedItems.length > 0) {
    menuSections.push({
      key: "uncategorized",
      anchorId: "menu-uncategorized-items",
      name: "Other items",
      description: null,
      items: uncategorizedItems,
    });
  }
  const menuReadMessage = menuRecoveryMessage(menusQuery.error);
  const orderingEnabled = Boolean(selectedMenu?.orderingEnabled);
  const cardPaymentsEnabled = Boolean(selectedMenu?.paymentMethods?.card);
  const restaurantCart = cart.filter((i) => i.restaurantId === restaurantId);
  const cartMenuIds = new Set(restaurantCart.map((item) => item.menuId));
  const cartHasMixedMenus = cartMenuIds.size > 1;
  const cartMenu = activeMenus.find(
    (menu) => menu.id === restaurantCart[0]?.menuId,
  );

  const cartItemCount = restaurantCart
    .reduce((sum, i) => sum + i.quantity, 0);

  const addToCart = (item: CartItem) => {
    const existingMenuId = restaurantCart[0]?.menuId;
    let baseCart = cart;
    if (existingMenuId && existingMenuId !== item.menuId) {
      const existingMenuName =
        activeMenus.find((menu) => menu.id === existingMenuId)?.name ||
        "another menu";
      const shouldReplace = window.confirm(
        `Your cart contains items from ${existingMenuName}. Clear that cart and start an order from this menu?`,
      );
      if (!shouldReplace) return false;
      baseCart = cart.filter((cartItem) => cartItem.restaurantId !== restaurantId);
    }
    const newCart = [...baseCart, item];
    setCart(newCart);
    saveCart(newCart);
    return true;
  };

  const removeFromCart = (idx: number) => {
    const newCart = cart.filter((_, i) => i !== idx);
    setCart(newCart);
    saveCart(newCart);
  };

  const updateQty = (idx: number, delta: number) => {
    const newCart = cart
      .map((item, i) => {
        if (i !== idx) return item;
        const newQty = item.quantity + delta;
        if (newQty <= 0) return null;
        return {
          ...item,
          quantity: newQty,
          lineTotalCents:
            (item.priceCents + item.variantAddCents + item.modifierAddCents) *
            newQty,
        };
      })
      .filter(Boolean) as CartItem[];
    setCart(newCart);
    saveCart(newCart);
  };

  const cartTotal = restaurantCart.reduce(
    (sum, i) => sum + i.lineTotalCents,
    0,
  );

  if (menusQuery.isLoading) {
    return (
      <div
        className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)]"
        data-public-menu-shell="warm-food-led"
      >
        <PublicOrderingTopBar secondaryHref={publicProfileHref} />
        <main className="mx-auto flex min-h-[70vh] w-full max-w-5xl items-center justify-center px-4 py-20">
          <div className="profile-surface flex items-center gap-3 rounded-3xl px-6 py-5 text-[color:var(--profile-ink-soft)]">
            <Loader2 className="h-5 w-5 animate-spin text-[color:var(--profile-accent)]" />
            <span className="font-bold">Loading menu</span>
          </div>
        </main>
      </div>
    );
  }

  if (menusQuery.isError || activeMenus.length === 0) {
    return (
      <div
        className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)]"
        data-public-menu-shell="warm-food-led"
      >
        <PublicOrderingTopBar secondaryHref={publicProfileHref} />
        <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center justify-center px-4 py-20">
          <section className="profile-surface w-full rounded-[2rem] p-7 text-center sm:p-10">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--profile-surface-strong)] text-[color:var(--profile-accent)]">
              <AlertCircle className="h-6 w-6" />
            </span>
            <h1 className="mt-4 text-2xl font-black tracking-tight text-[color:var(--profile-ink)]">
              {menusQuery.isError ? menuReadMessage.title : "Menu coming soon"}
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[color:var(--profile-muted)]">
              {menusQuery.isError
                ? menuReadMessage.description
                : "This business has not published an active menu yet. Check the profile for current details."}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {menusQuery.isError ? (
                <Button className="profile-action-primary min-h-11" disabled={menusQuery.isFetching} onClick={() => void menusQuery.refetch()}>
                  {menusQuery.isFetching ? "Retrying menu…" : "Retry menu"}
                </Button>
              ) : null}
              <Link
                href={publicProfileHref}
                className="profile-action-secondary inline-flex min-h-11 items-center rounded-full px-5 text-sm font-black"
              >
                View profile
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

  return (
    <div
      className="mealscout-public-profile min-h-screen bg-[color:var(--profile-page)] pb-24 text-[color:var(--profile-ink)]"
      data-public-menu-shell="warm-food-led"
    >
      <SEOHead
        title={seoTitle}
        description={seoDescription}
        ogType="website"
      />
      <PublicOrderingTopBar secondaryHref={publicProfileHref} />

      <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:py-7">
        <header className="profile-surface mb-6 overflow-hidden rounded-[2rem]">
          <div className="p-5 sm:p-6">
            <Link
              href={publicProfileHref}
              className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-[color:var(--profile-surface-soft)] px-3 text-sm font-black text-[color:var(--profile-ink-soft)] transition-colors hover:text-[color:var(--profile-accent)]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to profile
            </Link>

            <p className="profile-section-label">
              {entityType} menu
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-[color:var(--profile-ink)] sm:text-4xl">
              {restaurantName || "Menu"}
            </h1>

            {(restaurantCity || cuisineType) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-bold text-[color:var(--profile-muted)]">
                {restaurantCity ? (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-4 w-4 text-[color:var(--profile-accent)]" aria-hidden="true" />
                    {restaurantCity}
                  </span>
                ) : null}
                {cuisineType ? <span>{cuisineType}</span> : null}
              </div>
            )}
          </div>
        </header>

        {requestedMenuId && requestedMenuId !== selectedMenuId ? (
          <p role="status" className="mb-4 text-sm text-[color:var(--profile-ink-soft)]">The selected menu is no longer available. Showing {selectedMenu?.name} instead. Your cart has not been changed.</p>
        ) : null}

        {/* Menu selector tabs if multiple menus */}
        {activeMenus.length > 1 && (
          <div className="mb-5 flex gap-2 overflow-x-auto pb-1" aria-label="Choose a menu">
            {activeMenus.map((menu) => (
              <button
                key={menu.id}
                onClick={() => selectMenu(menu.id)}
                aria-pressed={selectedMenuId === menu.id}
                className={`min-h-11 whitespace-nowrap rounded-full border px-4 text-sm font-black transition-colors ${
                  selectedMenuId === menu.id
                    ? "border-[color:var(--profile-accent)] bg-[color:var(--profile-accent)] text-white"
                    : "border-[color:var(--profile-border)] bg-white text-[color:var(--profile-ink-soft)] hover:border-[color:var(--profile-accent)]"
                }`}
              >
                {menu.name}
              </button>
            ))}
          </div>
        )}

        {selectedMenu && (
          <>
            {!orderingEnabled && (
              <div className="mb-5 flex items-start gap-3 rounded-2xl border border-[#efc37b] bg-[#fff4d9] px-4 py-3 text-sm text-[#70470f]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-black">Browse the menu</p>
                  <p className="mt-0.5 text-xs leading-5">
                    {selectedMenu.orderingBlockingReasons?.join(", ") ||
                      `Online ordering is not available here yet. Contact this ${entityType.toLowerCase()} directly to order.`}
                  </p>
                </div>
              </div>
            )}
            {!selectedMenu.hidePlatformFee &&
              orderingEnabled &&
              cardPaymentsEnabled && (
              <p className="mb-4 text-center text-xs text-[color:var(--profile-muted)]">
                Card fees are calculated by MealScout and itemized before payment.
              </p>
            )}
            {selectedMenu.hidePlatformFee &&
              orderingEnabled &&
              cardPaymentsEnabled && (
                <p className="mb-4 text-center text-xs text-[color:var(--profile-muted)]">
                  Secure card payment is available for pickup.
                </p>
              )}
            {orderingEnabled && selectedMenu.pricesIncludeTax ? (
              <p className="mb-4 text-center text-xs text-[color:var(--profile-muted)]">
                Displayed item prices include applicable tax as set by this
                business.
              </p>
            ) : null}

            {menuSections.length > 1 && (
              <nav
                className="mb-6 flex gap-2 overflow-x-auto pb-1"
                aria-label="Menu categories"
              >
                {menuSections.map((section) => (
                  <a
                    key={section.key}
                    href={`#${section.anchorId}`}
                    className="inline-flex min-h-9 items-center whitespace-nowrap rounded-full border border-[color:var(--profile-border)] bg-white px-3 text-xs font-black text-[color:var(--profile-ink-soft)] hover:border-[color:var(--profile-accent)] hover:text-[color:var(--profile-accent)]"
                  >
                    {section.name}
                  </a>
                ))}
              </nav>
            )}

            {/* Menu sections + items */}
            {menuSections.map((section) => {
              return (
                <section
                  key={section.key}
                  id={section.anchorId}
                  className="mb-9 scroll-mt-24"
                >
                  <div className="mb-4 border-b border-[color:var(--profile-border)] pb-3">
                    <h2 className="text-xl font-black tracking-tight text-[color:var(--profile-ink)]">
                      {section.name}
                    </h2>
                    {section.description && (
                      <p className="mt-1 text-sm leading-6 text-[color:var(--profile-muted)]">
                        {section.description}
                      </p>
                    )}
                  </div>
                  {section.items.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {section.items.map((item) => (
                        <MenuItemCard
                          key={item.id}
                          item={item}
                          onAdd={() => setAddingItem(item)}
                          orderingEnabled={orderingEnabled && item.isAvailable}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="profile-surface rounded-2xl px-4 py-5 text-sm font-bold text-[color:var(--profile-muted)]">
                      No items have been added to this category yet.
                    </div>
                  )}
                </section>
              );
            })}

            <section className="profile-surface mt-10 flex flex-col items-start justify-between gap-4 rounded-[2rem] p-5 sm:flex-row sm:items-center sm:p-6">
              <div>
                <p className="profile-section-label">Still deciding?</p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-[color:var(--profile-ink)]">
                  Find another local favorite
                </h2>
              </div>
              <Link
                href="/scout"
                className="profile-action-primary inline-flex min-h-11 items-center rounded-full px-5 text-sm font-black"
              >
                Scout
              </Link>
            </section>
          </>
        )}
      </main>

      {/* Floating cart button */}
      {cartItemCount > 0 && (
        <div className="fixed bottom-4 inset-x-4 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-96 z-50">
          <Button
            className="h-12 w-full rounded-full bg-[#d84a12] text-base font-black text-white shadow-[0_16px_35px_rgba(149,58,18,0.24)] hover:bg-[#b83a0a]"
            onClick={() => setCartOpen(true)}
          >
            <ShoppingCart className="w-5 h-5 mr-2" />
            View Cart ({cartItemCount})
            <span className="ml-auto">{formatMoney(cartTotal)}</span>
          </Button>
        </div>
      )}

      {/* Add item dialog */}
      {addingItem && selectedMenu && orderingEnabled && (
        <AddItemDialog
          item={addingItem}
          menuId={selectedMenu.id}
          restaurantId={restaurantId ?? ""}
          hidePlatformFee={selectedMenu.hidePlatformFee}
          onAdd={(cartItem) => {
            if (addToCart(cartItem)) setAddingItem(null);
          }}
          onClose={() => setAddingItem(null)}
        />
      )}

      {/* Cart sheet */}
      <Sheet open={cartOpen} onOpenChange={setCartOpen}>
        <SheetContent side="right" className="w-full border-l border-[#ead7c7] bg-[#fffaf4] text-[#2c1c14] sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="text-[#2c1c14]">Your cart</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto py-4 space-y-3">
            {restaurantCart.length === 0 && (
              <p className="text-center text-muted-foreground py-8">
                Your cart is empty.
              </p>
            )}
            {restaurantCart.map((item, idx) => {
              const globalIdx = cart.indexOf(item);
              return (
                <div
                  key={idx}
                  className="flex gap-3 rounded-2xl border border-[#ead7c7] bg-white p-3"
                >
                  <div className="flex-1">
                    <div className="font-medium">{item.itemName}</div>
                    {item.variantLabel && (
                      <div className="text-xs text-muted-foreground">
                        {item.variantLabel}
                      </div>
                    )}
                    {item.modifierLabels.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        + {item.modifierLabels.join(", ")}
                      </div>
                    )}
                    {item.specialInstructions && (
                      <div className="text-xs italic text-muted-foreground">
                        {item.specialInstructions}
                      </div>
                    )}
                    <div className="font-semibold text-sm mt-1">
                      {formatMoney(item.lineTotalCents)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => updateQty(globalIdx, -1)}
                    >
                      <Minus className="w-3 h-3" />
                    </Button>
                    <span className="w-5 text-center text-sm">
                      {item.quantity}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => updateQty(globalIdx, 1)}
                    >
                      <Plus className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <SheetFooter className="border-t border-[#ead7c7] pt-4">
            <div className="w-full space-y-3">
              <div className="flex justify-between font-medium">
                <span>Subtotal</span>
                <span>{formatMoney(cartTotal)}</span>
              </div>
              {restaurantCart.length > 0 &&
              cartMenu?.paymentMethods.card &&
              !cartMenu.hidePlatformFee ? (
                <p className="text-xs text-muted-foreground">
                  Card fees are itemized before payment.
                </p>
              ) : null}
              <Button
                className="w-full rounded-full bg-[#d84a12] font-black text-white hover:bg-[#b83a0a]"
                size="lg"
                onClick={() => {
                  setCartOpen(false);
                  navigate(`/checkout/${restaurantId}`);
                }}
                disabled={
                  restaurantCart.length === 0 ||
                  cartHasMixedMenus ||
                  !cartMenu?.orderingEnabled
                }
              >
                Proceed to Checkout
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
              {cartHasMixedMenus ? (
                <p className="text-xs font-bold text-destructive">
                  This saved cart contains more than one menu. Remove those items
                  before checkout.
                </p>
              ) : cartMenu && !cartMenu.orderingEnabled ? (
                <p className="text-xs font-bold text-[#70470f]">
                  This menu is not accepting orders right now.
                </p>
              ) : null}
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─────────────────────────────── MenuItemCard ─────────────────────────────────
function MenuItemCard({
  item,
  onAdd,
  orderingEnabled = true,
}: {
  item: MenuItem;
  onAdd: () => void;
  orderingEnabled?: boolean;
}) {
  const hasOrderablePrice =
    typeof item.priceCents === "number" &&
    Number.isInteger(item.priceCents) &&
    item.priceCents >= 0;
  const categoryPhoto = getDishCategoryPhoto(item.name, item.description);
  const hasPrimaryImage = Boolean(item.imageUrl?.trim());
  const [imageMode, setImageMode] = useState<"primary" | "category" | "none">(
    () => (hasPrimaryImage ? "primary" : categoryPhoto ? "category" : "none"),
  );
  const imageSrc =
    imageMode === "primary"
      ? item.imageUrl
      : imageMode === "category"
        ? categoryPhoto?.image
        : null;

  return (
    <article className="profile-surface grid min-h-36 grid-cols-[minmax(0,1fr)_7rem] gap-3 overflow-hidden rounded-3xl p-3 sm:min-h-40 sm:grid-cols-[minmax(0,1fr)_8rem]">
      <div className="flex min-w-0 flex-col p-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-black leading-tight text-[color:var(--profile-ink)]">
            {item.name}
          </h3>
          {item.itemType === "merchandise" && (
            <Badge
              variant="outline"
              className="border-[color:var(--profile-border)] bg-white text-[10px] font-black text-[color:var(--profile-ink-soft)]"
            >
              Merch
            </Badge>
          )}
          {!item.isAvailable && (
            <Badge className="border-0 bg-[#efe3da] text-[10px] font-black text-[#795e4d] hover:bg-[#efe3da]">
              Unavailable
            </Badge>
          )}
        </div>
        {item.description && (
          <p className="mt-1 line-clamp-3 text-sm leading-5 text-[color:var(--profile-muted)]">
            {item.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-black text-[color:var(--profile-ink)]">
            {hasOrderablePrice ? formatMoney(item.priceCents!) : "Price unavailable"}
          </span>
          {item.itemType !== "merchandise" && item.calories && (
            <span className="text-xs font-bold text-[color:var(--profile-muted)]">
              {item.calories} cal
            </span>
          )}
          {item.itemType !== "merchandise" && (item.dietaryTags ?? []).map((tag) => (
            <Badge
              key={tag}
              className="border-0 bg-[#e8f4e8] px-1.5 py-0 text-[10px] font-black text-[#35633b] hover:bg-[#e8f4e8]"
            >
              {tag}
            </Badge>
          ))}
        </div>
        {orderingEnabled && hasOrderablePrice ? (
          <button
            type="button"
            onClick={onAdd}
            className="mt-auto inline-flex min-h-9 w-fit items-center rounded-full bg-[color:var(--profile-accent)] px-4 text-xs font-black text-white transition-colors hover:bg-[color:var(--profile-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--profile-accent)] focus-visible:ring-offset-2"
            aria-label={`Add ${item.name} to cart`}
          >
            Add
          </button>
        ) : null}
      </div>

      <div className="relative min-h-28 overflow-hidden rounded-2xl bg-[color:var(--profile-surface-soft)]">
        {imageSrc ? (
          <>
            <img
              src={imageSrc}
              alt={imageMode === "primary" ? item.name : ""}
              className="h-full w-full object-cover"
              onError={() =>
                setImageMode((current) =>
                  current === "primary" && categoryPhoto ? "category" : "none",
                )
              }
            />
            {imageMode === "category" ? (
              <span className="absolute inset-x-1.5 bottom-1.5 rounded-full bg-[#2c1c14]/80 px-2 py-1 text-center text-[9px] font-black uppercase tracking-wide text-white backdrop-blur-sm">
                Photo coming soon
              </span>
            ) : null}
          </>
        ) : (
          <div className="flex h-full min-h-28 items-center justify-center bg-[linear-gradient(145deg,#ffe5cf,#fff3e5)] px-3 text-center text-[10px] font-black uppercase tracking-[0.12em] text-[#8a5b3f]">
            Photo coming soon
          </div>
        )}
      </div>
    </article>
  );
}

// ───────────────────────────── AddItemDialog ──────────────────────────────────
function AddItemDialog({
  item,
  menuId,
  restaurantId,
  hidePlatformFee,
  onAdd,
  onClose,
}: {
  item: MenuItem;
  menuId: string;
  restaurantId: string;
  hidePlatformFee: boolean;
  onAdd: (cartItem: CartItem) => void;
  onClose: () => void;
}) {
  const [qty, setQty] = useState(1);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    item.variants.find((v) => v.isDefault)?.id ?? item.variants[0]?.id ?? null,
  );
  const [selectedModifierIds, setSelectedModifierIds] = useState<string[]>([]);
  const [specialInstructions, setSpecialInstructions] = useState("");

  const selectedVariant = item.variants.find((v) => v.id === selectedVariantId);
  const variantAddCents = selectedVariant?.additionalCents ?? 0;
  const selectedModifiers = item.modifiers.filter((m) =>
    selectedModifierIds.includes(m.id),
  );
  const modifierAddCents = selectedModifiers.reduce(
    (sum, m) => sum + m.additionalCents,
    0,
  );
  if (
    typeof item.priceCents !== "number" ||
    !Number.isInteger(item.priceCents) ||
    item.priceCents < 0
  ) {
    return null;
  }

  const basePriceCents = item.priceCents;
  const unitPrice = basePriceCents + variantAddCents + modifierAddCents;
  const lineTotal = unitPrice * qty;

  // Group modifiers by groupName
  const modifierGroups = item.modifiers.reduce<Record<string, Modifier[]>>(
    (acc, m) => {
      acc[m.groupName] = acc[m.groupName] ?? [];
      acc[m.groupName].push(m);
      return acc;
    },
    {},
  );
  const missingRequiredModifier = Object.values(modifierGroups).some((mods) => {
    const required = mods.some((modifier) => modifier.isRequired);
    return (
      required &&
      !mods.some((modifier) => selectedModifierIds.includes(modifier.id))
    );
  });

  const toggleModifier = (
    id: string,
    maxSelections: number,
    groupName: string,
  ) => {
    const groupModIds = item.modifiers
      .filter((m) => m.groupName === groupName)
      .map((m) => m.id);
    const currentGroupSelected = selectedModifierIds.filter((mid) =>
      groupModIds.includes(mid),
    );

    if (selectedModifierIds.includes(id)) {
      setSelectedModifierIds((prev) => prev.filter((m) => m !== id));
    } else {
      if (currentGroupSelected.length >= maxSelections) {
        // Replace the oldest selection in this group
        const toRemove = currentGroupSelected[0];
        setSelectedModifierIds((prev) =>
          prev.filter((m) => m !== toRemove).concat(id),
        );
      } else {
        setSelectedModifierIds((prev) => [...prev, id]);
      }
    }
  };

  const handleAdd = () => {
    const cartItem: CartItem = {
      menuId,
      restaurantId,
      menuItemId: item.id,
      itemName: item.name,
      priceCents: basePriceCents,
      quantity: qty,
      selectedVariantId: selectedVariantId,
      variantLabel: selectedVariant?.label ?? null,
      variantAddCents,
      selectedModifierIds,
      modifierLabels: selectedModifiers.map((m) => m.label),
      modifierAddCents,
      lineTotalCents: lineTotal,
      specialInstructions,
    };
    onAdd(cartItem);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto border-[#ead7c7] bg-[#fffaf4] text-[#2c1c14] shadow-[0_24px_80px_rgba(90,43,17,0.22)]">
        <DialogHeader>
          <DialogTitle className="text-[#2c1c14]">{item.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {item.description && (
            <p className="text-sm leading-6 text-[#806657]">{item.description}</p>
          )}
          {item.itemType !== "merchandise" && item.calories && (
            <p className="text-xs font-bold text-[#806657]">
              {item.calories} calories
            </p>
          )}
          {item.itemType !== "merchandise" && item.allergens && item.allergens.length > 0 && (
            <p className="text-xs text-amber-700">
              ⚠ Contains: {item.allergens.join(", ")}
            </p>
          )}

          {/* Variants */}
          {item.variants.length > 0 && (
            <div>
              <Label className="font-black text-[#2c1c14]">Size / Option</Label>
              <RadioGroup
                value={selectedVariantId ?? ""}
                onValueChange={setSelectedVariantId}
                className="mt-2 space-y-2"
              >
                {item.variants.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between rounded-xl border border-[#ead7c7] bg-white px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value={v.id} id={`var-${v.id}`} />
                      <Label
                        htmlFor={`var-${v.id}`}
                        className="font-normal cursor-pointer"
                      >
                        {v.label}
                      </Label>
                    </div>
                    {v.additionalCents > 0 && (
                      <span className="text-sm text-[#806657]">
                        +{formatMoney(v.additionalCents)}
                      </span>
                    )}
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}

          {/* Modifiers */}
          {Object.entries(modifierGroups).map(([groupName, mods]) => {
            const required = mods.some((modifier) => modifier.isRequired);
            const max = Math.min(
              ...mods.map((modifier) => Math.max(1, modifier.maxSelections)),
            );
            return (
              <div key={groupName}>
                <div className="flex items-center gap-2 mb-2">
                  <Label className="font-black text-[#2c1c14]">{groupName}</Label>
                  {required ? (
                    <Badge
                      variant="destructive"
                      className="text-xs px-1.5 py-0"
                    >
                      Required
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs px-1.5 py-0">
                      Optional{max > 1 ? ` (up to ${max})` : ""}
                    </Badge>
                  )}
                </div>
                <div className="space-y-2">
                  {mods.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded-xl border border-[#ead7c7] bg-white px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`mod-${m.id}`}
                          checked={selectedModifierIds.includes(m.id)}
                          onCheckedChange={() =>
                            toggleModifier(m.id, max, groupName)
                          }
                        />
                        <Label
                          htmlFor={`mod-${m.id}`}
                          className="font-normal cursor-pointer"
                        >
                          {m.label}
                        </Label>
                      </div>
                      {m.additionalCents > 0 && (
                        <span className="text-sm text-[#806657]">
                          +{formatMoney(m.additionalCents)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Special instructions */}
          <div>
            <Label className="font-black text-[#2c1c14]">Special instructions</Label>
            <Textarea
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              placeholder="Any allergies or special requests?"
              className="mt-2 border-[#d8bda8] bg-white text-[#2c1c14] placeholder:text-[#9b8172]"
              rows={2}
            />
          </div>

          {/* Quantity */}
          <div className="flex items-center justify-between">
            <Label className="font-black text-[#2c1c14]">Quantity</Label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 border-[#d8bda8] bg-white p-0 text-[#2c1c14] hover:bg-[#fff2e5]"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
              >
                <Minus className="w-3 h-3" />
              </Button>
              <span className="w-8 text-center font-semibold">{qty}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 border-[#d8bda8] bg-white p-0 text-[#2c1c14] hover:bg-[#fff2e5]"
                onClick={() => setQty((q) => q + 1)}
              >
                <Plus className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="rounded-full border-[#d8bda8] bg-white font-black text-[#2c1c14] hover:bg-[#fff2e5]"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            className="rounded-full bg-[#d84a12] font-black text-white hover:bg-[#b83a0a]"
            onClick={handleAdd}
            disabled={missingRequiredModifier}
          >
            {missingRequiredModifier
              ? "Choose required options"
              : `Add to Cart — ${formatMoney(lineTotal)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
