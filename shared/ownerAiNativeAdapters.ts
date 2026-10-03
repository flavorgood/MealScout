import { resolveStoredFoodBusinessType } from "./businessTypes";

export const OWNER_AI_NATIVE_ADAPTERS = ["restaurant_native", "truck_native", "bar_native", "caterer_native", "private_chef_native"] as const;
export function resolveOwnerAiNativeAdapter(row: { id: string; businessType?: unknown; isFoodTruck?: unknown }) {
  const foodType = resolveStoredFoodBusinessType(row);
  if (!foodType) throw new Error("UNSUPPORTED_ADAPTER");
  const profileType = foodType === "food_truck" ? "truck" : foodType;
  return { adapter: (profileType + "_native") as typeof OWNER_AI_NATIVE_ADAPTERS[number], profileType, profileId: row.id,
    profileStorage: "restaurants", menuStorage: "menus/menu_categories/menu_items",
    scheduleStorage: profileType === "truck" ? "truck_manual_schedules" : "food_business_appearances" } as const;
}
