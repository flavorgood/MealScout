import { test, expect } from "@playwright/test";

const FRONTEND = process.env.FRONTEND_URL ?? "http://localhost:5174";
const USER_COORDS = { lat: 30.4213, lng: -87.2169 };

async function mockGuest(page: any) {
  await page.route("**/api/auth/user", async (route: any) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Unauthorized" }),
    });
  });
}

async function mockCustomer(page: any) {
  await page.addInitScript((coords) => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (success: any) => {
          success({
            coords: {
              latitude: coords.lat,
              longitude: coords.lng,
              accuracy: 20,
            },
          });
        },
      },
    });
  }, USER_COORDS);

  await page.route("**/api/auth/user", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "welcome-routing-user",
        email: "scout@example.test",
        firstName: "Scout",
        lastName: "Tester",
        userType: "customer",
        roles: [],
        emailVerified: true,
      }),
    });
  });
}

async function mockScoutFeeds(page: any) {
  await page.route("**/api/trucks/live?*", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ trucks: [] }),
    });
  });

  await page.route("**/api/deals/featured", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ deals: [] }),
    });
  });

  await page.route("**/api/deals/nearby/**", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/events/public", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [] }),
    });
  });

  await page.route("**/api/restaurants/subscribed/**", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/parking-pass", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
}

async function dismissBetaDialog(page: any) {
  const betaButton = page.getByRole("button", { name: /got it/i });
  if (await betaButton.isVisible().catch(() => false)) {
    await betaButton.click();
  }
}

test.describe("welcome and Scout routing law", () => {
  test("logged-out root shows Welcome, not Scout map UI", async ({ page }) => {
    await mockGuest(page);

    await page.goto(`${FRONTEND}/`, { waitUntil: "domcontentloaded" });
    await dismissBetaDialog(page);

    await expect(page.getByTestId("welcome-landing")).toBeVisible();
    // The welcome page dropped its logo mark (commit 34454aa3, "Remove welcome
    // logo"); the document title is the remaining accessible brand signal.
    await expect(page).toHaveTitle(/mealscout/i);
    await expect(page.getByRole("link", { name: /^sign up$/i })).toHaveAttribute(
      "href",
      "/customer-signup",
    );
    await expect(page.getByRole("link", { name: /^log in$/i })).toBeVisible();
    await expect(page.getByText("Follow The Flavor")).toBeVisible();
    await expect(page.getByTestId("scout-map-container")).toHaveCount(0);
  });

  test("welcome business signup allows a private draft before explicit account creation", async ({ page }) => {
    await mockGuest(page);
    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
        /^\/api\/(?:auth|owner|restaurants)(?:\/|$)/.test(path)
      ) writes.push(path);
    });

    await page.goto(`${FRONTEND}/`, { waitUntil: "domcontentloaded" });
    await dismissBetaDialog(page);
    await page.getByRole("link", { name: /^sign up$/i }).click();

    // "/signup" was retired in commit 650582c1 ("Clean up legacy page
    // routes"); the role picker now lives directly on /customer-signup.
    await expect(page).toHaveURL(/\/customer-signup(?:[?#].*)?$/);
    await expect(page.getByTestId("button-signup-flow-food_truck")).toBeVisible();
    await expect(page.getByTestId("button-signup-flow-private_chef")).toBeVisible();
    await page.getByTestId("button-signup-flow-private_chef").click();
    await expect(page).toHaveURL(/\/restaurant-signup\?.*businessType=private_chef/);
    await expect(page.getByTestId("guest-business-draft")).toBeVisible();
    await expect(page.locator("#guest-draft-businessType")).toHaveValue("private_chef");
    await expect(page.getByTestId("button-signup-toggle")).toHaveCount(0);
    await page.locator("#guest-draft-name").fill("Private Chef Preview");
    await expect(
      page.getByTestId("private-draft-preview").getByRole("heading", { name: "Private Chef Preview" }),
    ).toBeVisible();
    expect(writes).toEqual([]);
    await page.getByTestId("button-keep-guest-draft").click();
    await expect(page.getByTestId("button-signup-toggle")).toBeVisible();
    const kept = await page.evaluate(() => JSON.parse(
      window.localStorage.getItem("mealscout:restaurant-signup-draft") || "null",
    ));
    expect(kept).toMatchObject({ name: "Private Chef Preview", businessType: "private_chef" });
    expect(writes).toEqual([]);
  });

  test("event organizer choice creates an account before event setup", async ({ page }) => {
    await mockGuest(page);

    await page.goto(`${FRONTEND}/customer-signup`, { waitUntil: "domcontentloaded" });
    await dismissBetaDialog(page);
    await page.getByTestId("button-signup-flow-event_organizer").click();

    await expect(page).toHaveURL(/\/customer-signup\?role=event_coordinator/);
    await expect(page.getByTestId("input-event-name")).toBeVisible();
    await expect(page.getByTestId("button-login-submit")).toHaveCount(0);
  });

  test("logged-in root redirects to Scout", async ({ page }) => {
    await mockCustomer(page);
    await mockScoutFeeds(page);

    await page.goto(`${FRONTEND}/`, { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/scout(?:[?#].*)?$/);
    await expect(page.getByTestId("scout-map-container")).toBeVisible();
  });

  // Commit 159766bf restored these legacy aliases as explicit redirects so old
  // discovery links recover at the canonical Scout route instead of becoming
  // business-profile lookups.
  test("/explore redirects to Scout", async ({ page }) => {
    await mockCustomer(page);
    await mockScoutFeeds(page);

    await page.goto(`${FRONTEND}/explore`, { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/scout(?:[?#].*)?$/);
    await expect(page.getByTestId("scout-map-container")).toBeVisible();
    await expect(page.getByTestId("public-profile-not-found")).toHaveCount(0);
  });

  test("/explore-preview redirects to Scout", async ({ page }) => {
    await mockCustomer(page);
    await mockScoutFeeds(page);

    await page.goto(`${FRONTEND}/explore-preview`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page).toHaveURL(/\/scout(?:[?#].*)?$/);
    await expect(page.getByTestId("scout-map-container")).toBeVisible();
    await expect(page.getByTestId("public-profile-not-found")).toHaveCount(0);
  });

  test("Scout map stays embedded in Scout", async ({ page }) => {
    await mockCustomer(page);
    await mockScoutFeeds(page);

    await page.goto(`${FRONTEND}/scout`, { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/scout(?:[?#].*)?$/);
    await expect(page.getByTestId("scout-map-container")).toBeVisible();
    await expect(page.locator('[data-testid="scout-map-container"]')).toHaveCount(1);
  });
});
