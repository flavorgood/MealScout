import { createHash } from "node:crypto";
import { z } from "zod";
import { projectAdmittedFoodProfileLink, type NativePublicFoodProfileType } from "../publicProfiles/admitPublicRestaurant";
import { deriveProfileEvidenceQuarantineVisibility } from "./profileEvidenceQuarantine";
import { assertPublicResponseSafe } from "../publicProfiles/assertPublicResponseSafe";

export type LinkSql = {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
};
export type LinkDatabase = LinkSql & {
  transaction<T>(action: (tx: LinkSql) => Promise<T>): Promise<T>;
};
export class PublicLinkError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const revision = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= 9223372036854775807n);
export const publicLinkApprovalSchema = z.object({
  generationId: z.string().regex(/^[a-f0-9]{32}$/),
  nativeRevision: revision,
  authorityRevision: revision,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const publicLinkRevokeSchema = publicLinkApprovalSchema.pick({
  generationId: true, authorityRevision: true,
});

// One statement admits native data and reads its permission in one DB view.
const readViewSql = `SELECT to_jsonb(r) AS restaurant, to_jsonb(u) AS owner,
  to_jsonb(a) || jsonb_build_object('native_revision', a.native_revision::text,
    'authority_revision', a.authority_revision::text,
    'approved_native_revision', a.approved_native_revision::text) AS authority,
  statement_timestamp() AS read_at
  FROM restaurants r JOIN users u ON u.id = r.owner_id
  JOIN mealscout_public_link_authority a ON a.source_id = r.id
  WHERE r.id = $1`;
const camelRow = (row: Record<string, any>) => Object.fromEntries(
  Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value,
  ]),
);
const asIso = (value: any) => new Date(value).toISOString();
const validId = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 160 && !/[\s/\\?#%\u0000-\u001f]/.test(value);

export function isNativeFoodProfileDestination(canonicalUrl: string, sourceId: string, profileType: NativePublicFoodProfileType) {
  const prefix = profileType === "private_chef" ? "private-chef" : profileType;
  if (!["restaurant", "truck", "bar", "caterer", "private-chef"].includes(prefix)) return false;
  try {
    const destination = new URL(canonicalUrl);
    const tail = destination.pathname.split("/").at(-1) ?? "";
    return destination.origin === "https://www.mealscout.us"
      && /^[a-zA-Z0-9_-]{1,80}$/.test(sourceId)
      && new RegExp(`^/${prefix}/[a-z0-9][a-z0-9-]{0,119}$`).test(destination.pathname)
      && destination.href === canonicalUrl && !destination.username && !destination.password
      && !/%|\\|\/\//.test(destination.pathname)
      && tail.lastIndexOf("--") >= 1
      && tail.slice(tail.lastIndexOf("--") + 2) === sourceId
      && !destination.search && !destination.hash;
  } catch { return false; }
}

function project(view: any) {
  if (!view) return null;
  const row = camelRow(view.restaurant);
  const owner = camelRow(view.owner);
  const authority = view.authority;
  if (authority.owner_id !== row.ownerId || authority.state === "deleted") return null;
  const admitted = projectAdmittedFoodProfileLink(row, owner);
  const dto = admitted?.dto;
  const contentDigest = dto ? createHash("sha256").update(JSON.stringify([
    "mealscout-public-link-v1", row.id, authority.generation_id,
    dto.displayName, dto.seo.canonicalUrl,
  ])).digest("hex") : null;
  return { row, owner, authority, dto, contentDigest,
    eligible: Boolean(dto && typeof dto.displayName === "string"
      && dto.displayName.trim() && dto.displayName.length <= 120
      && !/[<>\x00-\x1f]/.test(dto.displayName)
      && isNativeFoodProfileDestination(dto.seo.canonicalUrl, row.id, dto.profileType)
      && !deriveProfileEvidenceQuarantineVisibility(row).isQuarantined),
    readAt: new Date(view.read_at).getTime() };
}

function ownerRequired(value: ReturnType<typeof project>, userId: string) {
  if (!value) throw new PublicLinkError(404, "PROFILE_NOT_FOUND", "Profile not found");
  if (!userId || value.row.ownerId !== userId || value.owner.isDisabled !== false) {
    throw new PublicLinkError(403, "ACTUAL_OWNER_REQUIRED", "Only the current MealScout owner can change sharing");
  }
  return value;
}
function ownerView(value: NonNullable<ReturnType<typeof project>>) {
  const { authority: a, dto } = value;
  return {
    sourceId: value.row.id, publicTenantId: a.public_tenant_id,
    generationId: a.generation_id, nativeRevision: String(a.native_revision),
    authorityRevision: String(a.authority_revision), contentDigest: value.contentDigest,
    eligible: value.eligible, publicLabel: dto?.displayName ?? null,
    canonicalUrl: dto?.seo.canonicalUrl ?? null,
    state: a.state === "approved" && new Date(a.expires_at).getTime() <= value.readAt
      ? "expired" : a.state,
    expiresAt: a.expires_at ? asIso(a.expires_at) : null,
  };
}

export function createPublicLinkAuthority(database: LinkDatabase, options: {
  sourceRevision: string; nowMs?: () => number;
}) {
  const nowMs = options.nowMs ?? Date.now;
  async function read(tx: LinkSql, sourceId: string) {
    if (!validId(sourceId)) throw new PublicLinkError(400, "INVALID_PROFILE_ID", "Invalid profile ID");
    const result = await tx.query(readViewSql, [sourceId]);
    return project(result.rows[0]);
  }
  async function lockedOwnerView(tx: LinkSql, sourceId: string, userId: string) {
    if (!validId(sourceId)) throw new PublicLinkError(400, "INVALID_PROFILE_ID", "Invalid profile ID");
    // Native owner updates already lock user -> restaurant (migration140).
    // Take that order, and recheck ownership after locking the restaurant.
    // A transfer between the initial check and either lock cannot grant access.
    const { rows } = await tx.query(
      "SELECT owner_id FROM restaurants WHERE id = $1", [sourceId]);
    if (!rows[0]) throw new PublicLinkError(404, "PROFILE_NOT_FOUND", "Profile not found");
    if (rows[0].owner_id !== userId) {
      throw new PublicLinkError(403, "ACTUAL_OWNER_REQUIRED", "Only the current MealScout owner can change sharing");
    }
    await tx.query("SELECT id FROM users WHERE id = $1 FOR SHARE", [userId]);
    const locked = await tx.query("SELECT owner_id FROM restaurants WHERE id = $1 FOR UPDATE", [sourceId]);
    if (!locked.rows[0] || locked.rows[0].owner_id !== userId) {
      throw new PublicLinkError(403, "ACTUAL_OWNER_REQUIRED", "Only the current MealScout owner can change sharing");
    }
    await tx.query("SELECT source_id FROM mealscout_public_link_authority WHERE source_id = $1 FOR UPDATE", [sourceId]);
    return ownerRequired(await read(tx, sourceId), userId);
  }
  return {
    async getOwnerPreview(sourceId: string, userId: string) {
      return ownerView(ownerRequired(await read(database, sourceId), userId));
    },
    async approve(sourceId: string, userId: string, input: unknown) {
      const expected = publicLinkApprovalSchema.parse(input);
      return database.transaction(async tx => {
        const view = await lockedOwnerView(tx, sourceId, userId);
        const a = view.authority;
        if (!view.eligible) {
          throw new PublicLinkError(409, "NOT_EXPORT_ELIGIBLE", "This profile is not eligible for optional ecosystem sharing");
        }
        if (expected.generationId !== a.generation_id
          || expected.nativeRevision !== String(a.native_revision)
          || expected.authorityRevision !== String(a.authority_revision)
          || expected.contentDigest !== view.contentDigest) {
          throw new PublicLinkError(409, "PROFILE_CHANGED", "Profile or sharing permission changed; review the current link again");
        }
        await tx.query(`UPDATE mealscout_public_link_authority SET state = 'approved',
          authority_revision = authority_revision + 1, approved_native_revision = native_revision,
          approved_content_digest = $2, approved_at = clock_timestamp(),
          expires_at = clock_timestamp() + INTERVAL '7 days' WHERE source_id = $1`,
          [sourceId, view.contentDigest]);
        return ownerView(ownerRequired(await read(tx, sourceId), userId));
      });
    },
    async revoke(sourceId: string, userId: string, input: unknown) {
      const expected = publicLinkRevokeSchema.parse(input);
      return database.transaction(async tx => {
        const view = await lockedOwnerView(tx, sourceId, userId);
        const a = view.authority;
        if (expected.generationId !== a.generation_id
          || expected.authorityRevision !== String(a.authority_revision)) {
          throw new PublicLinkError(409, "PERMISSION_CHANGED", "Sharing permission changed; refresh before stopping sharing");
        }
        await tx.query(`UPDATE mealscout_public_link_authority SET state = 'revoked',
          authority_revision = authority_revision + 1, approved_native_revision = NULL,
          approved_content_digest = NULL, approved_at = NULL, expires_at = NULL
          WHERE source_id = $1`, [sourceId]);
        return ownerView(ownerRequired(await read(tx, sourceId), userId));
      });
    },
    async readPublicLink(publicTenantId: string, sourceId: string) {
      if (!/^[a-f0-9]{32}$/.test(publicTenantId) || !validId(sourceId)
        || !/^[a-f0-9]{40}$/.test(options.sourceRevision)) return null;
      const startedAt = performance.now();
      const startedWall = nowMs();
      if (!Number.isFinite(startedWall)) return null;
      const view = await read(database, sourceId);
      const now = nowMs();
      if (!view?.eligible || !view.dto || performance.now() - startedAt >= 1000
        || !Number.isFinite(now) || now < startedWall || now - startedWall >= 1000
        || view.readAt > now || now - view.readAt >= 1000) return null;
      const a = view.authority;
      const expiry = Math.min(new Date(a.expires_at).getTime(), view.readAt + 1000, startedWall + 1000);
      if (a.public_tenant_id !== publicTenantId || a.state !== "approved"
        || String(a.approved_native_revision) !== String(a.native_revision)
        || a.approved_content_digest !== view.contentDigest
        || !Number.isFinite(expiry) || expiry <= now
        || new Date(a.approved_at).getTime() > view.readAt) return null;
      const dto = view.dto;
      if (!isNativeFoodProfileDestination(dto.seo.canonicalUrl, sourceId, dto.profileType)) return null;
      const envelope = {
        app: "mealscout", tenantId: publicTenantId, sourceId,
        publication: "published", exportApproval: "approved",
        publicLabel: dto.displayName, canonicalUrl: dto.seo.canonicalUrl,
        sourceRevision: options.sourceRevision,
        publicationRevision: `g${a.generation_id}_p${a.native_revision}_a${a.authority_revision}`,
        approvedAt: asIso(a.approved_at), expiresAt: new Date(expiry).toISOString(),
      };
      assertPublicResponseSafe(envelope);
      return envelope;
    },
  };
}
export type PublicLinkAuthority = ReturnType<typeof createPublicLinkAuthority>;
