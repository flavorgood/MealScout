export const GUEST_MENU_DRAFT_KEY = "mealscout:guest-menu-draft:v1";
export const GUEST_MENU_MAX_ITEMS = 100;
export const GUEST_MENU_CATEGORY_NOTICE = "Categories stay in your private preview. After importing, assign categories in the business menu workspace.";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type GuestMenuItemDraft = { name: string; description: string; price: string; category: string };
export type GuestMenuDraft = { name: string; serviceType: "all" | "breakfast" | "lunch" | "dinner"; items: GuestMenuItemDraft[] };
const serviceTypes = new Set(["all", "breakfast", "lunch", "dinner"]);
const itemLimits = { name: 160, description: 500, price: 16, category: 80 } as const;

export const emptyGuestMenuItem = (): GuestMenuItemDraft => ({ name: "", description: "", price: "", category: "" });
export const emptyGuestMenuDraft = (): GuestMenuDraft => ({ name: "", serviceType: "all", items: [emptyGuestMenuItem()] });

// Local continuity only: this format carries no account, business, ownership or menu ID.
export function parseGuestMenuDraft(raw: string | null, now = Date.now()): GuestMenuDraft | null {
  if (!raw || raw.length > 256 * 1024) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      typeof value.__savedAt !== "number" || !Number.isFinite(value.__savedAt) ||
      value.__savedAt > now || now - value.__savedAt > MAX_AGE_MS ||
      typeof value.name !== "string" || value.name.length > 160 ||
      !serviceTypes.has(value.serviceType) || !Array.isArray(value.items) || value.items.length > GUEST_MENU_MAX_ITEMS) return null;
    const items: GuestMenuItemDraft[] = [];
    for (const item of value.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      for (const [field, limit] of Object.entries(itemLimits)) {
        if (typeof item[field] !== "string" || item[field].length > limit) return null;
      }
      items.push({ name: item.name, description: item.description, price: item.price, category: item.category });
    }
    return { name: value.name, serviceType: value.serviceType, items };
  } catch { return null; }
}

export function readGuestMenuDraft(storage: () => Pick<Storage, "getItem">, now = Date.now()): GuestMenuDraft | null {
  try { return parseGuestMenuDraft(storage().getItem(GUEST_MENU_DRAFT_KEY), now); }
  catch { return null; }
}

export function persistGuestMenuDraft(storage: () => Pick<Storage, "setItem">, draft: GuestMenuDraft, now = Date.now()): boolean {
  try {
    const envelope = { version: 1, __savedAt: now, ...draft };
    const safe = parseGuestMenuDraft(JSON.stringify(envelope), now);
    if (!safe) return false;
    storage().setItem(GUEST_MENU_DRAFT_KEY, JSON.stringify({ version: 1, __savedAt: now, ...safe }));
    return true;
  } catch { return false; }
}

export function guestMenuDraftToCsv(draft: GuestMenuDraft): string {
  if (!draft.items.length || draft.items.some(item => !item.name.trim() || !/^\d{1,5}(?:\.\d{1,2})?$/.test(item.price.trim()))) {
    throw new Error("Add a name and a valid price to every item before importing. Your private draft is saved.");
  }
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return ["Name,Description,Price", ...draft.items.map(item => {
    // The existing importer treats large integers as cents. Explicit decimals
    // preserve the dollars shown in the private preview without changing it.
    const [dollars, cents = ""] = item.price.trim().split(".");
    return [item.name.trim(), item.description, `${dollars}.${cents.padEnd(2, "0")}`].map(cell).join(",");
  })].join("\r\n");
}
