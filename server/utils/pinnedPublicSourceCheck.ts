import * as https from "node:https";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { isBlockedIp, resolvePublicHostname } from "./websiteProfileImport";

export const SOURCE_CHECK_MAX_BYTES = 512 * 1024;
export type SourceCheckReceipt = {
  sourceUrl: string; checkedAt: string; httpStatus: number | null;
  bodyHash: string | null; byteCount: number; outcome: "UNVERIFIED";
  availability: "reachable" | "unavailable"; reason: string;
};
export function sourceCheckUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search
      || (url.port && url.port !== "443")) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}
export function hasPublicSourceAccessBarrier(url: URL, boundedHtml: string): boolean {
  if (/(?:^|\/)(?:login|log-in|signin|sign-in|checkpoint|challenge)(?:\/|$)/i.test(url.pathname)) return true;
  // Only dominant page signals count. Optional sign-in navigation and script
  // feature names such as checkout-cloudflare-challenge-recovery are normal UI.
  const $ = cheerio.load(boundedHtml.slice(0, 16384));
  const signals = [$("title").first().text(), $("h1").first().text()]
    .map(value => value.replace(/\s+/g, " ").trim());
  return signals.some(value => /^(?:(?:please\s+)?(?:log\s*in|sign\s*in)(?:\s|$|[|:-])|access denied(?:\s|$)|(?:please\s+)?verify (?:that )?you are human(?:\s|$)|security (?:check|verification)(?:\s|$)|just a moment(?:\s|$|[.!])|enable javascript and cookies to continue(?:\s|$))/i.test(value));
}

// One deadline covers DNS, all redirect hops, headers, and the complete body.
// The socket uses the validated address; TLS still authenticates the URL host.
export async function checkPinnedPublicSource(startUrl: string, options: {
  timeoutMs?: number; resolve?: typeof resolvePublicHostname; request?: typeof https.request;
} = {}): Promise<SourceCheckReceipt> {
  const receipt: SourceCheckReceipt = { sourceUrl: sourceCheckUrl(startUrl) || "",
    checkedAt: new Date().toISOString(), httpStatus: null, bodyHash: null,
    byteCount: 0, outcome: "UNVERIFIED", availability: "unavailable", reason: "unavailable" };
  if (!receipt.sourceUrl) return { ...receipt, reason: "unsafe_url" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
  const resolveHost = options.resolve || resolvePublicHostname;
  const request = options.request || https.request;
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  });
  // A late resolver completion has no continuation that can start a socket.
  try {
    let current = receipt.sourceUrl;
    for (let hop = 0; hop <= 2; hop++) {
      const safe = sourceCheckUrl(current);
      if (!safe) throw new Error("unsafe_redirect");
      const url = new URL(safe);
      const records = await Promise.race([resolveHost(url.hostname), aborted]);
      if (!records.length || records.some(r => isBlockedIp(r.address))) throw new Error("blocked_address");
      if (controller.signal.aborted) throw new Error("timeout");
      const record = records[0];
      const result = await Promise.race([new Promise<{ redirect?: string; hash?: string; bytes?: number; login?: boolean }>((resolve, reject) => {
        const req = request({ hostname: record.address, family: record.family,
          port: 443, servername: url.hostname, rejectUnauthorized: true, agent: false,
          path: url.pathname, method: "GET", signal: controller.signal,
          headers: { Host: url.host, Accept: "text/html,application/json;q=0.8,text/plain;q=0.7", "Accept-Encoding": "identity", "User-Agent": "MealScout-Public-Link-Check/1.0", Connection: "close" } }, res => {
          receipt.httpStatus = res.statusCode || 0;
          if (receipt.httpStatus >= 300 && receipt.httpStatus < 400) {
            const location = res.headers.location; res.destroy();
            if (!location || hop === 2) return reject(new Error("redirect_limit"));
            return resolve({ redirect: new URL(location, url).toString() });
          }
          if (receipt.httpStatus < 200 || receipt.httpStatus >= 300) { res.destroy(); return reject(new Error("http_unavailable")); }
          if (Number(res.headers["content-length"] || 0) > SOURCE_CHECK_MAX_BYTES) { res.destroy(); return reject(new Error("size_limit")); }
          const hash = createHash("sha256"); let bytes = 0; let snippet = "";
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > SOURCE_CHECK_MAX_BYTES) { res.destroy(); reject(new Error("size_limit")); return; }
            hash.update(chunk);
            if (snippet.length < 16384) snippet += chunk.toString("utf8").slice(0, 16384 - snippet.length);
          });
          res.on("end", () => resolve({ hash: hash.digest("hex"), bytes,
            login: hasPublicSourceAccessBarrier(url, snippet) }));
          res.on("error", reject);
          res.on("aborted", () => reject(new Error("incomplete_body")));
        });
        req.on("error", reject); req.end();
      }), aborted]);
      if (result.redirect) { current = result.redirect; continue; }
      receipt.bodyHash = result.hash || null; receipt.byteCount = result.bytes || 0;
      receipt.availability = result.login ? "unavailable" : "reachable";
      receipt.reason = result.login ? "login_or_access_barrier" : "link_response_only_not_verified_facts";
      return receipt;
    }
  } catch (error) {
    const reason = controller.signal.aborted ? "timeout" : String((error as Error)?.message || "unavailable");
    receipt.reason = ["unsafe_redirect", "blocked_address", "redirect_limit", "http_unavailable", "size_limit", "incomplete_body", "timeout"].includes(reason) ? reason : "unavailable";
  } finally { clearTimeout(timer); controller.abort(); }
  return receipt;
}
