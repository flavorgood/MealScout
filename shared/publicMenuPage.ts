/** Public menu facts already admitted by the canonical anonymous menu reader. */
export type PublicMenuPageFacts = {
  parentIndexable?: boolean;
  restaurantName?: string | null;
  restaurantCity?: string | null;
  cuisineType?: string | null;
  menus: Array<{
    id: string;
    name: string;
    isActive: boolean;
    categories: Array<{ name: string; items: Array<{ name: string; description?: string | null; priceCents: number | null; itemType?: string }> }>;
    uncategorizedItems?: Array<{ name: string; description?: string | null; priceCents: number | null; itemType?: string }>;
  }>;
};

export function publicMenuPageMetadata(restaurantId: string, data?: PublicMenuPageFacts | null, requestedMenuId?: string | null) {
  const canonicalPath = `/menu/${encodeURIComponent(restaurantId)}`;
  const name = data?.restaurantName;
  const active = data?.menus.filter(menu => menu.isActive) ?? [];
  const selected = active.find(menu => menu.id === requestedMenuId) ?? active[0];
  const title = name ? `${name} Menu${data?.restaurantCity ? ` - ${data.restaurantCity}` : ""} | MealScout` : "Online Menu | MealScout";
  const description = name
    ? `Browse the menu from ${name}${data?.restaurantCity ? ` in ${data.restaurantCity}` : ""}${data?.cuisineType ? ` — ${data.cuisineType}` : ""}. Order for pickup when available on MealScout.`
    : "Browse the full menu and order for pickup when available on MealScout.";
  const schemaItem = (item: PublicMenuPageFacts["menus"][number]["categories"][number]["items"][number]) => ({
    "@type": "MenuItem",
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    ...(Number.isSafeInteger(item.priceCents) && item.priceCents !== null && item.priceCents >= 0
      ? { offers: { "@type": "Offer", price: (item.priceCents / 100).toFixed(2), priceCurrency: "USD" } } : {}),
  });
  const foodItems = (items: Parameters<typeof schemaItem>[0][]) => items.filter(item => item.itemType !== "merchandise").map(schemaItem);
  const sections = selected?.categories.map(category => ({ "@type": "MenuSection", name: category.name, hasMenuItem: foodItems(category.items) })) ?? [];
  if (selected?.uncategorizedItems?.length) sections.push({ "@type": "MenuSection", name: "Other items", hasMenuItem: foodItems(selected.uncategorizedItems) });
  const indexable = Boolean(selected) && data?.parentIndexable === true;
  return {
    canonicalPath, title, description, noIndex: !indexable,
    schema: selected && indexable ? { "@context": "https://schema.org", "@type": "Menu", name: name ? `${name} — ${selected.name}` : selected.name, hasMenuSection: sections } : undefined,
  };
}

export function publicMenuSelectionPath(restaurantId: string, search: string, menuId: string) {
  const params = new URLSearchParams(search);
  params.set("menuId", menuId);
  return `/menu/${encodeURIComponent(restaurantId)}?${params.toString()}`;
}
