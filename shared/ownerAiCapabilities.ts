import { z } from "zod";
import type { PublicProfileType } from "./publicProfiles";
import { OWNER_AI_PACKET_JSON_SCHEMA, ownerAiActionPacketSchema, ownerAiExpectedVersionsSchema } from "./ownerAiActions";

// Carry the native definitions with their own resource scope in both REST and MCP.
export const OWNER_AI_PROFILE_PREVIEW_JSON_SCHEMA = {
  $schema: OWNER_AI_PACKET_JSON_SCHEMA.$schema,
  $id: "https://www.mealscout.us/schemas/owner-ai-profile-preview.v1.json",
  title: "MealScout authenticated profile preview request",
  type: "object",
  additionalProperties: false,
  required: ["packet", "expectedVersions", "provenance"],
  $defs: OWNER_AI_PACKET_JSON_SCHEMA.$defs,
  properties: {
    packet: OWNER_AI_PACKET_JSON_SCHEMA.properties.packet,
    expectedVersions: OWNER_AI_PACKET_JSON_SCHEMA.properties.expectedVersions,
    provenance: {
      type: "object", additionalProperties: false,
      required: ["source", "observedAt", "access", "expiresAt"],
      properties: {
        source: { type: "string", minLength: 1 },
        observedAt: { type: "string", format: "date-time" },
        access: { enum: ["public", "private", "restricted", "unknown"] },
        expiresAt: { type: ["string", "null"], format: "date-time" },
      },
    },
  },
} as const;

// Server-side trusted-input facade, not authentication or a persistence adapter.
export const OWNER_AI_PROFILE_TYPES = ["restaurant", "truck", "bar", "caterer", "private_chef", "location", "host", "supplier"] as const satisfies readonly PublicProfileType[];
const profileType = z.enum(OWNER_AI_PROFILE_TYPES);
const targetSchema = z.object({ profileType, profileId: z.string().min(1) }).strict();
const dated = z.string().datetime();
const provenanceSchema = z.object({
  source: z.string().min(1), observedAt: dated,
  access: z.enum(["public", "private", "restricted", "unknown"]),
  expiresAt: dated.nullable(),
}).strict();
const authoritySchema = z.object({
  target: targetSchema, currentOwnerId: z.string().min(1),
  adapter: z.enum(["restaurant_native", "unsupported"]),
  backingRestaurantId: z.string().min(1).nullable(),
  currentVersions: ownerAiExpectedVersionsSchema.nullable(),
  provenance: provenanceSchema,
}).strict();
const principalSchema = z.object({
  apiKeyId: z.string().min(1), userId: z.string().min(1), target: targetSchema,
  scopes: z.array(z.string()), isActive: z.boolean(), expiresAt: dated.nullable(), revokedAt: dated.nullable(),
}).strict();
export type OwnerAiTarget = z.infer<typeof targetSchema>;
export type OwnerAiAuthority = z.infer<typeof authoritySchema>;
export type OwnerAiCapabilityPrincipal = z.infer<typeof principalSchema>;
export class OwnerAiCapabilityError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function reject(code: string): never { throw new OwnerAiCapabilityError(code); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : reject("INVALID_INPUT");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function bind(targetInput: unknown, authorityInput: unknown, principalInput: unknown, nowInput: string) {
  const target = parse(targetSchema, targetInput);
  const authority = parse(authoritySchema, authorityInput);
  const principal = parse(principalSchema, principalInput);
  const now = Date.parse(parse(dated, nowInput));
  if (![authority.target, principal.target].every(t => t.profileId === target.profileId && t.profileType === target.profileType)) reject("TARGET_MISMATCH");
  if (principal.userId !== authority.currentOwnerId) reject("CURRENT_OWNER_REQUIRED");
  if (!principal.isActive || principal.revokedAt !== null || (principal.expiresAt !== null && Date.parse(principal.expiresAt) <= now)) reject("PRINCIPAL_INACTIVE");
  if (!principal.scopes.includes("owner_ai:context")) reject("CONTEXT_SCOPE_REQUIRED");
  if (Date.parse(authority.provenance.observedAt) > now || (authority.provenance.expiresAt !== null && Date.parse(authority.provenance.expiresAt) <= now)) reject("CONTEXT_EXPIRED");
  if (authority.provenance.access === "unknown") reject("ACCESS_UNKNOWN");
  // A shared restaurant ID is never proof of a type-specific adapter.
  if (authority.adapter === "restaurant_native" && (!["restaurant", "truck", "bar", "caterer", "private_chef"].includes(target.profileType) || authority.backingRestaurantId !== target.profileId)) reject("ADAPTER_TARGET_MISMATCH");
  return { target, authority, principal, now };
}
export function readOwnerAiCapabilities(input: { target: unknown; authority: unknown; principal: unknown; now: string }) {
  const { target, authority, principal } = bind(input.target, input.authority, input.principal, input.now);
  const native = authority.adapter === "restaurant_native";
  const canPreview = native && authority.currentVersions !== null && principal.scopes.includes("owner_ai:drafts:create");
  const canPreviewPublicFields = canPreview && authority.provenance.access === "public";
  return freeze({ target, mode: "read" as const, approvalRequired: true as const, canApply: false as const,
    provenance: authority.provenance, principalExpiresAt: principal.expiresAt,
    profiles: OWNER_AI_PROFILE_TYPES.map(type => ({ profileType: type,
      adapter: type === target.profileType && native ? "restaurant_native" : "unsupported",
      details: type === target.profileType && canPreviewPublicFields, menus: type === target.profileType && canPreviewPublicFields,
      prices: type === target.profileType && canPreviewPublicFields, schedules: type === target.profileType && canPreview,
      scheduleAccess: type === target.profileType && canPreview ? (authority.provenance.access === "public" ? "public_and_private" : "private_only") : "none",
      locations: type === target.profileType && canPreviewPublicFields, photos: type === target.profileType && canPreviewPublicFields,
      settings: false as const,
    })),
  });
}
export function previewOwnerAiPacket(input: { target: unknown; authority: unknown; principal: unknown; now: string; request: unknown }) {
  const { target, authority, principal, now } = bind(input.target, input.authority, input.principal, input.now);
  if (!principal.scopes.includes("owner_ai:drafts:create")) reject("CREATE_SCOPE_REQUIRED");
  if (authority.adapter !== "restaurant_native") reject("UNSUPPORTED_ADAPTER");
  const request = parse(z.object({ packet: ownerAiActionPacketSchema, expectedVersions: ownerAiExpectedVersionsSchema, provenance: provenanceSchema }).strict(), input.request);
  if (!authority.currentVersions || Object.keys(request.expectedVersions).some(key => request.expectedVersions[key as keyof typeof request.expectedVersions] !== authority.currentVersions![key as keyof typeof request.expectedVersions])) reject("STALE_CONTEXT");
  if (request.packet.social || request.packet.deals) reject("UNSUPPORTED_CAPABILITY");
  if (request.provenance.access === "unknown" || Date.parse(request.provenance.observedAt) > now || (request.provenance.expiresAt !== null && Date.parse(request.provenance.expiresAt) <= now)) reject("SOURCE_UNAVAILABLE");
  if ((request.packet.profile || request.packet.hours || request.packet.menus?.length) && (request.provenance.access !== "public" || authority.provenance.access !== "public")) reject("PUBLIC_ACCESS_REQUIRED");
  const raw = input.request as { packet: { schedules?: { isPublic?: boolean }[] } };
  for (const [index, stop] of (request.packet.schedules || []).entries()) {
    // Native packet defaults isPublic=true; never let that default publish private evidence.
    if (raw.packet.schedules?.[index]?.isPublic === undefined) reject("EXPLICIT_SCHEDULE_ACCESS_REQUIRED");
    if (stop.isPublic && (request.provenance.access !== "public" || authority.provenance.access !== "public")) reject("PUBLIC_ACCESS_REQUIRED");
    if (!stop.timezone || !stop.expiresAt) reject("DATED_STOP_CONTEXT_REQUIRED");
    const calendarDate = new Date(`${stop.date}T00:00:00Z`);
    if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== stop.date) reject("INVALID_SCHEDULE_DATE");
    let localToday: string;
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: stop.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
      localToday = ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
    } catch { reject("DATED_STOP_CONTEXT_REQUIRED"); }
    if (Date.parse(stop.expiresAt) <= now || stop.date < localToday!) reject("SCHEDULE_EXPIRED");
  }
  return freeze({ target, mode: "preview" as const, approvalRequired: true as const, canApply: false as const,
    packet: request.packet, expectedVersions: request.expectedVersions, provenance: request.provenance,
    contextProvenance: authority.provenance, principalExpiresAt: principal.expiresAt,
  });
}
