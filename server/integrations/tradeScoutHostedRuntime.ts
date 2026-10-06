import type { RequestHandler } from "express";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

export type MealScoutHostedRuntimeBinding = Readonly<{
  appId: "mealscout";
  host: string;
  profileId: string;
  ownerUserId: string;
  handle: RequestHandler;
}>;

export type MealScoutHostedRuntimeOptions = Readonly<{
  host: string;
  profileId: string;
  ownerUserId: string;
  /** Fixed existing native runtime, supplied only by the server owner. */
  upstreamOrigin: string;
  responseIdleTimeoutMs?: number;
}>;

const hopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "transfer-encoding", "upgrade",
]);

function exactHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.toLowerCase().replace(/:(?:80|443)$/, "");
  return host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    ? host : null;
}

function fixedOrigin(value: string): URL {
  const origin = new URL(value);
  const localHttp = origin.protocol === "http:" &&
    (origin.hostname === "127.0.0.1" || origin.hostname === "[::1]");
  if ((origin.protocol !== "https:" && !localHttp) ||
      origin.username || origin.password || origin.pathname !== "/" ||
      origin.search || origin.hash) {
    throw new Error("MealScout requires a fixed HTTPS or literal-loopback runtime origin");
  }
  return origin;
}

function transportHeaders(message: IncomingMessage, request: boolean): string[] {
  const excluded = new Set(hopHeaders);
  for (const name of String(message.headers.connection || "").split(",")) {
    excluded.add(name.trim().toLowerCase());
  }
  const headers: string[] = [];
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const lower = name.toLowerCase();
    if (excluded.has(lower) || (request &&
        (lower === "host" || lower === "forwarded" || lower.startsWith("x-forwarded-")))) {
      continue;
    }
    headers.push(name, message.rawHeaders[index + 1]);
  }
  return headers;
}

function unsupportedTransferCoding(message: IncomingMessage): boolean {
  const coding = message.headers["transfer-encoding"];
  return coding !== undefined && String(coding).trim().toLowerCase() !== "chunked";
}

function trailerPairs(message: IncomingMessage): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < message.rawTrailers.length; index += 2) {
    pairs.push([message.rawTrailers[index], message.rawTrailers[index + 1]]);
  }
  return pairs;
}

/**
 * A complete HTTP handler for the pinned TradeScout register(binding) contract.
 * Import/construction starts no listener, worker, database or provider call.
 * TradeScout's current profile/domain gate must run before this handler.
 * Native MealScout owns every route, cookie, session, permission and payment.
 */
export function createMealScoutHostedRuntimeBinding(
  options: MealScoutHostedRuntimeOptions,
): MealScoutHostedRuntimeBinding {
  const host = exactHost(options.host);
  if (!host || host === "thetradescout.com" || host === "www.thetradescout.com" ||
      host === "tradescoutai.onrender.com" ||
      typeof options.profileId !== "string" || !options.profileId.trim() ||
      typeof options.ownerUserId !== "string" || !options.ownerUserId.trim()) {
    throw new Error("MealScout requires exact existing profile/domain/owner routing identities");
  }
  const upstream = fixedOrigin(options.upstreamOrigin);
  if (upstream.hostname.toLowerCase() === host) {
    throw new Error("MealScout upstream must be separate from its hosted entry point");
  }
  const idleTimeout = options.responseIdleTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 120_000) {
    throw new Error("Invalid MealScout native response idle timeout");
  }
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  const handle: RequestHandler = (req, res) => {
    const unavailable = (status: number, message: string) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.statusCode = status;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(message);
    };
    if (exactHost(req.headers.host) !== host) {
      unavailable(404, "App domain unavailable");
      return;
    }
    if (req.method === "CONNECT" || req.headers.upgrade ||
        String(req.headers.connection || "").toLowerCase().split(",")
          .some(value => value.trim() === "upgrade")) {
      unavailable(426, "MealScout hosted HTTP upgrades are unsupported");
      return;
    }
    const originalUrl = req.originalUrl || req.url;
    if (!originalUrl.startsWith("/") || originalUrl.startsWith("//") ||
        /[\u0000-\u0020\u007f]/.test(originalUrl)) {
      unavailable(400, "Invalid app request target");
      return;
    }
    // Signed webhooks cannot be reconstructed from JSON or a consumed stream.
    const bodyExpected = Number(req.headers["content-length"] || 0) > 0 ||
      Boolean(req.headers["transfer-encoding"]);
    if (req.body !== undefined || (bodyExpected && (req.readableDidRead || req.readableEnded))) {
      unavailable(503, "Native app requires the original request stream");
      return;
    }
    if (req.aborted || res.destroyed) return;
    if (unsupportedTransferCoding(req)) {
      unavailable(501, "Additional app transfer codings are unsupported");
      return;
    }

    const headers = transportHeaders(req, true);
    // GET/HEAD/DELETE do not default to chunked ClientRequest framing.
    // Reframe the original decoded stream for every method that carries it.
    if (bodyExpected && req.headers["content-length"] === undefined) {
      headers.push("Transfer-Encoding", "chunked");
    }
    headers.push("Host", host, "X-Forwarded-Host", host, "X-Forwarded-Proto", "https");
    // Never promote caller forwarding claims to native proxy/session authority.
    // Native trust-proxy sees this captured peer; real edge client-IP policy is
    // an operator compatibility input, not an invented forwarded identity.
    if (req.socket.remoteAddress) {
      headers.push("X-Forwarded-For", req.socket.remoteAddress);
    }

    let nativeResponse: IncomingMessage | undefined;
    let nativeSocket: Socket | undefined;
    let stopped = false;
    let requestComplete = false;
    let responseComplete = false;
    let connectionDeadline: ReturnType<typeof setTimeout> | undefined;
    const connected = () => {
      if (connectionDeadline) clearTimeout(connectionDeadline);
      connectionDeadline = undefined;
    };
    const removeListeners = () => {
      connected();
      nativeSocket?.off("connect", connected);
      nativeSocket?.off("secureConnect", connected);
      req.off("aborted", cancel);
      req.off("error", cancel);
      req.off("end", finishRequest);
      res.off("close", responseClosed);
      res.off("error", cancel);
      res.off("finish", responseFinished);
    };
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      removeListeners();
      req.unpipe(nativeRequest);
      nativeRequest.destroy();
      nativeResponse?.destroy();
    };
    const fail = () => {
      if (stopped) return;
      cancel();
      unavailable(503, "Native app temporarily unavailable");
    };
    const responseClosed = () => { if (!res.writableFinished) cancel(); };
    const complete = () => {
      if (!requestComplete || !responseComplete || stopped) return;
      stopped = true;
      removeListeners();
    };
    const responseFinished = () => {
      if (stopped) return;
      responseComplete = true;
      complete();
    };
    const finishRequest = () => {
      if (stopped) return;
      if (req.rawTrailers.length) nativeRequest.addTrailers(trailerPairs(req));
      nativeRequest.end();
      requestComplete = true;
      complete();
    };

    const nativeRequest = send({
      protocol: upstream.protocol,
      hostname: upstream.hostname.startsWith("[") ? upstream.hostname.slice(1, -1) : upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: originalUrl,
      headers,
      agent: false,
    });
    nativeRequest.once("error", fail);
    nativeRequest.once("upgrade", (_response, socket) => {
      socket.destroy();
      fail();
    });
    nativeRequest.setTimeout(idleTimeout, fail);
    connectionDeadline = setTimeout(fail, 10_000);
    connectionDeadline.unref();
    nativeRequest.once("socket", socket => {
      if (stopped) { socket.destroy(); return; }
      nativeSocket = socket;
      socket.once(upstream.protocol === "https:" ? "secureConnect" : "connect", connected);
      if (upstream.protocol === "http:" && !socket.connecting) connected();
    });
    req.once("aborted", cancel);
    req.once("error", cancel);
    res.once("close", responseClosed);
    res.once("error", cancel);
    res.once("finish", responseFinished);

    nativeRequest.once("response", (incoming) => {
      if (stopped) { incoming.destroy(); return; }
      nativeResponse = incoming;
      connected();
      incoming.once("error", fail);
      incoming.once("aborted", fail);
      if (unsupportedTransferCoding(incoming)) {
        cancel();
        unavailable(502, "Additional native transfer codings are unsupported");
        return;
      }
      try {
        res.writeHead(
          incoming.statusCode ?? 502,
          incoming.statusMessage ?? "",
          transportHeaders(incoming, false),
        );
      } catch { fail(); return; }
      incoming.once("end", () => {
        if (stopped) return;
        if (incoming.rawTrailers.length) res.addTrailers(trailerPairs(incoming));
        res.end();
      });
      // Streams/ranges/media are relayed with backpressure, never accumulated.
      incoming.pipe(res, { end: false });
    });
    if (req.readableEnded) finishRequest();
    else {
      req.once("end", finishRequest);
      req.pipe(nativeRequest, { end: false });
    }
  };

  return Object.freeze({
    appId: "mealscout",
    host,
    profileId: options.profileId,
    ownerUserId: options.ownerUserId,
    handle,
  });
}
