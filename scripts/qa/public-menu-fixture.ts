export const SYNTHETIC_MENU_ID = "synthetic-menu-vendor";
export function publicMenuFixture() {
  const item = (id: string, name: string, priceCents: number | null) => ({ id, name, priceCents, description: "Synthetic menu proof only", itemType: "food", imageUrl: null,
    isAvailable: true, calories: null, dietaryTags: [], allergens: [], variants: [], modifiers: [] });
  const menu = (id: string, name: string, items: ReturnType<typeof item>[]) => ({ id, name, serviceType: id, isActive: true,
    acceptsCash: false, hidePlatformFee: false, pricesIncludeTax: false, orderingEnabled: false, orderingBlockingReasons: ["Online pickup ordering is not currently available"],
    paymentMethods: { card: false, cash: false }, categories: [{ id: "category-" + id, name: "Plates", description: null, items }],
    uncategorizedItems: [item("other-" + id, "Uncategorized synthetic side", null)] });
  return { parentIndexable: true, restaurantName: "Synthetic Native Kitchen", restaurantCity: "Synthetic City", cuisineType: "Synthetic cuisine", isFoodTruck: false, orderingEnabled: false,
    menus: [menu("lunch", "Lunch menu", [item("lunch-item", "Synthetic lunch plate", 825), item("unpriced", "Ask about this dish", null)]),
      menu("dinner", "Dinner menu", [item("dinner-item", "Synthetic dinner plate", 0)])] };
}
