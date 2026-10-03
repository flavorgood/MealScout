import { z } from "zod";

export const OWNER_AI_SOURCE_FACT_TTL_MS = 24 * 60 * 60 * 1000;
export const ownerAiSourceFactSchema = z.object({
  path: z.enum(["profile.menuUrl", "profile.phone", "profile.instagramUrl", "profile.facebookPageUrl", "profile.xUrl"]),
  value: z.string().min(1).max(2000),
  sourceUrl: z.string().url().max(2000).refine(v => v.startsWith("https://")),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  captureSha256: z.string().regex(/^[a-f0-9]{64}$/),
  access: z.literal("public"),
  qualification: z.literal("Official page explicitly supplies this value; no claim about menu prices, inventory, availability or dated attendance."),
}).strict();
const ownerAiSourceFactsV1Schema = z.object({
  version: z.literal(1),
  officialSources: z.array(z.string().url().max(2000).refine(v => v.startsWith("https://"))).min(1).max(4),
  fields: z.array(ownerAiSourceFactSchema).min(1).max(50),
}).strict();
export type OwnerAiSourceFact = z.infer<typeof ownerAiSourceFactSchema>;
const OWNER_AI_SOURCE_FACTS_V1_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["version", "officialSources", "fields"],
  properties: { version: { const: 1 }, officialSources: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", format: "uri", pattern: "^https://", maxLength: 2000 } }, fields: { type: "array", minItems: 1, maxItems: 50, items: {
    type: "object", additionalProperties: false,
    required: ["path", "value", "sourceUrl", "capturedAt", "expiresAt", "captureSha256", "access", "qualification"],
    properties: { path: { enum: ["profile.menuUrl", "profile.phone", "profile.instagramUrl", "profile.facebookPageUrl", "profile.xUrl"] },
      value: { type: "string", minLength: 1, maxLength: 2000 }, sourceUrl: { type: "string", format: "uri", maxLength: 2000, pattern: "^https://" },
      capturedAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" },
      captureSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, access: { const: "public" },
      qualification: { const: "Official page explicitly supplies this value; no claim about menu prices, inventory, availability or dated attendance." } },
  } } },
} as const;

const ownerAiSourceSectionSchema = z.object({
  path: z.enum(["menus", "schedules"]),
  value: z.string().min(1).max(200000),
  sourceUrl: z.string().url().max(2000).refine(v => v.startsWith("https://")),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  captureSha256: z.string().regex(/^[a-f0-9]{64}$/),
  access: z.literal("public"),
  qualification: z.literal("Official public structured content supplies the complete proposed section. Explicit dates, identity and public access were checked; exact owner consent remains required."),
  effectiveFrom: z.string().datetime(),
  effectiveThrough: z.string().datetime(),
}).strict();
export type OwnerAiSourceSection = z.infer<typeof ownerAiSourceSectionSchema>;
export const ownerAiSourceFactsSchema = z.discriminatedUnion("version", [
  ownerAiSourceFactsV1Schema,
  z.object({
    version: z.literal(2),
    officialSources: ownerAiSourceFactsV1Schema.shape.officialSources,
    fields: z.array(ownerAiSourceFactSchema).max(50),
    sections: z.array(ownerAiSourceSectionSchema).min(1).max(2),
  }).strict(),
]);
export function canonicalSourceSection(value: unknown): string {
  const order = (v: any): any => Array.isArray(v) ? v.map(order) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, order(v[k])])) : v;
  return JSON.stringify(order(value));
}
export const OWNER_AI_SOURCE_FACTS_JSON_SCHEMA = { anyOf: [OWNER_AI_SOURCE_FACTS_V1_JSON_SCHEMA, {
  type: "object", additionalProperties: false, required: ["version", "officialSources", "fields", "sections"],
  properties: { version: { const: 2 }, officialSources: OWNER_AI_SOURCE_FACTS_V1_JSON_SCHEMA.properties.officialSources,
    fields: { ...OWNER_AI_SOURCE_FACTS_V1_JSON_SCHEMA.properties.fields, minItems: 0 },
    sections: { type: "array", minItems: 1, maxItems: 2, items: { type: "object", additionalProperties: false,
      required: ["path", "value", "sourceUrl", "capturedAt", "expiresAt", "captureSha256", "access", "qualification", "effectiveFrom", "effectiveThrough"],
      properties: { ...OWNER_AI_SOURCE_FACTS_V1_JSON_SCHEMA.properties.fields.items.properties,
        path: { enum: ["menus", "schedules"] }, value: { type: "string", minLength: 1, maxLength: 200000 },
        qualification: { const: "Official public structured content supplies the complete proposed section. Explicit dates, identity and public access were checked; exact owner consent remains required." },
        effectiveFrom: { type: "string", format: "date-time" }, effectiveThrough: { type: "string", format: "date-time" },
      },
    } },
  },
} ] } as const;

// Called again inside the canonical transaction: parsing alone never verifies evidence.
export function assertOwnerAiSourceFactBindings(packet: any, now = new Date()) {
  if (!packet.sourceFacts) return;
  const evidence = ownerAiSourceFactsSchema.parse(packet.sourceFacts);
  const seen = new Set<string>();
  for (const fact of evidence.fields) {
    if (seen.has(fact.path)) throw new Error("SOURCE_FACT_CONFLICT");
    seen.add(fact.path);
    const [section, field] = fact.path.split(".");
    if (packet[section]?.[field] !== fact.value) throw new Error("SOURCE_FACT_VALUE_MISMATCH");
    const captured = Date.parse(fact.capturedAt), expires = Date.parse(fact.expiresAt);
    if (captured > now.getTime() || expires <= now.getTime() || expires <= captured || expires - captured > OWNER_AI_SOURCE_FACT_TTL_MS) throw new Error("SOURCE_FACT_EXPIRED");
  }
  const sectionNames = new Set<string>();
  if (evidence.version === 2) for (const section of evidence.sections) {
    if (sectionNames.has(section.path)) throw new Error("SOURCE_FACT_CONFLICT");
    sectionNames.add(section.path);
    if (!packet[section.path]?.length || canonicalSourceSection(packet[section.path]) !== section.value) throw new Error("SOURCE_FACT_VALUE_MISMATCH");
    const captured=Date.parse(section.capturedAt), expires=Date.parse(section.expiresAt);
    if (captured > now.getTime() || expires <= now.getTime() || expires <= captured || expires-captured > OWNER_AI_SOURCE_FACT_TTL_MS || Date.parse(section.effectiveFrom) > now.getTime() || Date.parse(section.effectiveThrough) <= now.getTime() || expires > Date.parse(section.effectiveThrough)) throw new Error("SOURCE_FACT_EXPIRED");
    if (section.path === "schedules" && packet.schedules.some((stop:any)=>stop.isPublic !== true || stop.status !== "confirmed" || stop.kind !== "event_stop" || !stop.timezone || !stop.startTime || !stop.endTime || !stop.expiresAt || Date.parse(stop.expiresAt) <= now.getTime() || stop.sourceUrl !== section.sourceUrl)) throw new Error("SOURCE_FACT_SCHEDULE_CONTEXT_REQUIRED");
  }
  // A source-backed revision cannot smuggle changes without complete value evidence.
  if (Object.keys(packet.profile || {}).some(k => !seen.has("profile." + k)) ||
      packet.hours || (packet.menus?.length && !sectionNames.has("menus")) || (packet.schedules?.length && !sectionNames.has("schedules")) || packet.deals?.length || packet.social || packet.settings) throw new Error("SOURCE_FACT_UNSUPPORTED_CHANGE");
}
