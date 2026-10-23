import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Actual routed App; every API and WebSocket is isolated from any service.
// Cancellation responses are synthetic. No billing provider is contacted.
const FRONTEND = process.env.FRONTEND_URL ?? "http://127.0.0.1:5174";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(FRONTEND).hostname)) {
  throw new Error("Synthetic profile-access proof requires loopback FRONTEND_URL");
}
const profilePath = "/subscribe?restaurantId=synthetic-business";
const actor = (id = "synthetic-owner") => ({ id, email: `${id}@example.invalid`, userType: "restaurant_owner", firstName: "Synthetic", lastName: "Owner", profileComplete: true, accountOnboardingComplete: true, emailVerified: true, nextRequiredStep: "complete" });
type Mode = "ok" | "failed" | "malformed";
type Fixture = {
  userId: string | null; legacy: boolean; statusMode: Mode; cancelMode: Mode;
  reads: number; writes: number; delayCancel: boolean; unexpectedWrites: string[];
};
const states = new WeakMap<Page, Fixture>();
async function isolate(page: Page, legacy = false) {
  const state: Fixture = { userId: "synthetic-owner", legacy, statusMode: "ok", cancelMode: "ok", reads: 0, writes: 0, delayCancel: false, unexpectedWrites: [] };
  states.set(page, state);
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(FRONTEND).origin) return route.abort("blockedbyclient");
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    if (key === "GET /api/auth/user") return route.fulfill({ status: state.userId ? 200 : 401, json: state.userId ? actor(state.userId) : { message: "Synthetic guest" } });
    if (key === "GET /api/subscription/status") {
      state.reads += 1;
      return route.fulfill({ status: state.statusMode === "failed" ? 503 : 200, json: state.statusMode === "failed" ? { message: "Synthetic status unavailable" } : state.statusMode === "malformed" ? { hasAccess: true } : { status: "active", hasAccess: true, legacySubscriptionPresent: state.legacy } });
    }
    if (key === "POST /api/subscription/cancel") {
      state.writes += 1;
      if (state.delayCancel) await new Promise(resolve => setTimeout(resolve, 500));
      if (state.cancelMode === "failed") return route.fulfill({ status: 502, json: { message: "Synthetic legacy cancellation unavailable. Please try again." } });
      if (state.cancelMode === "malformed") return route.fulfill({ status: 200, json: { status: "active", hasAccess: true } });
      const canceled = state.legacy; state.legacy = false;
      return route.fulfill({ status: 200, json: { status: "active", hasAccess: true, legacySubscriptionCanceled: canceled } });
    }
    if (key === "GET /api/business-access/me") return route.fulfill({ status: 200, json: { hasAnyAccess: true, restaurants: [] } });
    if (key === "GET /api/affiliate/tag") return route.fulfill({ status: 200, json: { tag: "", sharePath: "/scout" } });
    if (request.method() === "GET") return route.fulfill({ status: 200, json: [] });
    if (/^\/api\/(telemetry|analytics|funnel|geo)\//.test(url.pathname)) return route.fulfill({ status: 200, json: { ok: true } });
    state.unexpectedWrites.push(key);
    return route.fulfill({ status: 599, json: { message: `Unexpected API write blocked: ${key}` } });
  });
  await page.addInitScript(() => localStorage.setItem("mealscout:welcome-dismissed", "true"));
  return state;
}
const billing = (page: Page) => page.getByTestId("profile-legacy-billing");
async function open(page: Page) {
  await page.goto(FRONTEND + profilePath);
  await expect(page.getByTestId("button-open-complete-profile")).toBeVisible();
}
async function confirmStop(page: Page) {
  await billing(page).getByRole("button", { name: "Stop legacy subscription", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Confirm stop", exact: true }).click();
}

test.describe("Synthetic native Profile access and legacy billing", () => {
  test.use({ serviceWorkers: "block", actionTimeout: 10_000, navigationTimeout: 20_000 });
  test.setTimeout(40_000);
  test.afterEach(async ({ page }, info) => {
    const state = states.get(page);
    expect(state?.unexpectedWrites).toEqual([]);
    if (!process.env.SYNTHETIC_EVIDENCE_DIR) return;
    const dir = process.env.SYNTHETIC_EVIDENCE_DIR;
    mkdirSync(dir, { recursive: true });
    const stem = `${info.project.name}-${info.title}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    await page.screenshot({ path: path.join(dir, `${stem}.png`), fullPage: true });
    writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({ revision: process.env.SYNTHETIC_REVISION, url: page.url(), state, status: info.status, syntheticOnly: true }, null, 2));
  });

  test("free access remains usable with no legacy subscription and keeps business context", async ({ page }) => {
    const state = await isolate(page); await open(page);
    await expect(billing(page).getByText("No legacy subscription is linked to this account.", { exact: true })).toBeVisible();
    await expect(billing(page).getByRole("button", { name: "Stop legacy subscription", exact: true })).toHaveCount(0);
    expect(state.reads).toBe(1); expect(state.writes).toBe(0);
    await expect(page.getByRole("link", { name: "Return to workspace", exact: true })).toHaveAttribute("href", "/restaurant-owner-dashboard?restaurantId=synthetic-business");
    expect((await billing(page).getByRole("button", { name: "Refresh legacy billing status", exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByTestId("button-open-complete-profile").click();
    await expect(page).toHaveURL(/\/restaurant-owner-dashboard\?restaurantId=synthetic-business&setup=profile$/);
  });

  test("legacy subscription requires explicit confirmation and one acknowledged request", async ({ page }) => {
    const state = await isolate(page, true); state.delayCancel = true; await open(page);
    await expect(billing(page).getByText("Legacy subscription linked", { exact: true })).toBeVisible();
    expect(state.writes).toBe(0);
    await billing(page).getByRole("button", { name: "Stop legacy subscription", exact: true }).click();
    await page.getByRole("button", { name: "Keep it for now", exact: true }).click();
    expect(state.writes).toBe(0);
    await confirmStop(page);
    await expect(billing(page).getByRole("button", { name: "Stopping legacy subscription…", exact: true })).toBeDisabled();
    await expect(billing(page).getByText("Legacy subscription stopped. Your complete profile access remains active.", { exact: true })).toBeVisible();
    expect(state.writes).toBe(1);
    await expect(page.getByTestId("button-open-complete-profile")).toBeEnabled();
    await page.reload();
    await expect(billing(page).getByText("No legacy subscription is linked to this account.", { exact: true })).toBeVisible();
    expect(state.writes).toBe(1);
  });

  test("status failure and malformed status have a retry without blocking profile tools", async ({ page }) => {
    const state = await isolate(page, true); state.statusMode = "failed"; await open(page);
    await expect(billing(page).getByText("Legacy billing status is unavailable", { exact: true })).toBeVisible();
    expect(state.reads).toBe(1); expect(state.writes).toBe(0);
    await expect(page.getByTestId("button-open-complete-profile")).toBeEnabled();
    expect((await billing(page).getByRole("button", { name: "Retry billing status", exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    state.statusMode = "malformed";
    await billing(page).getByRole("button", { name: "Retry billing status", exact: true }).click();
    await expect(billing(page).getByText("Legacy billing status could not be verified. Please try again.", { exact: true })).toBeVisible();
    state.statusMode = "ok";
    await billing(page).getByRole("button", { name: "Retry billing status", exact: true }).click();
    await expect(billing(page).getByText("Legacy subscription linked", { exact: true })).toBeVisible();
    expect(state.reads).toBe(3); expect(state.writes).toBe(0);
  });

  test("cancellation failure and unacknowledged response never claim success and permit explicit retry", async ({ page }) => {
    const state = await isolate(page, true); state.cancelMode = "failed"; await open(page);
    await confirmStop(page);
    await expect(billing(page).getByRole("alert")).toContainText("Synthetic legacy cancellation unavailable");
    expect(state.writes).toBe(1);
    await expect(billing(page).getByText("Legacy subscription linked", { exact: true })).toBeVisible();
    state.cancelMode = "malformed"; await confirmStop(page);
    await expect(billing(page).getByRole("alert")).toContainText("did not confirm");
    expect(state.writes).toBe(2);
    state.cancelMode = "ok"; await confirmStop(page);
    await expect(billing(page).getByText("Legacy subscription stopped. Your complete profile access remains active.", { exact: true })).toBeVisible();
    expect(state.writes).toBe(3);
  });

  test("billing state and success messages do not carry into a different signed-in account", async ({ page }) => {
    const state = await isolate(page, true); await open(page); await confirmStop(page);
    await expect(billing(page).getByText("Legacy subscription stopped. Your complete profile access remains active.", { exact: true })).toBeVisible();
    state.userId = "synthetic-other-owner"; state.legacy = true;
    // Simulate the existing authentication cache handoff in the same App, so a
    // full document reload cannot hide an account-scoping regression.
    await page.evaluate(async user => {
      const modulePath = "/src/lib/queryClient.ts";
      const { queryClient } = await import(/* @vite-ignore */ modulePath);
      queryClient.setQueryData(["/api/auth/user"], user);
    }, actor(state.userId));
    await expect(billing(page).getByText("Legacy subscription linked", { exact: true })).toBeVisible();
    await expect(billing(page).getByText("Legacy subscription stopped. Your complete profile access remains active.", { exact: true })).toHaveCount(0);
    expect(state.reads).toBe(2); expect(state.writes).toBe(1);
  });

  test("guest management entry uses native login continuation without reading billing", async ({ page }) => {
    const state = await isolate(page); state.userId = null;
    await page.goto(FRONTEND + profilePath);
    const boundary = page.getByRole("region", { name: "Continue to this account page", exact: true });
    await expect(boundary).toBeVisible();
    await boundary.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get("redirect")).toBe(profilePath);
    expect(state.reads).toBe(0); expect(state.writes).toBe(0);
  });
});
