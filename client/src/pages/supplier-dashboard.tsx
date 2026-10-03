import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Navigation from "@/components/navigation";
import { BackHeader } from "@/components/back-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";

type Supplier = {
  id: string;
  businessName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  isActive?: boolean | null;
  offersDelivery?: boolean | null;
  deliveryRadiusMiles?: number | null;
  deliveryFeeCents?: number | null;
  deliveryMinOrderCents?: number | null;
  deliveryNotes?: string | null;
  stripeConnectAccountId?: string | null;
  stripeChargesEnabled?: boolean | null;
  stripePayoutsEnabled?: boolean | null;
  stripeOnboardingCompleted?: boolean | null;
  stripeConnectStatus?: string | null;
};

type StripeStatus = {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingCompleted: boolean;
  accountId?: string;
};

type SupplierProduct = {
  id: string;
  name: string;
  priceCents: number;
  unitLabel?: string | null;
  isActive?: boolean | null;
  deliveryEligible?: boolean | null;
};

type SupplierOrder = {
  id: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  totalCents: number;
  createdAt?: string;
};

type SupplierRequest = {
  id: string;
  status: string;
  requestedFulfillment?: string | null;
  paymentPreference: string;
  note?: string | null;
  deliveryAddress?: string | null;
  deliveryCity?: string | null;
  deliveryState?: string | null;
  deliveryPostalCode?: string | null;
  deliveryInstructions?: string | null;
  deliveryFeeCents?: number | null;
  deliveryStatus?: string | null;
  deliveryScheduledFor?: string | null;
  createdAt?: string;
};

const formatMoney = (cents: number) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const prettify = (raw: string | null | undefined) =>
  String(raw || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase()) || "Unknown";

const toDateTimeLocalValue = (raw: string | null | undefined) => {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
};

export default function SupplierDashboardPage() {
  const { toast } = useToast();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [profileDraft, setProfileDraft] = useState({
    businessName: "",
    contactEmail: "",
    contactPhone: "",
    address: "",
    city: "",
    state: "",
  });
  const [newProduct, setNewProduct] = useState({
    name: "",
    priceDollars: "",
    unitLabel: "",
  });
  const [importFile, setImportFile] = useState<File | null>(null);
  const [deliverySettings, setDeliverySettings] = useState({
    offersDelivery: false,
    deliveryRadiusMiles: "",
    deliveryFeeDollars: "",
    deliveryMinOrderDollars: "",
    deliveryNotes: "",
  });
  const [onlineSettings, setOnlineSettings] = useState({
    onlinePaymentsEnabled: false,
    onlinePaymentsAllowAch: true,
    onlinePaymentsAllowCard: true,
    onlinePaymentsMinOrderDollars: "",
    onlinePaymentsNotes: "",
  });
  const [deliveryEdits, setDeliveryEdits] = useState<
    Record<string, { deliveryScheduledFor: string; deliveryFeeDollars: string }>
  >({});
  const [deliveryFilter, setDeliveryFilter] = useState<
    "all" | "submitted" | "active" | "delivered" | "cancelled"
  >("active");
  const [requestFilter, setRequestFilter] = useState<
    "all" | "submitted" | "accepted" | "closed"
  >("submitted");
  const [orderFilter, setOrderFilter] = useState<"all" | "open" | "ready" | "completed" | "cancelled">(
    "open",
  );

  const { data: supplier, isError: isSupplierError, refetch: refetchSupplier } = useQuery<Supplier>({
    queryKey: ["/api/supplier/me"],
    queryFn: async () => {
      const res = await fetch("/api/supplier/me", { credentials: "include" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to load supplier");
      return data;
    },
    staleTime: 30_000,
    gcTime: 10 * 60_000,
  });

  const { data: stripeStatus } = useQuery<StripeStatus>({
    queryKey: ["/api/supplier/stripe/status"],
    queryFn: async () => {
      const res = await fetch("/api/supplier/stripe/status", { credentials: "include" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to load Stripe status");
      return data;
    },
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    enabled: !isSupplierError,
  });

  const activateSupplierProfile = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/supplier/profile/activate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to create supplier profile");
      return data;
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      await refetchSupplier();
      toast({ title: "Supplier profile created" });
    },
    onError: (error: any) => {
      toast({
        title: "Unable to create supplier profile",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const supplierDeliveryDefaults = useMemo(() => {
    return {
      offersDelivery: Boolean(supplier?.offersDelivery),
      deliveryRadiusMiles:
        supplier?.deliveryRadiusMiles !== null && supplier?.deliveryRadiusMiles !== undefined
          ? String(supplier.deliveryRadiusMiles)
          : "",
      deliveryFeeDollars:
        supplier?.deliveryFeeCents !== null && supplier?.deliveryFeeCents !== undefined
          ? String((Number(supplier.deliveryFeeCents) / 100).toFixed(2))
          : "",
      deliveryMinOrderDollars:
        supplier?.deliveryMinOrderCents !== null && supplier?.deliveryMinOrderCents !== undefined
          ? String((Number(supplier.deliveryMinOrderCents) / 100).toFixed(2))
          : "",
      deliveryNotes: supplier?.deliveryNotes ?? "",
    };
  }, [supplier]);

  const supplierOnlineDefaults = useMemo(() => {
    return {
      onlinePaymentsEnabled: Boolean((supplier as any)?.onlinePaymentsEnabled),
      onlinePaymentsAllowAch: Boolean((supplier as any)?.onlinePaymentsAllowAch ?? true),
      onlinePaymentsAllowCard: Boolean((supplier as any)?.onlinePaymentsAllowCard ?? true),
      onlinePaymentsMinOrderDollars:
        (supplier as any)?.onlinePaymentsMinOrderCents !== null &&
        (supplier as any)?.onlinePaymentsMinOrderCents !== undefined
          ? String((Number((supplier as any).onlinePaymentsMinOrderCents) / 100).toFixed(2))
          : "",
      onlinePaymentsNotes: String((supplier as any)?.onlinePaymentsNotes ?? ""),
    };
  }, [supplier]);

  useEffect(() => {
    if (!supplier) return;
    setProfileDraft((prev) => ({
      ...prev,
      businessName: String(supplier.businessName || ""),
      contactEmail: String(supplier.contactEmail || ""),
      contactPhone: String(supplier.contactPhone || ""),
      address: String((supplier as any)?.address || ""),
      city: String((supplier as any)?.city || ""),
      state: String((supplier as any)?.state || ""),
    }));
  }, [supplier]);

  useEffect(() => {
    if (!supplier) return;
    setDeliverySettings((prev) => ({ ...prev, ...supplierDeliveryDefaults }));
  }, [supplier, supplierDeliveryDefaults]);

  useEffect(() => {
    if (!supplier) return;
    setOnlineSettings((prev) => ({ ...prev, ...supplierOnlineDefaults }));
  }, [supplier, supplierOnlineDefaults]);

  const updateProfile = useMutation({
    mutationFn: async () => {
      const businessName = profileDraft.businessName.trim();
      if (!businessName) throw new Error("Business name is required");

      const res = await fetch("/api/supplier/me", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          contactEmail: profileDraft.contactEmail.trim() || null,
          contactPhone: profileDraft.contactPhone.trim() || null,
          address: profileDraft.address.trim() || null,
          city: profileDraft.city.trim() || null,
          state: profileDraft.state.trim() || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to update profile");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/me"] });
      toast({ title: "Profile saved" });
    },
    onError: (error: any) => {
      toast({
        title: "Save failed",
        description: error?.message || "Unable to save profile",
        variant: "destructive",
      });
    },
  });

  const { data: products = [] } = useQuery<SupplierProduct[]>({
    queryKey: ["/api/supplier/products"],
    queryFn: async () => {
      const res = await fetch("/api/supplier/products", {
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to load products");
      return data;
    },
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    enabled: !isSupplierError,
  });

  const { data: orders = [] } = useQuery<SupplierOrder[]>({
    queryKey: ["/api/supplier/orders"],
    queryFn: async () => {
      const res = await fetch("/api/supplier/orders", {
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to load orders");
      return data;
    },
    staleTime: 15_000,
    gcTime: 10 * 60_000,
    enabled: !isSupplierError,
  });

  const { data: requests = [] } = useQuery<SupplierRequest[]>({
    queryKey: ["/api/supplier/requests"],
    queryFn: async () => {
      const res = await fetch("/api/supplier/requests", {
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to load requests");
      return data;
    },
    staleTime: 10_000,
    gcTime: 10 * 60_000,
    enabled: !isSupplierError,
  });

  const createProduct = useMutation({
    mutationFn: async () => {
      const price = Number(newProduct.priceDollars);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error("Enter a valid price");
      }
      const priceCents = Math.round(price * 100);
      const res = await fetch("/api/supplier/products", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProduct.name.trim(),
          priceCents,
          unitLabel: newProduct.unitLabel.trim() || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to create product");
      return data;
    },
    onSuccess: () => {
      setNewProduct({ name: "", priceDollars: "", unitLabel: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/products"] });
      toast({ title: "Product created" });
    },
    onError: (error: any) => {
      toast({
        title: "Create failed",
        description: error?.message || "Unable to create product",
        variant: "destructive",
      });
    },
  });

  const toggleDeliveryEligible = useMutation({
    mutationFn: async (params: { productId: string; deliveryEligible: boolean }) => {
      const res = await fetch(`/api/supplier/products/${params.productId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryEligible: params.deliveryEligible }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to update product");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/products"] });
    },
    onError: (error: any) => {
      toast({
        title: "Update failed",
        description: error?.message || "Unable to update product",
        variant: "destructive",
      });
    },
  });

  const startStripeOnboarding = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/supplier/stripe/onboard", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to start onboarding");
      return data as { onboardingUrl: string };
    },
    onSuccess: (data) => {
      if (data?.onboardingUrl) {
        window.location.href = data.onboardingUrl;
      } else {
        toast({
          title: "Onboarding unavailable",
          description: "No onboarding URL returned.",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Stripe setup failed",
        description: error?.message || "Unable to start Stripe onboarding",
        variant: "destructive",
      });
    },
  });

  const importProducts = useMutation({
    mutationFn: async () => {
      if (!importFile) throw new Error("Select a file");
      const form = new FormData();
      form.set("file", importFile);
      const res = await fetch("/api/supplier/products/import", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to import products");
      return data;
    },
    onSuccess: (data: any) => {
      setImportFile(null);
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/products"] });
      toast({
        title: "Import complete",
        description: `Imported ${Number(data?.imported ?? 0)} items.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Import failed",
        description: error?.message || "Unable to import products",
        variant: "destructive",
      });
    },
  });

  const acceptRequest = useMutation({
    mutationFn: async ({ requestId }: { requestId: string }) => {
      const res = await fetch(`/api/supplier/requests/${requestId}/accept`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to accept request");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/orders"] });
      toast({ title: "Request accepted" });
    },
    onError: (error: any) => {
      toast({
        title: "Accept failed",
        description: error?.message || "Unable to accept request",
        variant: "destructive",
      });
    },
  });

  const updateSupplier = useMutation({
    mutationFn: async () => {
      const fee = Number(deliverySettings.deliveryFeeDollars);
      const minOrder = Number(deliverySettings.deliveryMinOrderDollars);
      const radius = deliverySettings.deliveryRadiusMiles
        ? Number(deliverySettings.deliveryRadiusMiles)
        : null;

      if (deliverySettings.offersDelivery) {
        if (radius !== null && (!Number.isFinite(radius) || radius <= 0)) {
          throw new Error("Enter a valid delivery radius in miles");
        }
        if (!Number.isFinite(fee) || fee < 0) throw new Error("Enter a valid delivery fee");
        if (!Number.isFinite(minOrder) || minOrder < 0) {
          throw new Error("Enter a valid delivery minimum order");
        }
      }

      const onlineMin = Number(onlineSettings.onlinePaymentsMinOrderDollars);
      if (onlineSettings.onlinePaymentsEnabled) {
        if (
          !onlineSettings.onlinePaymentsAllowAch &&
          !onlineSettings.onlinePaymentsAllowCard
        ) {
          throw new Error("Enable ACH or card (or both) for online payments");
        }
        if (!Number.isFinite(onlineMin) || onlineMin < 0) {
          throw new Error("Enter a valid online minimum order");
        }
      }

      const res = await fetch("/api/supplier/me", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offersDelivery: deliverySettings.offersDelivery,
          deliveryRadiusMiles: deliverySettings.offersDelivery ? radius : null,
          deliveryFeeCents: deliverySettings.offersDelivery ? Math.round(fee * 100) : 0,
          deliveryMinOrderCents: deliverySettings.offersDelivery ? Math.round(minOrder * 100) : 0,
          deliveryNotes: deliverySettings.deliveryNotes.trim() || null,

          onlinePaymentsEnabled: onlineSettings.onlinePaymentsEnabled,
          onlinePaymentsAllowAch: onlineSettings.onlinePaymentsEnabled
            ? onlineSettings.onlinePaymentsAllowAch
            : true,
          onlinePaymentsAllowCard: onlineSettings.onlinePaymentsEnabled
            ? onlineSettings.onlinePaymentsAllowCard
            : true,
          onlinePaymentsMinOrderCents: onlineSettings.onlinePaymentsEnabled
            ? Math.round((Number.isFinite(onlineMin) ? onlineMin : 0) * 100)
            : 0,
          onlinePaymentsNotes: onlineSettings.onlinePaymentsNotes.trim() || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to update settings");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/stripe/status"] });
      toast({ title: "Settings saved" });
    },
    onError: (error: any) => {
      toast({
        title: "Save failed",
        description: error?.message || "Unable to save settings",
        variant: "destructive",
      });
    },
  });

  const updateDelivery = useMutation({
    mutationFn: async (params: {
      requestId: string;
      deliveryStatus?: string;
      deliveryScheduledFor?: string | null;
      deliveryFeeCents?: number;
    }) => {
      const res = await fetch(`/api/supplier/requests/${params.requestId}/delivery`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(params.deliveryStatus ? { deliveryStatus: params.deliveryStatus } : {}),
          ...(params.deliveryScheduledFor !== undefined
            ? { deliveryScheduledFor: params.deliveryScheduledFor }
            : {}),
          ...(params.deliveryFeeCents !== undefined
            ? { deliveryFeeCents: params.deliveryFeeCents }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to update delivery");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/requests"] });
      toast({ title: "Delivery updated" });
    },
    onError: (error: any) => {
      toast({
        title: "Update failed",
        description: error?.message || "Unable to update delivery",
        variant: "destructive",
      });
    },
  });

  const setOrderStatus = useMutation({
    mutationFn: async ({ orderId, status }: { orderId: string; status: string }) => {
      const res = await fetch(`/api/supplier/orders/${orderId}/status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "Failed to update order");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/supplier/orders"] });
      toast({ title: "Order updated" });
    },
    onError: (error: any) => {
      toast({
        title: "Update failed",
        description: error?.message || "Unable to update order",
        variant: "destructive",
      });
    },
  });

  const activeCount = useMemo(
    () => products.filter((p) => p.isActive !== false).length,
    [products],
  );
  const supplierProfileComplete = Boolean(
    supplier?.businessName &&
      ((supplier as any)?.address || (supplier as any)?.city) &&
      (supplier.contactEmail || supplier.contactPhone),
  );
  const supplierPayoutReady = Boolean(
    stripeStatus?.connected &&
      stripeStatus.chargesEnabled &&
      stripeStatus.payoutsEnabled,
  );
  const supplierSetupItems = [
    {
      label: "Profile",
      description: supplierProfileComplete
        ? "Supplier profile has contact and service-area details."
        : "Add business name, contact, and local service area.",
      done: supplierProfileComplete,
      action: "Complete profile",
      targetId: "supplier-profile",
    },
    {
      label: "Products",
      description:
        activeCount > 0
          ? `${activeCount} active product${activeCount === 1 ? "" : "s"} listed.`
          : "Add or import products so businesses can order.",
      done: activeCount > 0,
      action: "Add products",
      targetId: "supplier-products",
    },
    {
      label: "Delivery",
      description: supplier?.offersDelivery
        ? "Delivery settings are enabled."
        : "Set delivery radius, fees, and notes if you deliver.",
      done: Boolean(supplier?.offersDelivery),
      action: "Set delivery",
      targetId: "supplier-delivery",
    },
    {
      label: "Payments",
      description: supplierPayoutReady
        ? "Online payments and payouts are ready."
        : "Connect Stripe before paid orders scale.",
      done: supplierPayoutReady,
      action: "Enable payouts",
      targetId: "supplier-payments",
    },
  ];
  const supplierSetupComplete = supplierSetupItems.filter((item) => item.done).length;

  const deliveryRequests = useMemo(
    () => requests.filter((r) => String(r.requestedFulfillment || "") === "delivery"),
    [requests],
  );
  const nonDeliveryRequests = useMemo(
    () => requests.filter((r) => String(r.requestedFulfillment || "") !== "delivery"),
    [requests],
  );
  const filteredDeliveryRequests = useMemo(() => {
    const rows = deliveryRequests;
    if (deliveryFilter === "all") return rows;
    if (deliveryFilter === "submitted") return rows.filter((r) => String(r.status) === "submitted");
    if (deliveryFilter === "delivered") {
      return rows.filter((r) => String(r.deliveryStatus || "pending") === "delivered");
    }
    if (deliveryFilter === "cancelled") {
      return rows.filter(
        (r) =>
          String(r.deliveryStatus || "pending") === "cancelled" || String(r.status) === "cancelled",
      );
    }
    return rows.filter((r) =>
      ["accepted", "out_for_delivery"].includes(String(r.deliveryStatus || "pending")),
    );
  }, [deliveryRequests, deliveryFilter]);
  const filteredRequests = useMemo(() => {
    if (requestFilter === "all") return nonDeliveryRequests;
    if (requestFilter === "submitted") {
      return nonDeliveryRequests.filter((r) => String(r.status) === "submitted");
    }
    if (requestFilter === "accepted") {
      return nonDeliveryRequests.filter((r) => String(r.status) === "accepted");
    }
    return nonDeliveryRequests.filter((r) =>
      ["declined", "cancelled"].includes(String(r.status)),
    );
  }, [nonDeliveryRequests, requestFilter]);
  const filteredOrders = useMemo(() => {
    if (orderFilter === "all") return orders;
    if (orderFilter === "open") return orders.filter((o) => !["completed", "cancelled"].includes(String(o.status)));
    if (orderFilter === "ready") return orders.filter((o) => String(o.status) === "ready");
    if (orderFilter === "completed") return orders.filter((o) => String(o.status) === "completed");
    return orders.filter((o) => String(o.status) === "cancelled");
  }, [orders, orderFilter]);

  useEffect(() => {
    if (deliveryRequests.length === 0) return;
    setDeliveryEdits((prev) => {
      const next = { ...prev };
      for (const r of deliveryRequests) {
        if (next[r.id]) continue;
        next[r.id] = {
          deliveryScheduledFor: toDateTimeLocalValue(r.deliveryScheduledFor),
          deliveryFeeDollars: String(((Number(r.deliveryFeeCents || 0) || 0) / 100).toFixed(2)),
        };
      }
      return next;
    });
  }, [deliveryRequests]);

  return (
    <div className="min-h-screen pb-24">
      <h1 className="sr-only">MealScout supplier dashboard</h1>
      <BackHeader title="Supplier Dashboard" fallbackHref="/" />
      {supplier ? <div className="px-4 pb-4"><a className="text-sm font-medium underline" href="/owner-ai">Review AI profile updates</a></div> : null}

      <div className="px-4 space-y-4">
        {isSupplierError ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              This dashboard is for supplier profiles. Add a supplier profile to this account to list products and accept orders.
              <div className="pt-3">
                {isAuthenticated ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={activateSupplierProfile.isPending}
                    onClick={() => activateSupplierProfile.mutate()}
                  >
                    {activateSupplierProfile.isPending
                      ? "Creating profile..."
                      : "Create supplier profile"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      window.location.href = "/login?redirect=/supplier/dashboard";
                    }}
                  >
                    Sign in
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardContent className="p-4 space-y-2">
                <div className="text-sm font-semibold">
                  {supplier?.businessName || "Supplier"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Active products: {activeCount}
                </div>
                <div className="pt-2 flex items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    Payouts setup:{" "}
                    {stripeStatus?.connected
                      ? stripeStatus.payoutsEnabled
                        ? "Active"
                        : "Pending"
                      : "Not connected"}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={startStripeOnboarding.isPending}
                    onClick={() => startStripeOnboarding.mutate()}
                  >
                    {stripeStatus?.connected ? "Manage Stripe" : "Enable payouts"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="border-orange-200 bg-orange-50">
              <CardContent className="p-4">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-700">
                      Supplier onboarding
                    </p>
                    <h2 className="mt-1 text-xl font-black text-orange-950">
                      Finish your supply profile
                    </h2>
                    <p className="mt-1 text-sm text-orange-900/75">
                      Suppliers need a clean profile, real products, delivery
                      rules, and payment settings so restaurants and trucks can
                      act without back-and-forth.
                    </p>
                  </div>
                  <span className="w-fit rounded-full bg-orange-600 px-3 py-1 text-xs font-bold text-white">
                    {supplierSetupComplete}/{supplierSetupItems.length} complete
                  </span>
                </div>
                <div className="grid gap-2 md:grid-cols-4">
                  {supplierSetupItems.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() =>
                        document
                          .getElementById(item.targetId)
                          ?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }
                      className="rounded-xl border border-orange-200 bg-white p-3 text-left transition hover:border-orange-400"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-lg" aria-hidden="true">
                          {item.done ? "✓" : "•"}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          item.done
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-orange-100 text-orange-700"
                        }`}>
                          {item.done ? "Done" : "Next"}
                        </span>
                      </div>
                      <p className="text-sm font-black text-orange-950">{item.label}</p>
                      <p className="mt-1 min-h-[2.5rem] text-xs text-orange-900/70">
                        {item.description}
                      </p>
                      <p className="mt-2 text-xs font-bold text-orange-700">
                        {item.action}
                      </p>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card id="supplier-profile">
              <CardContent className="p-4 space-y-3">
                <div className="text-sm font-semibold">Profile</div>
                <Input
                  placeholder="Business name"
                  value={profileDraft.businessName}
                  onChange={(e) =>
                    setProfileDraft((p) => ({ ...p, businessName: e.target.value }))
                  }
                />
                <div className="flex gap-2">
                  <Input
                    placeholder="Contact email (optional)"
                    value={profileDraft.contactEmail}
                    onChange={(e) =>
                      setProfileDraft((p) => ({ ...p, contactEmail: e.target.value }))
                    }
                  />
                  <Input
                    placeholder="Contact phone (optional)"
                    value={profileDraft.contactPhone}
                    onChange={(e) =>
                      setProfileDraft((p) => ({ ...p, contactPhone: e.target.value }))
                    }
                  />
                </div>
                <Input
                  placeholder="Address (optional)"
                  value={profileDraft.address}
                  onChange={(e) =>
                    setProfileDraft((p) => ({ ...p, address: e.target.value }))
                  }
                />
                <div className="flex gap-2">
                  <Input
                    placeholder="City (optional)"
                    value={profileDraft.city}
                    onChange={(e) =>
                      setProfileDraft((p) => ({ ...p, city: e.target.value }))
                    }
                  />
                  <Input
                    placeholder="State (optional)"
                    value={profileDraft.state}
                    onChange={(e) =>
                      setProfileDraft((p) => ({ ...p, state: e.target.value }))
                    }
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={updateProfile.isPending}
                  onClick={() => updateProfile.mutate()}
                >
                  {updateProfile.isPending ? "Saving..." : "Save profile"}
                </Button>
              </CardContent>
            </Card>

            <Card id="supplier-products">
              <CardContent className="p-4 space-y-3">
                <div className="text-sm font-semibold">Add product</div>
                <Input
                  placeholder="Name"
                  value={newProduct.name}
                  onChange={(e) =>
                    setNewProduct((p) => ({ ...p, name: e.target.value }))
                  }
                />
                <div className="flex gap-2">
                  <Input
                    placeholder="Price (e.g. 12.50)"
                    value={newProduct.priceDollars}
                    onChange={(e) =>
                      setNewProduct((p) => ({
                        ...p,
                        priceDollars: e.target.value,
                      }))
                    }
                  />
                  <Input
                    placeholder="Unit (optional)"
                    value={newProduct.unitLabel}
                    onChange={(e) =>
                      setNewProduct((p) => ({ ...p, unitLabel: e.target.value }))
                    }
                  />
                </div>
                <Button
                  disabled={createProduct.isPending || !newProduct.name.trim()}
                  onClick={() => createProduct.mutate()}
                >
                  {createProduct.isPending ? "Saving..." : "Create"}
                </Button>
              </CardContent>
            </Card>

            <Card id="supplier-delivery">
              <CardContent className="p-4 space-y-3">
                <div className="text-sm font-semibold">Delivery settings</div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={deliverySettings.offersDelivery}
                    onChange={(e) =>
                      setDeliverySettings((p) => ({
                        ...p,
                        offersDelivery: e.target.checked,
                      }))
                    }
                  />
                  Offer delivery
                </label>

                <div className="grid grid-cols-1 gap-2">
                  <Input
                    placeholder="Delivery radius (miles)"
                    value={deliverySettings.deliveryRadiusMiles}
                    onChange={(e) =>
                      setDeliverySettings((p) => ({
                        ...p,
                        deliveryRadiusMiles: e.target.value,
                      }))
                    }
                    disabled={!deliverySettings.offersDelivery}
                  />
                  <div className="flex gap-2">
                    <Input
                      placeholder="Delivery fee ($)"
                      value={deliverySettings.deliveryFeeDollars}
                      onChange={(e) =>
                        setDeliverySettings((p) => ({
                          ...p,
                          deliveryFeeDollars: e.target.value,
                        }))
                      }
                      disabled={!deliverySettings.offersDelivery}
                    />
                    <Input
                      placeholder="Min order ($)"
                      value={deliverySettings.deliveryMinOrderDollars}
                      onChange={(e) =>
                        setDeliverySettings((p) => ({
                          ...p,
                          deliveryMinOrderDollars: e.target.value,
                        }))
                      }
                      disabled={!deliverySettings.offersDelivery}
                    />
                  </div>
                  <Input
                    placeholder="Delivery notes (optional)"
                    value={deliverySettings.deliveryNotes}
                    onChange={(e) =>
                      setDeliverySettings((p) => ({
                        ...p,
                        deliveryNotes: e.target.value,
                      }))
                    }
                    disabled={!deliverySettings.offersDelivery}
                  />
                </div>

                <Button
                  variant="outline"
                  disabled={updateSupplier.isPending}
                  onClick={() => updateSupplier.mutate()}
                >
                  {updateSupplier.isPending ? "Saving..." : "Save settings"}
                </Button>
              </CardContent>
            </Card>

            <Card id="supplier-payments">
              <CardContent className="p-4 space-y-3">
                <div className="text-sm font-semibold">Online payments (MealScout)</div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={onlineSettings.onlinePaymentsEnabled}
                    onChange={(e) =>
                      setOnlineSettings((p) => ({
                        ...p,
                        onlinePaymentsEnabled: e.target.checked,
                      }))
                    }
                  />
                  Allow buyers to pay online (ACH/Card)
                </label>

                <div className="grid grid-cols-1 gap-2">
                  <div className="flex items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={onlineSettings.onlinePaymentsAllowAch}
                        onChange={(e) =>
                          setOnlineSettings((p) => ({
                            ...p,
                            onlinePaymentsAllowAch: e.target.checked,
                          }))
                        }
                        disabled={!onlineSettings.onlinePaymentsEnabled}
                      />
                      ACH (bank transfer)
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={onlineSettings.onlinePaymentsAllowCard}
                        onChange={(e) =>
                          setOnlineSettings((p) => ({
                            ...p,
                            onlinePaymentsAllowCard: e.target.checked,
                          }))
                        }
                        disabled={!onlineSettings.onlinePaymentsEnabled}
                      />
                      Card
                    </label>
                  </div>

                  <Input
                    placeholder="Online min order ($)"
                    value={onlineSettings.onlinePaymentsMinOrderDollars}
                    onChange={(e) =>
                      setOnlineSettings((p) => ({
                        ...p,
                        onlinePaymentsMinOrderDollars: e.target.value,
                      }))
                    }
                    disabled={!onlineSettings.onlinePaymentsEnabled}
                  />

                  <Input
                    placeholder="Online payment notes (optional)"
                    value={onlineSettings.onlinePaymentsNotes}
                    onChange={(e) =>
                      setOnlineSettings((p) => ({
                        ...p,
                        onlinePaymentsNotes: e.target.value,
                      }))
                    }
                    disabled={!onlineSettings.onlinePaymentsEnabled}
                  />

                  <div className="text-xs text-muted-foreground">
                    Buyers will be offered ACH first for large orders to reduce fees.
                  </div>
                </div>

                <Button
                  variant="outline"
                  disabled={updateSupplier.isPending}
                  onClick={() => updateSupplier.mutate()}
                >
                  {updateSupplier.isPending ? "Saving..." : "Save settings"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="text-sm font-semibold">Import products</div>
                <div className="text-xs text-muted-foreground">
                  Upload CSV/TSV/XLSX. Required column: `name`. Optional: `sku`,
                  `price` (dollars) or `price_cents`, `unit_label`, `description`,
                  `active`.
                </div>
                <input
                  type="file"
                  accept=".csv,.tsv,.xlsx"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                />
                <Button
                  variant="outline"
                  disabled={importProducts.isPending || !importFile}
                  onClick={() => importProducts.mutate()}
                >
                  {importProducts.isPending ? "Importing..." : "Import"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">Delivery portal</div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-muted-foreground">
                      {filteredDeliveryRequests.length}/{deliveryRequests.length}
                    </div>
                    <select
                      className="border rounded px-2 py-1 text-xs bg-background"
                      value={deliveryFilter}
                      onChange={(e) => setDeliveryFilter(e.target.value as any)}
                    >
                      <option value="active">Active</option>
                      <option value="submitted">Submitted</option>
                      <option value="delivered">Delivered</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="all">All</option>
                    </select>
                  </div>
                </div>
                {deliveryRequests.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No delivery requests yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredDeliveryRequests.map((r) => {
                      const address = [r.deliveryAddress, r.deliveryCity, r.deliveryState]
                        .map((v) => (v || "").trim())
                        .filter(Boolean)
                        .join(", ");
                      const reqStatus = String(r.status || "");
                      const delStatus = String(r.deliveryStatus || "pending");
                      const canMarkOutForDelivery =
                        reqStatus === "accepted" &&
                        ["accepted", "pending"].includes(delStatus);
                      const canMarkDelivered =
                        reqStatus === "accepted" && ["out_for_delivery", "accepted"].includes(delStatus);
                      const canCancel =
                        !["delivered", "cancelled"].includes(delStatus) && reqStatus !== "cancelled";
                      return (
                        <div key={r.id} className="border rounded p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="text-xs text-muted-foreground">
                              Delivery - {r.paymentPreference}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {prettify(delStatus)} - {prettify(reqStatus)}
                            </div>
                          </div>
                          {address ? <div className="text-sm">{address}</div> : null}
                          {r.deliveryInstructions ? (
                            <div className="text-sm text-muted-foreground">
                              {r.deliveryInstructions}
                            </div>
                          ) : null}
                          <div className="text-xs text-muted-foreground">
                            Fee: {formatMoney(Number(r.deliveryFeeCents || 0))}
                          </div>
                          <div className="grid grid-cols-1 gap-2">
                            <Input
                              type="datetime-local"
                              value={deliveryEdits[r.id]?.deliveryScheduledFor ?? ""}
                              onChange={(e) =>
                                setDeliveryEdits((p) => ({
                                  ...p,
                                  [r.id]: {
                                    ...(p[r.id] || {
                                      deliveryScheduledFor: "",
                                      deliveryFeeDollars: "",
                                    }),
                                    deliveryScheduledFor: e.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              value={deliveryEdits[r.id]?.deliveryFeeDollars ?? ""}
                              onChange={(e) =>
                                setDeliveryEdits((p) => ({
                                  ...p,
                                  [r.id]: {
                                    ...(p[r.id] || {
                                      deliveryScheduledFor: "",
                                      deliveryFeeDollars: "",
                                    }),
                                    deliveryFeeDollars: e.target.value,
                                  },
                                }))
                              }
                              placeholder="Delivery fee ($)"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={updateDelivery.isPending}
                              onClick={() => {
                                const fee = Number(deliveryEdits[r.id]?.deliveryFeeDollars);
                                const feeCents = Number.isFinite(fee) ? Math.round(fee * 100) : 0;
                                updateDelivery.mutate({
                                  requestId: r.id,
                                  deliveryScheduledFor: deliveryEdits[r.id]?.deliveryScheduledFor
                                    ? deliveryEdits[r.id]?.deliveryScheduledFor
                                    : null,
                                  deliveryFeeCents: Math.max(0, feeCents),
                                });
                              }}
                            >
                              Save schedule/fee
                            </Button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={acceptRequest.isPending || r.status !== "submitted"}
                              onClick={() => acceptRequest.mutate({ requestId: r.id })}
                            >
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={updateDelivery.isPending || !canMarkOutForDelivery}
                              onClick={() =>
                                updateDelivery.mutate({
                                  requestId: r.id,
                                  deliveryStatus: "out_for_delivery",
                                })
                              }
                            >
                              Out for delivery
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={updateDelivery.isPending || !canMarkDelivered}
                              onClick={() =>
                                updateDelivery.mutate({
                                  requestId: r.id,
                                  deliveryStatus: "delivered",
                                })
                              }
                            >
                              Delivered
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={updateDelivery.isPending || !canCancel}
                              onClick={() =>
                                updateDelivery.mutate({
                                  requestId: r.id,
                                  deliveryStatus: "cancelled",
                                })
                              }
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">Requests</div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-muted-foreground">
                      {filteredRequests.length}/{nonDeliveryRequests.length}
                    </div>
                    <select
                      className="border rounded px-2 py-1 text-xs bg-background"
                      value={requestFilter}
                      onChange={(e) => setRequestFilter(e.target.value as any)}
                    >
                      <option value="submitted">Submitted</option>
                      <option value="accepted">Accepted</option>
                      <option value="closed">Closed</option>
                      <option value="all">All</option>
                    </select>
                  </div>
                </div>
                {nonDeliveryRequests.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No requests yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredRequests.map((r) => (
                      <div key={r.id} className="border rounded p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-xs text-muted-foreground">
                            {prettify(r.paymentPreference)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {prettify(r.status)}
                          </div>
                        </div>
                        {r.note ? (
                          <div className="text-sm">{r.note}</div>
                        ) : null}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={
                              acceptRequest.isPending || r.status !== "submitted"
                            }
                            onClick={() => acceptRequest.mutate({ requestId: r.id })}
                          >
                            Accept
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="text-sm font-semibold">Products</div>
                {products.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No products yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {products.map((p) => (
                      <div key={p.id} className="flex items-center justify-between">
                        <div>
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatMoney(p.priceCents)}
                            {p.unitLabel ? ` / ${p.unitLabel}` : ""}
                          </div>
                          <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={p.deliveryEligible !== false}
                              onChange={(e) =>
                                toggleDeliveryEligible.mutate({
                                  productId: p.id,
                                  deliveryEligible: e.target.checked,
                                })
                              }
                              disabled={toggleDeliveryEligible.isPending}
                            />
                            Delivery eligible
                          </label>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {p.isActive === false ? "Inactive" : "Active"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">Orders</div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-muted-foreground">
                      {filteredOrders.length}/{orders.length}
                    </div>
                    <select
                      className="border rounded px-2 py-1 text-xs bg-background"
                      value={orderFilter}
                      onChange={(e) => setOrderFilter(e.target.value as any)}
                    >
                      <option value="open">Open</option>
                      <option value="ready">Ready</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="all">All</option>
                    </select>
                  </div>
                </div>
                {orders.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No orders yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredOrders.map((o) => (
                      <div key={o.id} className="border rounded p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold">
                            {formatMoney(o.totalCents)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {prettify(o.paymentMethod)}:{prettify(o.paymentStatus)}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Status: {prettify(o.status)}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={setOrderStatus.isPending || ["ready", "completed", "cancelled"].includes(String(o.status))}
                            onClick={() =>
                              setOrderStatus.mutate({ orderId: o.id, status: "ready" })
                            }
                          >
                            Ready
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={setOrderStatus.isPending || ["completed", "cancelled"].includes(String(o.status))}
                            onClick={() =>
                              setOrderStatus.mutate({
                                orderId: o.id,
                                status: "completed",
                              })
                            }
                          >
                            Completed
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Navigation />
    </div>
  );
}
