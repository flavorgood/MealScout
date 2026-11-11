import { AlertCircle, CheckCircle2, Clock3, XCircle } from "lucide-react";

const ORDER_STATUS: Record<
  string,
  { label: string; className: string; icon: typeof Clock3; group: "active" | "past" | "unknown" }
> = {
  pending: {
    group: "active",
    label: "Received",
    className: "border-amber-200 bg-amber-50 text-amber-900",
    icon: Clock3,
  },
  confirmed: {
    group: "active",
    label: "Confirmed",
    className: "border-blue-200 bg-blue-50 text-blue-800",
    icon: CheckCircle2,
  },
  preparing: {
    group: "active",
    label: "Preparing",
    className: "border-orange-200 bg-orange-50 text-orange-800",
    icon: Clock3,
  },
  ready: {
    group: "active",
    label: "Ready",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    icon: CheckCircle2,
  },
  out_for_delivery: {
    group: "active",
    label: "Out for delivery",
    className: "border-violet-200 bg-violet-50 text-violet-800",
    icon: Clock3,
  },
  delivered: {
    group: "active",
    label: "Delivered",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    icon: CheckCircle2,
  },
  payment_disputed: {
    group: "active",
    label: "Payment under review",
    className: "border-amber-200 bg-amber-50 text-amber-900",
    icon: AlertCircle,
  },
  cancellation_pending: {
    group: "active",
    label: "Cancellation processing",
    className: "border-amber-200 bg-amber-50 text-amber-900",
    icon: Clock3,
  },
  completed: {
    group: "past",
    label: "Completed",
    className: "border-stone-200 bg-stone-100 text-stone-700",
    icon: CheckCircle2,
  },
  cancelled: {
    group: "past",
    label: "Cancelled",
    className: "border-red-200 bg-red-50 text-red-800",
    icon: XCircle,
  },
};

const UNKNOWN_STATUS = {
  group: "unknown" as const,
  label: "Status unavailable",
  className: "border-stone-200 bg-stone-100 text-stone-700",
  icon: AlertCircle,
};

// Presentation only: fulfillment and payment transitions remain server-owned.
export function orderActivityStatus(status: string) {
  return Object.prototype.hasOwnProperty.call(ORDER_STATUS, status)
    ? ORDER_STATUS[status]
    : UNKNOWN_STATUS;
}

export function countOrderActivity(orders: ReadonlyArray<{ status: string }>) {
  return orders.reduce((counts, order) => {
    counts[orderActivityStatus(order.status).group] += 1;
    return counts;
  }, { active: 0, past: 0, unknown: 0 });
}
