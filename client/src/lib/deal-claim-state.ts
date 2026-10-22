export type DealClaimReceipt = {
  id: string;
  dealId: string;
  claimedAt: string;
  usedAt?: string | null;
  isUsed?: boolean | null;
  orderAmount?: string | number | null;
  dealTitle?: string | null;
  dealType?: string | null;
  discountValue?: string | number | null;
  restaurantName?: string | null;
  restaurantId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isActive?: boolean | null;
  isOngoing?: boolean | null;
  available?: boolean | null;
  restaurantIsActive?: boolean | null;
  startTime?: string | null;
  endTime?: string | null;
  availableDuringBusinessHours?: boolean | null;
};

export type ClaimStatus = "Active" | "Used" | "Expired" | "Upcoming" | "Unavailable";

export function dealClaimStatus(claim: DealClaimReceipt, now = Date.now()): ClaimStatus {
  if (claim.isUsed || claim.usedAt) return "Used";
  const end = claim.endDate ? Date.parse(claim.endDate) : null;
  if (end !== null && Number.isFinite(end) && end <= now) return "Expired";
  if (claim.isUsed == null || claim.available === false || claim.isActive !== true || claim.restaurantIsActive !== true) return "Unavailable";
  const start = claim.startDate ? Date.parse(claim.startDate) : null;
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) return "Unavailable";
  if (start !== null && start > now) return "Upcoming";
  // A missing expiry is only meaningful when the server explicitly says ongoing.
  if (end === null && claim.isOngoing !== true) return "Unavailable";
  return "Active";
}

export function displayClaimStatus(status: ClaimStatus) {
  return status === "Active" ? "Claimed — check offer hours" : status;
}

export function isDealAuthenticationError(message: string) {
  return /unauthor|not authenticated|authentication required/i.test(message);
}

export function receiptDateLabel(value: string) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Date unavailable";
}

function isReceipt(value: any): value is DealClaimReceipt {
  return !!value && typeof value.id === "string" && value.id.trim().length > 0 && typeof value.dealId === "string" && value.dealId.trim().length > 0 && typeof value.claimedAt === "string" && Number.isFinite(Date.parse(value.claimedAt)) && (typeof value.isUsed === "boolean" || value.isUsed === null);
}

export function readClaimList(value: unknown): DealClaimReceipt[] {
  if (!Array.isArray(value) || value.some((claim) => !isReceipt(claim))) {
    throw new Error("Claim history could not be read. Please retry.");
  }
  return value;
}

export function readClaimResponse(value: any, dealId: string): DealClaimReceipt {
  if (value?.success !== true || !isReceipt(value?.claim) || value.claim.dealId !== dealId) {
    throw new Error("Claim confirmation could not be read. Check your wallet before trying again.");
  }
  return value.claim;
}

export function dealIntentPath(path: string, intent: "claim" | "save") {
  const url = new URL(path, "https://www.mealscout.us");
  url.searchParams.set("intent", intent);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function dealPhoneHref(phone?: string | null) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `tel:${raw.startsWith("+") ? "+" : ""}${digits}`;
}

export function dealDirectionsHref(address?: string | null) {
  const destination = String(address || "").trim();
  return destination ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` : null;
}
