export type SearchLocation = { lat: number; lng: number; label?: string };

export function validSearchLocation(value: unknown): value is SearchLocation {
  const location = value as SearchLocation | null;
  return !!location && Number.isFinite(location.lat) && Number.isFinite(location.lng) &&
    Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180 &&
    (location.label === undefined || typeof location.label === "string");
}

function coordinate(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Use only coordinates already approved for the public response. Unknown
// locations cannot establish that a result belongs inside a nearby search.
export function withinSearchRadius(row: any, location: SearchLocation, radiusKm: number): boolean {
  const lat = coordinate(row?.currentLatitude ?? row?.latitude);
  const lng = coordinate(row?.currentLongitude ?? row?.longitude);
  if (lat === null || lng === null || !validSearchLocation({ lat, lng })) return false;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const a = Math.sin(radians(lat - location.lat) / 2) ** 2 +
    Math.cos(radians(location.lat)) * Math.cos(radians(lat)) *
    Math.sin(radians(lng - location.lng) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) <= radiusKm;
}

const renderedTextFields = [
  "title", "name", "description", "cuisineType", "restaurantName", "restaurantCity",
  "restaurantState", "businessName", "businessType", "address", "city", "state",
  "hostBusinessName", "hostAddress", "hostCity", "hostState", "display_name",
];

function hasInvalidRenderedText(row: Record<string, unknown>): boolean {
  if (renderedTextFields.some((field) => row[field] !== null && row[field] !== undefined && typeof row[field] !== "string")) return true;
  if (row.restaurant !== null && row.restaurant !== undefined) {
    if (typeof row.restaurant !== "object" || Array.isArray(row.restaurant)) return true;
    return hasInvalidRenderedText(row.restaurant as Record<string, unknown>);
  }
  return false;
}

export function searchArray(value: unknown, requiredTextFields: string[] = []): any[] {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row) ||
    requiredTextFields.some((field) => typeof row[field] !== "string" || !row[field].trim()) || hasInvalidRenderedText(row))) {
    throw new Error("Search returned an invalid collection. Please retry.");
  }
  return value;
}

export function unifiedSearchResult(value: unknown): Record<string, any[]> {
  if (!value || typeof value !== "object") throw new Error("Search returned an invalid response. Please retry.");
  return Object.fromEntries(["restaurants", "deals", "parkingPassHosts", "videos", "events"].map(
    (bucket) => [bucket, searchArray((value as Record<string, unknown>)[bucket], bucket === "parkingPassHosts" ? ["hostId", "businessName"] : bucket === "restaurants" ? ["id", "name"] : bucket === "deals" ? ["id", "title"] : ["id"])],
  ));
}

export async function fetchSearchJson(path: string, signal?: AbortSignal, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { signal: controller.signal });
    if (!response.ok) throw new Error("Search is unavailable. Please retry.");
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("Search timed out. Please retry.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
