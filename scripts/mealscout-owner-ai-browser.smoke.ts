import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page, type Route } from "playwright";

const baseUrl = String(
  process.env.OWNER_AI_BROWSER_BASE_URL || "http://127.0.0.1:5174",
).replace(/\/+$/, "");
const outputDir = process.env.OWNER_AI_BROWSER_OUTPUT_DIR
  ? resolve(process.env.OWNER_AI_BROWSER_OUTPUT_DIR)
  : resolve(process.env.TEMP || ".", "mealscout-owner-ai-browser");
mkdirSync(outputDir, { recursive: true });

const restaurantId = "33333333-3333-4333-8333-333333333333";
const allPermissions = {
  manageDeals: true,
  manageParkingPass: true,
  viewAnalytics: true,
  manageProfile: true,
};
const user = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.com",
  firstName: "Riley",
  lastName: "Owner",
  userType: "food_truck",
  emailVerified: true,
  profileComplete: true,
  businessOnboardingRequired: false,
  nextRequiredStep: "complete",
};
const business = {
  id: restaurantId,
  ownerId: user.id,
  name: "Consent Kitchen",
  businessType: "food_truck",
  isFoodTruck: true,
  city: "Pensacola",
  state: "FL",
  description: "Owner-controlled food truck profile",
};
const socialConnections = [
  {
    platform: "facebook",
    connected: true,
    status: "active",
    displayName: "Consent Kitchen",
  },
  {
    platform: "instagram",
    connected: false,
    status: "not_connected",
    displayName: null,
  },
  {
    platform: "x",
    connected: false,
    status: "not_connected",
    displayName: null,
  },
];
const oauthCredential = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Favorite AI via MealScout login",
  keyPrefix: "msai_abc",
  scope:
    "owner_ai:context owner_ai:drafts:create owner_ai:drafts:read owner_ai:drafts:approve",
  connectionKind: "oauth",
  connectionExpiresAt: "2026-11-09T12:00:00.000Z",
  isActive: true,
  revokedAt: null,
  lastUsedAt: "2026-08-11T17:30:00.000Z",
  expiresAt: "2026-08-11T18:30:00.000Z",
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function installMockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/auth/user") return json(route, user);
    if (path === "/api/owner-ai/native-profiles") return json(route, []);
    if (path === `/api/owner-ai/restaurants/${restaurantId}/source-reviews`) return json(route, { reviews: [] });
    if (path === "/api/restaurants/my-restaurants") {
      return json(route, [business]);
    }
    if (path === "/api/business-access/me") {
      return json(route, {
        hasAnyAccess: true,
        permissions: allPermissions,
        restaurants: [
          { id: restaurantId, isOwner: true, permissions: allPermissions },
        ],
      });
    }
    if (path === "/api/settings/me") {
      return json(route, {
        accountSettings: {},
        publicProfileSettings: { showAddress: true, showContact: true },
        profileLinks: [],
      });
    }
    if (
      path ===
      `/api/owner-ai/restaurants/${restaurantId}/credentials`
    ) {
      return json(route, { credentials: [oauthCredential] });
    }
    if (
      path ===
      `/api/restaurants/${restaurantId}/social-connections/status`
    ) {
      return json(route, {
        connections: socialConnections,
        publishingConfig: {
          platforms: {
            facebook: { configured: true },
            instagram: { configured: true },
            x: { configured: true },
          },
        },
      });
    }
    if (path === `/api/owner-ai/restaurants/${restaurantId}/drafts`) {
      return json(route, { drafts: [] });
    }
    if (path === `/api/owner-ai/restaurants/${restaurantId}/context`) {
      return json(route, {
        restaurant: business,
        menus: [],
        schedules: [],
        deals: [],
        socialConnections,
        expectedVersions: {
          restaurant: "restaurant-v1",
          menus: "menus-v1",
          schedules: "schedules-v1",
          deals: "deals-v1",
        },
      });
    }
    if (path === "/api/owner-ai/oauth/authorize/prepare") {
      const hasSocial = !url.searchParams.get("client_id")?.includes("no-social");
      return json(route, {
        request: Object.fromEntries(url.searchParams),
        client: {
          clientId: url.searchParams.get("client_id"),
          clientName: "Favorite AI",
          clientUri: "https://ai.example",
          registrationKind: "client_metadata_document",
        },
        scopes: [
          "owner_ai:context",
          "owner_ai:drafts:create",
          "owner_ai:drafts:read",
          "owner_ai:drafts:approve",
        ],
        businesses: [
          {
            ...business,
            socialConnections: socialConnections.map((connection) => ({
              ...connection,
              connected:
                hasSocial && connection.platform === "facebook"
                  ? true
                  : false,
            })),
          },
        ],
      });
    }
    if (path === "/api/notifications/unread-count") {
      return json(route, { count: 0 });
    }
    return json(route, {});
  });
}

const oauthQuery = (clientId: string) => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://ai.example/oauth/callback",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    scope:
      "owner_ai:context owner_ai:drafts:create owner_ai:drafts:read owner_ai:drafts:approve",
    state: "browser-proof",
    resource: `${baseUrl}/api/owner-ai/mcp`,
  });
  return query.toString();
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await installMockApi(page);

  await page.goto(
    `${baseUrl}/owner-ai?restaurantId=${restaurantId}&src=settings&focus=all`,
    { waitUntil: "networkidle" },
  );
  await page.getByRole("heading", {
    name: "Reverse Osmosis",
  }).waitFor();
  await page.getByText("Complete the one-surface connection").waitFor();
  await page.getByText("Copy tool URL", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Ready", { exact: true }).count(),
    3,
    "MealScout, social publishing, and OAuth AI should all be ready",
  );
  assert.equal(
    await page.getByText("MealScout sign-in", { exact: true }).count(),
    1,
  );
  assert.ok(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <=
      (await page.evaluate(() => window.innerWidth)),
    "Owner AI desktop page must not overflow horizontally",
  );
  await page.screenshot({
    path: resolve(outputDir, "mealscout-owner-ai-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${baseUrl}/settings?tab=ai&restaurantId=${restaurantId}`,
    { waitUntil: "networkidle" },
  );
  await page.getByRole("heading", { name: "Use the AI you already have" }).waitFor();
  await page.getByText("Owner approves in chat", { exact: true }).waitFor();
  await page.getByText("Favorite AI", { exact: true }).waitFor();
  await page.getByText("1 active", { exact: true }).waitFor();
  assert.ok(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <=
      (await page.evaluate(() => window.innerWidth)),
    "AI settings mobile page must not overflow horizontally",
  );
  await page.screenshot({
    path: resolve(outputDir, "mealscout-ai-settings-mobile.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(
    `${baseUrl}/owner-ai/authorize?${oauthQuery("https://ai.example/client.json")}`,
    { waitUntil: "networkidle" },
  );
  await page.getByRole("heading", {
    name: "Sign in to your AI with MealScout",
  }).waitFor();
  await page.getByText("Approval is granted one exact revision at a time").waitFor();
  const connectButton = page.getByRole("button", { name: "Connect Favorite AI" });
  assert.equal(await connectButton.isEnabled(), true);
  await page.screenshot({
    path: resolve(outputDir, "mealscout-ai-oauth-consent.png"),
    fullPage: true,
  });

  await page.goto(
    `${baseUrl}/owner-ai/authorize?${oauthQuery("https://ai.example/no-social.json")}`,
    { waitUntil: "networkidle" },
  );
  await page.getByText(
    "Connect Facebook, Instagram, or X above to enable the AI sign-in.",
  ).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Connect Favorite AI" })
      .isDisabled(),
    true,
  );

  assert.deepEqual(browserErrors, [], `Browser errors: ${browserErrors.join(" | ")}`);
  await context.close();
  console.log(
    "mealscout-owner-ai-browser.smoke: PASS (desktop, mobile settings, OAuth ready, OAuth social gate)",
  );
} finally {
  await browser.close();
}
