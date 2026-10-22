import { test, expect, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

// This suite renders the real app. Every API response is synthetic and every
// external request is blocked, including APIs hidden behind an absolute URL.
const FRONTEND = process.env.FRONTEND_URL ?? "http://127.0.0.1:5174";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(FRONTEND).hostname)) {
  throw new Error("Synthetic nearby search proof requires a loopback FRONTEND_URL");
}

const origin = { lat: 30, lng: -97 };
const insideRestaurant = {
  id: "synthetic-inside", name: "Taco fixture inside", cuisineType: "Mexican",
  address: "1 Synthetic Lane", city: "Fixture Town", state: "TX",
  latitude: "30.01", longitude: "-97", distance: 1.12, distanceMiles: 0.7,
};
const outsideRestaurant = {
  id: "synthetic-outside", name: "Taco fixture outside", cuisineType: "Mexican",
  address: "20 Synthetic Lane", city: "Fixture Town", state: "TX",
  latitude: "30.18", longitude: "-97", distance: 20.02, distanceMiles: 12.4,
};
const restaurantRows = [insideRestaurant, outsideRestaurant];
const dealRows = restaurantRows.map((restaurant) => ({
  id: `deal-${restaurant.id}`, title: `Taco fixture deal ${restaurant.id === insideRestaurant.id ? "inside" : "outside"}`,
  description: "Synthetic test offer only", restaurantId: restaurant.id,
  discountType: "percentage", discountValue: "10", minOrderAmount: "0",
  createdAt: "2026-01-01T00:00:00.000Z", endDate: "2099-01-01T00:00:00.000Z",
  isActive: true, restaurant,
}));
const menuRows = restaurantRows.map((restaurant) => ({
  id: `menu-${restaurant.id}`, name: `Taco fixture dish ${restaurant.id === insideRestaurant.id ? "inside" : "outside"}`,
  description: "Synthetic menu item", restaurantId: restaurant.id,
  restaurantName: restaurant.name, restaurantCity: restaurant.city,
  restaurantState: restaurant.state, priceCents: 700,
  distanceMiles: restaurant.distanceMiles,
}));

type Source = "unified" | "restaurants" | "menus" | "deals";
type Scenario = {
  empty?: boolean;
  fail?: Source[];
  malformed?: Source[];
  menuGate?: Promise<void>;
  deniedLocation?: boolean;
};
type RequestRecord = { method: string; pathname: string; params: Record<string, string> };
type Proof = { requests: RequestRecord[]; unexpectedApi: string[]; blockedExternal: string[] };
const proofs = new WeakMap<Page, Proof>();

test.use({ serviceWorkers: "block" });

async function installSyntheticApi(page: Page, scenario: Scenario = {}) {
  page.setDefaultTimeout(10_000);
  const proof: Proof = { requests: [], unexpectedApi: [], blockedExternal: [] };
  proofs.set(page, proof);
  await page.routeWebSocket("**/*", (socket) => {
    proof.blockedExternal.push(`WebSocket blocked: ${socket.url()}`);
    socket.close();
  });
  await page.addInitScript(({ denied, coordinates }) => {
    localStorage.setItem("mealscout:discovery-radius-km", "12");
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(success: (position: unknown) => void, error?: (reason: unknown) => void) {
          if (denied) error?.({ code: 1, message: "Synthetic permission denied" });
          else success({ coords: { latitude: coordinates.lat, longitude: coordinates.lng, accuracy: 1 } });
        },
      },
    });
  }, { denied: !!scenario.deniedLocation, coordinates: origin });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!loopback) {
      proof.blockedExternal.push(url.origin + url.pathname);
      if (url.pathname.startsWith("/api/")) proof.unexpectedApi.push(request.method() + " " + request.url());
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/socket.io")) await route.abort("blockedbyclient");
      else await route.continue();
      return;
    }
    const params = Object.fromEntries(url.searchParams);
    proof.requests.push({ method: request.method(), pathname: url.pathname, params });
    const json = async (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const scopedRows = <T>(rows: T[]) => {
      const radius = Number(url.searchParams.get("radiusKm") ?? url.searchParams.get("radius"));
      const scoped = url.searchParams.get("lat") === "30" && url.searchParams.get("lng") === "-97" && radius > 0;
      return scenario.empty ? [] : scoped && radius < 20 ? rows.slice(0, 1) : rows;
    };
    const source: Source | undefined = url.pathname === "/api/search" ? "unified"
      : url.pathname === "/api/restaurants/search" ? "restaurants"
      : url.pathname === "/api/menus/local-items" ? "menus"
      : url.pathname === "/api/deals/search" ? "deals" : undefined;
    if (source) {
      if (source === "menus" && scenario.menuGate) await scenario.menuGate;
      if (scenario.fail?.includes(source)) return json({ message: "Synthetic source unavailable" }, 503);
      if (scenario.malformed?.includes(source)) return json({ results: "Synthetic malformed response" });
      if (source === "unified") return json({
        deals: scenario.empty ? [] : dealRows,
        restaurants: scenario.empty ? [] : restaurantRows,
        parkingPassHosts: [], videos: [], events: [],
      });
      if (source === "restaurants") return json(scopedRows(restaurantRows));
      if (source === "menus") return json({ items: scopedRows(menuRows) });
      return json(scopedRows(dealRows));
    }
    if (url.pathname === "/api/auth/user") return json(null, 401);
    if (url.pathname === "/api/deals/featured" || url.pathname.startsWith("/api/deals/nearby/") ||
      url.pathname === "/api/hosts" || url.pathname === "/api/search/trending" ||
      url.pathname === "/api/search/suggestions" || url.pathname.startsWith("/api/search/suggestions/") ||
      url.pathname === "/api/map/place-autocomplete") return json([]);
    if (url.pathname === "/api/discovery/cities") return json([]);
    if (url.pathname === "/api/location/search") return json([{ lat: "30", lon: "-97", display_name: "Synthetic Fixture Town, TX" }]);
    if (url.pathname === "/api/telemetry/track" || url.pathname === "/api/search/track" ||
      url.pathname === "/api/menus/local-items/engagement") return json({ ok: true });
    proof.unexpectedApi.push(request.method() + " " + request.url());
    return json({ message: "Unexpected API blocked by synthetic proof" }, 599);
  });
  return proof;
}

async function localSearch(page: Page) {
  await page.goto(`${FRONTEND}/search`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("button-search-quick-location").click();
  await expect(page.locator('[aria-label="Search radius"]').getByRole("slider")).toBeVisible();
  await page.getByTestId("input-smart-search").fill("taco");
  await page.getByTestId("button-search").click();
  await expect(page.getByTestId("card-restaurant-synthetic-inside")).toBeVisible();
  await expect(page.getByTestId("card-menu-item-menu-synthetic-inside")).toBeVisible();
}

async function captureProof(page: Page, info: TestInfo) {
  const proof = proofs.get(page);
  if (!proof) return;
  const slug = `${info.project.name}-${info.title}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const directory = process.env.SYNTHETIC_EVIDENCE_DIR ?? info.outputDir;
  await fs.mkdir(directory, { recursive: true });
  const screenshot = path.join(directory, `${slug}.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  const evidence = path.join(directory, `${slug}.json`);
  await fs.writeFile(evidence, JSON.stringify({ title: info.title, project: info.project.name,
    status: info.status, revision: process.env.SYNTHETIC_REVISION ?? "unspecified", screenshot,
    renderedApp: await page.getByRole("heading", { name: "Search", exact: true }).count(),
    url: page.url(), syntheticOnly: true, ...proof }, null, 2));
  await info.attach("synthetic-request-evidence", { path: evidence, contentType: "application/json" });
  expect(proof.unexpectedApi, "Every API must have an explicit synthetic response").toEqual([]);
}

test.afterEach(async ({ page }, info) => captureProof(page, info));

test.describe("Synthetic nearby search scope", () => {
  test("local radius bounds restaurants menu items and deals, then wider search is explicit", async ({ page }) => {
    const proof = await installSyntheticApi(page);
    await localSearch(page);
    await expect(page.getByText("Taco fixture deal inside", { exact: true })).toBeVisible();
    await expect(page.getByTestId("card-restaurant-synthetic-outside")).toHaveCount(0);
    await expect(page.getByTestId("card-menu-item-menu-synthetic-outside")).toHaveCount(0);
    await expect(page.getByText("Taco fixture deal outside", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("search-scope")).toContainText(/near|radius|mi/i);
    for (const endpoint of ["/api/restaurants/search", "/api/menus/local-items", "/api/deals/search"]) {
      await expect.poll(() => proof.requests.some((request) => request.pathname === endpoint &&
        request.params.lat === "30" && request.params.lng === "-97" &&
        (request.params.radiusKm === "12" || request.params.radius === "12"))).toBeTruthy();
    }
    await page.getByTestId("button-search-wider").click();
    await expect(page.getByTestId("card-restaurant-synthetic-outside")).toBeVisible();
    await expect(page.getByText("Taco fixture deal outside", { exact: true })).toBeVisible();
    await expect(page.getByTestId("search-scope")).toContainText(/wider|all|anywhere/i);
  });

  test("radius changes refetch all local buckets without restoring broad results", async ({ page }) => {
    const proof = await installSyntheticApi(page);
    await localSearch(page);
    await page.locator('[aria-label="Search radius"]').getByRole("slider").focus();
    await page.keyboard.press("End");
    for (const endpoint of ["/api/restaurants/search", "/api/menus/local-items", "/api/deals/search"]) {
      await expect.poll(() => proof.requests.some((request) => request.pathname === endpoint &&
        (request.params.radiusKm === "40" || request.params.radius === "40"))).toBeTruthy();
    }
    await expect(page.getByTestId("card-restaurant-synthetic-outside")).toBeVisible();
    await expect(page.getByTestId("card-menu-item-menu-synthetic-outside")).toBeVisible();
    await expect(page.getByText("Taco fixture deal outside", { exact: true })).toBeVisible();
  });

  test("denied GPS has a manual location fallback that scopes the existing query", async ({ page }) => {
    const proof = await installSyntheticApi(page, { deniedLocation: true });
    await page.goto(`${FRONTEND}/search`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("button-search-quick-location").click();
    await expect(page.getByText(/Unable to get your location/)).toBeVisible();
    await page.getByTestId("input-smart-search").fill("taco");
    await page.getByTestId("button-search").click();
    await page.getByTestId("input-search-location").fill("Synthetic Fixture Town");
    await page.getByTestId("button-search-location").click();
    await page.getByTestId("button-location-choice-0").click();
    await expect(page.getByTestId("search-scope")).toContainText(/Synthetic Fixture Town/);
    await expect(page.getByTestId("card-restaurant-synthetic-inside")).toBeVisible();
    await expect(page.getByTestId("card-restaurant-synthetic-outside")).toHaveCount(0);
    await expect.poll(() => proof.requests.some((request) => request.pathname === "/api/deals/search" && request.params.lat === "30")).toBeTruthy();
    await expect(page.getByTestId("input-smart-search")).toHaveValue("taco");
  });

  test("successful results stay usable while menu source is delayed and restaurant source fails", async ({ page }) => {
    let releaseMenus!: () => void;
    const menuGate = new Promise<void>((resolve) => { releaseMenus = resolve; });
    await installSyntheticApi(page, { fail: ["restaurants"], menuGate });
    try {
      await page.goto(`${FRONTEND}/search?q=taco`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Taco fixture deal inside", { exact: true })).toBeVisible();
      await expect(page.getByTestId("search-loading-sources")).toBeVisible();
      await expect(page.getByTestId("search-source-errors")).toContainText(/restaurant/i);
      await expect(page.getByRole("heading", { name: "No matches found", exact: true })).toHaveCount(0);
    } finally { releaseMenus(); }
    await expect(page.getByTestId("card-menu-item-menu-synthetic-inside")).toBeVisible();
    await expect(page.getByTestId("search-loading-sources")).toHaveCount(0);
    await expect(page.getByTestId("button-retry-search")).toBeVisible();
  });

  test("empty success reports no matches with clear query recovery", async ({ page }) => {
    await installSyntheticApi(page, { empty: true });
    await page.goto(`${FRONTEND}/search?q=taco`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "No matches found", exact: true })).toBeVisible();
    await expect(page.getByTestId("search-source-errors")).toHaveCount(0);
    await page.getByTestId("button-clear-search").click();
    await expect(page.getByTestId("input-smart-search")).toHaveValue("");
    await expect(page).not.toHaveURL(/q=taco/);
  });

  test("total source outage is recoverable and never presented as no matches", async ({ page }) => {
    const proof = await installSyntheticApi(page, { fail: ["unified", "restaurants", "menus", "deals"] });
    await page.goto(`${FRONTEND}/search?q=taco`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("search-source-errors")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "No matches found", exact: true })).toHaveCount(0);
    const count = proof.requests.filter((request) => request.pathname === "/api/search").length;
    await page.getByTestId("button-retry-search").click();
    await expect.poll(() => proof.requests.filter((request) => request.pathname === "/api/search").length).toBeGreaterThan(count);
    await expect(page.getByTestId("input-smart-search")).toHaveValue("taco");
  });

  test("malformed source reports recovery without hiding valid matches", async ({ page }) => {
    await installSyntheticApi(page, { malformed: ["restaurants"] });
    await page.goto(`${FRONTEND}/search?q=taco`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("search-source-errors")).toContainText(/restaurant/i);
    await expect(page.getByText("Taco fixture deal inside", { exact: true })).toBeVisible();
    await expect(page.getByTestId("card-menu-item-menu-synthetic-inside")).toBeVisible();
    await expect(page.getByTestId("button-retry-search")).toBeVisible();
  });
});
