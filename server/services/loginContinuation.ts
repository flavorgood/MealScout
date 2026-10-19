import { and, count, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
import {
  menuItems,
  restaurants,
  truckManualSchedules,
  verificationRequests,
} from "@shared/schema";
import { getBusinessVerificationState } from "./businessVerificationState";

type LinkState = "linked" | "not_attached";

export type BusinessAccessSummary = {
  linkState?: LinkState;
  guidance?: string | null;
  restaurantCount?: number;
  primaryRestaurantId?: string | null;
} | null;

export type NextRequiredStep =
  | "account_onboarding"
  | "business_setup"
  | "profile"
  | "profile_visual"
  | "verification"
  | "menu"
  | "schedule"
  | "complete";

export type LoginContinuationSummary = {
  accountOnboardingComplete: boolean;
  businessOnboardingRequired: boolean;
  businessAccessSummary: BusinessAccessSummary;
  primaryBusinessId: string | null;
  profileComplete: boolean;
  verificationRequired: boolean;
  emailVerified: boolean;
  businessInsuranceSubmitted: boolean;
  menuRequired: boolean;
  menuItemCount: number;
  scheduleRequired: boolean;
  hasSchedule: boolean;
  nextRequiredStep: NextRequiredStep;
  continuationPath: string | null;
  reason: string | null;
};

const isBusinessUserType = (value: unknown) => {
  const type = String(value || "").toLowerCase();
  return type === "food_truck" || type === "restaurant_owner";
};

const isFoodTruckBusinessType = (value: unknown, isFoodTruckFlag: unknown) => {
  return (
    String(value || "").toLowerCase() === "food_truck" || isFoodTruckFlag === true
  );
};

const hasText = (value: unknown) => String(value || "").trim().length > 0;

export async function resolveUserContinuation(params: {
  user: any;
  businessAccessSummary: BusinessAccessSummary;
}): Promise<LoginContinuationSummary> {
  const { user, businessAccessSummary } = params;

  const emailVerified = user?.emailVerified === true;
  const accountOnboardingComplete =
    user?.mustResetPassword !== true &&
    hasText(user?.firstName) &&
    hasText(user?.lastName) &&
    hasText(user?.phone);

  const isBusinessUser = isBusinessUserType(user?.userType);
  const primaryBusinessId = String(
    businessAccessSummary?.primaryRestaurantId || "",
  ).trim() || null;
  const businessOnboardingRequired =
    isBusinessUser && businessAccessSummary?.linkState === "not_attached";

  let profileComplete = true;
  let profileVisualComplete = true;
  let verificationRequired = false;
  let businessInsuranceSubmitted = false;
  let menuItemCount = 0;
  let menuRequired = false;
  let scheduleRequired = false;
  let hasSchedule = true;
  let nextRequiredStep: NextRequiredStep = "complete";
  let continuationPath: string | null = null;
  let reason: string | null = null;

  if (!accountOnboardingComplete) {
    return {
      accountOnboardingComplete,
      businessOnboardingRequired,
      businessAccessSummary,
      primaryBusinessId,
      profileComplete: false,
      verificationRequired: false,
      emailVerified,
      businessInsuranceSubmitted: false,
      menuRequired: false,
      menuItemCount: 0,
      scheduleRequired: false,
      hasSchedule: false,
      nextRequiredStep: "account_onboarding",
      continuationPath: "/account-setup",
      reason: "Your account setup is incomplete.",
    };
  }

  if (businessOnboardingRequired) {
    const normalizedUserType = String(user?.userType || "").toLowerCase();
    return {
      accountOnboardingComplete,
      businessOnboardingRequired,
      businessAccessSummary,
      primaryBusinessId,
      profileComplete: false,
      verificationRequired: false,
      emailVerified,
      businessInsuranceSubmitted: false,
      menuRequired: false,
      menuItemCount: 0,
      scheduleRequired: false,
      hasSchedule: false,
      nextRequiredStep: "business_setup",
      continuationPath:
        normalizedUserType === "food_truck"
          ? "/restaurant-signup?businessType=food_truck&source=auth&claim=1"
          : "/restaurant-signup?businessType=restaurant&source=auth&claim=1",
      reason: "Business account is not attached yet.",
    };
  }

  if (isBusinessUser && primaryBusinessId) {
    const [restaurantRow] = await db
      .select({
        id: restaurants.id,
        name: restaurants.name,
        address: restaurants.address,
        city: restaurants.city,
        state: restaurants.state,
        phone: restaurants.phone,
        cuisineType: restaurants.cuisineType,
        logoUrl: restaurants.logoUrl,
        coverImageUrl: restaurants.coverImageUrl,
        businessType: restaurants.businessType,
        isFoodTruck: restaurants.isFoodTruck,
        isVerified: restaurants.isVerified,
        isActive: restaurants.isActive,
        claimedFromImportId: restaurants.claimedFromImportId,
      })
      .from(restaurants)
      .where(eq(restaurants.id, primaryBusinessId))
      .limit(1);

    if (restaurantRow) {
      const requiresProfileFields = [
        restaurantRow.name,
        restaurantRow.city,
      ];
      const hasContact = hasText(restaurantRow.phone) || hasText(user?.email);
      const hasCuisine = hasText((restaurantRow as any)?.cuisineType);
      profileComplete =
        requiresProfileFields.every((value) => hasText(value)) &&
        hasContact &&
        hasCuisine;
      profileVisualComplete =
        hasText(restaurantRow.logoUrl) ||
        hasText(restaurantRow.coverImageUrl) ||
        hasText(user?.profileImageUrl);

      const [menuCountRow] = await db
        .select({ value: count(menuItems.id) })
        .from(menuItems)
        .where(eq(menuItems.restaurantId, primaryBusinessId));
      menuItemCount = Number(menuCountRow?.value || 0);
      menuRequired = menuItemCount <= 0;

      const [verificationRow] = await db
        .select({
          status: verificationRequests.status,
          documents: verificationRequests.documents,
          licenseNumber: verificationRequests.licenseNumber,
        })
        .from(verificationRequests)
        .where(eq(verificationRequests.restaurantId, primaryBusinessId))
        .orderBy(desc(verificationRequests.submittedAt))
        .limit(1);

      businessInsuranceSubmitted =
        hasText(verificationRow?.licenseNumber) ||
        (Array.isArray(verificationRow?.documents) &&
          verificationRow!.documents.length > 0);
      const verificationState = getBusinessVerificationState({
        isActive: restaurantRow.isActive,
        isVerified: restaurantRow.isVerified,
        insuranceVerified: restaurantRow.insuranceVerified,
        insuranceExpiresAt: restaurantRow.insuranceExpiresAt,
        emailVerified,
        businessInsuranceSubmitted,
        claimedFromImportId: restaurantRow.claimedFromImportId,
      });
      verificationRequired = !verificationState.isVerifiedForSetup;

      scheduleRequired = isFoodTruckBusinessType(
        restaurantRow.businessType,
        restaurantRow.isFoodTruck,
      );
      if (scheduleRequired) {
        const today = new Date();
        const [scheduleCountRow] = await db
          .select({ value: count(truckManualSchedules.id) })
          .from(truckManualSchedules)
          .where(
            and(
              eq(truckManualSchedules.truckId, primaryBusinessId),
              gte(truckManualSchedules.date, today),
            ),
          );
        hasSchedule = Number(scheduleCountRow?.value || 0) > 0;
      } else {
        hasSchedule = true;
      }
    }
  }

  if (isBusinessUser && !profileComplete) {
    nextRequiredStep = "profile";
    continuationPath = "/restaurant-owner-dashboard?setup=profile";
    reason = "Business profile is missing required basics.";
  } else if (isBusinessUser && !profileVisualComplete) {
    nextRequiredStep = "profile_visual";
    continuationPath = "/restaurant-owner-dashboard?setup=profile-media";
    reason =
      "Add a logo, profile photo, or banner so customers can recognize your business.";
  } else if (isBusinessUser && menuRequired) {
    nextRequiredStep = "menu";
    continuationPath = "/menu-builder";
    reason = "Add at least one menu item so customers can discover your business.";
  } else if (isBusinessUser && scheduleRequired && !hasSchedule) {
    nextRequiredStep = "schedule";
    continuationPath = "/restaurant-owner-dashboard?setup=schedule";
    reason = "Schedule and location setup is still required.";
  } else if (isBusinessUser && verificationRequired && !businessInsuranceSubmitted) {
    nextRequiredStep = "verification";
    continuationPath = "/restaurant-owner-dashboard?setup=verification";
    reason = "Verification details are still missing, but setup can continue.";
  }

  if (continuationPath && primaryBusinessId &&
      ["profile", "profile_visual", "menu", "schedule"].includes(nextRequiredStep)) {
    const target = new URL(continuationPath, "https://mealscout.local");
    target.searchParams.set("restaurantId", primaryBusinessId);
    continuationPath = `${target.pathname}${target.search}`;
  }

  return {
    accountOnboardingComplete,
    businessOnboardingRequired,
    businessAccessSummary,
    primaryBusinessId,
    profileComplete,
    verificationRequired,
    emailVerified,
    businessInsuranceSubmitted,
    menuRequired,
    menuItemCount,
    scheduleRequired,
    hasSchedule,
    nextRequiredStep,
    continuationPath,
    reason,
  };
}
