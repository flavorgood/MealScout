import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PROFILE_SALES_CUSTOMER_COPY,
  assertCustomerCopyHasNoAi,
  backfillProfileSalesAssistants,
  buildProfileSalesAssistantConfig,
  buildSalesInquiry,
  completeSalesInquiry,
  qualifySalesInquiry,
  quoteListedOffers,
  type ProfileSalesAssistantConfig,
  type ProfileSalesSource,
  type SalesAssistantRepository,
} from "../shared/profileSalesAssistant";

const truckSource = (): ProfileSalesSource => ({
  profileKind: "truck",
  profileId: "truck-1",
  displayName: "Harbor Tacos",
  offers: [
    {
      id: "item-taco",
      source: "menu_item",
      name: "Street Tacos",
      priceCents: 1200,
      menuId: "menu-1",
    },
    {
      id: "item-agua",
      source: "menu_item",
      name: "Agua Fresca",
      priceCents: null,
      menuId: "menu-1",
    },
    {
      id: "deal-1",
      source: "deal",
      name: "Lunch special",
      priceCents: 99999,
      listedTerms: "15% off",
    },
    {
      id: "yearly-special",
      source: "menu_item",
      name: "Yearly membership",
      priceCents: 50000,
      menuId: "menu-1",
    },
  ],
});

function memoryRepository(): SalesAssistantRepository & {
  rows: Map<string, ProfileSalesAssistantConfig>;
  inquiries: number;
} {
  const rows = new Map<string, ProfileSalesAssistantConfig>();
  const store = {
    rows,
    inquiries: 0,
    async findConfig(kind: string, id: string) {
      return rows.get(`${kind}:${id}`) || null;
    },
    async saveConfig(config: ProfileSalesAssistantConfig) {
      const key = `${config.profileKind}:${config.profileId}`;
      const status = rows.has(key) ? "existing" : "created";
      const previous = rows.get(key);
      rows.set(key, previous ? { ...config } : config);
      if (previous) rows.set(key, { ...previous, offers: config.offers });
      return status as "created" | "existing";
    },
    async writeInquiry() {
      store.inquiries += 1;
      return { id: `inquiry-${store.inquiries}` };
    },
  };
  return store;
}

test("defaults copy listed prices and drop yearly or invented deal prices", () => {
  const config = buildProfileSalesAssistantConfig(truckSource());
  assert.equal(config.solicitationGuard, true);
  assert.equal(config.marketingOptInDefault, false);
  assert.equal(config.quotePolicy, "listed_items_only");
  assert.deepEqual(
    config.offers.map((offer) => [offer.id, offer.priceCents, offer.listedTerms]),
    [
      ["item-taco", 1200, null],
      ["item-agua", null, null],
      ["deal-1", null, "15% off"],
    ],
  );
  const host = buildProfileSalesAssistantConfig({
    profileKind: "host",
    profileId: "host-1",
    displayName: "River Lot",
    bookingPreferences: {
      daysOfWeek: ["fri"],
      startTime: "11:00",
      endTime: "14:00",
    },
    offers: [
      {
        id: "host-1:lunch",
        source: "host_parking",
        name: "Lunch parking",
        priceCents: 2500,
        bookingPassId: "pass-1",
      },
      {
        id: "host-1:zero",
        source: "host_parking",
        name: "Daily parking",
        priceCents: 0,
      },
    ],
  });
  assert.equal(host.offers.length, 1);
  assert.equal(host.offers[0].priceCents, 2500);
  assert.equal(host.bookingPreferences?.startTime, "11:00");
  assert.equal(host.offers[0].fulfillment, "parking_pass_booking");
});

test("qualification completes on the existing pickup rail without a new charge", () => {
  const config = buildProfileSalesAssistantConfig(truckSource());
  const qualified = qualifySalesInquiry({
    profileKind: "truck",
    what: "street tacos",
    where: "pickup at the truck",
    when: "today at noon",
  });
  assert.equal(qualified.ok, true);
  if (!qualified.ok) return;
  const quote = quoteListedOffers(config, qualified.qualification);
  assert.equal(quote.pricesInvented, false);
  assert.deepEqual(
    quote.lines.map((line) => [line.offerId, line.priceCents]),
    [["item-taco", 1200]],
  );
  const completion = completeSalesInquiry({
    config,
    qualification: qualified.qualification,
    quote,
    customerName: "Ada Visitor",
  });
  assert.equal(completion.rail, "pickup_order");
  assert.equal(completion.existingPath, "/api/pickup-orders");
  assert.equal(completion.chargeCreatedHere, false);
  assert.equal(completion.pricesInvented, false);
  assert.deepEqual(completion.body?.items, [
    { menuItemId: "item-taco", quantity: 1 },
  ]);
  assert.equal("priceCents" in (completion.body || {}), false);
  const inquiry = buildSalesInquiry({
    config,
    qualification: qualified.qualification,
    quote,
    completion,
    marketingOptIn: false,
  });
  assert.equal(inquiry.marketingOptIn, false);
  assert.equal(inquiry.crm.written, true);
  assert.equal(inquiry.crm.outboundEmail, false);
  assert.equal(inquiry.crm.outboundSms, false);
});

test("catering requires headcount and does not invent a package price", () => {
  const config = buildProfileSalesAssistantConfig(truckSource());
  const missing = qualifySalesInquiry({
    profileKind: "truck",
    what: "catering street tacos",
    where: "office park",
    when: "Friday",
  });
  assert.equal(missing.ok, false);
  const qualified = qualifySalesInquiry({
    profileKind: "truck",
    what: "catering street tacos",
    where: "office park",
    when: "Friday",
    headcount: 40,
  });
  assert.equal(qualified.ok, true);
  if (!qualified.ok) return;
  const quote = quoteListedOffers(config, qualified.qualification);
  const completion = completeSalesInquiry({
    config,
    qualification: qualified.qualification,
    quote,
    customerName: "Ada Visitor",
  });
  assert.equal(completion.rail, "request");
  assert.equal(completion.existingPath, null);
  assert.equal(quote.lines[0].priceCents, 1200);
  assert.equal(completion.chargeCreatedHere, false);
});

test("no listed match opens a request without prices", () => {
  const config = buildProfileSalesAssistantConfig(truckSource());
  const qualified = qualifySalesInquiry({
    profileKind: "truck",
    what: "oysters and champagne",
    where: "dock",
    when: "Saturday",
  });
  assert.equal(qualified.ok, true);
  if (!qualified.ok) return;
  const quote = quoteListedOffers(config, qualified.qualification);
  assert.equal(quote.matched, false);
  const completion = completeSalesInquiry({
    config,
    qualification: qualified.qualification,
    quote,
  });
  assert.equal(completion.rail, "direct_connect_request");
  assert.equal(completion.body?.prices, null);
  assert.equal(completion.pricesInvented, false);
  assert.deepEqual(quote.lines, []);
});

test("host and vendor completion stay on existing rails without invented prices", () => {
  const host = buildProfileSalesAssistantConfig({
    profileKind: "host",
    profileId: "host-1",
    displayName: "River Lot",
    offers: [
      {
        id: "host-1:lunch",
        source: "host_parking",
        name: "Lunch parking",
        priceCents: 2500,
        bookingPassId: "pass-1",
      },
    ],
  });
  const hostAsk = qualifySalesInquiry({
    profileKind: "host",
    what: "lunch parking",
    where: "River Lot",
    when: "Friday",
  });
  assert.equal(hostAsk.ok, true);
  if (!hostAsk.ok) return;
  const hostQuote = quoteListedOffers(host, hostAsk.qualification);
  const hostCompletion = completeSalesInquiry({
    config: host,
    qualification: hostAsk.qualification,
    quote: hostQuote,
  });
  assert.equal(hostCompletion.rail, "parking_pass_booking");
  assert.equal(hostCompletion.existingPath, "/api/parking-pass/pass-1/book");
  assert.equal(hostCompletion.chargeCreatedHere, false);
  assert.equal(hostQuote.lines[0].priceCents, 2500);
  assert.equal("priceCents" in (hostCompletion.body || {}), false);

  const vendor = buildProfileSalesAssistantConfig({
    profileKind: "vendor",
    profileId: "vendor-1",
    displayName: "Gulf Produce",
    offers: [
      {
        id: "sku-lime",
        source: "supplier_product",
        name: "Limes",
        priceCents: 0,
      },
    ],
  });
  const vendorAsk = qualifySalesInquiry({
    profileKind: "vendor",
    what: "limes",
    where: "dock pickup",
    when: "tomorrow",
  });
  assert.equal(vendorAsk.ok, true);
  if (!vendorAsk.ok) return;
  const vendorQuote = quoteListedOffers(vendor, vendorAsk.qualification);
  const vendorCompletion = completeSalesInquiry({
    config: vendor,
    qualification: vendorAsk.qualification,
    quote: vendorQuote,
    customerName: "Ada Visitor",
  });
  assert.equal(vendorQuote.lines[0].priceCents, null);
  assert.equal(vendorCompletion.rail, "supplier_request");
  assert.equal(vendorCompletion.existingPath, "/api/supplier-requests");
  assert.equal(vendorCompletion.pricesInvented, false);
  assert.equal(JSON.stringify(vendorCompletion.body).includes("price"), false);
});

test("quotes ignore offers that are not on the profile", () => {
  const config = buildProfileSalesAssistantConfig(truckSource());
  const qualified = qualifySalesInquiry({
    profileKind: "truck",
    what: "lobster roll from another truck",
    where: "pier",
    when: "tonight",
  });
  assert.equal(qualified.ok, true);
  if (!qualified.ok) return;
  const quote = quoteListedOffers(config, qualified.qualification);
  assert.equal(quote.matched, false);
});

test("customer copy does not use the forbidden label", () => {
  assertCustomerCopyHasNoAi({ ...PROFILE_SALES_CUSTOMER_COPY });
  const customerSurfaces = [
    "client/src/components/public-profile/ProfileSalesAssistant.tsx",
    "shared/profileSalesAssistant.ts",
  ];
  const forbidden = /\bai\b/i;
  for (const path of customerSurfaces) {
    const source = readFileSync(path, "utf8");
    const copyBlock = source.includes("PROFILE_SALES_CUSTOMER_COPY")
      ? source.slice(source.indexOf("PROFILE_SALES_CUSTOMER_COPY"))
      : source;
    assert.equal(forbidden.test(copyBlock), false, path);
  }
});

test("backfill is idempotent and keeps one config per profile", async () => {
  const repository = memoryRepository();
  const sources = [
    truckSource(),
    {
      profileKind: "host" as const,
      profileId: "host-9",
      displayName: "Market Yard",
      offers: [],
    },
    {
      profileKind: "vendor" as const,
      profileId: "vendor-3",
      displayName: "Gulf Produce",
      offers: [
        {
          id: "sku-1",
          source: "supplier_product" as const,
          name: "Limes",
          priceCents: 400,
        },
      ],
    },
  ];
  const first = await backfillProfileSalesAssistants(sources, repository);
  const second = await backfillProfileSalesAssistants(sources, repository);
  assert.deepEqual(first, { created: 3, existing: 0, configs: 3 });
  assert.deepEqual(second, { created: 0, existing: 3, configs: 3 });
  assert.equal(repository.rows.size, 3);
  const refreshed = truckSource();
  refreshed.offers.push({
    id: "item-queso",
    source: "menu_item",
    name: "Queso",
    priceCents: 600,
    menuId: "menu-1",
  });
  await backfillProfileSalesAssistants([refreshed], repository);
  assert.equal(repository.rows.size, 3);
  assert.equal(
    repository.rows.get("truck:truck-1")?.offers.some((offer) => offer.id === "item-queso"),
    true,
  );
});

test("marketing consent stays off unless the visitor opts in", () => {
  const config = buildProfileSalesAssistantConfig(truckSource());
  const qualified = qualifySalesInquiry({
    profileKind: "truck",
    what: "street tacos",
    where: "pickup",
    when: "now",
  });
  assert.equal(qualified.ok, true);
  if (!qualified.ok) return;
  const quote = quoteListedOffers(config, qualified.qualification);
  const completion = completeSalesInquiry({
    config,
    qualification: qualified.qualification,
    quote,
    customerName: "Ada Visitor",
  });
  const omitted = buildSalesInquiry({
    config,
    qualification: qualified.qualification,
    quote,
    completion,
    marketingOptIn: undefined,
  });
  const opted = buildSalesInquiry({
    config,
    qualification: qualified.qualification,
    quote,
    completion,
    marketingOptIn: true,
  });
  assert.equal(omitted.marketingOptIn, false);
  assert.equal(opted.marketingOptIn, true);
});
