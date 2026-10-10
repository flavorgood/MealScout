/**
 * Menu Builder — Business dashboard page
 * Allows restaurant/bar/truck owners to create and manage their online menus.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { prepareMenuCreationAttempt, confirmMenuCreationAttempt, assertMenuCreationReceipt, type MenuCreationAttempt } from "@/lib/menu-creation-request";
import { useAuth } from "@/hooks/useAuth";
import { MenuDraftPreview, PrivateMenuDraftPage } from "@/components/private-menu-draft";
import { guestMenuDraftToCsv, readGuestMenuDraft } from "@shared/guestMenuDraft";
import { getProgressiveAccountGate } from "@shared/progressiveOnboarding";
import { useToast } from "@/hooks/use-toast";
import BusinessWorkspaceShell from "@/components/business-workspace-shell";
import {
  getScopedBusinessPermissions,
  isScopedBusinessOwner,
  type BusinessAccessContext,
} from "@/lib/business-access";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Pencil,
  Trash2,
  Upload,
  ChevronDown,
  CircleAlert,
  CircleCheckBig,
  Loader2,
  UtensilsCrossed,
  DollarSign,
  ImageIcon,
  Package,
  Eye,
  EyeOff,
  SlidersHorizontal,
} from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { z } from "zod";
import type { Restaurant } from "@shared/schema";
import { isBarBusinessType, isTruckBusinessType } from "@shared/businessTypes";
import { buildPublicProfilePath } from "@/lib/public-profile-path";

const formatMoney = (cents: number) =>
  `$${(Number(cents || 0) / 100).toFixed(2)}`;

// ─────────────────────────────────── types ────────────────────────────────────
interface Menu {
  id: string;
  name: string;
  serviceType: string;
  isActive: boolean;
  acceptsCash: boolean;
  hidePlatformFee: boolean;
  pricesIncludeTax: boolean;
  availableFrom: string | null;
  availableTo: string | null;
}

interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
}

interface MenuItemVariant {
  id?: string;
  label: string;
  additionalCents: number;
  isDefault: boolean;
}

interface MenuItemModifier {
  id?: string;
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
  trackInventory: boolean;
  inventoryQty: number | null;
  dietaryTags: string[] | null;
  allergens: string[] | null;
  calories: number | null;
  variants: MenuItemVariant[];
  modifiers: MenuItemModifier[];
  categoryId: string | null;
}

interface FullMenu extends Menu {
  categories: Array<MenuCategory & { items: MenuItem[] }>;
  uncategorizedItems?: MenuItem[];
}

// Validate the fields this view displays. Readiness authority stays on the server.
const orderingReadinessSchema = z.object({
  orderingEnabled: z.boolean(),
  publicMenuBusinessVisible: z.boolean().optional(),
  blockingReasons: z.array(z.string()),
  paymentMethods: z.object({ card: z.boolean(), cash: z.boolean() }).optional(),
  checks: z.array(z.object({
    id: z.string(),
    label: z.string(),
    ok: z.boolean(),
    blocking: z.boolean(),
    action: z.string(),
  })),
  payout: z.object({
    connected: z.boolean(),
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    status: z.string(),
    message: z.string(),
  }).optional(),
});
type OrderingReadiness = z.infer<typeof orderingReadinessSchema>;

// ──────────────────────────────── helpers ─────────────────────────────────────
function useRestaurantId(): string | null {
  const { user } = useAuth();
  const search = useSearch();
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(search);
    const queryRestaurantId = String(params.get("restaurantId") || "").trim();
    if (queryRestaurantId) return queryRestaurantId;
  }
  return (user as any)?.restaurantId ?? null;
}

const MENU_IMPORT_DRAFT_KEY = "mealscout:menu-import-draft";

function getInitialMenuSourceUrl() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const querySource = String(params.get("menuSource") || "").trim();
  if (querySource) return querySource;
  try {
    const stored = window.localStorage.getItem(MENU_IMPORT_DRAFT_KEY);
    if (!stored) return "";
    const parsed = JSON.parse(stored) as { sourceUrl?: string };
    return String(parsed.sourceUrl || "").trim();
  } catch {
    return "";
  }
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeMenusPayload(payload: unknown): Menu[] {
  if (Array.isArray(payload)) return payload as Menu[];
  if (payload && typeof payload === "object") {
    const wrapped = payload as Record<string, unknown>;
    if (Array.isArray(wrapped.menus)) return wrapped.menus as Menu[];
    if (Array.isArray(wrapped.items)) return wrapped.items as Menu[];
    if (Array.isArray(wrapped.data)) return wrapped.data as Menu[];
  }
  return [];
}

function normalizeFullMenu(menu: unknown): FullMenu | null {
  if (!menu || typeof menu !== "object") return null;
  const candidate = menu as Record<string, unknown>;
  const categoriesRaw = toArray<Record<string, unknown>>(candidate.categories);
  const categories = categoriesRaw.map((category) => ({
    ...((category as unknown) as MenuCategory),
    items: toArray<MenuItem>(category.items),
  }));
  return {
    ...((candidate as unknown) as FullMenu),
    categories,
  };
}

// ──────────────────────────────── main page ───────────────────────────────────
export default function MenuBuilderPage() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  if (getProgressiveAccountGate(user) !== "continue" || new URLSearchParams(window.location.search).get("design") === "1") {
    return <PrivateMenuDraftPage user={user} />;
  }
  return <OwnerMenuBuilderPage />;
}

function OwnerMenuBuilderPage() {
  const restaurantId = useRestaurantId();
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [showNewMenuDialog, setShowNewMenuDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [newMenuName, setNewMenuName] = useState("");
  const [newMenuServiceType, setNewMenuServiceType] = useState("all");
  const [isPreparingMenu, setIsPreparingMenu] = useState(false);
  const [menuPreparationError, setMenuPreparationError] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importType, setImportType] = useState<"csv" | "pdf" | "pos_json" | "photo">("csv");
  const [isImporting, setIsImporting] = useState(false);
  const [menuSourceUrl, setMenuSourceUrl] = useState(getInitialMenuSourceUrl);
  const [posSource, setPosSource] = useState("toast");
  const [posNotes, setPosNotes] = useState("");
  const [externalJson, setExternalJson] = useState("");
  const [isRequestingPosSync, setIsRequestingPosSync] = useState(false);
  const [guestDraft] = useState(() => readGuestMenuDraft(() => window.localStorage));

  const { data: businesses = [], isLoading: loadingBusinesses } = useQuery<
    Restaurant[]
  >({
    queryKey: ["/api/restaurants/my-restaurants"],
    enabled: !!user,
  });
  const { data: businessAccess } = useQuery<BusinessAccessContext>({
    queryKey: ["/api/business-access/me"],
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const currentBusiness =
    businesses.find((business) => business.id === restaurantId) || null;
  const isElevated =
    user?.userType === "admin" ||
    user?.userType === "duper_admin" ||
    user?.userType === "super_admin" ||
    user?.userType === "staff";
  const scopedBusinessPermissions = getScopedBusinessPermissions(
    businessAccess,
    restaurantId,
  );
  const ownsSelectedBusiness = isScopedBusinessOwner(
    businessAccess,
    restaurantId,
  );
  const hasFullBusinessControl = isElevated || ownsSelectedBusiness;
  const canManageProfile =
    hasFullBusinessControl || scopedBusinessPermissions.manageProfile;
  const workspaceCapabilities = {
    overview: canManageProfile,
    profile: canManageProfile,
    menu: canManageProfile,
    availability:
      hasFullBusinessControl || scopedBusinessPermissions.manageParkingPass,
    media: canManageProfile,
    deals: hasFullBusinessControl || scopedBusinessPermissions.manageDeals,
    work: hasFullBusinessControl || scopedBusinessPermissions.manageParkingPass,
    audience: hasFullBusinessControl || scopedBusinessPermissions.viewAnalytics,
    team: hasFullBusinessControl,
    payments: hasFullBusinessControl,
    settings: canManageProfile,
  };
  const currentEntityType =
    currentBusiness?.isFoodTruck ||
    isTruckBusinessType(currentBusiness?.businessType)
      ? "truck"
      : isBarBusinessType(currentBusiness?.businessType)
        ? "bar"
        : currentBusiness?.businessType === "caterer"
          ? "caterer"
          : currentBusiness?.businessType === "private_chef"
            ? "private_chef"
        : "restaurant";
  const publicProfileHref = currentBusiness
    ? buildPublicProfilePath({
        entityType: currentEntityType,
        id: currentBusiness.id,
        name: currentBusiness.name,
      })
    : null;
  const handleWorkspaceBusinessChange = (businessId: string) => {
    setSelectedMenuId(null);
    const params = new URLSearchParams(window.location.search);
    params.set("restaurantId", businessId);
    const query = params.toString();
    setLocation(`/menu-builder${query ? `?${query}` : ""}`);
  };

  useEffect(() => {
    try {
      if (!menuSourceUrl.trim()) {
        window.localStorage.removeItem(MENU_IMPORT_DRAFT_KEY);
        return;
      }
      window.localStorage.setItem(
        MENU_IMPORT_DRAFT_KEY,
        JSON.stringify({
          sourceUrl: menuSourceUrl.trim(),
          restaurantId,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch {
      // Draft persistence is only a convenience.
    }
  }, [menuSourceUrl, restaurantId]);

  // fetch menus list
  const menusQuery = useQuery<Menu[]>({
    queryKey: ["/api/owner/menus", restaurantId],
    queryFn: async () => {
      if (!restaurantId) return [];
      const res = await fetch(
        `/api/owner/menus/${encodeURIComponent(restaurantId)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load menus");
      const data = await res.json();
      return normalizeMenusPayload(data);
    },
    enabled: !!restaurantId,
  });
  const menus = toArray<Menu>(menusQuery.data);

  useEffect(() => {
    if (menusQuery.isLoading) return;
    if (menus.length === 0) {
      if (selectedMenuId) setSelectedMenuId(null);
      return;
    }
    if (
      !selectedMenuId ||
      !menus.some((menu) => String(menu.id) === String(selectedMenuId))
    ) {
      setSelectedMenuId(menus[0].id);
    }
  }, [menus, menusQuery.isLoading, selectedMenuId]);

  // Fetch the owner detail payload so unavailable items remain editable.
  const fullMenuQuery = useQuery<FullMenu | null>({
    queryKey: ["/api/owner/menus", selectedMenuId, "details"],
    queryFn: async () => {
      if (!selectedMenuId) throw new Error("No menu selected");
      const res = await fetch(
        `/api/owner/menus/${encodeURIComponent(selectedMenuId)}/details`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load menu");
      const data = await res.json();
      return normalizeFullMenu(data?.menu ?? data);
    },
    enabled: !!selectedMenuId,
  });

  // create menu
  const createMenuMutation = useMutation({
    mutationFn: async (attempt: MenuCreationAttempt) => {
      const res = await apiRequest("POST", "/api/owner/menus/create", attempt.input, {
        headers: { "Idempotency-Key": attempt.requestId },
      });
      const payload = await res.json().catch(() => null);
      assertMenuCreationReceipt(payload, attempt);
      return payload;
    },
    onSuccess: (payload, attempt) => {
      confirmMenuCreationAttempt(attempt);
      const createdMenu = normalizeFullMenu(payload?.menu ?? payload);
      queryClient.invalidateQueries({
        queryKey: ["/api/owner/menus", attempt.input.restaurantId],
      });
      if (attempt.input.restaurantId !== restaurantId) return;
      if (createdMenu?.id) setSelectedMenuId(createdMenu.id);
      setShowNewMenuDialog(false);
      setNewMenuName("");
      setNewMenuServiceType("all");
      toast({ title: "Menu created" });
    },
    onError: (err: Error) =>
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      }),
  });

  const submitNewMenu = async () => {
    if (!user?.id || !restaurantId || isPreparingMenu || createMenuMutation.isPending) return;
    setIsPreparingMenu(true);
    setMenuPreparationError("");
    try {
      const attempt = await prepareMenuCreationAttempt(user.id, {
        restaurantId, name: newMenuName, serviceType: newMenuServiceType,
      });
      createMenuMutation.mutate(attempt);
    } catch {
      const message = "The browser could not preserve this request for a safe retry. Nothing was submitted. Please try again.";
      setMenuPreparationError(message);
      toast({ title: "Menu not submitted", description: message, variant: "destructive" });
    } finally {
      setIsPreparingMenu(false);
    }
  };

  // import menu items
  const handleImport = async () => {
    if (!selectedMenuId) return;
    setIsImporting(true);
    try {
      if (importType === "pos_json") {
        const rawData = JSON.parse(externalJson.trim());
        const rows = Array.isArray(rawData)
          ? rawData
          : Array.isArray(rawData?.items)
            ? rawData.items
            : Array.isArray(rawData?.menuItems)
              ? rawData.menuItems
              : [];
        if (!rows.length) {
          throw new Error("Paste a JSON array, or an object with items/menuItems.");
        }
        const res = await fetch(
          `/api/owner/menus/${encodeURIComponent(selectedMenuId)}/import/external`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: posSource, rawData: rows }),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || "Import failed");
        queryClient.invalidateQueries({
          queryKey: ["/api/owner/menus", selectedMenuId, "details"],
        });
        setShowImportDialog(false);
        setExternalJson("");
        toast({
          title: "Import complete",
          description: `${data.imported ?? 0} items imported from ${posSource}.`,
        });
        return;
      }

      if (importType === "photo") {
        if (importFiles.length === 0) return;
        const form = new FormData();
        importFiles.forEach((file) => form.append("files", file));
        const res = await fetch(
          `/api/owner/menus/${encodeURIComponent(selectedMenuId)}/import/photo`,
          { method: "POST", body: form, credentials: "include" },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Import failed");
        queryClient.invalidateQueries({
          queryKey: ["/api/owner/menus", selectedMenuId, "details"],
        });
        setShowImportDialog(false);
        setImportFiles([]);
        toast({
          title: "Import complete",
          description: data.imported
            ? `${data.imported} items imported. Review prices and availability now.`
            : "No items found in those photos. Try clearer, well-lit shots of the menu text.",
        });
        return;
      }

      if (!importFile) return;
      const form = new FormData();
      form.append("file", importFile);
      const res = await fetch(
        `/api/owner/menus/${encodeURIComponent(selectedMenuId)}/import/${importType}`,
        { method: "POST", body: form, credentials: "include" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Import failed");
      queryClient.invalidateQueries({
        queryKey: ["/api/owner/menus", selectedMenuId, "details"],
      });
      setShowImportDialog(false);
      setImportFile(null);
      toast({
        title: "Import complete",
        description: `${data.imported ?? data.inserted ?? 0} items imported.`,
      });
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
    }
  };

  const requestPosConnection = async () => {
    if (!selectedMenuId) {
      setShowNewMenuDialog(true);
      return;
    }

    setIsRequestingPosSync(true);
    try {
      const res = await fetch(
        `/api/owner/menus/${encodeURIComponent(selectedMenuId)}/pos-connection-request`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: posSource,
            sourceUrl: menuSourceUrl.trim() || undefined,
            notes: posNotes.trim() || undefined,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Unable to save POS request");
      queryClient.invalidateQueries({
        queryKey: ["/api/owner/menus", restaurantId],
      });
      toast({
        title: "POS source saved",
        description:
          "We saved this as a pending connection. You can still import CSV/PDF or build manually while sync is connected.",
      });
    } catch (err: any) {
      toast({
        title: "POS request failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsRequestingPosSync(false);
    }
  };

  if (!restaurantId) {
    return <PrivateMenuDraftPage user={user} />;
  }

  if (loadingBusinesses) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-layered)]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!currentBusiness) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-layered)] px-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center">
            <h1 className="text-lg font-bold">Business unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This menu is not linked to a business you can manage.
            </p>
            <Button asChild className="mt-4">
              <Link href="/dashboard">Back to overview</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!canManageProfile) {
    return (
      <BusinessWorkspaceShell
        activeModule="menu"
        business={currentBusiness}
        businesses={businesses}
        onBusinessChange={handleWorkspaceBusinessChange}
        publicProfileHref={publicProfileHref}
        capabilities={workspaceCapabilities}
      >
        <div className="mx-auto flex min-h-[70vh] max-w-lg items-center px-4 py-10">
          <Card className="w-full border-amber-200 bg-amber-50">
            <CardContent className="p-6 text-center">
              <h2 className="text-lg font-bold text-amber-950">
                Permission required
              </h2>
              <p className="mt-2 text-sm text-amber-900/80">
                Ask the business owner to grant profile management access.
              </p>
            </CardContent>
          </Card>
        </div>
      </BusinessWorkspaceShell>
    );
  }

  const selectedMenu = normalizeFullMenu(fullMenuQuery.data);

  return (
    <BusinessWorkspaceShell
      activeModule="menu"
      business={currentBusiness}
      businesses={businesses}
      onBusinessChange={handleWorkspaceBusinessChange}
      publicProfileHref={publicProfileHref}
      capabilities={workspaceCapabilities}
      headerActions={
        <Button size="sm" onClick={() => setShowNewMenuDialog(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          New menu
        </Button>
      }
    >
      <div
        className="mx-auto min-h-screen max-w-6xl space-y-4 px-4 py-5 pb-28 lg:px-6 lg:py-8"
        data-testid="owner-menu-workspace"
      >
        {guestDraft && <section className="space-y-3 rounded-2xl border bg-card p-4" aria-label="Kept private menu draft">
          <h2 className="text-xl font-bold">Your kept menu draft</h2>
          <p className="text-sm text-muted-foreground">Review this draft for {currentBusiness.name}. Creating a menu and importing items each require your confirmation.</p>
          <MenuDraftPreview draft={guestDraft} />
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => { setNewMenuName(guestDraft.name); setNewMenuServiceType(guestDraft.serviceType); setShowNewMenuDialog(true); }}>Review new menu</Button>
            <Button variant="outline" disabled={!selectedMenuId} onClick={() => {
              try {
                const csv = guestMenuDraftToCsv(guestDraft);
                setImportFile(new File([csv], "kept-menu-draft.csv", { type: "text/csv" }));
                setImportType("csv");
                setShowImportDialog(true);
              } catch (error) {
                toast({ title: "Draft needs review", description: error instanceof Error ? error.message : "Review the items before importing.", variant: "destructive" });
              }
            }}>Review items for selected menu</Button>
            <Button asChild variant="outline"><Link href="/menu-builder?design=1">Edit private draft</Link></Button>
          </div>
        </section>}
        <section className="rounded-2xl border border-orange-200/80 bg-gradient-to-br from-orange-50 via-background to-amber-50/70 p-4 shadow-sm sm:p-5">
          <div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                {currentEntityType === "truck"
                  ? "Food truck menu"
                  : currentEntityType === "bar"
                    ? "Bar menu"
                    : "Restaurant menu"}
              </p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight">
                Menus and items
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep names, prices, and availability current for customers.
              </p>
            </div>
          </div>

          {menus.length > 0 ? (
            <div
              className="mt-4 flex gap-2 overflow-x-auto pb-1"
              aria-label="Business menus"
            >
              {menus.map((menu) => {
                const selected = selectedMenuId === menu.id;
                return (
                  <button
                    key={menu.id}
                    type="button"
                    onClick={() => setSelectedMenuId(menu.id)}
                    className={`min-w-40 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                      selected
                        ? "border-orange-500 bg-orange-600 text-white shadow-sm"
                        : "border-border bg-background/90 hover:border-orange-300 hover:bg-orange-50"
                    }`}
                    aria-pressed={selected}
                  >
                    <span className="block truncate font-semibold">
                      {menu.name}
                    </span>
                    <span className="mt-0.5 block text-xs opacity-80">
                      {menu.serviceType === "all"
                        ? "All day"
                        : menu.serviceType.replace(/_/g, " ")}
                      {!menu.isActive ? " · Hidden" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>

        {menusQuery.isLoading ? (
          <Card>
            <CardContent className="flex min-h-52 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-orange-600" />
              <span className="ml-2 text-sm text-muted-foreground">
                Loading menus…
              </span>
            </CardContent>
          </Card>
        ) : menusQuery.isError ? (
          <Card className="border-red-200">
            <CardContent className="p-6 text-center">
              <CircleAlert className="mx-auto h-8 w-8 text-red-600" />
              <h2 className="mt-3 font-semibold">Menus could not be loaded</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your menu data was not changed. Try loading it again.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => menusQuery.refetch()}
              >
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : menus.length === 0 ? (
          <Card className="border-dashed border-orange-300 bg-orange-50/40">
            <CardContent className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
              <div className="rounded-full bg-orange-100 p-3 text-orange-700">
                <UtensilsCrossed className="h-7 w-7" />
              </div>
              <h2 className="mt-4 text-lg font-bold">Add your first menu</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Start with an empty menu, then add items manually or import an
                existing file or photo.
              </p>
              <Button
                type="button"
                className="mt-4"
                onClick={() => setShowNewMenuDialog(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create menu
              </Button>
            </CardContent>
          </Card>
        ) : fullMenuQuery.isLoading ? (
          <Card>
            <CardContent className="flex min-h-64 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-orange-600" />
              <span className="ml-2 text-sm text-muted-foreground">
                Loading menu items…
              </span>
            </CardContent>
          </Card>
        ) : fullMenuQuery.isError ? (
          <Card className="border-red-200">
            <CardContent className="p-6 text-center">
              <CircleAlert className="mx-auto h-8 w-8 text-red-600" />
              <h2 className="mt-3 font-semibold">This menu could not be loaded</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing was changed. Try loading the selected menu again.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => fullMenuQuery.refetch()}
              >
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : selectedMenu ? (
          <MenuEditor
            key={selectedMenu.id}
            menu={selectedMenu}
            restaurantId={restaurantId}
            onImport={() => setShowImportDialog(true)}
            onRefresh={() => {
              queryClient.invalidateQueries({
                queryKey: [
                  "/api/owner/menus",
                  selectedMenuId,
                  "details",
                ],
              });
              queryClient.invalidateQueries({
                queryKey: ["/api/owner/menus", restaurantId],
              });
              queryClient.invalidateQueries({
                queryKey: ["/api/owner/restaurants", restaurantId, "ordering-readiness"],
                exact: true,
              });
            }}
          />
        ) : null}

        <details
          className="group rounded-2xl border bg-card shadow-sm"
          data-testid="menu-import-tools"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-semibold sm:p-5">
            <span className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-orange-600" />
              Import or connect an existing menu
            </span>
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t p-4 sm:p-5">
            <div>
              <Label htmlFor="menu-source-url">Menu source link</Label>
              <Input
                id="menu-source-url"
                value={menuSourceUrl}
                onChange={(event) => setMenuSourceUrl(event.target.value)}
                placeholder="Website, menu PDF, or online menu URL"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                This draft stays on this device until you submit the source or
                import a file.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
              <div>
                <Label>Menu or POS source</Label>
                <Select value={posSource} onValueChange={setPosSource}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="toast">Toast</SelectItem>
                    <SelectItem value="square">Square</SelectItem>
                    <SelectItem value="clover">Clover</SelectItem>
                    <SelectItem value="website">Website menu</SelectItem>
                    <SelectItem value="ubereats">Uber Eats</SelectItem>
                    <SelectItem value="doordash">DoorDash</SelectItem>
                    <SelectItem value="gmb">Google Business Profile</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="menu-source-notes">Notes</Label>
                <Input
                  id="menu-source-notes"
                  value={posNotes}
                  onChange={(event) => setPosNotes(event.target.value)}
                  placeholder="Location name or anything needed to identify this menu"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Saving the source creates a connection request. You can keep
              editing manually or import an export while it is pending.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => {
                  if (!selectedMenuId) {
                    setShowNewMenuDialog(true);
                    return;
                  }
                  setShowImportDialog(true);
                }}
              >
                <Upload className="mr-2 h-4 w-4" />
                {selectedMenuId ? "Import file or photos" : "Create menu to import"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={requestPosConnection}
                disabled={isRequestingPosSync}
              >
                {isRequestingPosSync ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Save source
              </Button>
            </div>
          </div>
        </details>
      </div>

      {/* New menu dialog */}
      <Dialog open={showNewMenuDialog} onOpenChange={setShowNewMenuDialog}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create menu</DialogTitle>
          </DialogHeader>
          {(menuPreparationError || createMenuMutation.isError) && (
            <Alert variant="destructive">
              <CircleAlert className="h-4 w-4" />
              <AlertDescription>{menuPreparationError || createMenuMutation.error?.message}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="menu-name">Menu name</Label>
              <Input
                id="menu-name"
                placeholder="e.g. Lunch Menu, Happy Hour, Full Menu"
                value={newMenuName}
                onChange={(e) => setNewMenuName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="service-type">When it is served</Label>
              <Select
                value={newMenuServiceType}
                onValueChange={setNewMenuServiceType}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All day</SelectItem>
                  <SelectItem value="breakfast">Breakfast</SelectItem>
                  <SelectItem value="lunch">Lunch</SelectItem>
                  <SelectItem value="dinner">Dinner</SelectItem>
                  <SelectItem value="late_night">Late Night</SelectItem>
                  <SelectItem value="weekend_brunch">Weekend brunch</SelectItem>
                  <SelectItem value="happy_hour">Happy Hour</SelectItem>
                  <SelectItem value="seasonal">Seasonal</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewMenuDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={submitNewMenu}
              disabled={!newMenuName.trim() || isPreparingMenu || createMenuMutation.isPending}
            >
              {(isPreparingMenu || createMenuMutation.isPending) && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Create menu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import menu items</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {menuSourceUrl.trim() ? (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <div className="font-medium">Saved menu source</div>
                <a
                  href={menuSourceUrl.trim()}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block break-all text-primary underline"
                >
                  {menuSourceUrl.trim()}
                </a>
              </div>
            ) : null}
            <div>
              <Label>Import format</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["csv", "pdf", "photo", "pos_json"] as const).map((t) => (
                  <Button
                    key={t}
                    variant={importType === t ? "default" : "outline"}
                    size="sm"
                    onClick={() => setImportType(t)}
                  >
                    {t === "pos_json"
                      ? "POS JSON"
                      : t === "photo"
                        ? "Photos"
                        : t.toUpperCase()}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {importType === "csv"
                  ? "CSV with columns: Name, Description, Price, Category, Calories, etc."
                  : importType === "pdf"
                    ? "Upload a PDF menu — AI will extract items automatically."
                    : importType === "photo"
                      ? "Upload up to 8 photos of your menu board, printed menu, or individual dishes — AI will read them and fill in a draft menu for you to review."
                      : "Paste exported item JSON from Toast, Square, Clover, DoorDash, Uber Eats, or Google."}
              </p>
            </div>
            {importType === "photo" ? (
              <div>
                <Label htmlFor="import-photos">Photos</Label>
                <Input
                  id="import-photos"
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 8) {
                      toast({
                        title: "8 photo limit",
                        description: "Only the first 8 photos will be used.",
                      });
                    }
                    setImportFiles(files.slice(0, 8));
                  }}
                />
                {importFiles.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {importFiles.length} photo{importFiles.length === 1 ? "" : "s"} selected.
                  </p>
                )}
              </div>
            ) : importType === "pos_json" ? (
              <div className="space-y-3">
                <div>
                  <Label>Source</Label>
                  <Select value={posSource} onValueChange={setPosSource}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="toast">Toast</SelectItem>
                      <SelectItem value="square">Square</SelectItem>
                      <SelectItem value="clover">Clover</SelectItem>
                      <SelectItem value="ubereats">Uber Eats</SelectItem>
                      <SelectItem value="doordash">DoorDash</SelectItem>
                      <SelectItem value="gmb">Google Business Profile</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="external-json">Exported JSON</Label>
                  <Textarea
                    id="external-json"
                    value={externalJson}
                    onChange={(event) => setExternalJson(event.target.value)}
                    placeholder='[{"name":"Smash Burger","description":"...","price":"12.99"}]'
                    rows={8}
                  />
                </div>
              </div>
            ) : (
              <div>
                <Label htmlFor="import-file">File</Label>
                <Input
                  id="import-file"
                  type="file"
                  accept={importType === "csv" ? ".csv,.tsv,.xlsx,.xls" : ".pdf"}
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                />
                {importFile && <p className="mt-2 text-sm text-muted-foreground">Ready to review: {importFile.name}</p>}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowImportDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleImport}
              disabled={
                isImporting ||
                (importType === "pos_json"
                  ? !externalJson.trim()
                  : importType === "photo"
                    ? importFiles.length === 0
                    : !importFile)
              }
            >
              {isImporting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BusinessWorkspaceShell>
  );
}

// ─────────────────────────────── MenuEditor ───────────────────────────────────
function MenuEditor({
  menu,
  restaurantId,
  onImport,
  onRefresh,
}: {
  menu: FullMenu;
  restaurantId: string;
  onImport: () => void;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState<MenuCategory | null>(
    null,
  );
  const [categoryName, setCategoryName] = useState("");
  const [categoryDesc, setCategoryDesc] = useState("");
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [menuSettings, setMenuSettings] = useState({
    acceptsCash: menu.acceptsCash,
    hidePlatformFee: menu.hidePlatformFee,
    pricesIncludeTax: menu.pricesIncludeTax,
    isActive: menu.isActive,
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const readinessQuery = useQuery<OrderingReadiness>({
    queryKey: ["/api/owner/restaurants", restaurantId, "ordering-readiness"],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/owner/restaurants/${encodeURIComponent(restaurantId)}/ordering-readiness`,
        { credentials: "include", signal },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || "Failed to load ordering readiness");
      }
      return orderingReadinessSchema.parse(data);
    },
    enabled: !!restaurantId,
  });
  const readiness = readinessQuery.data;
  const checkingPublication = readinessQuery.isLoading || readinessQuery.isFetching;
  const publicBusinessVisible = !readinessQuery.isError && !checkingPublication
    ? readiness?.publicMenuBusinessVisible
    : undefined;
  // Public status reflects saved menu state and the server's public-business
  // policy. Changing the settings form does not publish anything before save.
  const publicMenuVisible = menu.isActive && publicBusinessVisible === true;
  const publicationLabel = !menu.isActive
    ? "Menu disabled"
    : checkingPublication
      ? "Checking visibility"
      : publicBusinessVisible === undefined
        ? "Visibility unconfirmed"
        : publicMenuVisible
          ? "Public menu"
          : "Not public yet";
  const publicationMessage = !menu.isActive
    ? "This menu is saved but disabled. Customers cannot view it."
    : checkingPublication
      ? "Checking whether your business profile and this menu are public."
      : publicBusinessVisible === undefined
        ? "Your menu is saved. Public visibility could not be confirmed."
        : publicMenuVisible
          ? "Customers can view this menu. Online ordering has separate setup requirements."
          : "Your menu is saved. Customers cannot view it until your business profile is public.";
  const startStripeOnboarding = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/owner/restaurants/${encodeURIComponent(restaurantId)}/stripe/onboard`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.onboardingUrl) {
        throw new Error(data?.message || "Stripe payout setup could not be started");
      }
      return data as { onboardingUrl: string };
    },
    onSuccess: ({ onboardingUrl }) => {
      window.location.assign(onboardingUrl);
    },
    onError: (error: Error) => {
      toast({
        title: "Payout setup unavailable",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  const refreshStripeStatus = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/owner/restaurants/${encodeURIComponent(restaurantId)}/stripe/status`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || "Stripe payout status could not be refreshed");
      }
      return data as { connectStatus?: string };
    },
    onSuccess: async () => {
      await readinessQuery.refetch();
      toast({ title: "Payout status refreshed" });
    },
    onError: (error: Error) => {
      toast({
        title: "Status refresh failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  const uncategorizedItems = toArray<MenuItem>(menu.uncategorizedItems);
  const sections = [
    ...menu.categories.map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
      items: category.items,
      category,
    })),
    ...(uncategorizedItems.length
      ? [
          {
            id: "uncategorized",
            name: "Other items",
            description: "Items that are not assigned to a category yet.",
            items: uncategorizedItems,
            category: null,
          },
        ]
      : []),
  ];
  const allItems = sections.flatMap((section) => section.items);
  const customerVisibleItems = sections.flatMap((section) =>
    section.category?.isActive === false ? [] : section.items,
  );
  const availableItemCount = customerVisibleItems.filter(
    (item) => item.isAvailable,
  ).length;

  const saveCategory = async () => {
    try {
      if (editingCategory) {
        await apiRequest(
          "PATCH",
          `/api/owner/menu-categories/${editingCategory.id}`,
          {
            name: categoryName,
            description: categoryDesc || null,
          },
        );
      } else {
        await apiRequest("POST", "/api/owner/menu-categories", {
          menuId: menu.id,
          restaurantId,
          name: categoryName,
          description: categoryDesc || null,
        });
      }
      onRefresh();
      setShowCategoryDialog(false);
      setCategoryName("");
      setCategoryDesc("");
      setEditingCategory(null);
      toast({ title: editingCategory ? "Category updated" : "Category added" });
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    }
  };

  const setCategoryVisibility = async (category: MenuCategory) => {
    const nextActive = !category.isActive;
    if (
      !nextActive &&
      !confirm("Hide this category and its items from customers?")
    ) {
      return;
    }
    try {
      if (nextActive) {
        await apiRequest(
          "PATCH",
          `/api/owner/menu-categories/${category.id}`,
          { isActive: true },
        );
      } else {
        await apiRequest(
          "DELETE",
          `/api/owner/menu-categories/${category.id}`,
          undefined,
        );
      }
      onRefresh();
      toast({ title: nextActive ? "Category enabled" : "Category hidden" });
    } catch (err: any) {
      toast({
        title: "Category visibility could not be updated",
        description: err.message,
        variant: "destructive",
      });
    }
  };

  const saveMenuSettings = async () => {
    setSavingSettings(true);
    try {
      await apiRequest("PATCH", `/api/owner/menus/${menu.id}`, menuSettings);
      onRefresh();
      toast({ title: "Settings saved" });
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden" data-testid="owner-menu-editor">
        <CardHeader className="border-b bg-gradient-to-r from-orange-50 via-background to-amber-50/70 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-xl">{menu.name}</CardTitle>
                <Badge variant={publicMenuVisible ? "default" : "secondary"} data-testid="menu-publication-badge">
                  {publicationLabel}
                </Badge>
              </div>
              <CardDescription className="mt-1 capitalize">
                {menu.serviceType === "all"
                  ? "All day"
                  : menu.serviceType.replace(/_/g, " ")}
              </CardDescription>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground" role="status" data-testid="menu-publication-message">
                {publicationMessage}
              </p>
              {menu.isActive && !publicMenuVisible && !readinessQuery.isError ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 min-h-11"
                  disabled={readinessQuery.isFetching}
                  onClick={() => void readinessQuery.refetch()}
                >
                  {readinessQuery.isFetching ? "Checking public visibility…" : "Check public visibility"}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onImport}>
                <Upload className="mr-1.5 h-4 w-4" />
                Import
              </Button>
              <Button asChild type="button" variant="outline" size="sm">
                <Link href={`/menu/${restaurantId}`} target="_blank">
                  <Eye className="mr-1.5 h-4 w-4" />
                  Preview
                </Link>
              </Button>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <div className="rounded-xl border bg-background/80 px-3 py-2">
              <p className="text-lg font-bold">{allItems.length}</p>
              <p className="text-xs text-muted-foreground">Items</p>
            </div>
            <div className="rounded-xl border bg-background/80 px-3 py-2">
              <p className="text-lg font-bold">{availableItemCount}</p>
              <p className="text-xs text-muted-foreground">Available</p>
            </div>
            <div className="rounded-xl border bg-background/80 px-3 py-2">
              <p className="text-lg font-bold">{menu.categories.length}</p>
              <p className="text-xs text-muted-foreground">Categories</p>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Categories and items</h2>
              <p className="text-xs text-muted-foreground">
                Availability changes save immediately.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingCategory(null);
                setCategoryName("");
                setCategoryDesc("");
                setShowCategoryDialog(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              Category
            </Button>
          </div>

          {sections.length === 0 ? (
            <div className="rounded-xl border border-dashed bg-muted/20 p-6 text-center">
              <UtensilsCrossed className="mx-auto h-7 w-7 text-muted-foreground" />
              <p className="mt-3 font-medium">No categories yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add a category such as Mains, Drinks, or Desserts, then add its
                items.
              </p>
              <Button
                type="button"
                className="mt-4"
                onClick={() => {
                  setEditingCategory(null);
                  setCategoryName("");
                  setCategoryDesc("");
                  setShowCategoryDialog(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add category
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {sections.map((section) => (
                <section
                  key={section.id}
                  className={`overflow-hidden rounded-xl border bg-background ${
                    section.category?.isActive === false
                      ? "border-dashed opacity-75"
                      : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 border-b bg-muted/25 px-3 py-3 sm:px-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{section.name}</h3>
                        <Badge variant="secondary" className="text-xs">
                          {section.items.length}
                        </Badge>
                        {section.category?.isActive === false ? (
                          <Badge variant="outline" className="text-xs">
                            Hidden
                          </Badge>
                        ) : null}
                      </div>
                      {section.description ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {section.description}
                        </p>
                      ) : null}
                    </div>
                    {section.category ? (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          aria-label={`Edit ${section.name} category`}
                          onClick={() => {
                            setEditingCategory(section.category);
                            setCategoryName(section.category.name);
                            setCategoryDesc(section.category.description ?? "");
                            setShowCategoryDialog(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          <span className="ml-1 hidden sm:inline">Edit</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={`h-8 px-2 ${
                            section.category.isActive
                              ? "text-destructive hover:text-destructive"
                              : "text-foreground"
                          }`}
                          aria-label={`${
                            section.category.isActive ? "Hide" : "Restore"
                          } ${section.name} category`}
                          onClick={() =>
                            setCategoryVisibility(section.category)
                          }
                        >
                          {section.category.isActive ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                          <span className="ml-1 hidden sm:inline">
                            {section.category.isActive ? "Hide" : "Restore"}
                          </span>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="space-y-2 p-3 sm:p-4">
                    {section.items.length > 0 ? (
                      section.items.map((item) => (
                        <MenuItemRow
                          key={item.id}
                          item={item}
                          onEdit={() => {
                            setEditingItem(item);
                            setActiveCategoryId(section.category?.id ?? null);
                            setShowItemDialog(true);
                          }}
                          onRefresh={onRefresh}
                        />
                      ))
                    ) : (
                      <p className="rounded-lg bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
                        No items in this category yet.
                      </p>
                    )}
                    {section.category ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          setEditingItem(null);
                          setActiveCategoryId(section.category.id);
                          setShowItemDialog(true);
                        }}
                      >
                        <Plus className="mr-1 h-4 w-4" />
                        Add item to {section.name}
                      </Button>
                    ) : null}
                  </div>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {readinessQuery.isLoading ? (
        <div className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
          Checking online ordering…
        </div>
      ) : readinessQuery.isError ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p role="status">
            Online ordering status is unavailable. Menu editing still works.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-3 min-h-11"
            disabled={readinessQuery.isFetching}
            onClick={() => void readinessQuery.refetch()}
          >
            {readinessQuery.isFetching ? "Checking ordering status…" : "Check ordering status again"}
          </Button>
        </div>
      ) : readiness ? (
        <details
          className="group rounded-2xl border bg-card shadow-sm"
          data-testid="menu-ordering-readiness"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:p-5">
            <span className="flex min-w-0 items-start gap-3">
              {readiness.orderingEnabled ? (
                <CircleCheckBig className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              ) : (
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              )}
              <span>
                <span className="block font-semibold">Online ordering</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {readiness.orderingEnabled
                    ? "Customers can place pickup orders."
                    : "Online ordering needs setup."}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Badge variant={readiness.orderingEnabled ? "default" : "secondary"}>
                {readiness.orderingEnabled ? "Ready" : "Needs setup"}
              </Badge>
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            </span>
          </summary>
          <div className="space-y-3 border-t p-4 sm:p-5">
            <div className="grid gap-2 sm:grid-cols-2">
              {readiness.checks.map((check) => (
                <div key={check.id} className="rounded-lg border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{check.label}</span>
                    <Badge
                      variant={
                        check.ok
                          ? "default"
                          : check.blocking
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {check.ok ? "Done" : check.blocking ? "Required" : "Review"}
                    </Badge>
                  </div>
                  {!check.ok ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {check.action}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            {readiness.payout?.message ? (
              <div className="rounded-lg bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
                <p>
                  <span className="font-semibold text-foreground">Payouts: </span>
                  {readiness.payout.message}
                </p>
                {!readiness.paymentMethods?.card ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => startStripeOnboarding.mutate()}
                      disabled={startStripeOnboarding.isPending}
                    >
                      {startStripeOnboarding.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      {readiness.payout.status === "revoked"
                        ? "Reconnect Stripe payouts"
                        : readiness.payout.connected
                          ? "Finish Stripe setup"
                          : "Connect Stripe payouts"}
                    </Button>
                    {readiness.payout.connected ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => refreshStripeStatus.mutate()}
                        disabled={refreshStripeStatus.isPending}
                      >
                        {refreshStripeStatus.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Refresh status
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <details
        className="group rounded-2xl border bg-card shadow-sm"
        data-testid="menu-settings"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:p-5">
          <span className="flex items-center gap-2 font-semibold">
            <SlidersHorizontal className="h-4 w-4 text-orange-600" />
            Menu and ordering settings
          </span>
          <span className="flex items-center gap-2">
            <Badge variant={publicMenuVisible ? "default" : "secondary"}>
              {publicationLabel}
            </Badge>
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="space-y-4 border-t p-4 sm:p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor={`menu-enabled-${menu.id}`}>Enable this menu</Label>
              <p className="text-xs text-muted-foreground">
                Save this setting to include the menu and its available items when your business profile is public.
              </p>
            </div>
            <Switch
              id={`menu-enabled-${menu.id}`}
              checked={menuSettings.isActive}
              onCheckedChange={(value) =>
                setMenuSettings((settings) => ({
                  ...settings,
                  isActive: value,
                }))
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Prices include applicable tax</Label>
              <p className="text-xs text-muted-foreground">
                Enable only after every displayed item price includes the tax
                your business is responsible for. This is required for checkout.
              </p>
            </div>
            <Switch
              checked={menuSettings.pricesIncludeTax}
              onCheckedChange={(value) =>
                setMenuSettings((settings) => ({
                  ...settings,
                  pricesIncludeTax: value,
                }))
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Cover customer fees</Label>
              <p className="text-xs text-muted-foreground">
                You cover processing and the $1 MealScout fee instead of the customer.
              </p>
            </div>
            <Switch
              checked={menuSettings.hidePlatformFee}
              onCheckedChange={(value) =>
                setMenuSettings((settings) => ({
                  ...settings,
                  hidePlatformFee: value,
                }))
              }
            />
          </div>
          <Button type="button" onClick={saveMenuSettings} disabled={savingSettings}>
            {savingSettings ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Save settings
          </Button>
        </div>
      </details>

      {/* Category dialog */}
      <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingCategory ? "Edit category" : "Add category"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="category-name">Name</Label>
              <Input
                id="category-name"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                placeholder="e.g. Appetizers, Burgers, Drinks"
              />
            </div>
            <div>
              <Label htmlFor="category-description">
                Description (optional)
              </Label>
              <Textarea
                id="category-description"
                value={categoryDesc}
                onChange={(e) => setCategoryDesc(e.target.value)}
                placeholder="Brief description shown to customers"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCategoryDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={saveCategory} disabled={!categoryName.trim()}>
              {editingCategory ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Item dialog */}
      {showItemDialog && (
        <MenuItemDialog
          item={editingItem}
          menuId={menu.id}
          categoryId={activeCategoryId!}
          restaurantId={restaurantId}
          onClose={() => {
            setShowItemDialog(false);
            setEditingItem(null);
          }}
          onSaved={() => {
            onRefresh();
            setShowItemDialog(false);
            setEditingItem(null);
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────── MenuItemRow ────────────────────────────────────
function MenuItemRow({
  item,
  onEdit,
  onRefresh,
}: {
  item: MenuItem;
  onEdit: () => void;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [updatingAvailability, setUpdatingAvailability] = useState(false);

  const toggleAvailable = async () => {
    setUpdatingAvailability(true);
    try {
      await apiRequest("PATCH", `/api/owner/menu-items/${item.id}`, {
        isAvailable: !item.isAvailable,
      });
      onRefresh();
      toast({
        title: item.isAvailable ? "Item marked unavailable" : "Item is available",
      });
    } catch (err: any) {
      toast({
        title: "Availability could not be updated",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setUpdatingAvailability(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/25 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-orange-300">
            <ImageIcon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{item.name}</span>
          {item.itemType === "merchandise" && (
              <Badge variant="outline" className="gap-1 text-xs">
                <Package className="h-3 w-3" />
                Merchandise
            </Badge>
          )}
          {!item.isAvailable && (
            <Badge variant="secondary" className="text-xs">
                Unavailable
            </Badge>
          )}
        </div>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>
            {item.priceCents === null
              ? "Price unavailable"
              : formatMoney(item.priceCents)}
          </span>
          {item.itemType !== "merchandise" && item.calories && (
            <span>· {item.calories} cal</span>
          )}
          {item.trackInventory && item.inventoryQty !== null && (
            <span>· {item.inventoryQty} left</span>
          )}
        </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button
          type="button"
          variant={item.isAvailable ? "outline" : "secondary"}
          size="sm"
          className="h-8 px-2.5"
          onClick={toggleAvailable}
          disabled={updatingAvailability}
          aria-label={
            item.isAvailable
              ? `Mark ${item.name} unavailable`
              : `Mark ${item.name} available`
          }
        >
          {updatingAvailability ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : item.isAvailable ? (
            <Eye className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <EyeOff className="mr-1.5 h-3.5 w-3.5" />
          )}
          {item.isAvailable ? "Available" : "Unavailable"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2.5"
          onClick={onEdit}
          aria-label={`Edit ${item.name}`}
        >
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
      </div>
    </div>
  );
}

// ──────────────────────────── MenuItemDialog ──────────────────────────────────
function MenuItemDialog({
  item,
  menuId,
  categoryId,
  restaurantId,
  onClose,
  onSaved,
}: {
  item: MenuItem | null;
  menuId: string;
  categoryId: string | null;
  restaurantId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState({
    name: item?.name ?? "",
    description: item?.description ?? "",
    priceCents:
      item?.priceCents === null || item?.priceCents === undefined
        ? ""
        : String(item.priceCents / 100),
    itemType: item?.itemType ?? "food",
    calories: item?.calories ? String(item.calories) : "",
    isAvailable: item?.isAvailable ?? true,
    trackInventory: item?.trackInventory ?? false,
    inventoryQty: item?.inventoryQty ? String(item.inventoryQty) : "",
    dietaryTags: (item?.dietaryTags ?? []).join(", "),
    allergens: (item?.allergens ?? []).join(", "),
  });
  const [variantDrafts, setVariantDrafts] = useState(
    (item?.variants ?? []).map((variant) => ({
      label: variant.label,
      additionalPrice: String((variant.additionalCents || 0) / 100),
      isDefault: Boolean(variant.isDefault),
    })),
  );
  const [modifierDrafts, setModifierDrafts] = useState(
    (item?.modifiers ?? []).map((modifier) => ({
      groupName: modifier.groupName,
      label: modifier.label,
      additionalPrice: String((modifier.additionalCents || 0) / 100),
      isRequired: Boolean(modifier.isRequired),
      maxSelections: String(modifier.maxSelections || 1),
    })),
  );
  const parsedPrice = Number.parseFloat(form.priceCents);
  const hasValidPrice =
    form.priceCents.trim().length > 0 &&
    Number.isFinite(parsedPrice) &&
    parsedPrice >= 0;

  const save = async () => {
    if (!form.name.trim() || (form.priceCents.trim() && !hasValidPrice)) return;
    setIsSaving(true);
    try {
      const payload = {
        menuId,
        categoryId: item?.categoryId ?? categoryId,
        restaurantId,
        name: form.name.trim(),
        description: form.description.trim() || null,
        priceCents: hasValidPrice ? Math.round(parsedPrice * 100) : null,
        itemType: form.itemType,
        calories:
          form.itemType === "merchandise"
            ? null
            : form.calories
              ? parseInt(form.calories)
              : null,
        isAvailable: form.isAvailable,
        trackInventory: form.trackInventory,
        inventoryQty:
          form.trackInventory && form.inventoryQty
            ? parseInt(form.inventoryQty)
            : null,
        dietaryTags: form.itemType === "merchandise"
          ? []
          : form.dietaryTags
          ? form.dietaryTags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        allergens: form.itemType === "merchandise"
          ? []
          : form.allergens
          ? form.allergens
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean)
          : [],
      };

      let savedItemId = item?.id || null;
      if (item) {
        await apiRequest("PATCH", `/api/owner/menu-items/${item.id}`, payload);
      } else {
        const response = await apiRequest("POST", "/api/owner/menu-items", payload);
        const data = await response.json().catch(() => ({}));
        savedItemId = String(data?.item?.id || "") || null;
      }

      if (!savedItemId) {
        onSaved();
        toast({
          title: "Item saved",
          description:
            "MealScout could not link sizes and add-ons. Reopen the item and try those options again.",
          variant: "destructive",
        });
        return;
      }

      const variants = variantDrafts
        .filter((variant) => variant.label.trim())
        .map((variant, index) => ({
          menuItemId: savedItemId,
          label: variant.label.trim(),
          additionalCents: Math.max(
            0,
            Math.round(
              (Number.parseFloat(variant.additionalPrice) || 0) * 100,
            ),
          ),
          isDefault: variant.isDefault,
          sortOrder: index,
        }));
      const modifiers = modifierDrafts
        .filter((modifier) => modifier.groupName.trim() && modifier.label.trim())
        .map((modifier, index) => ({
          menuItemId: savedItemId,
          groupName: modifier.groupName.trim(),
          label: modifier.label.trim(),
          additionalCents: Math.max(
            0,
            Math.round(
              (Number.parseFloat(modifier.additionalPrice) || 0) * 100,
            ),
          ),
          isRequired: modifier.isRequired,
          maxSelections: Math.max(
            1,
            Number.parseInt(modifier.maxSelections, 10) || 1,
          ),
          sortOrder: index,
        }));

      try {
        await Promise.all([
          apiRequest("PUT", `/api/owner/menu-items/${savedItemId}/variants`, {
            variants,
          }),
          apiRequest("PUT", `/api/owner/menu-items/${savedItemId}/modifiers`, {
            modifiers,
          }),
        ]);
      } catch {
        onSaved();
        toast({
          title: "Item saved",
          description:
            "Sizes or add-ons did not finish saving. Reopen the item and try those options again.",
          variant: "destructive",
        });
        return;
      }
      onSaved();
      toast({ title: item ? "Item updated" : "Item added" });
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? "Edit item" : "Add menu item"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {item?.imageUrl ? (
            <div className="flex items-center gap-3 rounded-xl border bg-muted/20 p-3">
              <img
                src={item.imageUrl}
                alt=""
                className="h-16 w-16 rounded-lg object-cover"
              />
              <div>
                <p className="text-sm font-semibold">Customer photo</p>
                <p className="text-xs text-muted-foreground">
                  This image is already attached to the item.
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="menu-item-name">Item name *</Label>
              <Input
                id="menu-item-name"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g. Classic Burger"
              />
            </div>
            <div>
              <Label htmlFor="menu-item-price">Base price</Label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="menu-item-price"
                  className="pl-8"
                  value={form.priceCents}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, priceCents: e.target.value }))
                  }
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="0.01"
                />
              </div>
              {!form.priceCents ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave blank to show “Price unavailable.” Unpriced items cannot
                  be ordered online.
                </p>
              ) : null}
              {form.priceCents && !hasValidPrice ? (
                <p className="mt-1 text-xs text-destructive">
                  Enter a valid price of $0 or more.
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="menu-item-type">Item type</Label>
              <Select
                value={form.itemType}
                onValueChange={(value) =>
                  setForm((f) => ({
                    ...f,
                    itemType: value as "food" | "merchandise",
                    calories: value === "merchandise" ? "" : f.calories,
                    dietaryTags: value === "merchandise" ? "" : f.dietaryTags,
                    allergens: value === "merchandise" ? "" : f.allergens,
                  }))
                }
              >
                <SelectTrigger id="menu-item-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="food">Food / drink</SelectItem>
                  <SelectItem value="merchandise">Merchandise</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="menu-item-description">Description</Label>
              <Textarea
                id="menu-item-description"
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Brief appetizing description"
                rows={2}
              />
            </div>
            {form.itemType !== "merchandise" && (
              <>
                <div>
                  <Label htmlFor="menu-item-calories">Calories</Label>
                  <Input
                    id="menu-item-calories"
                    value={form.calories}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, calories: e.target.value }))
                    }
                    placeholder="e.g. 650"
                    type="number"
                    min="0"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="menu-item-dietary-tags">
                    Dietary tags
                  </Label>
                  <Input
                    id="menu-item-dietary-tags"
                    value={form.dietaryTags}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, dietaryTags: e.target.value }))
                    }
                    placeholder="vegan, gluten-free, keto"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Separate multiple tags with commas.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="menu-item-allergens">Allergens</Label>
                  <Input
                    id="menu-item-allergens"
                    value={form.allergens}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, allergens: e.target.value }))
                    }
                    placeholder="nuts, dairy, gluten"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Separate multiple allergens with commas.
                  </p>
                </div>
              </>
            )}
          </div>

          {form.itemType !== "merchandise" ? (
            <details
              className="group rounded-xl border"
              data-testid="menu-item-options-editor"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 font-semibold">
                <span>Sizes and add-ons</span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {variantDrafts.length + modifierDrafts.length}
                  </Badge>
                  <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div className="space-y-5 border-t p-3">
                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Sizes or styles</h3>
                      <p className="text-xs text-muted-foreground">
                        Add choices that change the base price.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setVariantDrafts((current) => [
                          ...current,
                          {
                            label: "",
                            additionalPrice: "0",
                            isDefault: current.length === 0,
                          },
                        ])
                      }
                    >
                      <Plus className="mr-1 h-4 w-4" />
                      Size
                    </Button>
                  </div>
                  {variantDrafts.length === 0 ? (
                    <p className="rounded-lg bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                      No size or style choices.
                    </p>
                  ) : (
                    variantDrafts.map((variant, index) => (
                      <div
                        key={`variant-${index}`}
                        className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_130px_auto_auto] sm:items-end"
                      >
                        <div>
                          <Label htmlFor={`variant-label-${index}`}>Label</Label>
                          <Input
                            id={`variant-label-${index}`}
                            value={variant.label}
                            onChange={(event) =>
                              setVariantDrafts((current) =>
                                current.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? { ...entry, label: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                            placeholder="Large"
                          />
                        </div>
                        <div>
                          <Label htmlFor={`variant-price-${index}`}>
                            Added price
                          </Label>
                          <Input
                            id={`variant-price-${index}`}
                            value={variant.additionalPrice}
                            onChange={(event) =>
                              setVariantDrafts((current) =>
                                current.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? {
                                        ...entry,
                                        additionalPrice: event.target.value,
                                      }
                                    : entry,
                                ),
                              )
                            }
                            type="number"
                            min="0"
                            step="0.01"
                          />
                        </div>
                        <label className="flex h-10 items-center gap-2 text-xs font-medium">
                          <Switch
                            checked={variant.isDefault}
                            onCheckedChange={(checked) =>
                              setVariantDrafts((current) =>
                                current.map((entry, entryIndex) => ({
                                  ...entry,
                                  isDefault: checked && entryIndex === index,
                                })),
                              )
                            }
                          />
                          Default
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-10 px-2 text-destructive hover:text-destructive"
                          aria-label={`Remove ${variant.label || "size"}`}
                          onClick={() =>
                            setVariantDrafts((current) =>
                              current.filter((_, entryIndex) => entryIndex !== index),
                            )
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))
                  )}
                </section>

                <section className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Add-ons</h3>
                      <p className="text-xs text-muted-foreground">
                        Add sauces, toppings, or other choices.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setModifierDrafts((current) => [
                          ...current,
                          {
                            groupName: "",
                            label: "",
                            additionalPrice: "0",
                            isRequired: false,
                            maxSelections: "1",
                          },
                        ])
                      }
                    >
                      <Plus className="mr-1 h-4 w-4" />
                      Add-on
                    </Button>
                  </div>
                  {modifierDrafts.length === 0 ? (
                    <p className="rounded-lg bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                      No add-ons.
                    </p>
                  ) : (
                    modifierDrafts.map((modifier, index) => (
                      <div
                        key={`modifier-${index}`}
                        className="space-y-3 rounded-lg border p-3"
                      >
                        <div className="grid gap-2 sm:grid-cols-2">
                          <div>
                            <Label htmlFor={`modifier-group-${index}`}>
                              Group
                            </Label>
                            <Input
                              id={`modifier-group-${index}`}
                              value={modifier.groupName}
                              onChange={(event) =>
                                setModifierDrafts((current) =>
                                  current.map((entry, entryIndex) =>
                                    entryIndex === index
                                      ? { ...entry, groupName: event.target.value }
                                      : entry,
                                  ),
                                )
                              }
                              placeholder="Sauces"
                            />
                          </div>
                          <div>
                            <Label htmlFor={`modifier-label-${index}`}>
                              Choice
                            </Label>
                            <Input
                              id={`modifier-label-${index}`}
                              value={modifier.label}
                              onChange={(event) =>
                                setModifierDrafts((current) =>
                                  current.map((entry, entryIndex) =>
                                    entryIndex === index
                                      ? { ...entry, label: event.target.value }
                                      : entry,
                                  ),
                                )
                              }
                              placeholder="Ranch"
                            />
                          </div>
                          <div>
                            <Label htmlFor={`modifier-price-${index}`}>
                              Added price
                            </Label>
                            <Input
                              id={`modifier-price-${index}`}
                              value={modifier.additionalPrice}
                              onChange={(event) =>
                                setModifierDrafts((current) =>
                                  current.map((entry, entryIndex) =>
                                    entryIndex === index
                                      ? {
                                          ...entry,
                                          additionalPrice: event.target.value,
                                        }
                                      : entry,
                                  ),
                                )
                              }
                              type="number"
                              min="0"
                              step="0.01"
                            />
                          </div>
                          <div>
                            <Label htmlFor={`modifier-max-${index}`}>
                              Maximum choices
                            </Label>
                            <Input
                              id={`modifier-max-${index}`}
                              value={modifier.maxSelections}
                              onChange={(event) =>
                                setModifierDrafts((current) =>
                                  current.map((entry, entryIndex) =>
                                    entryIndex === index
                                      ? {
                                          ...entry,
                                          maxSelections: event.target.value,
                                        }
                                      : entry,
                                  ),
                                )
                              }
                              type="number"
                              min="1"
                              step="1"
                            />
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <label className="flex items-center gap-2 text-xs font-medium">
                            <Switch
                              checked={modifier.isRequired}
                              onCheckedChange={(checked) =>
                                setModifierDrafts((current) =>
                                  current.map((entry, entryIndex) =>
                                    entryIndex === index
                                      ? { ...entry, isRequired: checked }
                                      : entry,
                                  ),
                                )
                              }
                            />
                            Customer must choose
                          </label>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() =>
                              setModifierDrafts((current) =>
                                current.filter(
                                  (_, entryIndex) => entryIndex !== index,
                                ),
                              )
                            }
                          >
                            <Trash2 className="mr-1.5 h-4 w-4" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </section>
              </div>
            </details>
          ) : null}

          <div className="space-y-3 rounded-xl border p-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label>Available to customers</Label>
                <p className="text-xs text-muted-foreground">
                  Turn this off when the item is sold out or paused.
                </p>
              </div>
              <Switch
                checked={form.isAvailable}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, isAvailable: v }))
                }
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label>Track inventory</Label>
                <p className="text-xs text-muted-foreground">
                  Keep a remaining quantity for this item.
                </p>
              </div>
              <Switch
                checked={form.trackInventory}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, trackInventory: v }))
                }
              />
            </div>
            {form.trackInventory && (
              <div>
                <Label htmlFor="menu-item-inventory">In-stock quantity</Label>
                <Input
                  id="menu-item-inventory"
                  value={form.inventoryQty}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, inventoryQty: e.target.value }))
                  }
                  type="number"
                  min="0"
                  placeholder="e.g. 20"
                />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={isSaving || !form.name.trim() || !hasValidPrice}
          >
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {item ? "Save changes" : "Add item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
