import { expect, test, type Page } from "@playwright/test";

const EVENT_ID = "aed6e382-3ed7-40dc-a04f-f81bb3388871";
const EVENT_PATH = `/event/neighborhood-food-night--${EVENT_ID}`;
const trucks = [
  { id: "truck-one", name: "First Kitchen", cuisineType: "Tacos", path: "/truck/first-kitchen--truck-one" },
  { id: "truck-two", name: "Second Kitchen", cuisineType: "Barbecue", path: "/truck/second-kitchen--truck-two" },
  { id: "truck-three", name: "Third Kitchen", cuisineType: "Dessert", path: "/truck/third-kitchen--truck-three" },
];
const event = {
  id: EVENT_ID,
  title: "Neighborhood Food Night",
  description: "Three kitchens, one evening.\nBring your neighbors.",
  date: "2026-11-07T00:00:00.000Z",
  startTime: "17:00", endTime: "21:00", timeZone: "America/Chicago",
  status: "open", eventType: "community", requiresPayment: false, ended: false,
  host: { id: "host-one", name: "Neighborhood Square", address: "123 Public Street",
    city: "Pensacola", state: "FL", path: "/location/neighborhood-square--host-one" },
  truck: trucks[0], trucks,
};

async function installReadOnlyEvent(page: Page, overrides: Record<string, unknown> = {}) {
  const writes: string[] = [];
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // The real page and local assets run; every API reply is a disposable fixture.
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, contentType: "application/json", body: "{}" });
    }
    const path = decodeURIComponent(url.pathname);
    const body = path === `/api/public/events/${EVENT_ID}` ? { ...event, ...overrides }
      : path === "/api/auth/user" ? null
      : {};
    return route.fulfill({ status: path === "/api/auth/user" ? 401 : 200,
      contentType: "application/json", body: JSON.stringify(body) });
  });
  return writes;
}

for (const timezoneId of ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Pacific/Honolulu"]) {
  test.describe(`event date in ${timezoneId}`, () => {
    test.use({ timezoneId });
    test("keeps the venue day and venue-local hours", async ({ page }) => {
      const writes = await installReadOnlyEvent(page);
      await page.goto(EVENT_PATH);
      await expect(page.getByRole("heading", { name: event.title, exact: true })).toBeVisible();
      await expect(page.locator('time[datetime="2026-11-07"]')).toHaveText("Saturday, November 7, 2026");
      await expect(page.getByText("17:00–21:00 (America/Chicago)", { exact: false })).toBeVisible();
      expect(writes).toEqual([]);
    });
  });
}

test("a visitor can read the details, find every booked truck and open a later truck", async ({ page }) => {
  const writes = await installReadOnlyEvent(page);
  await page.goto(EVENT_PATH);
  await expect(page.getByText(event.description, { exact: true })).toBeVisible();
  await expect(page.getByText("123 Public Street", { exact: true })).toBeVisible();
  await expect(page.getByText("Pensacola, FL", { exact: true })).toBeVisible();
  const roster = page.getByRole("region", { name: "Booked trucks" });
  await expect(roster.getByRole("listitem")).toHaveCount(3);
  for (const truck of trucks) {
    await expect(roster.getByRole("link", { name: truck.name, exact: true })).toHaveAttribute("href", truck.path);
    await expect(roster.getByText(truck.cuisineType, { exact: false })).toBeVisible();
  }
  const directions = new URL((await page.getByRole("link", { name: "Get directions", exact: true }).getAttribute("href"))!);
  expect(directions.origin).toBe("https://www.google.com");
  expect(directions.searchParams.get("destination")).toBe("123 Public Street, Pensacola, FL");
  await expect(page.getByRole("link", { name: "Choose Parking Pass slots", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("event-detail.png"), fullPage: true });
  const laterTruck = trucks[1];
  await page.route(`**${laterTruck.path}`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture truck destination</title>" }));
  await roster.getByRole("link", { name: laterTruck.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${laterTruck.path}$`));
  expect(writes).toEqual([]);
});

test("a hidden street address stays hidden and does not offer directions", async ({ page }) => {
  const writes = await installReadOnlyEvent(page, { host: { ...event.host, address: null } });
  await page.goto(EVENT_PATH);
  await expect(page.getByRole("heading", { name: event.title, exact: true })).toBeVisible();
  await expect(page.getByText("Pensacola, FL", { exact: true })).toBeVisible();
  await expect(page.getByText("123 Public Street", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Get directions", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("an explicitly empty confirmed roster does not revive the legacy first truck", async ({ page }) => {
  await installReadOnlyEvent(page, { trucks: [] });
  await page.goto(EVENT_PATH);
  const roster = page.getByRole("region", { name: "Booked trucks" });
  await expect(roster.getByText("No truck booked yet.", { exact: true })).toBeVisible();
  await expect(roster.getByRole("link")).toHaveCount(0);
});

test("a legacy event without the roster still exposes its booked truck", async ({ page }) => {
  await installReadOnlyEvent(page, { trucks: undefined });
  await page.goto(EVENT_PATH);
  const roster = page.getByRole("region", { name: "Booked trucks" });
  await expect(roster.getByRole("link", { name: trucks[0].name, exact: true })).toBeVisible();
  await expect(roster.getByRole("listitem")).toHaveCount(1);
});

test("blank descriptions are omitted and invalid dates never invent a new day", async ({ page }) => {
  await installReadOnlyEvent(page, { date: "2026-02-30T00:00:00.000Z", description: "  \n  " });
  await page.goto(EVENT_PATH);
  await expect(page.getByRole("heading", { name: event.title, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "About this event", exact: true })).toHaveCount(0);
  await expect(page.locator("time")).toHaveCount(0);
  await expect(page.getByText("Invalid Date", { exact: false })).toHaveCount(0);
});
