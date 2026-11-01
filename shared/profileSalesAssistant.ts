/**
 * MealScout per-profile sales assistant.
 *
 * TradeScout PR 1028 (flavorgood/tradescoutAI, branch
 * cursor/profile-sales-agent-44b2) was not readable from this repo: the
 * GitHub repository and pull request return 404. This module is the
 * MealScout-local contract for the behavior that PR describes: one config
 * per public profile, quotes limited to that profile's listed items, and
 * completion handed to an existing MealScout rail.
 *
 * The host adapter relays native MealScout HTTP. It does not expose a shared
 * sales identity or a TradeScout sales endpoint, so this unit does not add
 * a parallel one. It also does not add a payment stack, outbound email or
 * SMS, or a yearly price.
 */

export const PROFILE_SALES_ASSISTANT_CONTRACT =
  "mealscout.profile-sales-assistant.v1" as const;

export const PROFILE_SALES_KINDS = ["truck", "host", "vendor"] as const;

export type ProfileSalesKind = (typeof PROFILE_SALES_KINDS)[number];

export type ListedOfferSource =
  | "menu_item"
  | "deal"
  | "supplier_product"
  | "host_parking";

export type SalesCompletionRail =
  | "pickup_order"
  | "parking_pass_booking"
  | "supplier_order"
  | "supplier_request"
  | "request"
  | "direct_connect_request";

export type ListedOffer = {
  id: string;
  source: ListedOfferSource;
  name: string;
  priceCents: number | null;
  listedTerms: string | null;
  fulfillment: SalesCompletionRail;
  bookingPassId: string | null;
  menuId: string | null;
};

export type ProfileSalesBookingPreferences = {
  daysOfWeek: string[];
  startTime: string | null;
  endTime: string | null;
};

export type ProfileSalesSourceOffer = {
  id: string;
  source: ListedOfferSource;
  name: string;
  priceCents?: number | null;
  listedTerms?: string | null;
  bookingPassId?: string | null;
  menuId?: string | null;
};

export type ProfileSalesSource = {
  profileKind: ProfileSalesKind;
  profileId: string;
  displayName: string;
  offers: ProfileSalesSourceOffer[];
  bookingPreferences?: ProfileSalesBookingPreferences | null;
};

export type ProfileSalesAssistantConfig = {
  contractVersion: typeof PROFILE_SALES_ASSISTANT_CONTRACT;
  profileKind: ProfileSalesKind;
  profileId: string;
  displayName: string;
  enabled: true;
  solicitationGuard: true;
  marketingOptInDefault: false;
  quotePolicy: "listed_items_only";
  offers: ListedOffer[];
  bookingPreferences: ProfileSalesBookingPreferences | null;
};

export type SalesIntent = "order" | "catering" | "event" | "booking" | "supply";

export type SalesQualification = {
  what: string;
  where: string;
  when: string;
  headcount: number | null;
  intent: SalesIntent;
};

export type SalesQuoteLine = {
  offerId: string;
  source: ListedOfferSource;
  name: string;
  priceCents: number | null;
  listedTerms: string | null;
  charge: false;
};

export type SalesQuote = {
  profileId: string;
  lines: SalesQuoteLine[];
  pricesInvented: false;
  matched: boolean;
};

export type SalesCompletion = {
  rail: SalesCompletionRail;
  existingPath: string | null;
  method: "POST" | null;
  executable: boolean;
  body: Record<string, unknown> | null;
  pricesInvented: false;
  chargeCreatedHere: false;
  customerMessage: string;
};

export type SalesInquiryRecord = {
  contractVersion: typeof PROFILE_SALES_ASSISTANT_CONTRACT;
  profileKind: ProfileSalesKind;
  profileId: string;
  qualification: SalesQualification;
  quote: SalesQuote;
  completion: SalesCompletion;
  marketingOptIn: false | true;
  crm: {
    written: true;
    store: "profile_sales_inquiries";
    outboundEmail: false;
    outboundSms: false;
  };
};

export const PROFILE_SALES_CUSTOMER_COPY = {
  title: "Ask this business",
  intro:
    "Tell this business what you need, where, and when. Any price shown is one this profile already lists.",
  whatLabel: "What do you need?",
  whereLabel: "Where?",
  whenLabel: "When?",
  headcountLabel: "How many people?",
  headcountHint: "Required for catering and events.",
  nameLabel: "Your name",
  emailLabel: "Email, if you want a reply on the existing request",
  phoneLabel: "Phone, optional",
  marketingOptIn:
    "This business may contact me about updates. Leave this off if you only want this request.",
  submit: "See what is listed",
  quoteHeading: "Listed on this profile",
  unpricedLabel: "Price not listed",
  listedPriceNote:
    "Listed price only. Checkout or booking on the existing page confirms the total before you pay.",
  noMatch:
    "Nothing listed on this profile matches that request. You can send it without a price.",
  requestSaved:
    "Your request is saved for this business. No price was added.",
  continueCheckout: "Continue to checkout",
  continueBooking: "Continue to booking",
  continueSupplierOrder: "Continue to the existing supplier order",
  sendRequest: "Send request",
  missingFields: "Add what you need, where, and when.",
  headcountRequired: "Add how many people this catering or event is for.",
  solicitationBlocked:
    "This request stays with this business and only uses what this profile lists.",
  unavailable: "This profile is not available for requests right now.",
} as const;

const YEARLY_PRICE = /\b(year|yearly|annual|annually)\b/i;
const CATERING_OR_EVENT =
  /\b(cater(?:ing|ed)?|event|party|wedding|banquet|headcount)\b/i;
const EVENT_ONLY = /\b(event|party|wedding|banquet)\b/i;
const BOOKING_WORDS =
  /\b(park(?:ing)?|spot|breakfast|lunch|dinner|daily|weekly|monthly)\b/i;

const STOP_WORDS = new Set([
  "for",
  "the",
  "and",
  "with",
  "a",
  "an",
  "of",
  "to",
  "on",
  "at",
  "my",
  "our",
  "this",
  "that",
  "need",
  "want",
]);

export function assertCustomerCopyHasNoAi(
  copy: Record<string, string>,
): void {
  const forbidden = /\bai\b/i;
  for (const [key, value] of Object.entries(copy)) {
    if (forbidden.test(key) || forbidden.test(value)) {
      throw new Error(`Customer copy contains a forbidden label: ${key}`);
    }
  }
}

assertCustomerCopyHasNoAi(PROFILE_SALES_CUSTOMER_COPY);

export function isProfileSalesKind(value: unknown): value is ProfileSalesKind {
  return (
    value === "truck" || value === "host" || value === "vendor"
  );
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function listedPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function fulfillmentFor(offer: {
  source: ListedOfferSource;
  priceCents: number | null;
  bookingPassId: string | null;
}): SalesCompletionRail {
  if (offer.source === "menu_item") {
    return offer.priceCents === null ? "request" : "pickup_order";
  }
  if (offer.source === "deal") return "request";
  if (offer.source === "supplier_product") {
    return offer.priceCents === null ? "supplier_request" : "supplier_order";
  }
  if (offer.priceCents !== null && offer.bookingPassId) {
    return "parking_pass_booking";
  }
  return "request";
}

export function buildProfileSalesAssistantConfig(
  source: ProfileSalesSource,
): ProfileSalesAssistantConfig {
  if (!isProfileSalesKind(source.profileKind)) {
    throw new Error("PROFILE_KIND_REQUIRED");
  }
  const profileId = clean(source.profileId);
  const displayName = clean(source.displayName);
  if (!profileId || !displayName) {
    throw new Error("PROFILE_IDENTITY_REQUIRED");
  }

  const offers: ListedOffer[] = [];
  const seen = new Set<string>();
  for (const raw of source.offers || []) {
    const id = clean(raw?.id);
    const name = clean(raw?.name);
    if (!id || !name || seen.has(id)) continue;
    if (YEARLY_PRICE.test(id) || YEARLY_PRICE.test(name)) continue;
    seen.add(id);
    const sourceKind = raw.source;
    let priceCents = listedPrice(raw.priceCents);
    let listedTerms = clean(raw.listedTerms) || null;
    if (sourceKind === "deal") {
      priceCents = null;
    }
    if (
      (sourceKind === "supplier_product" || sourceKind === "host_parking") &&
      priceCents === 0
    ) {
      priceCents = null;
    }
    if (sourceKind === "host_parking" && priceCents === null && !listedTerms) {
      continue;
    }
    const bookingPassId = clean(raw.bookingPassId) || null;
    offers.push({
      id,
      source: sourceKind,
      name,
      priceCents,
      listedTerms,
      bookingPassId,
      menuId: clean(raw.menuId) || null,
      fulfillment: fulfillmentFor({
        source: sourceKind,
        priceCents,
        bookingPassId,
      }),
    });
  }

  const preferences = source.bookingPreferences
    ? {
        daysOfWeek: (source.bookingPreferences.daysOfWeek || [])
          .map((day) => clean(day))
          .filter(Boolean),
        startTime: clean(source.bookingPreferences.startTime) || null,
        endTime: clean(source.bookingPreferences.endTime) || null,
      }
    : null;

  return {
    contractVersion: PROFILE_SALES_ASSISTANT_CONTRACT,
    profileKind: source.profileKind,
    profileId,
    displayName,
    enabled: true,
    solicitationGuard: true,
    marketingOptInDefault: false,
    quotePolicy: "listed_items_only",
    offers,
    bookingPreferences: preferences,
  };
}

export function detectSalesIntent(
  profileKind: ProfileSalesKind,
  what: string,
): SalesIntent {
  if (CATERING_OR_EVENT.test(what) && !EVENT_ONLY.test(what)) return "catering";
  if (EVENT_ONLY.test(what) || CATERING_OR_EVENT.test(what)) return "event";
  if (profileKind === "vendor") return "supply";
  if (profileKind === "host" || BOOKING_WORDS.test(what)) return "booking";
  return "order";
}

export function qualifySalesInquiry(input: {
  profileKind: ProfileSalesKind;
  what: unknown;
  where: unknown;
  when: unknown;
  headcount?: unknown;
}):
  | { ok: true; qualification: SalesQualification }
  | { ok: false; code: string; customerMessage: string } {
  const what = clean(input.what);
  const where = clean(input.where);
  const when = clean(input.when);
  if (!what || !where || !when) {
    return {
      ok: false,
      code: "QUALIFICATION_INCOMPLETE",
      customerMessage: PROFILE_SALES_CUSTOMER_COPY.missingFields,
    };
  }
  const intent = detectSalesIntent(input.profileKind, what);
  const headcountRequired = intent === "catering" || intent === "event";
  let headcount: number | null = null;
  if (input.headcount !== null && input.headcount !== undefined && input.headcount !== "") {
    const parsed = Number(input.headcount);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) {
      return {
        ok: false,
        code: "HEADCOUNT_INVALID",
        customerMessage: PROFILE_SALES_CUSTOMER_COPY.headcountRequired,
      };
    }
    headcount = parsed;
  }
  if (headcountRequired && headcount === null) {
    return {
      ok: false,
      code: "HEADCOUNT_REQUIRED",
      customerMessage: PROFILE_SALES_CUSTOMER_COPY.headcountRequired,
    };
  }
  return {
    ok: true,
    qualification: { what, where, when, headcount, intent },
  };
}

function offerMatches(what: string, offer: ListedOffer): boolean {
  const haystack = what.toLowerCase();
  const name = offer.name.toLowerCase();
  if (name.length >= 3 && haystack.includes(name)) return true;
  const wanted = new Set(tokens(what));
  if (wanted.size === 0) return false;
  return tokens(offer.name).some((token) => wanted.has(token));
}

export function quoteListedOffers(
  config: ProfileSalesAssistantConfig,
  qualification: SalesQualification,
): SalesQuote {
  if (
    config.solicitationGuard !== true ||
    config.quotePolicy !== "listed_items_only" ||
    config.marketingOptInDefault !== false
  ) {
    return {
      profileId: config.profileId,
      lines: [],
      pricesInvented: false,
      matched: false,
    };
  }
  const lines = config.offers
    .filter((offer) => offerMatches(qualification.what, offer))
    .map((offer) => ({
      offerId: offer.id,
      source: offer.source,
      name: offer.name,
      priceCents: offer.priceCents,
      listedTerms: offer.listedTerms,
      charge: false as const,
    }));
  return {
    profileId: config.profileId,
    lines,
    pricesInvented: false,
    matched: lines.length > 0,
  };
}

function offersForLines(
  config: ProfileSalesAssistantConfig,
  quote: SalesQuote,
): ListedOffer[] {
  const byId = new Map(config.offers.map((offer) => [offer.id, offer]));
  return quote.lines.map((line) => {
    const offer = byId.get(line.offerId);
    if (!offer || offer.priceCents !== line.priceCents) {
      throw new Error("QUOTE_LEFT_PROFILE");
    }
    return offer;
  });
}

function requestCompletion(message: string): SalesCompletion {
  return {
    rail: "request",
    existingPath: null,
    method: null,
    executable: true,
    body: null,
    pricesInvented: false,
    chargeCreatedHere: false,
    customerMessage: message,
  };
}

export function completeSalesInquiry(input: {
  config: ProfileSalesAssistantConfig;
  qualification: SalesQualification;
  quote: SalesQuote;
  customerName?: unknown;
}): SalesCompletion {
  if (input.config.solicitationGuard !== true) {
    return {
      rail: "request",
      existingPath: null,
      method: null,
      executable: false,
      body: null,
      pricesInvented: false,
      chargeCreatedHere: false,
      customerMessage: PROFILE_SALES_CUSTOMER_COPY.solicitationBlocked,
    };
  }
  if (!input.quote.matched) {
    return {
      rail: "direct_connect_request",
      existingPath: null,
      method: null,
      executable: true,
      body: {
        profileKind: input.config.profileKind,
        profileId: input.config.profileId,
        what: input.qualification.what,
        where: input.qualification.where,
        when: input.qualification.when,
        headcount: input.qualification.headcount,
        prices: null,
      },
      pricesInvented: false,
      chargeCreatedHere: false,
      customerMessage: PROFILE_SALES_CUSTOMER_COPY.noMatch,
    };
  }

  const offers = offersForLines(input.config, input.quote);
  const intent = input.qualification.intent;
  const referenceOnly = intent === "catering" || intent === "event";
  if (referenceOnly) {
    return requestCompletion(PROFILE_SALES_CUSTOMER_COPY.listedPriceNote);
  }

  const customerName = clean(input.customerName);
  if (
    input.config.profileKind === "truck" &&
    intent === "order" &&
    offers.every(
      (offer) =>
        offer.source === "menu_item" &&
        offer.priceCents !== null &&
        offer.menuId,
    )
  ) {
    const menuIds = new Set(offers.map((offer) => offer.menuId));
    if (menuIds.size === 1 && customerName) {
      return {
        rail: "pickup_order",
        existingPath: "/api/pickup-orders",
        method: "POST",
        executable: true,
        body: {
          restaurantId: input.config.profileId,
          menuId: offers[0].menuId,
          customerName,
          orderType: "pickup",
          paymentMethod: "card",
          items: offers.map((offer) => ({
            menuItemId: offer.id,
            quantity: 1,
          })),
        },
        pricesInvented: false,
        chargeCreatedHere: false,
        customerMessage: PROFILE_SALES_CUSTOMER_COPY.continueCheckout,
      };
    }
  }

  if (
    input.config.profileKind === "vendor" &&
    offers.every((offer) => offer.source === "supplier_product")
  ) {
    const priced = offers.every((offer) => offer.priceCents !== null);
    return {
      rail: priced ? "supplier_order" : "supplier_request",
      existingPath: priced ? "/api/supplier-orders" : "/api/supplier-requests",
      method: "POST",
      executable: priced && Boolean(customerName),
      body: {
        supplierId: input.config.profileId,
        items: offers.map((offer) => ({
          productId: offer.id,
          quantity: 1,
        })),
        ...(priced ? { paymentMethod: "offsite" as const } : {}),
      },
      pricesInvented: false,
      chargeCreatedHere: false,
      customerMessage:
        priced && customerName
          ? PROFILE_SALES_CUSTOMER_COPY.continueSupplierOrder
          : PROFILE_SALES_CUSTOMER_COPY.requestSaved,
    };
  }

  if (
    input.config.profileKind === "host" &&
    intent === "booking" &&
    offers.length === 1 &&
    offers[0].fulfillment === "parking_pass_booking" &&
    offers[0].bookingPassId
  ) {
    return {
      rail: "parking_pass_booking",
      existingPath: `/api/parking-pass/${offers[0].bookingPassId}/book`,
      method: "POST",
      executable: false,
      body: {
        passId: offers[0].bookingPassId,
        listedOfferId: offers[0].id,
      },
      pricesInvented: false,
      chargeCreatedHere: false,
      customerMessage: PROFILE_SALES_CUSTOMER_COPY.listedPriceNote,
    };
  }

  return requestCompletion(
    input.quote.lines.some((line) => line.priceCents !== null)
      ? PROFILE_SALES_CUSTOMER_COPY.listedPriceNote
      : PROFILE_SALES_CUSTOMER_COPY.requestSaved,
  );
}

export function marketingOptInFromVisitor(value: unknown): boolean {
  return value === true;
}

export function buildSalesInquiry(input: {
  config: ProfileSalesAssistantConfig;
  qualification: SalesQualification;
  quote: SalesQuote;
  completion: SalesCompletion;
  marketingOptIn: unknown;
}): SalesInquiryRecord {
  return {
    contractVersion: PROFILE_SALES_ASSISTANT_CONTRACT,
    profileKind: input.config.profileKind,
    profileId: input.config.profileId,
    qualification: input.qualification,
    quote: input.quote,
    completion: input.completion,
    marketingOptIn: marketingOptInFromVisitor(input.marketingOptIn),
    crm: {
      written: true,
      store: "profile_sales_inquiries",
      outboundEmail: false,
      outboundSms: false,
    },
  };
}

export type SalesAssistantRepository = {
  findConfig(
    profileKind: ProfileSalesKind,
    profileId: string,
  ): Promise<ProfileSalesAssistantConfig | null>;
  saveConfig(
    config: ProfileSalesAssistantConfig,
  ): Promise<"created" | "existing">;
  writeInquiry(record: SalesInquiryRecord): Promise<{ id: string }>;
};

export async function ensureProfileSalesConfig(
  source: ProfileSalesSource,
  repository: SalesAssistantRepository,
): Promise<{ status: "created" | "existing"; config: ProfileSalesAssistantConfig }> {
  const config = buildProfileSalesAssistantConfig(source);
  const status = await repository.saveConfig(config);
  return { status, config };
}

export async function backfillProfileSalesAssistants(
  sources: ProfileSalesSource[],
  repository: SalesAssistantRepository,
): Promise<{ created: number; existing: number; configs: number }> {
  let created = 0;
  let existing = 0;
  for (const source of sources) {
    const saved = await ensureProfileSalesConfig(source, repository);
    if (saved.status === "created") created += 1;
    else existing += 1;
  }
  return { created, existing, configs: created + existing };
}

export function publicSalesProjection(config: ProfileSalesAssistantConfig) {
  return {
    contractVersion: config.contractVersion,
    profileKind: config.profileKind,
    profileId: config.profileId,
    displayName: config.displayName,
    copy: PROFILE_SALES_CUSTOMER_COPY,
    offers: config.offers.map((offer) => ({
      id: offer.id,
      name: offer.name,
      priceCents: offer.priceCents,
      listedTerms: offer.listedTerms,
    })),
    marketingOptInDefault: false as const,
  };
}
