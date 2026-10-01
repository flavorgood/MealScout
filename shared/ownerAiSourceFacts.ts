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
export const ownerAiSourceFactsSchema = z.object({
  version: z.literal(1),
  officialSources: z.array(z.string().url().max(2000).refine(v => v.startsWith("https://"))).min(1).max(4),
  fields: z.array(ownerAiSourceFactSchema).min(1).max(50),
}).strict();
export type OwnerAiSourceFact = z.infer<typeof ownerAiSourceFactSchema>;
export const OWNER_AI_SOURCE_FACTS_JSON_SCHEMA = {
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
  // A source-backed revision cannot smuggle changes without field evidence.
  if (Object.keys(packet.profile || {}).some(k => !seen.has("profile." + k)) ||
      packet.hours || packet.menus?.length || packet.schedules?.length || packet.deals?.length || packet.social || packet.settings) throw new Error("SOURCE_FACT_UNSUPPORTED_CHANGE");
}
