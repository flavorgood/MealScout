import { expect, test, type Page } from "@playwright/test";

const restaurantId = "ordering-truth-restaurant";

const menuPayload = {
  orderingEnabled: true,
  readiness: {
    orderingEnabled: true,
    blockingReasons: [],
    restaurantName: "Truth Table Kitchen",
    restaurantCity: "Pensacola",
    restaurantState: "FL",
    pickupAddressLabel: "101 Main St, Pensacola, FL",
    paymentMethods: { card: true, cash: false },
    checks: [],
  },
  restaurantName: "Truth Table Kitchen",
  restaurantCity: "Pensacola",
  isFoodTruck: false,
  cuisineType: "American",
  menus: [
    {
      id: "card-menu",
      name: "Card Menu",
      serviceType: "all",
      isActive: true,
      acceptsCash: false,
      hidePlatformFee: false,
      pricesIncludeTax: true,
      orderingEnabled: true,
      orderingBlockingReasons: [],
      paymentMethods: { card: true, cash: false },
      categories: [],
      uncategorizedItems: [],
    },
    {
      id: "cash-menu",
      name: "Cash Menu",
      serviceType: "all",
      isActive: true,
      acceptsCash: true,
      hidePlatformFee: true,
      pricesIncludeTax: true,
      orderingEnabled: true,
      orderingBlockingReasons: [],
      paymentMethods: { card: false, cash: true },
      categories: [],
      uncategorizedItems: [],
    },
  ],
};

const cartItem = (menuId: string, menuItemId: string) => ({
  menuId,
  restaurantId,
  menuItemId,
  itemName: menuId === "cash-menu" ? "Cash Lunch" : "Card Lunch",
  priceCents: 1299,
  quantity: 1,
  selectedVariantId: null,
  variantLabel: null,
  variantAddCents: 0,
  selectedModifierIds: [],
  modifierLabels: [],
  modifierAddCents: 0,
  lineTotalCents: 1299,
  specialInstructions: "",
});

async function mockOrderingApis(page: Page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `/api/menus/${restaurantId}`) {
      return route.fulfill({ status: 200, json: menuPayload });
    }
    if (pathname === `/api/restaurants/${restaurantId}/delivery`) {
      return route.fulfill({
        status: 200,
        json: {
          enabled: false,
          configured: false,
          availableNow: false,
          feeCents: 0,
          minimumOrderCents: 0,
          estimatedMinutes: 0,
          postalCodes: [],
        },
      });
    }
    if (pathname === "/api/auth/user") {
      return route.fulfill({ status: 401, json: { user: null } });
    }
    return route.fulfill({ status: 200, json: {} });
  });
}

test("checkout fails closed for a legacy cash-only menu", async ({ page }) => {
  await mockOrderingApis(page);
  await page.addInitScript(
    ({ cart }) => localStorage.setItem("mealscout_cart", JSON.stringify(cart)),
    { cart: [cartItem("cash-menu", "cash-item")] },
  );

  await page.goto(`/checkout/${restaurantId}`);

  await expect(
    page.getByText("Truth Table Kitchen", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("101 Main St, Pensacola, FL")).toBeVisible();
  await expect(page.getByLabel("Cash at Pickup")).toHaveCount(0);
  await expect(page.getByLabel("Card", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      "This business has not enabled a safe online payment method yet.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Online ordering is not available"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to secure payment" }),
  ).toBeDisabled();
  await expect(page.getByText("MealScout fee", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Card processing", { exact: true })).toHaveCount(
    0,
  );
  const totalRow = page.getByText("Total", { exact: true }).locator("..");
  await expect(totalRow.getByText("$12.99", { exact: true })).toBeVisible();
});

test("checkout blocks a legacy cart that mixes menus", async ({ page }) => {
  await mockOrderingApis(page);
  await page.addInitScript(
    ({ cart }) => localStorage.setItem("mealscout_cart", JSON.stringify(cart)),
    {
      cart: [
        cartItem("card-menu", "card-item"),
        cartItem("cash-menu", "cash-item"),
      ],
    },
  );

  await page.goto(`/checkout/${restaurantId}`);

  await expect(
    page.getByRole("heading", { name: "Choose one menu per order" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear saved cart" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pay|Place Order/ }),
  ).toHaveCount(0);
});

test("card checkout discloses server-priced fees and sends retry protection", async ({
  page,
}) => {
  await mockOrderingApis(page);
  let postedBody: any = null;
  await page.route("**/api/pickup-orders", async (route) => {
    postedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      json: { message: "Fixture stopped before creating an order" },
    });
  });
  // The final total is priced by the server totals preview before Continue
  // unlocks: subtotal $12.99 + $1.00 MealScout fee + $0.73 card processing.
  await page.route("**/api/pickup-orders/totals-preview", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        subtotalCents: 1299,
        mealscoutFeeCents: 100,
        processingFeeCents: 73,
        platformFeeCents: 173,
        totalCents: 1472,
        feePaidByBusiness: false,
      },
    });
  });
  await page.addInitScript(
    ({ cart }) => localStorage.setItem("mealscout_cart", JSON.stringify(cart)),
    { cart: [cartItem("card-menu", "card-item")] },
  );

  await page.goto(`/checkout/${restaurantId}`);

  await expect(page.getByLabel("Card", { exact: true })).toBeChecked();
  await expect(page.getByText("MealScout fee", { exact: true })).toBeVisible();
  await expect(page.getByText("$1.00", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Card processing", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$0.73", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Before card fees", { exact: true }),
  ).toHaveCount(0);
  const cardTotalRow = page.getByText("Total", { exact: true }).locator("..");
  await expect(
    cardTotalRow.getByText("$14.72", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Name *").fill("Fixture Customer");
  await page.getByLabel(/Email/).fill("fixture@example.com");
  await page.getByLabel("Pickup", { exact: true }).click();
  await page
    .getByRole("button", { name: "Continue to secure payment" })
    .click();

  await expect(
    page.getByText("Fixture stopped before creating an order"),
  ).toBeVisible();
  expect(postedBody.checkoutRequestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(postedBody.customerAccessToken).toMatch(/^[0-9a-f]{64}$/i);
  expect(postedBody.orderType).toBe("pickup");
});
