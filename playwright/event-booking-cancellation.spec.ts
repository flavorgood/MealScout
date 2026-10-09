import { expect, test, type Page } from "@playwright/test";

const FRONTEND = process.env.FRONTEND_URL ?? "http://localhost:5174";
const EVENT_ID = "pp:4950164b-6246-444e-a293-aea953aba78a:2026-08-23";
const TRUCK_ID = "event-checkout-truck";
const EVENT_URL = `${FRONTEND}/event/future-paid-parking-pass--${EVENT_ID}`;

// Preserve the occurrence's calendar date even when local time is the prior day.
test.use({ timezoneId: "America/Los_Angeles" });

async function installEventApi(
  page: Page,
  options: { eventType?: string; businessType?: string; authorized?: boolean } = {},
) {
  const checkoutPosts: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (request.method() === "POST" && /\/book$/.test(path)) {
      checkoutPosts.push(path);
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ code: "unexpected_checkout_in_event_detail" }) });
    }
    let body: unknown = {};
    if (path === "/api/auth/user") {
      body = { id: "event-checkout-owner", email: "event-checkout@example.test",
        firstName: "Event", lastName: "Checkout", userType: "food_truck",
        roles: [], emailVerified: true, continuationPath: null };
    } else if (path === "/api/business-access/me") {
      body = { hasAnyAccess: true, restaurants: [{ id: TRUCK_ID,
        isOwner: options.authorized !== false,
        businessType: options.businessType ?? "food_truck",
        isFoodTruck: options.businessType === undefined,
        permissions: { manageParkingPass: options.authorized !== false } }] };
    } else if (path === `/api/public/events/${EVENT_ID}`) {
      body = { id: EVENT_ID, title: "Future paid Parking Pass",
        description: "A fixture paid parking occurrence.",
        date: "2026-08-23T00:00:00.000Z", startTime: "07:00", endTime: "21:00",
        status: "open", eventType: options.eventType ?? "parking_pass",
        requiresPayment: true, hostPriceCents: 2500, ended: false, noIndex: true,
        host: { id: "event-checkout-host", name: "Test Host", city: "Pensacola", state: "FL" },
        truck: null };
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return checkoutPosts;
}

test("paid event links to canonical Parking Pass with exact occurrence date and truck", async ({ page }) => {
  const checkoutPosts = await installEventApi(page);
  await page.goto(EVENT_URL, { waitUntil: "domcontentloaded" });
  const link = page.getByRole("link", { name: "Choose Parking Pass slots", exact: true });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  const target = new URL(href!, FRONTEND);
  expect(target.pathname).toBe("/parking-pass");
  expect(target.searchParams.get("pass")).toBe(EVENT_ID);
  expect(target.searchParams.get("date")).toBe("2026-08-23");
  expect(target.searchParams.get("truckId")).toBe(TRUCK_ID);
  await expect(page.getByRole("dialog", { name: "Book This Spot" })).toHaveCount(0);
  expect(checkoutPosts).toEqual([]);
  // Observe real link navigation without fabricating a payment or target-page feed.
  await page.route("**/parking-pass?**", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Canonical checkout destination</title>",
  }));
  await link.click();
  await expect(page).toHaveURL(target.toString());
  expect(checkoutPosts).toEqual([]);
});

for (const [name, options] of [
  ["unrelated paid event", { eventType: "community" }],
  ["non-truck account profile", { businessType: "restaurant" }],
  ["truck without parking authority", { authorized: false }],
] as const) {
  test(`${name} cannot open a parking checkout`, async ({ page }) => {
    const checkoutPosts = await installEventApi(page, options);
    await page.goto(EVENT_URL, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Future paid Parking Pass", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Choose Parking Pass slots", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Book This Spot" })).toHaveCount(0);
    expect(checkoutPosts).toEqual([]);
  });
}
