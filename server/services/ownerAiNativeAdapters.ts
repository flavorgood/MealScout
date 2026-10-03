import { and, eq } from "drizzle-orm";
import { foodBusinessAppearances, truckManualSchedules } from "@shared/schema";
import { resolveOwnerAiNativeAdapter } from "@shared/ownerAiNativeAdapters";

export function nativeOwnerAiScheduleStorage(restaurant: any) {
  const binding = resolveOwnerAiNativeAdapter(restaurant);
  if (binding.profileType === "truck") return { binding, table: truckManualSchedules, idKey: "truckId", predicate: eq(truckManualSchedules.truckId, restaurant.id) };
  return { binding, table: foodBusinessAppearances, idKey: "restaurantId", predicate: and(eq(foodBusinessAppearances.restaurantId, restaurant.id), eq(foodBusinessAppearances.profileType, binding.profileType), eq(foodBusinessAppearances.ownerId, restaurant.ownerId)) };
}
