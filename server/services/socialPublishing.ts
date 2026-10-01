import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db";
import {
  socialPostQueue,
  socialPublishingConnections,
  type SocialPostQueueItem,
  type SocialPublishingConnection,
} from "@shared/schema";
import { fetchPinnedPublicImage } from "../utils/pinnedPublicImageFetch";

export type PublishResult =
  | { ok: true; providerPostId?: string | null; providerUrl?: string | null }
  | { ok: false; error: string; manualRequired?: boolean };

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const X_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

async function providerFetch(
  input: string,
  init: RequestInit,
  timeoutMs = 20_000,
) {
  // Keep the timeout signal alive for response-body consumption too. Clearing
  // an AbortController as soon as headers arrive can leave response.json()
  // hanging indefinitely and hold an approved publish lease open.
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readPublicSocialImage(startUrl: string) {
  const image = await fetchPinnedPublicImage(startUrl, {
    maxBytes: X_IMAGE_MAX_BYTES,
    timeoutMs: 10_000,
    maxRedirects: 2,
    allowedContentTypes: X_IMAGE_TYPES,
    accept: "image/jpeg,image/png,image/webp",
    userAgent: "MealScoutSocialPublisher/1.0 (+https://www.mealscout.us)",
  });
  return { bytes: image.buffer, mimeType: image.contentType };
}

function buildXPostText(message: string, link?: string | null) {
  const normalizedMessage = String(message || "").trim();
  const normalizedLink = String(link || "").trim();
  const suffix = normalizedLink ? `\n${normalizedLink}` : "";
  if (suffix.length >= 280) {
    throw new Error("X post link is too long");
  }
  return `${normalizedMessage.slice(0, 280 - suffix.length)}${suffix}`;
}

export async function getActiveSocialConnection(
  restaurantId: string | null | undefined,
  platform: string,
) {
  if (!restaurantId) return null;
  const [connection] = await db
    .select()
    .from(socialPublishingConnections)
    .where(
      and(
        eq(socialPublishingConnections.restaurantId, restaurantId),
        eq(socialPublishingConnections.platform, platform),
        eq(socialPublishingConnections.status, "active"),
      ),
    )
    .limit(1);
  return connection || null;
}

export async function listSocialConnectionStatus(restaurantId: string) {
  const rows = await db
    .select({
      id: socialPublishingConnections.id,
      platform: socialPublishingConnections.platform,
      displayName: socialPublishingConnections.displayName,
      externalAccountId: socialPublishingConnections.externalAccountId,
      externalAccountUrl: socialPublishingConnections.externalAccountUrl,
      scopes: socialPublishingConnections.scopes,
      status: socialPublishingConnections.status,
      accessToken: socialPublishingConnections.accessToken,
      tokenExpiresAt: socialPublishingConnections.tokenExpiresAt,
      lastPublishAt: socialPublishingConnections.lastPublishAt,
      lastError: socialPublishingConnections.lastError,
      updatedAt: socialPublishingConnections.updatedAt,
    })
    .from(socialPublishingConnections)
    .where(eq(socialPublishingConnections.restaurantId, restaurantId));

  const byPlatform = new Map<string, (typeof rows)[number]>(
    rows.map((row: (typeof rows)[number]) => [row.platform, row]),
  );
  return ["facebook", "instagram", "x"].map((platform) => {
    const row = byPlatform.get(platform);
    const { accessToken: _accessToken, ...safeRow } = row || {};
    return {
      platform,
      connected: Boolean(row && row.status === "active" && row.accessToken),
      ...safeRow,
    };
  });
}

async function updateConnectionPublishState(
  connection: SocialPublishingConnection,
  result: PublishResult,
  database: any = db,
  preserveBindingTimestamp = false,
) {
  await database
    .update(socialPublishingConnections)
    .set({
      lastPublishAt: result.ok ? new Date() : connection.lastPublishAt,
      lastError: result.ok ? null : result.error,
      // A publish receipt does not change account authority or its approved binding.
      updatedAt: preserveBindingTimestamp ? connection.updatedAt : new Date(),
    })
    .where(eq(socialPublishingConnections.id, connection.id));
}

async function ensureXPublishingConnection(
  connection: SocialPublishingConnection,
): Promise<
  | { connection: SocialPublishingConnection }
  | { errorResult: PublishResult }
> {
  const scopes = new Set(
    (Array.isArray(connection.scopes)
      ? connection.scopes
      : String(connection.scopes || "").split(/[\s,]+/)
    ).map((scope) => String(scope).trim()),
  );
  const missingScopes = ["tweet.write", "media.write"].filter(
    (scope) => !scopes.has(scope),
  );
  if (missingScopes.length) {
    return {
      errorResult: {
        ok: false,
        manualRequired: true,
        error: `Reconnect X in MealScout to approve ${missingScopes.join(
          " and ",
        )} publishing access`,
      },
    };
  }

  const expiresAt = connection.tokenExpiresAt
    ? new Date(connection.tokenExpiresAt)
    : null;
  if (!expiresAt || expiresAt.getTime() > Date.now() + 60_000) {
    return { connection };
  }
  const readPeerRefresh = async () => {
    const [latest] = await db
      .select()
      .from(socialPublishingConnections)
      .where(eq(socialPublishingConnections.id, connection.id))
      .limit(1);
    const latestExpiry = latest?.tokenExpiresAt
      ? new Date(latest.tokenExpiresAt).getTime()
      : 0;
    return latest?.accessToken && latestExpiry > Date.now() + 60_000
      ? latest
      : null;
  };
  if (!connection.refreshToken) {
    return {
      errorResult: {
        ok: false,
        manualRequired: true,
        error: "Reconnect X in MealScout because its access token expired",
      },
    };
  }

  const clientId = process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID;
  const clientSecret =
    process.env.X_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET;
  if (!clientId) {
    return {
      errorResult: {
        ok: false,
        manualRequired: true,
        error: "X token renewal is not configured on this environment",
      },
    };
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: connection.refreshToken,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(
      `${clientId}:${clientSecret}`,
    ).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
  }

  try {
    const response = await providerFetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers,
      body: body.toString(),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok || !token?.access_token) {
      const peerRefresh = await readPeerRefresh();
      if (peerRefresh) return { connection: peerRefresh };
      return {
        errorResult: {
          ok: false,
          manualRequired: true,
          error:
            token?.error_description ||
            token?.error ||
            "Reconnect X because its access token could not be renewed",
        },
      };
    }
    const nextScopes = String(token.scope || "")
      .split(" ")
      .filter(Boolean);
    const values = {
      accessToken: String(token.access_token),
      refreshToken: String(token.refresh_token || connection.refreshToken),
      tokenExpiresAt: token.expires_in
        ? new Date(Date.now() + Number(token.expires_in) * 1000)
        : connection.tokenExpiresAt,
      scopes: nextScopes.length ? nextScopes : [...scopes],
      lastError: null,
      updatedAt: new Date(),
    };
    const [updated] = await db
      .update(socialPublishingConnections)
      .set(values)
      .where(
        and(
          eq(socialPublishingConnections.id, connection.id),
          connection.accessToken
            ? eq(socialPublishingConnections.accessToken, connection.accessToken)
            : isNull(socialPublishingConnections.accessToken),
        ),
      )
      .returning();
    if (updated) return { connection: updated };
    const peerRefresh = await readPeerRefresh();
    if (peerRefresh) return { connection: peerRefresh };
    return {
      errorResult: {
        ok: false,
        manualRequired: true,
        error: "X credentials changed during token renewal; retry owner publishing",
      },
    };
  } catch {
    const peerRefresh = await readPeerRefresh().catch(() => null);
    if (peerRefresh) return { connection: peerRefresh };
    return {
      errorResult: {
        ok: false,
        manualRequired: true,
        error:
          "X access could not be renewed. Reconnect X before publishing this approved post.",
      },
    };
  }
}

async function publishFacebook(
  row: SocialPostQueueItem,
  connection: SocialPublishingConnection,
): Promise<PublishResult> {
  const token = connection.accessToken;
  const pageId = connection.externalAccountId;
  if (!token || !pageId) {
    return { ok: false, error: "Facebook Page token is not connected" };
  }

  const endpoint = row.imageUrl
    ? `https://graph.facebook.com/v24.0/${pageId}/photos`
    : `https://graph.facebook.com/v24.0/${pageId}/feed`;
  const body = new URLSearchParams();
  body.set("access_token", token);
  if (row.imageUrl) {
    body.set("url", row.imageUrl);
    body.set("caption", [row.message, row.link].filter(Boolean).join(" "));
  } else {
    body.set("message", row.message);
    if (row.link) body.set("link", row.link);
  }

  let res: Response;
  try {
    res = await providerFetch(endpoint, { method: "POST", body });
  } catch {
    return {
      ok: false,
      manualRequired: true,
      error:
        "Facebook did not confirm whether the approved post was delivered. MealScout did not retry, preventing a possible duplicate; review Facebook manually.",
    };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data?.error?.message || "Facebook publish failed",
    };
  }
  const providerPostId = data?.post_id || data?.id || null;
  if (!providerPostId) {
    return {
      ok: false,
      manualRequired: true,
      error:
        "Facebook accepted the request without returning a post ID. Review Facebook manually before retrying.",
    };
  }
  return { ok: true, providerPostId };
}

async function publishInstagram(
  row: SocialPostQueueItem,
  connection: SocialPublishingConnection,
): Promise<PublishResult> {
  const token = connection.accessToken;
  const metadata = asRecord(connection.metadata);
  const igUserId =
    String(metadata.instagramBusinessAccountId || "").trim() ||
    String(connection.externalAccountId || "").trim();
  if (!token || !igUserId) {
    return {
      ok: false,
      error: "Instagram Business account is not connected",
    };
  }
  if (!row.imageUrl) {
    return {
      ok: false,
      manualRequired: true,
      error: "Instagram publishing requires a public image URL",
    };
  }

  const caption = [row.message, row.link].filter(Boolean).join("\n\n");
  const createBody = new URLSearchParams();
  createBody.set("access_token", token);
  createBody.set("image_url", row.imageUrl);
  createBody.set("caption", caption);

  let createRes: Response;
  try {
    createRes = await providerFetch(
      `https://graph.facebook.com/v24.0/${igUserId}/media`,
      { method: "POST", body: createBody },
    );
  } catch {
    return {
      ok: false,
      error: "Instagram media preparation failed before publication was confirmed",
    };
  }
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !createData?.id) {
    return {
      ok: false,
      error: createData?.error?.message || "Instagram media creation failed",
    };
  }

  const publishBody = new URLSearchParams();
  publishBody.set("access_token", token);
  publishBody.set("creation_id", createData.id);
  let publishRes: Response;
  try {
    publishRes = await providerFetch(
      `https://graph.facebook.com/v24.0/${igUserId}/media_publish`,
      { method: "POST", body: publishBody },
    );
  } catch {
    return {
      ok: false,
      manualRequired: true,
      error:
        "Instagram did not confirm whether the approved post was published. MealScout did not retry, preventing a possible duplicate; review Instagram manually.",
    };
  }
  const publishData = await publishRes.json().catch(() => ({}));
  if (!publishRes.ok) {
    return {
      ok: false,
      error: publishData?.error?.message || "Instagram publish failed",
    };
  }
  const providerPostId = publishData?.id || null;
  if (!providerPostId) {
    return {
      ok: false,
      manualRequired: true,
      error:
        "Instagram accepted the publish request without returning a media ID. Review Instagram manually before retrying.",
    };
  }
  return { ok: true, providerPostId };
}

async function publishX(
  row: SocialPostQueueItem,
  connection: SocialPublishingConnection,
): Promise<PublishResult> {
  const preparedConnection = await ensureXPublishingConnection(connection);
  if ("errorResult" in preparedConnection) {
    return preparedConnection.errorResult;
  }
  connection = preparedConnection.connection;
  const token = connection.accessToken;
  if (!token) return { ok: false, error: "X access token is not connected" };
  let mediaId: string | null = null;
  if (row.imageUrl) {
    try {
      const image = await readPublicSocialImage(row.imageUrl);
      const uploadRes = await providerFetch("https://api.x.com/2/media/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          media: image.bytes.toString("base64"),
          media_category: "tweet_image",
          media_type: image.mimeType,
          shared: false,
        }),
      });
      const uploadData = await uploadRes.json().catch(() => ({}));
      mediaId = String(uploadData?.data?.id || "").trim() || null;
      if (!uploadRes.ok || !mediaId) {
        return {
          ok: false,
          error:
            uploadData?.detail ||
            uploadData?.title ||
            uploadData?.errors?.[0]?.detail ||
            "X media upload failed",
        };
      }
      const processingState = String(
        uploadData?.data?.processing_info?.state || "succeeded",
      ).toLowerCase();
      if (processingState !== "succeeded") {
        return {
          ok: false,
          error: `X media is not ready (${processingState})`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "X media upload failed",
      };
    }
  }

  let text: string;
  try {
    text = buildXPostText(row.message, row.link);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "X post is invalid",
    };
  }
  let res: Response;
  try {
    res = await providerFetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      }),
    });
  } catch {
    return {
      ok: false,
      manualRequired: true,
      error:
        "X did not confirm whether the approved post was published. MealScout did not retry, preventing a possible duplicate; review X manually.",
    };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data?.detail || data?.title || "X publish failed" };
  }
  const providerPostId = data?.data?.id || null;
  if (!providerPostId) {
    return {
      ok: false,
      manualRequired: true,
      error:
        "X accepted the publish request without returning a post ID. Review X manually before retrying.",
    };
  }
  return {
    ok: true,
    providerPostId,
    providerUrl: providerPostId
      ? `https://x.com/i/web/status/${providerPostId}`
      : null,
  };
}

export async function publishSocialQueueItem(
  row: SocialPostQueueItem,
  nativeBoundary?: { connection: SocialPublishingConnection; database: any },
): Promise<PublishResult> {
  const connection = nativeBoundary?.connection || await getActiveSocialConnection(
    row.restaurantId,
    row.platform,
  );
  if (!connection || (nativeBoundary && (connection.restaurantId !== row.restaurantId || connection.platform !== row.platform || connection.status !== "active"))) {
    return {
      ok: false,
      manualRequired: true,
      error: `${row.platform} publishing is not connected for this business`,
    };
  }

  const platform = String(row.platform || "").toLowerCase();
  const result =
    platform === "facebook"
      ? await publishFacebook(row, connection)
      : platform === "instagram"
        ? await publishInstagram(row, connection)
        : platform === "x"
          ? await publishX(row, connection)
          : {
              ok: false as const,
              manualRequired: true,
              error: `Unsupported publishing platform: ${row.platform}`,
            };
  try {
    await updateConnectionPublishState(connection, result, nativeBoundary?.database || db, Boolean(nativeBoundary));
  } catch {
    // The queue row remains the source of truth. A secondary connection-status
    // write must never erase or misreport a provider result.
  }
  return result;
}

export async function markSocialPostResult(
  row: SocialPostQueueItem,
  result: PublishResult,
  database: any = db,
) {
  await database
    .update(socialPostQueue)
    .set({
      status: result.ok
        ? "posted"
        : result.manualRequired
          ? "manual_required"
          : "failed",
      errorMessage: result.ok ? null : result.error,
      metadata: {
        ...asRecord(row.metadata),
        providerPostId: result.ok ? result.providerPostId || null : null,
        providerUrl: result.ok ? result.providerUrl || null : null,
        processedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(socialPostQueue.id, row.id));
}
