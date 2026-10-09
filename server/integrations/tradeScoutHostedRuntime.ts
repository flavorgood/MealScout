import type { RequestHandler } from "express";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

/** Verified existing Render service; transport identity is not profile or session authority. */
export const MEALSCOUT_RENDER_PRIVATE_SERVICE = Object.freeze({
  serviceId: "srv-d5escdh5pdvs73foo41g" as const,
  repositoryId: 1111403137,
  upstreamOrigin: "http://mealscout:10000",
});

type NativeUpgradeContext = Readonly<{
  signal: AbortSignal;
  accept(close: () => void): boolean;
}>;

export type MealScoutHostedRuntimeBinding = Readonly<{
  appId: "mealscout";
  host: string;
  profileId: string;
  ownerUserId: string;
  handle: RequestHandler;
  upgrade?: Readonly<{
    paths: readonly string[];
    handle(req: IncomingMessage, socket: Duplex, head: Buffer, context: NativeUpgradeContext): Promise<void>;
  }>;
}>;

export type MealScoutHostedRuntimeOptions = Readonly<{
  host: string;
  profileId: string;
  ownerUserId: string;
  /** Fixed existing native runtime, supplied only by the server owner. */
  upstreamOrigin: string;
  /** Explicit owner assembly for this exact existing private service only. */
  privateServiceBinding?: typeof MEALSCOUT_RENDER_PRIVATE_SERVICE.serviceId;
  responseIdleTimeoutMs?: number;
  /** Enable only after the fixed native runtime runs the reviewed pre101 repair. */
  nativeRealtimeAuthorization?: "mealscout-engine-session-v1";
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

function fixedOrigin(value: string, privateServiceBinding?: string): URL {
  if (privateServiceBinding !== undefined) {
    if (privateServiceBinding !== MEALSCOUT_RENDER_PRIVATE_SERVICE.serviceId ||
        value !== MEALSCOUT_RENDER_PRIVATE_SERVICE.upstreamOrigin) {
      throw new Error("MealScout private transport requires its exact existing Render service binding and origin");
    }
    return new URL(MEALSCOUT_RENDER_PRIVATE_SERVICE.upstreamOrigin);
  }
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

function nativeUpgradeHandler(host: string, upstream: URL) {
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  return (req: IncomingMessage, socket: Duplex, head: Buffer, context: NativeUpgradeContext): Promise<void> =>
    new Promise<void>((resolve) => {
      let nativeRequest: ReturnType<typeof httpRequest> | undefined;
      let nativeSocket: Socket | undefined;
      let nativeResponse: IncomingMessage | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let queueCheck: ReturnType<typeof setInterval> | undefined;
      let stopped = false;
      const close = () => {
        if (stopped) return;
        stopped = true;
        if (deadline) clearTimeout(deadline);
        if (queueCheck) clearInterval(queueCheck);
        context.signal.removeEventListener("abort", close);
        if (nativeSocket) {
          socket.unpipe(nativeSocket);
          nativeSocket.unpipe(socket);
        }
        nativeRequest?.destroy();
        nativeResponse?.destroy();
        nativeSocket?.destroy();
        socket.destroy();
        resolve();
      };
      socket.once("close", close);
      socket.once("end", close);
      socket.on("error", close);
      context.signal.addEventListener("abort", close, { once: true });
      if (context.signal.aborted || socket.destroyed) { close(); return; }
      try {
        const target = req.url || "";
        const parsed = new URL(target, "http://native.invalid");
        const key = req.headers["sec-websocket-key"];
        if (exactHost(req.headers.host) !== host || req.method !== "GET" ||
            req.httpVersion !== "1.1" || !target.startsWith("/") || target.startsWith("//") ||
            /[\u0000-\u0020\u007f]/.test(target) || target.split("?", 1)[0] !== "/socket.io/" ||
            parsed.pathname !== "/socket.io/" ||
            parsed.searchParams.getAll("EIO").length !== 1 || parsed.searchParams.get("EIO") !== "4" ||
            parsed.searchParams.getAll("transport").length !== 1 || parsed.searchParams.get("transport") !== "websocket" ||
            parsed.searchParams.getAll("sid").length > 1 ||
            (parsed.searchParams.has("sid") && !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.searchParams.get("sid") || "")) ||
            (req.headers.origin !== `https://${host}` && req.headers.origin !== `https://${host}:443`) ||
            String(req.headers.upgrade || "").toLowerCase() !== "websocket" ||
            !String(req.headers.connection || "").toLowerCase().split(",").some(value => value.trim() === "upgrade") ||
            req.headers["sec-websocket-version"] !== "13" || typeof key !== "string" ||
            !/^[A-Za-z0-9+/]{22}==$/.test(key) || head.length > 4096 ||
            req.headers["transfer-encoding"] !== undefined ||
            (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) {
          close();
          return;
        }
        const expectedAccept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        const headers = transportHeaders(req, true);
        headers.push("Host", host, "X-Forwarded-Host", host, "X-Forwarded-Proto", "https",
          "Connection", "Upgrade", "Upgrade", "websocket");
        if (req.socket.remoteAddress) headers.push("X-Forwarded-For", req.socket.remoteAddress);
        socket.pause();
        deadline = setTimeout(close, 5000);
        deadline.unref();
        // URL fixes connection/TLS authority, while the public Host is retained.
        // No credentials, store, Trade identity or client-selected target enter here.
        nativeRequest = send(upstream, {
          method: "GET", path: target, headers, agent: false, maxHeaderSize: 16 * 1024,
          ...(upstream.protocol === "https:" ? {
            servername: isIP(upstream.hostname.replace(/^\[|\]$/g, "")) ? "" : upstream.hostname,
          } : {}),
        });
        nativeRequest.on("error", close);
        nativeRequest.once("response", incoming => {
          nativeResponse = incoming;
          close();
        });
        nativeRequest.once("upgrade", (incoming, upgraded, nativeHead) => {
          if (stopped) { upgraded.destroy(); return; }
          nativeResponse = incoming;
          nativeSocket = upgraded;
          upgraded.pause();
          upgraded.on("error", close);
          upgraded.once("end", close);
          upgraded.once("close", close);
          if (incoming.statusCode !== 101 || incoming.headers["sec-websocket-accept"] !== expectedAccept ||
              String(incoming.headers.upgrade || "").toLowerCase() !== "websocket" ||
              !String(incoming.headers.connection || "").toLowerCase().split(",")
                .some(value => value.trim() === "upgrade") || nativeHead.length > 64 * 1024) {
            close();
            return;
          }
          // The reviewed fixed native runtime has completed session/account and
          // existing Engine.IO sid/host/origin checks before its own 101.
          // Attach the paused client leg before accept() can resume it; hold all
          // original head/frame bytes until the gateway grants this lease.
          socket.pipe(upgraded, { end: false });
          socket.pause();
          let accepted = false;
          try { accepted = context.accept(close); } catch { close(); return; }
          if (!accepted || stopped || context.signal.aborted || socket.destroyed) { close(); return; }
          if (deadline) clearTimeout(deadline);
          deadline = undefined;
          const nativeHeaders = transportHeaders(incoming, false);
          const responseLines = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket"];
          for (let index = 0; index < nativeHeaders.length; index += 2) {
            responseLines.push(`${nativeHeaders[index]}: ${nativeHeaders[index + 1]}`);
          }
          socket.write(Buffer.from(responseLines.join("\r\n") + "\r\n\r\n", "latin1"));
          if (head.length) upgraded.write(head);
          if (nativeHead.length) socket.write(nativeHead);
          queueCheck = setInterval(() => {
            if (upgraded.writableLength > 256 * 1024 || socket.writableLength > 256 * 1024) close();
          }, 250);
          queueCheck.unref();
          upgraded.pipe(socket);
          socket.resume();
          // Setup is complete. Gateway owns the active lease, byte ceilings,
          // authority rechecks and 15-minute reconnect; teardown stays attached.
          resolve();
        });
        nativeRequest.end();
      } catch { close(); }
    });
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
  const upstream = fixedOrigin(options.upstreamOrigin, options.privateServiceBinding);
  if (upstream.hostname.toLowerCase() === host) {
    throw new Error("MealScout upstream must be separate from its hosted entry point");
  }
  const idleTimeout = options.responseIdleTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 120_000) {
    throw new Error("Invalid MealScout native response idle timeout");
  }
  if (options.nativeRealtimeAuthorization !== undefined &&
      options.nativeRealtimeAuthorization !== "mealscout-engine-session-v1") {
    throw new Error("Unreviewed MealScout native realtime authorization");
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
      ...(upstream.protocol === "https:" ? {
        servername: isIP(upstream.hostname.replace(/^\[|\]$/g, "")) ? "" : upstream.hostname,
      } : {}),
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
    ...(options.nativeRealtimeAuthorization === "mealscout-engine-session-v1" ? {
      upgrade: Object.freeze({ paths: Object.freeze(["/socket.io"]), handle: nativeUpgradeHandler(host, upstream) }),
    } : {}),
  });
}
