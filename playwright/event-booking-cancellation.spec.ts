import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

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

test.describe("real Parking Pass selection", () => {
test.use({ serviceWorkers: "block" });
test("real Parking Pass retains requested occurrence and truck after delayed reads and reload", async ({ page }) => {
  const { createTestWorld } = createRequire(import.meta.url)("../scripts/qa/test-world.cjs");
  const world = createTestWorld();
  const identity = { actorId: world.actors.truck.id };
  const decoyTruck = { ...world.truck, id: `${world.truck.id}-decoy`, name: "QA ONLY decoy truck" };
  const trucks = [decoyTruck, world.truck];
  const host = { id: "qa-requested-host", businessName: "QA ONLY requested location",
    address: "20 QA Target Street", city: "Test City", state: "LA", status: "active" };
  const listing = { id: EVENT_ID, date: "2026-08-23T00:00:00.000Z", startTime: "07:00", endTime: "21:00",
    status: "open", requiresPayment: true, paymentsEnabled: true, hostPriceCents: 2500,
    breakfastPriceCents: 1000, lunchPriceCents: 1000, dinnerPriceCents: 1000, dailyPriceCents: 2500,
    hardCapEnabled: true, spotCount: 2, availableSpotNumbers: [1, 2], bookings: [], host };
  const listings = [
    { ...listing, id: "pp:ffffffff-ffff-4444-aaaa-ffffffffffff:2026-08-23",
      host: { ...host, id: "qa-decoy-host", businessName: "QA ONLY decoy location", address: "10 QA Decoy Street" } },
    { ...listing, id: EVENT_ID.replace("2026-08-23", "2026-08-24"), date: "2026-08-24T00:00:00.000Z" },
    listing,
  ];
  const gate = () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    return { ready, release };
  };
  let truckGate = gate();
  let listingGate = gate();
  let truckReads = 0;
  let listingReads = 0;
  const reads: string[] = [];
  const writes: string[] = [];
  const origin = new URL(FRONTEND).origin;
  await page.clock.setFixedTime(new Date("2026-08-22T12:00:00.000Z"));
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    if (url.pathname.startsWith("/socket.io")) return route.abort();
    return route.fallback();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    const path = decodeURIComponent(url.pathname);
    const reply = (body: unknown, status = 200) => route.fulfill({ status,
      contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET") {
      if (request.method() === "POST" && path === "/api/telemetry/track") return reply({ success: true });
      writes.push(`${request.method()} ${path}`);
      return reply({ code: "unexpected_write_in_read_only_selection" }, 409);
    }
    reads.push(path);
    if (path === "/api/restaurants/my-restaurants") {
      truckReads++;
      await truckGate.ready;
      return reply(trucks);
    }
    if (path === "/api/parking-pass") {
      listingReads++;
      await listingGate.ready;
      return reply(listings);
    }
    if (path === "/api/business-access/me") return reply({ hasAnyAccess: true,
      permissions: { manageParkingPass: true, manageProfile: true },
      restaurants: trucks.map((truck) => ({ ...truck, isOwner: true,
        permissions: { manageParkingPass: true, manageProfile: true } })) });
    if (path === "/api/map/locations") return reply({ hostLocations: [], eventLocations: [], supplierLocations: [] });
    if (/\/schedule$/.test(path)) return reply({ schedule: [] });
    if (/\/(manual-schedule|parking-reports)$/.test(path)) return reply([]);
    if (/\/social-connections\/status$/.test(path)) return reply({ restaurantId: world.truck.id, connections: [] });
    const result = world.handle(identity, url.toString(), "GET");
    return reply(result.body, result.status);
  });
  const params = new URLSearchParams({ pass: EVENT_ID, date: "2026-08-23", truckId: world.truck.id });
  const target = `${FRONTEND}/parking-pass?${params}`;
  const targetCard = page.locator('[role="button"][aria-pressed]').filter({ hasText: host.businessName });
  for (let visit = 0; visit < 2; visit++) {
    const priorTruckReads = truckReads;
    const priorListingReads = listingReads;
    const selectedTruckRead = `/api/restaurants/${world.truck.id}/social-connections/status`;
    const priorSelectedTruckReads = reads.filter((path) => path === selectedTruckRead).length;
    truckGate = gate();
    listingGate = gate();
    if (visit === 0) await page.goto(target, { waitUntil: "domcontentloaded" });
    else await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => truckReads).toBeGreaterThan(priorTruckReads);
    truckGate.release();
    await expect.poll(() => listingReads).toBeGreaterThan(priorListingReads);
    await expect(targetCard).toHaveCount(0);
    listingGate.release();
    await expect(targetCard).toBeVisible();
    await expect(targetCard).toHaveAttribute("aria-pressed", "true");
    await expect(targetCard.locator("div, p").filter({ hasText: /^Sun, Aug 23$/ })).toBeVisible();
    await expect(targetCard).not.toContainText("Sat, Aug 22");
    await expect(targetCard.locator("select")).toHaveValue("2026-08-23");
    await expect.poll(() => reads.filter((path) => path === selectedTruckRead).length)
      .toBeGreaterThan(priorSelectedTruckReads);
    expect(reads.some((path) => path.includes(`/${decoyTruck.id}/`))).toBe(false);
    await expect(page.getByText("Parking Pass unavailable", { exact: true })).toHaveCount(0);
    const current = new URL(page.url());
    for (const [key, value] of params) expect(current.searchParams.get(key)).toBe(value);
    expect(writes).toEqual([]);
  }
});
});
