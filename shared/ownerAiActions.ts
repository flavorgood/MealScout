import { DateTime } from "luxon";
import { z } from "zod";

export const OWNER_AI_SCHEMA_VERSION = "1.0" as const;
export const OWNER_AI_PLATFORMS = ["facebook", "instagram", "x"] as const;
export const OWNER_AI_DRAFT_ONLY_SCOPES = [
  "owner_ai:context",
  "owner_ai:drafts:create",
  "owner_ai:drafts:read",
] as const;
export const OWNER_AI_CONNECTOR_SCOPES = [
  ...OWNER_AI_DRAFT_ONLY_SCOPES,
  "owner_ai:drafts:approve",
] as const;

const optionalHttpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Only http(s) URLs are allowed")
  .optional()
  .nullable();

const optionalSocialLinkUrl = z
  .string()
  .trim()
  .max(240)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Only http(s) URLs are allowed")
  .optional()
  .nullable();

const operationSchema = z.enum(["upsert", "archive"]).default("upsert");

export const ownerAiProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(5000).optional().nullable(),
    phone: z.string().trim().max(80).optional().nullable(),
    websiteUrl: optionalHttpUrl,
    cuisineType: z.string().trim().max(120).optional().nullable(),
    address: z.string().trim().max(500).optional(),
    city: z.string().trim().max(120).optional().nullable(),
    state: z.string().trim().max(80).optional().nullable(),
    instagramUrl: optionalHttpUrl,
    facebookPageUrl: optionalHttpUrl,
    xUrl: optionalHttpUrl,
    menuUrl: optionalHttpUrl,
    onlineOrderingUrl: optionalHttpUrl,
    deliveryUrl: optionalHttpUrl,
    doordashUrl: optionalHttpUrl,
    uberEatsUrl: optionalHttpUrl,
    toastUrl: optionalHttpUrl,
    squareUrl: optionalHttpUrl,
    chowNowUrl: optionalHttpUrl,
    grubhubUrl: optionalHttpUrl,
    cateringInquiryUrl: optionalHttpUrl,
    truckBookingInquiryUrl: optionalHttpUrl,
    logoUrl: optionalHttpUrl,
    coverImageUrl: optionalHttpUrl,
    gallery: z
      .array(
        z
          .object({
            id: z.string().trim().max(100).optional(),
            operation: operationSchema,
            url: optionalHttpUrl,
            category: z.string().trim().max(80).default("general"),
            altText: z.string().trim().max(300).optional().nullable(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

const timeSlotSchema = z
  .object({
    open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();

export const ownerAiHoursSchema = z
  .object({
    mon: z.array(timeSlotSchema).max(4).default([]),
    tue: z.array(timeSlotSchema).max(4).default([]),
    wed: z.array(timeSlotSchema).max(4).default([]),
    thu: z.array(timeSlotSchema).max(4).default([]),
    fri: z.array(timeSlotSchema).max(4).default([]),
    sat: z.array(timeSlotSchema).max(4).default([]),
    sun: z.array(timeSlotSchema).max(4).default([]),
  })
  .strict();

export const ownerAiMenuItemSchema = z
  .object({
    id: z.string().uuid().optional(),
    ref: z.string().trim().max(100).optional(),
    operation: operationSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(3000).optional().nullable(),
    priceCents: z.number().int().min(0).max(10_000_000).optional().nullable(),
    imageUrl: optionalHttpUrl,
    itemType: z.string().trim().max(50).default("food"),
    dietaryTags: z.array(z.string().trim().max(80)).max(30).optional(),
    allergens: z.array(z.string().trim().max(80)).max(30).optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

export const ownerAiMenuCategorySchema = z
  .object({
    id: z.string().uuid().optional(),
    ref: z.string().trim().max(100).optional(),
    operation: operationSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional().nullable(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    items: z.array(ownerAiMenuItemSchema).max(500).default([]),
  })
  .strict();

export const ownerAiMenuSchema = z
  .object({
    id: z.string().uuid().optional(),
    ref: z.string().trim().max(100).optional(),
    operation: operationSchema,
    name: z.string().trim().min(1).max(160),
    serviceType: z
      .enum([
        "all",
        "breakfast",
        "lunch",
        "dinner",
        "late_night",
        "weekend_brunch",
      ])
      .default("all"),
    availableFrom: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
    availableTo: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
    availableDays: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .max(7)
      .optional(),
    categories: z.array(ownerAiMenuCategorySchema).max(100).default([]),
  })
  .strict();

export const ownerAiScheduleStopSchema = z
  .object({
    id: z.string().uuid().optional(),
    ref: z.string().trim().max(100).optional(),
    operation: operationSchema,
    kind: z.enum(["schedule", "event_stop"]).default("schedule"),
    status: z.enum(["confirmed", "closed"]).default("confirmed"),
    eventName: z.string().trim().max(200).optional().nullable(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, "Date must be a real calendar day"),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
    locationName: z.string().trim().max(240).optional().nullable(),
    address: z.string().trim().max(500).optional().nullable(),
    city: z.string().trim().max(120).optional().nullable(),
    state: z.string().trim().max(80).optional().nullable(),
    timezone: z.string().trim().max(100).optional().nullable(),
    notes: z.string().trim().max(3000).optional().nullable(),
    isPublic: z.boolean().default(true),
    sourceUrl: optionalHttpUrl,
    expiresAt: z.string().datetime().optional().nullable(),
  })
  .strict()
  .superRefine((stop, ctx) => {
    if (stop.timezone) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: stop.timezone }).format(); }
      catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timezone"], message: "Timezone must be a valid IANA timezone" }); }
    }
    if (stop.status === "closed" && stop.operation === "upsert") {
      if (!stop.expiresAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "Dated closures require an explicit expiry" });
      if (!stop.timezone) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timezone"], message: "Dated closures require an explicit timezone" });
      if (stop.timezone && stop.expiresAt) {
        const localDayStart = DateTime.fromISO(stop.date, { zone: stop.timezone }).startOf("day");
        const expiry = new Date(stop.expiresAt).getTime();
        if (!localDayStart.isValid || expiry <= localDayStart.toMillis() || expiry > localDayStart.plus({ days: 1 }).toMillis()) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "Closure expiry must be after its local day begins and no later than the next local midnight" });
        }
      }
      if (stop.kind !== "schedule") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "A dated closure is a schedule, not an event stop" });
      for (const key of ["startTime", "endTime", "locationName", "eventName", "address"] as const) {
        if (stop[key] != null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "A dated closure cannot advertise a service time or location" });
      }
    }
  });

export const ownerAiDealSchema = z
  .object({
    id: z.string().uuid().optional(),
    ref: z.string().trim().max(100).optional(),
    operation: operationSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(3000),
    dealType: z.enum(["percentage", "fixed"]),
    discountValue: z.number().positive().max(100000),
    minOrderAmount: z.number().min(0).max(1_000_000).optional().nullable(),
    imageUrl: optionalHttpUrl,
    startDate: z.string().datetime(),
    endDate: z.string().datetime().optional().nullable(),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
    isOngoing: z.boolean().default(false),
    availableDuringBusinessHours: z.boolean().default(false),
    totalUsesLimit: z.number().int().positive().optional().nullable(),
    perCustomerLimit: z.number().int().positive().default(1),
  })
  .strict();

const socialPostOverrideSchema = z
  .object({
    message: z.string().trim().max(5000).optional(),
    imageUrl: optionalHttpUrl,
    link: optionalSocialLinkUrl,
  })
  .strict();

export const ownerAiSocialPackageSchema = z
  .object({
    enabled: z.boolean().default(true),
    platforms: z.array(z.enum(OWNER_AI_PLATFORMS)).min(1).max(3).default([...OWNER_AI_PLATFORMS]),
    campaignLabel: z.string().trim().max(120).optional(),
    headline: z.string().trim().max(120).optional(),
    subheadline: z.string().trim().max(240).optional(),
    imageUrl: optionalHttpUrl,
    link: optionalSocialLinkUrl,
    posts: z
      .object({
        facebook: socialPostOverrideSchema.optional(),
        instagram: socialPostOverrideSchema.optional(),
        x: socialPostOverrideSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((social, ctx) => {
    if (new Set(social.platforms).size !== social.platforms.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["platforms"],
        message: "Social platforms must be unique",
      });
    }
    for (const [platform, post] of Object.entries(social.posts || {})) {
      if (post && !social.platforms.includes(platform as OwnerAiPlatform)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["posts", platform],
          message: "A platform-specific post requires that platform to be selected",
        });
      }
    }
  });

const nonempty = (value: Record<string, unknown>) => Object.keys(value).length > 0;
export const ownerAiSocialPostingSettingsSchema = z.object({
  platforms: z.object({ facebook: z.boolean().optional(), instagram: z.boolean().optional(), x: z.boolean().optional() }).strict().refine(nonempty, "Provide a platform preference").optional(),
  triggers: z.object({ schedule: z.boolean().optional(), booking: z.boolean().optional(), live: z.boolean().optional(), deal: z.boolean().optional() }).strict().refine(nonempty, "Provide a trigger preference").optional(),
  promptBeforePost: z.boolean().optional(),
}).strict().refine(nonempty, "Provide a social preference");
export const ownerAiSettingsSchema = z.object({ socialPosting: ownerAiSocialPostingSettingsSchema }).strict();

export const ownerAiActionPacketSchema = z
  .object({
    schemaVersion: z.literal(OWNER_AI_SCHEMA_VERSION).default(OWNER_AI_SCHEMA_VERSION),
    intent: z.string().trim().min(1).max(1000),
    source: z
      .object({
        tool: z.string().trim().max(160).optional(),
        model: z.string().trim().max(160).optional(),
        conversationRef: z.string().trim().max(500).optional(),
      })
      .strict()
      .optional(),
    mediaRights: z
      .object({
        affirmed: z.literal(true),
        affirmation: z
          .string()
          .trim()
          .min(20)
          .max(1000)
          .default(
            "The restaurant owner confirms they own or have permission to use every supplied remote image.",
          ),
      })
      .strict()
      .optional(),
    profile: ownerAiProfileSchema.optional(),
    hours: ownerAiHoursSchema.optional(),
    menus: z.array(ownerAiMenuSchema).max(25).optional(),
    schedules: z.array(ownerAiScheduleStopSchema).max(365).optional(),
    deals: z.array(ownerAiDealSchema).max(100).optional(),
    social: ownerAiSocialPackageSchema.optional(),
    settings: ownerAiSettingsSchema.optional(),
  })
  .strict()
  .superRefine((packet, ctx) => {
    if (!packet.profile && !packet.hours && !packet.menus?.length && !packet.schedules?.length && !packet.deals?.length && !packet.social && !packet.settings) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Packet must contain at least one proposed change or social package" });
    }
    const remoteImages = [
      packet.profile?.logoUrl,
      packet.profile?.coverImageUrl,
      ...(packet.profile?.gallery || []).map((entry) => entry.url),
      ...(packet.menus || []).flatMap((menu) =>
        menu.categories.flatMap((category) =>
          category.items.map((item) => item.imageUrl),
        ),
      ),
      ...(packet.deals || []).map((deal) => deal.imageUrl),
      packet.social?.imageUrl,
      ...Object.values(packet.social?.posts || {}).map((post) => post?.imageUrl),
    ].filter(Boolean);
    const categories = (packet.menus || []).flatMap((menu) => menu.categories);
    const itemCount = categories.reduce(
      (count, category) => count + category.items.length,
      0,
    );
    if (categories.length > 500) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menus"],
        message: "A draft may contain at most 500 menu categories",
      });
    }
    if (itemCount > 2000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["menus"],
        message: "A draft may contain at most 2,000 menu items",
      });
    }
    if (remoteImages.length > 250) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaRights"],
        message: "A draft may contain at most 250 remote images",
      });
    }
    for (const [index, image] of (packet.profile?.gallery || []).entries()) {
      if (image.operation === "upsert" && !image.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profile", "gallery", index, "url"],
          message: "Gallery upserts require an image URL",
        });
      }
      if (image.operation === "archive" && !image.id && !image.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profile", "gallery", index],
          message: "Gallery archives require an existing id or URL",
        });
      }
    }
    if (remoteImages.length > 0 && packet.mediaRights?.affirmed !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaRights"],
        message:
          "Remote images require an owner-visible rights and usage affirmation. MealScout-generated fallback cards do not.",
      });
    }
  });

export const ownerAiExpectedVersionsSchema = z
  .object({
    restaurant: z.string(),
    menus: z.string(),
    schedules: z.string(),
    deals: z.string(),
  })
  .strict();

export const ownerAiDraftRequestSchema = z
  .object({
    packet: ownerAiActionPacketSchema,
    expectedVersions: ownerAiExpectedVersionsSchema.optional(),
  })
  .strict();

export type OwnerAiActionPacket = z.infer<typeof ownerAiActionPacketSchema>;
export type OwnerAiDraftRequest = z.infer<typeof ownerAiDraftRequestSchema>;
export type OwnerAiExpectedVersions = z.infer<typeof ownerAiExpectedVersionsSchema>;
export type OwnerAiPlatform = (typeof OWNER_AI_PLATFORMS)[number];

export const OWNER_AI_PACKET_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://www.mealscout.us/api/owner-ai/schema",
  title: "MealScout owner AI draft request",
  type: "object",
  additionalProperties: false,
  required: ["packet"],
  $defs: {
    httpUrl: {
      type: "string",
      format: "uri",
      pattern: "^https?://",
      maxLength: 2000,
    },
    nullableHttpUrl: {
      anyOf: [{ $ref: "#/$defs/httpUrl" }, { type: "null" }],
    },
    socialLink: {
      anyOf: [
        {
          type: "string",
          format: "uri",
          pattern: "^https?://",
          maxLength: 240,
        },
        { type: "null" },
      ],
    },
    operation: { type: "string", enum: ["upsert", "archive"], default: "upsert" },
    time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    nullableTime: {
      anyOf: [{ $ref: "#/$defs/time" }, { type: "null" }],
    },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        tool: { type: "string", maxLength: 160 },
        model: { type: "string", maxLength: 160 },
        conversationRef: { type: "string", maxLength: 500 },
      },
    },
    mediaRights: {
      type: "object",
      additionalProperties: false,
      required: ["affirmed"],
      properties: {
        affirmed: { const: true },
        affirmation: { type: "string", minLength: 20, maxLength: 1000 },
      },
    },
    galleryImage: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", maxLength: 100 },
        operation: { $ref: "#/$defs/operation" },
        url: { $ref: "#/$defs/nullableHttpUrl" },
        category: { type: "string", maxLength: 80, default: "general" },
        altText: { type: ["string", "null"], maxLength: 300 },
      },
    },
    profile: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: ["string", "null"], maxLength: 5000 },
        phone: { type: ["string", "null"], maxLength: 80 },
        websiteUrl: { $ref: "#/$defs/nullableHttpUrl" },
        cuisineType: { type: ["string", "null"], maxLength: 120 },
        address: { type: "string", maxLength: 500 },
        city: { type: ["string", "null"], maxLength: 120 },
        state: { type: ["string", "null"], maxLength: 80 },
        instagramUrl: { $ref: "#/$defs/nullableHttpUrl" },
        facebookPageUrl: { $ref: "#/$defs/nullableHttpUrl" },
        xUrl: { $ref: "#/$defs/nullableHttpUrl" },
        menuUrl: { $ref: "#/$defs/nullableHttpUrl" },
        onlineOrderingUrl: { $ref: "#/$defs/nullableHttpUrl" },
        deliveryUrl: { $ref: "#/$defs/nullableHttpUrl" },
        doordashUrl: { $ref: "#/$defs/nullableHttpUrl" },
        uberEatsUrl: { $ref: "#/$defs/nullableHttpUrl" },
        toastUrl: { $ref: "#/$defs/nullableHttpUrl" },
        squareUrl: { $ref: "#/$defs/nullableHttpUrl" },
        chowNowUrl: { $ref: "#/$defs/nullableHttpUrl" },
        grubhubUrl: { $ref: "#/$defs/nullableHttpUrl" },
        cateringInquiryUrl: { $ref: "#/$defs/nullableHttpUrl" },
        truckBookingInquiryUrl: { $ref: "#/$defs/nullableHttpUrl" },
        logoUrl: { $ref: "#/$defs/nullableHttpUrl" },
        coverImageUrl: { $ref: "#/$defs/nullableHttpUrl" },
        gallery: {
          type: "array",
          maxItems: 50,
          items: { $ref: "#/$defs/galleryImage" },
        },
      },
    },
    timeSlot: {
      type: "object",
      additionalProperties: false,
      required: ["open", "close"],
      properties: {
        open: { $ref: "#/$defs/time" },
        close: { $ref: "#/$defs/time" },
      },
    },
    hours: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
          day,
          {
            type: "array",
            maxItems: 4,
            items: { $ref: "#/$defs/timeSlot" },
            default: [],
          },
        ]),
      ),
    },
    menuItem: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        id: { type: "string", format: "uuid" },
        ref: { type: "string", maxLength: 100 },
        operation: { $ref: "#/$defs/operation" },
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: ["string", "null"], maxLength: 3000 },
        priceCents: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 10000000,
        },
        imageUrl: { $ref: "#/$defs/nullableHttpUrl" },
        itemType: { type: "string", maxLength: 50, default: "food" },
        dietaryTags: {
          type: "array",
          maxItems: 30,
          items: { type: "string", maxLength: 80 },
        },
        allergens: {
          type: "array",
          maxItems: 30,
          items: { type: "string", maxLength: 80 },
        },
        sortOrder: { type: "integer", minimum: 0, maximum: 10000 },
      },
    },
    menuCategory: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        id: { type: "string", format: "uuid" },
        ref: { type: "string", maxLength: 100 },
        operation: { $ref: "#/$defs/operation" },
        name: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: ["string", "null"], maxLength: 2000 },
        sortOrder: { type: "integer", minimum: 0, maximum: 10000 },
        items: {
          type: "array",
          maxItems: 500,
          items: { $ref: "#/$defs/menuItem" },
          default: [],
        },
      },
    },
    menu: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        id: { type: "string", format: "uuid" },
        ref: { type: "string", maxLength: 100 },
        operation: { $ref: "#/$defs/operation" },
        name: { type: "string", minLength: 1, maxLength: 160 },
        serviceType: {
          type: "string",
          enum: ["all", "breakfast", "lunch", "dinner", "late_night", "weekend_brunch"],
          default: "all",
        },
        availableFrom: { $ref: "#/$defs/nullableTime" },
        availableTo: { $ref: "#/$defs/nullableTime" },
        availableDays: {
          type: "array",
          maxItems: 7,
          uniqueItems: true,
          items: { enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
        },
        categories: {
          type: "array",
          maxItems: 100,
          items: { $ref: "#/$defs/menuCategory" },
          default: [],
        },
      },
    },
    schedule: {
      allOf: [{
        if: { required: ["status"], properties: { status: { const: "closed" }, operation: { const: "upsert" } } },
        then: { required: ["timezone", "expiresAt"], properties: {
          timezone: { type: "string", minLength: 1, maxLength: 100 },
          expiresAt: { type: "string", format: "date-time" },
          kind: { const: "schedule" },
          ...Object.fromEntries(["startTime", "endTime", "locationName", "eventName", "address"].map((key) => [key, { type: "null" }])),
        } },
      }],
      type: "object",
      additionalProperties: false,
      required: ["date"],
      properties: {
        id: { type: "string", format: "uuid" },
        ref: { type: "string", maxLength: 100 },
        operation: { $ref: "#/$defs/operation" },
        kind: { enum: ["schedule", "event_stop"], default: "schedule" },
        status: { enum: ["confirmed", "closed"], default: "confirmed" },
        eventName: { type: ["string", "null"], maxLength: 200 },
        date: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        startTime: { $ref: "#/$defs/nullableTime" },
        endTime: { $ref: "#/$defs/nullableTime" },
        locationName: { type: ["string", "null"], maxLength: 240 },
        address: { type: ["string", "null"], maxLength: 500 },
        city: { type: ["string", "null"], maxLength: 120 },
        state: { type: ["string", "null"], maxLength: 80 },
        timezone: { type: ["string", "null"], maxLength: 100 },
        notes: { type: ["string", "null"], maxLength: 3000 },
        isPublic: { type: "boolean", default: true },
        sourceUrl: { $ref: "#/$defs/nullableHttpUrl" },
        expiresAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    deal: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "dealType", "discountValue", "startDate"],
      properties: {
        id: { type: "string", format: "uuid" },
        ref: { type: "string", maxLength: 100 },
        operation: { $ref: "#/$defs/operation" },
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", minLength: 1, maxLength: 3000 },
        dealType: { enum: ["percentage", "fixed"] },
        discountValue: { type: "number", exclusiveMinimum: 0, maximum: 100000 },
        minOrderAmount: { type: ["number", "null"], minimum: 0, maximum: 1000000 },
        imageUrl: { $ref: "#/$defs/nullableHttpUrl" },
        startDate: { type: "string", format: "date-time" },
        endDate: { type: ["string", "null"], format: "date-time" },
        startTime: { $ref: "#/$defs/nullableTime" },
        endTime: { $ref: "#/$defs/nullableTime" },
        isOngoing: { type: "boolean", default: false },
        availableDuringBusinessHours: { type: "boolean", default: false },
        totalUsesLimit: { type: ["integer", "null"], minimum: 1 },
        perCustomerLimit: { type: "integer", minimum: 1, default: 1 },
      },
    },
    socialPostingSettings: {
      type: "object", additionalProperties: false, minProperties: 1,
      properties: {
        platforms: { type: "object", additionalProperties: false, minProperties: 1, properties: Object.fromEntries(OWNER_AI_PLATFORMS.map(key => [key, { type: "boolean" }])) },
        triggers: { type: "object", additionalProperties: false, minProperties: 1, properties: Object.fromEntries(["schedule", "booking", "live", "deal"].map(key => [key, { type: "boolean" }])) },
        promptBeforePost: { type: "boolean" },
      },
    },
    settings: { type: "object", additionalProperties: false, required: ["socialPosting"], properties: { socialPosting: { $ref: "#/$defs/socialPostingSettings" } } },
    socialPost: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string", maxLength: 5000 },
        imageUrl: { $ref: "#/$defs/nullableHttpUrl" },
        link: { $ref: "#/$defs/socialLink" },
      },
    },
    social: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        platforms: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { enum: OWNER_AI_PLATFORMS },
          default: OWNER_AI_PLATFORMS,
        },
        campaignLabel: { type: "string", maxLength: 120 },
        headline: { type: "string", maxLength: 120 },
        subheadline: { type: "string", maxLength: 240 },
        imageUrl: { $ref: "#/$defs/nullableHttpUrl" },
        link: { $ref: "#/$defs/socialLink" },
        posts: {
          type: "object",
          additionalProperties: false,
          properties: {
            facebook: { $ref: "#/$defs/socialPost" },
            instagram: { $ref: "#/$defs/socialPost" },
            x: { $ref: "#/$defs/socialPost" },
          },
        },
      },
    },
  },
  properties: {
    expectedVersions: {
      type: "object",
      additionalProperties: false,
      required: ["restaurant", "menus", "schedules", "deals"],
      properties: {
        restaurant: { type: "string" },
        menus: { type: "string" },
        schedules: { type: "string" },
        deals: { type: "string" },
      },
    },
    packet: {
      type: "object",
      additionalProperties: false,
      required: ["intent"],
      properties: {
        schemaVersion: { const: OWNER_AI_SCHEMA_VERSION, default: OWNER_AI_SCHEMA_VERSION },
        intent: { type: "string", minLength: 1, maxLength: 1000 },
        source: { $ref: "#/$defs/source" },
        mediaRights: { $ref: "#/$defs/mediaRights" },
        profile: { $ref: "#/$defs/profile" },
        hours: { $ref: "#/$defs/hours" },
        menus: {
          type: "array",
          maxItems: 25,
          items: { $ref: "#/$defs/menu" },
        },
        schedules: {
          type: "array",
          maxItems: 365,
          items: { $ref: "#/$defs/schedule" },
        },
        deals: {
          type: "array",
          maxItems: 100,
          items: { $ref: "#/$defs/deal" },
        },
        social: { $ref: "#/$defs/social" },
        settings: { $ref: "#/$defs/settings" },
      },
      anyOf: [
        { required: ["profile"] },
        { required: ["hours"] },
        { required: ["menus"] },
        { required: ["schedules"] },
        { required: ["deals"] },
        { required: ["social"] },
        { required: ["settings"] },
      ],
    },
  },
} as const;
