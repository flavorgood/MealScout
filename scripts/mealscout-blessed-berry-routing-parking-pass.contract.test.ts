import { existsSync, readFileSync } from "node:fs";

const loginContinuationPath = "server/services/loginContinuation.ts";
const businessTeamAccessPath = "server/services/businessTeamAccess.ts";
const appPath = "client/src/App.tsx";
const parkingPassManagePath = "client/src/pages/parking-pass-manage.tsx";
const ownerDashboardPath = "client/src/pages/restaurant-owner-dashboard.tsx";
const routeMapPath = "MEALSCOUT_ROUTE_MAP.md";
const ownerDashboardMapPath = "MEALSCOUT_OWNER_DASHBOARD_DECOMPOSITION_MAP.md";

for (const path of [
  loginContinuationPath,
  businessTeamAccessPath,
  appPath,
  parkingPassManagePath,
  ownerDashboardPath,
  routeMapPath,
  ownerDashboardMapPath,
]) {
  if (!existsSync(path)) {
    throw new Error(`Required routing file is missing: ${path}`);
  }
}

const loginContinuation = readFileSync(loginContinuationPath, "utf8");
const businessTeamAccess = readFileSync(businessTeamAccessPath, "utf8");
const app = readFileSync(appPath, "utf8");
const parkingPassManage = readFileSync(parkingPassManagePath, "utf8");
const ownerDashboard = readFileSync(ownerDashboardPath, "utf8");
const routeMap = readFileSync(routeMapPath, "utf8");
const ownerDashboardMap = readFileSync(ownerDashboardMapPath, "utf8");

const scheduleBranchNeedle =
  "} else if (isBusinessUser && scheduleRequired && !hasSchedule) {";
const scheduleBranchIndex = loginContinuation.indexOf(scheduleBranchNeedle);
if (scheduleBranchIndex === -1) {
  throw new Error("Login continuation must keep the schedule-required branch inventoried");
}

const scheduleBranchEnd = loginContinuation.indexOf(
  "} else if (isBusinessUser && verificationRequired",
  scheduleBranchIndex,
);
const scheduleBranch = loginContinuation.slice(
  scheduleBranchIndex,
  scheduleBranchEnd === -1 ? undefined : scheduleBranchEnd,
);

if (!scheduleBranch.includes('nextRequiredStep = "schedule"')) {
  throw new Error("Schedule-required food truck continuation must still mark the schedule step");
}

if (
  !scheduleBranch.includes('continuationPath = "/restaurant-owner-dashboard?setup=schedule";') ||
  scheduleBranch.includes("buildOwnerAiHref")
) {
  throw new Error(
    "Schedule-required food truck continuation must enter the existing manual schedule workspace",
  );
}

if (scheduleBranch.includes('continuationPath = "/parking-pass-manage"')) {
  throw new Error(
    "Schedule-required food truck continuation must not route to host-oriented /parking-pass-manage",
  );
}

if (
  !loginContinuation.includes("isFoodTruckBusinessType(") ||
  !loginContinuation.includes("truckManualSchedules.truckId") ||
  !loginContinuation.includes("scheduleRequired = isFoodTruckBusinessType")
) {
  throw new Error("Food truck schedule requirement must still be derived from existing truck schedule logic");
}

if (
  !ownerDashboard.includes('setupMode === "schedule"') ||
  !ownerDashboard.includes("/restaurant-owner-dashboard?setup=schedule") ||
  !ownerDashboardMap.includes("/restaurant-owner-dashboard?setup=schedule")
) {
  throw new Error("Owner dashboard schedule setup route must remain present and documented");
}

if (
  !app.includes('/parking-pass-manage') ||
  !routeMap.includes("/parking-pass-manage") ||
  !parkingPassManage.includes('/api/restaurants/my-restaurants') ||
  !parkingPassManage.includes('/parking-pass?setup=host')
) {
  throw new Error(
    "Parking Pass management redirect must keep truck selection and host fallback behavior",
  );
}

if (
  !businessTeamAccess.includes("manageParkingPass: true") ||
  !businessTeamAccess.includes("isOwner: true") ||
  !businessTeamAccess.includes("ownerId: restaurants.ownerId")
) {
  throw new Error("Direct business ownership must still grant manageParkingPass access");
}

const forbiddenRoleSnippets = [
  '"diner"',
  '"business_owner"',
  '"parking_pass_owner"',
  '"blessed_berry"',
];
for (const snippet of forbiddenRoleSnippets) {
  if (loginContinuation.includes(snippet)) {
    throw new Error(`Login continuation must not introduce a new role or account type: ${snippet}`);
  }
}

const forbiddenMutationSnippets = [
  "stripe",
  "payout",
  "affiliate",
  "insuranceExpiresAt =",
  "insuranceVerified =",
  "createHost",
  "insertHost",
];
for (const snippet of forbiddenMutationSnippets) {
  if (scheduleBranch.toLowerCase().includes(snippet.toLowerCase())) {
    throw new Error(
      `Schedule continuation hotfix must not change pricing, payout, affiliate, host, or insurance logic: ${snippet}`,
    );
  }
}

console.log("mealscout-blessed-berry-routing-parking-pass.contract: PASS");
