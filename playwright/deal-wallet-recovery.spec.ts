import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDealClaimHandler } from "../server/routes/dealClaimHandler";

// These are synthetic receipts and people. Every API request is handled below;
// the compiled application runs in Vite, with no backend or provider connection.
const FRONTEND = process.env.FRONTEND_URL ?? "http://127.0.0.1:5174";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(FRONTEND).hostname)) {
  throw new Error("Synthetic deal proof requires a loopback FRONTEND_URL");
}
const dealId = "synthetic-original-deal";
const otherDealId = "synthetic-other-deal";
const restaurantId = "synthetic-kitchen";
const claimId = "synthetic-receipt-001";
const walletPath = "/orders?view=deals";
const deal = {
  id: dealId, restaurantId, title: "Synthetic original lunch special",
  description: "Synthetic offer for isolated browser verification only.",
  dealType: "percentage", discountValue: "20", minOrderAmount: "10",
  imageUrl: "/images/category-fallback/craving-salad.jpg",
  startDate: "2020-01-01T00:00:00.000Z", endDate: "2099-12-31T23:59:59.000Z",
  startTime: "00:00", endTime: "23:59", isOngoing: true, isActive: true,
  perCustomerLimit: 1, currentUses: 0, totalUsesLimit: 100,
  restaurant: { id: restaurantId, name: "Synthetic Kitchen", cuisineType: "Salad", address: "100 Synthetic Lane", isActive: true },
};
const receipt = {
  id: claimId, dealId, claimedAt: "2026-10-22T10:00:00.000Z", usedAt: null,
  isUsed: false, orderAmount: null, dealTitle: deal.title, dealType: deal.dealType,
  discountValue: deal.discountValue, restaurantId, restaurantName: "Synthetic Kitchen",
  restaurantAddress: null, startDate: deal.startDate, endDate: deal.endDate,
  startTime: "00:00", endTime: "23:59", availableDuringBusinessHours: false,
  isOngoing: true, isActive: true, restaurantIsActive: true,
};
type ClaimMode = "ok" | "malformed" | "failed";
type FixtureState = {
  authenticated: boolean;
  userType?: string;
  userId?: string;
  offer?: Partial<typeof deal>;
  saved?: boolean;
  saveFailure?: boolean;
  saveWrites?: number;
  rows: Array<Record<string, unknown>>;
  claimMode: ClaimMode;
  walletFailure: boolean;
  walletMalformed: boolean;
  sessionExpired: boolean;
  initialClaimUnauthorized: boolean;
  initialFavoriteUnauthorized: boolean;
  nativeReplay: boolean;
  nativeResponses: Array<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }>;
  syntheticNotifications: number;
  unavailable: boolean;
  claimPosts: string[];
  requests: string[];
  unexpected: string[];
  blockedExternal: string[];
  pageErrors: string[];
};
const stateFor = (): FixtureState => ({
  authenticated: true, rows: [], claimMode: "ok", walletFailure: false, walletMalformed: false, sessionExpired: false, initialClaimUnauthorized: false, initialFavoriteUnauthorized: false, nativeReplay: false, nativeResponses: [], syntheticNotifications: 0,
  unavailable: false, claimPosts: [], requests: [], unexpected: [], blockedExternal: [], pageErrors: [],
});
const fixtureByPage = new WeakMap<Page, FixtureState>();

async function nativeClaimResponse(state: FixtureState) {
  // This is the production HTTP handler with a disposable in-memory adapter.
  // Its lifecycle import is type-only; no database or provider module executes.
  const handler = createDealClaimHandler({
    getDeal: async () => ({ ...deal, ...state.offer }),
    getRestaurant: async () => deal.restaurant,
    claimDealAtomic: async (requestedDeal, userId, limit) => {
      expect([requestedDeal, userId, limit]).toEqual([dealId, "synthetic-customer", state.offer?.perCustomerLimit || 1]);
      // A concurrent synthetic request can create a receipt after preflight.
      if (state.nativeReplay && state.rows.length === 0) state.rows.push({ ...receipt });
      const previous = state.rows.find((row) => row.dealId === requestedDeal && !row.isUsed && !row.usedAt);
      const saved = previous ?? { ...receipt };
      if (!previous) state.rows.push(saved);
      return { ok: true, replayed: Boolean(previous), claim: {
        id: String(saved.id), dealId: requestedDeal, userId,
        claimedAt: new Date(String(saved.claimedAt)), usedAt: null, isUsed: false, orderAmount: null,
      } };
    },
    getUserDealClaimsWithDetails: async () => state.rows,
  }, async () => { state.syntheticNotifications += 1; });
  let status = 200;
  let body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const response = {
    status(code: number) { status = code; return response; },
    setHeader(name: string, value: string) { headers[name] = value; return response; },
    json(payload: Record<string, unknown>) { body = payload; return response; },
  };
  await handler({ params: { dealId }, user: { id: "synthetic-customer" } }, response);
  expect(status).toBe(200);
  expect(headers["Cache-Control"]).toBe("no-store");
  const result = { status, body, headers };
  state.nativeResponses.push(result);
  return result;
}

async function isolate(page: Page, state: FixtureState) {
  fixtureByPage.set(page, state);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-10-22T12:00:00.000Z"));
  await page.routeWebSocket("**/*", (socket) => {
    state.blockedExternal.push(`WebSocket blocked: ${socket.url()}`);
    socket.close();
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!local) {
      state.blockedExternal.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    state.requests.push(key);
    if (key === "GET /api/auth/user") {
      const hasSession = state.authenticated && !state.sessionExpired;
      return route.fulfill({ status: hasSession ? 200 : 401, json: hasSession ? {
        id: state.userId || "synthetic-customer", email: "synthetic@example.invalid", userType: state.userType || "customer",
        firstName: "Synthetic", lastName: "Customer", profileComplete: true,
        accountOnboardingComplete: true, emailVerified: true, nextRequiredStep: "complete",
      } : { message: "Guest fixture" } });
    }
    if (key === "POST /api/auth/login") {
      const body = request.postDataJSON();
      expect(body.email).toBe("synthetic@example.invalid");
      state.authenticated = true;
      state.sessionExpired = false;
      return route.fulfill({ status: 200, json: { success: true } });
    }
    if (key === `GET /api/deals/${dealId}`) return route.fulfill({ status: state.unavailable ? 404 : 200, json: state.unavailable ? { message: "Special unavailable" } : { ...deal, ...state.offer } });
    if (key === `GET /api/restaurants/${restaurantId}`) return route.fulfill({ status: 200, json: { ...deal.restaurant, address: "100 Synthetic Lane", latitude: 30.42, longitude: -87.22 } });
    if (key === `GET /api/reviews/restaurant/${restaurantId}`) return route.fulfill({ status: 200, json: [] });
    if (key === "GET /api/deals/featured") return route.fulfill({ status: 200, json: [deal] });
    if (key === `GET /api/deals/restaurant/${restaurantId}`) return route.fulfill({ status: 200, json: [{ ...deal, id: otherDealId, title: "Synthetic second offer" }, deal] });
    if (key === "GET /api/deals/claimed") {
      if (state.initialClaimUnauthorized) state.sessionExpired = true;
      if (state.sessionExpired) return route.fulfill({ status: 401, json: { error: "Authentication required" } });
      return route.fulfill({ status: state.walletFailure ? 503 : 200, json: state.walletFailure ? { message: "Synthetic wallet outage" } : state.walletMalformed ? { claims: "untrusted response" } : state.rows });
    }
    if (key === `POST /api/deals/${dealId}/claim`) {
      state.claimPosts.push(dealId);
      if (state.claimMode === "failed") return route.fulfill({ status: 503, json: { message: "Synthetic claim unavailable. Try again." } });
      if (state.claimMode === "malformed") return route.fulfill({ status: 200, json: { success: true } });
      const result = await nativeClaimResponse(state);
      return route.fulfill({ status: result.status, json: result.body, headers: result.headers });
    }
    if (key === "GET /api/my/orders") return route.fulfill({ status: 200, json: { orders: [] } });
    if (key === "GET /api/business-access/me") return route.fulfill({ status: 200, json: { hasAnyAccess: false, restaurants: [] } });
    if (key === "GET /api/affiliate/tag") return route.fulfill({ status: 200, json: { tag: "", sharePath: "/scout" } });
    if (key === "POST /api/share/generate") return route.fulfill({ status: 503, json: { message: "Synthetic attribution outage" } });
    if (key === "GET /api/favorites/restaurants" && state.initialFavoriteUnauthorized) {
      state.sessionExpired = true;
      return route.fulfill({ status: 401, json: { error: "Authentication required" } });
    }
    if (key === "GET /api/favorites/restaurants") return route.fulfill({ status: 200, json: state.saved ? [{ id: "synthetic-favorite", restaurantId, restaurant: deal.restaurant }] : [] });
    if ([`POST /api/restaurants/${restaurantId}/favorite`, `DELETE /api/restaurants/${restaurantId}/favorite`].includes(key)) {
      state.saveWrites = (state.saveWrites || 0) + 1;
      if (state.saveFailure) return route.fulfill({ status: 503, json: { message: "Synthetic save outage" } });
      state.saved = request.method() === "POST";
      return route.fulfill({ status: 200, json: { success: true } });
    }
    if (["/api/hosts", "/api/following/restaurants", "/api/favorites/restaurants", "/api/recommendations/restaurants", "/api/geo-ads"].includes(url.pathname) && request.method() === "GET") return route.fulfill({ status: 200, json: [] });
    if (["/api/telemetry/track", "/api/analytics/track", "/api/funnel/events", "/api/funnel/track", "/api/geo/ping"].includes(url.pathname) && request.method() === "POST") return route.fulfill({ status: 200, json: { ok: true } });
    if (/^\/api\/deals\/[^/]+\/view$/.test(url.pathname) && request.method() === "POST") return route.fulfill({ status: 200, json: { ok: true } });
    state.unexpected.push(key);
    return route.fulfill({ status: 599, json: { message: `Unexpected API blocked: ${key}` } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("mealscout:welcome-dismissed", "true");
    // No external SDK is permitted. The receipt flow must work without sharing.
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (_success: unknown, failure: (error: unknown) => void) => failure({ code: 1, message: "Synthetic location denied" }) }, configurable: true });
  });
}

async function capture(page: Page, info: TestInfo) {
  const dir = process.env.SYNTHETIC_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const stem = `${info.project.name}-${info.title}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  await page.screenshot({ path: path.join(dir, `${stem}.png`), fullPage: true }).catch(() => {});
  writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({
    revision: process.env.SYNTHETIC_REVISION ?? "unspecified", url: page.url(),
    project: info.project.name, title: info.title, status: info.status,
    syntheticOnly: true, renderedApp: await page.locator("#root > *").count(),
    fixture: fixtureByPage.get(page), bodyText: (await page.locator("body").innerText().catch(() => "")).slice(0, 16000),
  }, null, 2));
}

async function captureStage(page: Page, name: string) {
  const dir = process.env.SYNTHETIC_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${test.info().project.name}-${name}.png`.replace(/ /g, "_")), fullPage: true });
}

async function openClaim(page: Page) {
  await page.goto(`${FRONTEND}/deal/${dealId}`);
  await expect(page.getByTestId("button-claim-deal")).toBeVisible();
  await page.getByTestId("button-claim-deal").click();
  await expect(confirmClaim(page)).toBeVisible();
}

function confirmClaim(page: Page) {
  return page.getByTestId("button-confirm-claim").or(page.getByRole("button", { name: "Claim Special", exact: true }));
}

test.describe("Synthetic rendered deal receipt and wallet recovery", () => {
  test.use({ actionTimeout: 8_000, navigationTimeout: 15_000, serviceWorkers: "block", timezoneId: "UTC" });
  test.setTimeout(35_000);
  test.afterEach(async ({ page }, info) => {
    await capture(page, info);
    const state = fixtureByPage.get(page);
    if (state) {
      expect(state.unexpected, "Every API must be explicitly synthetic").toEqual([]);
      expect(state.pageErrors, "The rendered application must have no uncaught errors").toEqual([]);
    }
  });

  test("guest detail login continues the original deal into one durable receipt", async ({ page }) => {
    const state = stateFor(); state.authenticated = false;
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deal/${dealId}`);
    const claim = page.getByTestId("button-claim-deal");
    await expect(claim).toBeEnabled();
    await claim.click();
    await expect(page).toHaveURL(/\/login\?/);
    const redirect = new URL(page.url()).searchParams.get("redirect");
    expect(redirect).toContain(`/deal/${dealId}`);
    await page.getByTestId("button-email-login").click();
    await page.getByTestId("input-email").fill("synthetic@example.invalid");
    await page.getByTestId("input-password").fill("SyntheticOnlyPassword123!");
    await page.getByTestId("button-login-submit").click();
    await expect(page).toHaveURL(new RegExp(`/deal/${dealId}`));
    // Returning to the original deal may reopen confirmation, but never POSTs automatically.
    expect(state.claimPosts).toEqual([]);
    const confirm = page.getByTestId("button-confirm-claim");
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(page.getByTestId("claim-receipt")).toContainText(claimId);
    await expect(page.getByTestId("claim-receipt")).toContainText(deal.title);
    await captureStage(page, "durable-claim-receipt");
    expect(state.claimPosts).toEqual([dealId]);
    await page.getByTestId("link-claimed-deals").click();
    await expect(page).toHaveURL(/\/orders\?view=deals/);
    await expect(page.getByTestId(`claimed-deal-${claimId}`)).toContainText(claimId);
    await page.reload();
    await expect(page.getByTestId(`claimed-deal-${claimId}`)).toContainText(deal.title);
    expect(state.rows).toHaveLength(1);
    expect(state.claimPosts).toHaveLength(1);
    expect(state.nativeResponses).toHaveLength(1);
    expect(state.nativeResponses[0].body.replayed).toBe(false);
    expect(state.syntheticNotifications).toBe(1);
  });

  test("detail footer actions are reachable in the actual application shell", async ({ page }) => {
    const state = stateFor();
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deal/${dealId}`);
    for (const id of ["button-claim-deal", "button-save-deal"]) {
      const button = page.getByTestId(id);
      await expect(button).toBeEnabled();
      await expect.poll(() => button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.height >= 44 && [[rect.width/2,2],[rect.width/2,rect.height-2],[2,rect.height/2],[rect.width-2,rect.height/2],[rect.width/2,rect.height/2]].every(([x,y]) => element.contains(document.elementFromPoint(rect.x+x,rect.y+y)));
      }), `${id}'s full 44px tap target must remain unobstructed`).toBe(true);
    }
    expect(state.claimPosts).toEqual([]);
  });

  test("used history allows a deliberate second claim within the offer allowance", async ({ page }) => {
    const state = stateFor(); state.offer = { perCustomerLimit: 2 };
    state.rows = [{ ...receipt, id: "synthetic-used-first", isUsed: true, usedAt: "2026-10-22T10:01:00.000Z" }];
    await isolate(page, state);
    await openClaim(page);
    expect(state.claimPosts).toEqual([]);
    await confirmClaim(page).click();
    await expect(page.getByTestId("claim-receipt")).toContainText(claimId);
    expect(state.rows).toHaveLength(2);
    expect(state.claimPosts).toEqual([dealId]);
    await page.reload();
    await page.getByTestId("button-claim-deal").click();
    await expect(page.getByTestId("claim-receipt")).toContainText(claimId);
    expect(state.claimPosts).toHaveLength(1);
  });

  test("exhausted used history opens the receipt without claiming again", async ({ page }) => {
    const state = stateFor(); state.rows = [{ ...receipt, isUsed: true, usedAt: "2026-10-22T10:01:00.000Z" }];
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deal/${dealId}`);
    await page.getByTestId("button-claim-deal").click();
    await expect(page.getByTestId("claim-receipt")).toContainText("Used");
    expect(state.claimPosts).toEqual([]);
  });

  test("merchant role follows its explicit consumer wallet link", async ({ page }) => {
    const state = stateFor(); state.userType = "restaurant_owner"; state.rows = [{ ...receipt }];
    await isolate(page, state);
    await page.goto(`${FRONTEND}${walletPath}`);
    await expect(page.getByTestId(`claimed-deal-${claimId}`)).toContainText(claimId);
    expect(state.claimPosts).toEqual([]);
  });

  test("fixed offer share preview retains actual terms without inventing a minimum", async ({ page }) => {
    const state = stateFor(); state.offer = { dealType: "fixed", discountValue: "4", minOrderAmount: undefined };
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deal/${dealId}`);
    await page.getByTestId("button-share").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("$4 OFF");
    await expect(dialog).toContainText("Minimum order not provided");
    await expect(dialog).not.toContainText("4% OFF");
    await expect(dialog).not.toContainText("$15");
    await expect(page.getByTestId("input-share-url")).toHaveValue(`${FRONTEND}/deal/${dealId}`);
  });

  test("card save failures recover into the native saved list and detail", async ({ page }) => {
    const state = stateFor(); state.saveFailure = true;
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deals`);
    const save = page.getByTestId(`button-save-place-${dealId}`);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("alert")).toContainText("Synthetic save outage");
    await expect(save).toHaveAttribute("aria-pressed", "false");
    state.saveFailure = false;
    await page.getByRole("button", { name: "Refresh saved places", exact: true }).click();
    await save.click();
    await expect(save).toHaveAttribute("aria-pressed", "true");
    await page.goto(`${FRONTEND}/favorites`);
    await expect(page.getByRole("heading", { name: "Synthetic Kitchen", exact: true })).toBeVisible();
    await page.goto(`${FRONTEND}/deal/${dealId}`);
    await expect(page.getByTestId("button-save-deal")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("button-save-deal").click();
    await expect(page.getByTestId("button-save-deal")).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => localStorage.getItem("mealscout_saved_deals"))).toBeNull();
    expect(state.saveWrites).toBe(3);
  });

  test("saved places do not reuse another signed-in account's cached list", async ({ page }) => {
    const state = stateFor(); state.saved = true;
    await isolate(page, state);
    await page.goto(`${FRONTEND}/favorites`);
    await expect(page.getByRole("heading", { name: "Synthetic Kitchen", exact: true })).toBeVisible();
    state.userId = "synthetic-other-customer"; state.saved = false;
    await page.evaluate(async () => {
      // Refresh the native auth source without reloading the application cache.
      const { queryClient } = await import(/* @vite-ignore */ "/src/lib/queryClient.ts");
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
    });
    await expect(page.getByRole("heading", { name: "Nothing saved yet", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Synthetic Kitchen", exact: true })).not.toBeVisible();
    expect(state.claimPosts).toEqual([]);
  });

  test("guest drawer preserves the selected offer through login", async ({ page }) => {
    const state = stateFor(); state.authenticated = false;
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deals`);
    await page.getByRole("button", { name: "View Special", exact: true }).click();
    await expect(page.getByTestId(`text-deal-title-${dealId}`)).toBeVisible();
    await page.getByTestId(`button-claim-deal-${dealId}`).click();
    await expect(page).toHaveURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get("redirect")).toContain(`/deal/${dealId}`);
    expect(state.claimPosts).toEqual([]);
  });

  test("retrying an already claimed offer recovers the same receipt", async ({ page }) => {
    const state = stateFor(); state.rows = [{ ...receipt }];
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deal/${dealId}`);
    await page.getByTestId("button-claim-deal").click();
    await expect(page.getByTestId("claim-receipt")).toContainText(claimId);
    expect(state.rows).toHaveLength(1);
    await page.goto(`${FRONTEND}${walletPath}`);
    await expect(page.getByTestId(`claimed-deal-${claimId}`)).toContainText(claimId);
    expect(state.claimPosts).toEqual([]);
  });

  test("native handler replay response renders one receipt without another notification", async ({ page }) => {
    const state = stateFor(); state.nativeReplay = true;
    await isolate(page, state);
    await openClaim(page);
    await confirmClaim(page).click();
    await expect(page.getByTestId("claim-receipt")).toContainText(claimId);
    expect(state.nativeResponses).toHaveLength(1);
    expect(state.nativeResponses[0].body.replayed).toBe(true);
    expect(state.syntheticNotifications).toBe(0);
    expect(state.rows).toHaveLength(1);
    expect(state.claimPosts).toEqual([dealId]);
  });

  test("wallet separates active used expired and unavailable receipts", async ({ page }) => {
    const state = stateFor();
    state.rows = [
      { ...receipt },
      { ...receipt, id: "synthetic-used", dealId: "used-offer", dealTitle: "Synthetic used offer", isUsed: true, usedAt: "2026-10-22T10:01:00.000Z" },
      { ...receipt, id: "synthetic-expired", dealId: "expired-offer", dealTitle: "Synthetic expired offer", isOngoing: false, endDate: "2020-01-01T00:00:00.000Z" },
      { ...receipt, id: "synthetic-unavailable", dealId: "removed-offer", dealTitle: "Synthetic removed offer", isActive: false, restaurantIsActive: false },
    ];
    await isolate(page, state);
    await page.goto(`${FRONTEND}${walletPath}`);
    for (const [id, label] of [[claimId, "Claimed"], ["synthetic-used", "Used"], ["synthetic-expired", "Expired"], ["synthetic-unavailable", "Unavailable"]]) {
      const card = page.getByTestId(`claimed-deal-${id}`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(label);
      await expect(card).toContainText(id);
    }
    await expect(page.getByTestId(`claimed-deal-${claimId}`)).toContainText(/check offer hours/i);
    expect(state.claimPosts).toEqual([]);
  });

  test("wallet failure has a retry and cannot masquerade as an empty wallet", async ({ page }) => {
    const state = stateFor(); state.rows = [{ ...receipt }]; state.walletFailure = true;
    await isolate(page, state);
    await page.goto(`${FRONTEND}${walletPath}`);
    await expect(page.getByText("Activity could not be loaded", { exact: true })).toBeVisible();
    await expect(page.getByText("No claimed deals yet", { exact: true })).not.toBeVisible();
    state.walletFailure = false;
    await page.getByTestId("button-retry-deals").click();
    await expect(page.getByTestId(`claimed-deal-${claimId}`)).toContainText(claimId);
  });

  test("malformed wallet is an error with recovery rather than an empty wallet", async ({ page }) => {
    const state = stateFor(); state.walletMalformed = true;
    await isolate(page, state);
    await page.goto(`${FRONTEND}${walletPath}`);
    await expect(page.getByText("Activity could not be loaded", { exact: true })).toBeVisible();
    await expect(page.getByText("No claimed deals yet", { exact: true })).not.toBeVisible();
    state.walletMalformed = false; state.rows = [{ ...receipt }];
    await page.getByTestId("button-retry-deals").click();
    await expect(page.getByTestId(`claimed-deal-${claimId}`)).toContainText(claimId);
  });

  test("expired session uses canonical auth error and preserves original claim intent", async ({ page }) => {
    const state = stateFor();
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deal/${dealId}?fixture=expired-session#offer`);
    await expect(page.getByTestId("button-claim-deal")).toBeVisible();
    // The detail status lookup succeeds; only the subsequent fresh preflight expires.
    await expect.poll(() => state.requests.filter((request) => request === "GET /api/deals/claimed").length).toBeGreaterThan(0);
    state.sessionExpired = true;
    await page.getByTestId("button-claim-deal").click();
    await expect(confirmClaim(page)).toBeVisible();
    await confirmClaim(page).click();
    await expect(page).toHaveURL(/\/login\?/);
    const redirect = new URL(new URL(page.url()).searchParams.get("redirect")!, FRONTEND);
    expect(redirect.pathname).toBe(`/deal/${dealId}`);
    expect(redirect.searchParams.get("fixture")).toBe("expired-session");
    expect(redirect.searchParams.get("intent")).toBe("claim");
    expect(redirect.hash).toBe("#offer");
    expect(state.claimPosts).toEqual([]);
  });

  for (const intent of ["claim", "save"] as const) {
    test(`initial ${intent} status 401 recovers through a fresh login document`, async ({ page }) => {
      const state = stateFor();
      if (intent === "claim") state.initialClaimUnauthorized = true;
      else state.initialFavoriteUnauthorized = true;
      await isolate(page, state);
      await page.goto(`${FRONTEND}/deal/${dealId}?fixture=initial-${intent}#offer`);
      const recovery = page.getByTestId(`link-login-${intent}`);
      await expect(recovery).toBeVisible();
      await recovery.click();
      await expect(page).toHaveURL(/\/login\?/);
      await expect(page.getByTestId("button-email-login")).toBeVisible();
      const redirect = new URL(new URL(page.url()).searchParams.get("redirect")!, FRONTEND);
      expect(redirect.pathname).toBe(`/deal/${dealId}`);
      expect(redirect.searchParams.get("fixture")).toBe(`initial-${intent}`);
      expect(redirect.searchParams.get("intent")).toBe(intent);
      expect(redirect.hash).toBe("#offer");
      expect(state.requests.filter((request) => request === "GET /api/auth/user").length).toBeGreaterThanOrEqual(2);
      expect(state.claimPosts).toEqual([]);
    });
  }

  for (const mode of ["malformed", "failed"] as const) {
    test(`${mode} claim API cannot report a receipt and allows explicit retry`, async ({ page }) => {
      const state = stateFor(); state.claimMode = mode;
      await isolate(page, state);
      await openClaim(page);
      await confirmClaim(page).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByTestId("claim-receipt")).not.toBeVisible();
      await expect(page.getByTestId("button-confirm-claim")).toBeEnabled();
      expect(state.rows).toHaveLength(0);
      state.claimMode = "ok";
      await page.getByTestId("button-confirm-claim").click();
      await expect(page.getByTestId("claim-receipt")).toContainText(claimId);
      expect(state.rows).toHaveLength(1);
    });
  }

  test("unavailable deal cannot initiate a claim", async ({ page }) => {
    const state = stateFor(); state.unavailable = true;
    await isolate(page, state);
    await page.goto(`${FRONTEND}/deal/${dealId}`);
    await expect(page.getByTestId("button-claim-deal")).not.toBeVisible();
    await expect(page.getByText(/special not found|special unavailable|could not.*load/i).first()).toBeVisible();
    expect(state.claimPosts).toEqual([]);
  });
});

