import { apiRequest } from "@/lib/queryClient";
import {
  isLikelyCleanAffiliateTagSegment,
} from "@shared/cleanAffiliateLinks";

const AFFILIATE_REF_STORAGE_KEY = "affiliate_ref";

export function setAffiliateRef(ref: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (ref) {
      window.localStorage.setItem(AFFILIATE_REF_STORAGE_KEY, ref);
    } else {
      window.localStorage.removeItem(AFFILIATE_REF_STORAGE_KEY);
    }
  } catch {
    // Referral persistence is optional; it must not block signup or authentication.
  }
}

export function getStoredAffiliateRef(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(AFFILIATE_REF_STORAGE_KEY);
  } catch {
    return null;
  }
}

function normalizeSharePath(input: string): string {
  if (!input) return "/";

  if (input.startsWith("http")) {
    try {
      const url = new URL(input);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return "/";
    }
  }

  if (input.startsWith("/")) {
    return input;
  }

  return `/${input}`;
}

function isEligiblePublicShareTarget(path: string): boolean {
  const target = normalizeSharePath(path);
  const pathname = target.split(/[?#]/, 1)[0].toLowerCase();
  if (
    pathname === "/" ||
    pathname === "" ||
    pathname === "/ref" ||
    pathname.startsWith("/ref/") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/staff") ||
    pathname.startsWith("/api")
  ) {
    return false;
  }
  return true;
}

function buildClientFallbackAttributedUrl(
  targetPath: string,
  fallbackRef: string,
): string {
  const ref = String(fallbackRef || "").trim();
  if (!ref) {
    return new URL(normalizeSharePath(targetPath), window.location.origin).toString();
  }

  const sanitized = sanitizeTargetPathForTrackedLink(targetPath);
  const parsed = new URL(sanitized, window.location.origin);
  const normalizedPathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (normalizedPathname === "/") {
    return parsed.toString();
  }

  parsed.pathname = normalizedPathname;
  parsed.searchParams.delete("to");
  parsed.searchParams.set("ref", ref);
  return parsed.toString();
}

function sanitizeTargetPathForTrackedLink(targetPath: string): string {
  const parsed = new URL(targetPath, window.location.origin);
  parsed.searchParams.delete("to");
  parsed.searchParams.delete("ref");
  if (
    parsed.pathname.toLowerCase() === "/customer-signup" &&
    parsed.searchParams.get("role") === "business"
  ) {
    parsed.searchParams.delete("role");
  }
  const normalizedPathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${normalizedPathname}${parsed.search}${parsed.hash}`;
}

function isDirectAttributedShareLink(
  shareLink: string,
  targetPath: string,
): boolean {
  try {
    const generated = new URL(shareLink, window.location.origin);
    const expectedTarget = new URL(
      sanitizeTargetPathForTrackedLink(targetPath),
      window.location.origin,
    );
    const expectedBasePath = expectedTarget.pathname.replace(/\/+$/, "") || "/";
    const ref = String(generated.searchParams.get("ref") || "").trim();
    return (
      generated.pathname === expectedBasePath &&
      Boolean(ref) &&
      !generated.searchParams.has("to") &&
      generated.hash === expectedTarget.hash &&
      generated.pathname.toLowerCase() !== "/ref" &&
      !generated.pathname.toLowerCase().startsWith("/ref/") &&
      !shareLink.includes("to=") &&
      !shareLink.includes("%2F") &&
      !shareLink.includes("role=business")
    );
  } catch {
    return false;
  }
}

export async function getAffiliateShareUrl(input: string): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("Tracked links are available in the browser session only.");
  }

  const path = normalizeSharePath(input);

  const res = await apiRequest("POST", "/api/share/generate", {
    path,
  });
  const data = await res.json().catch(() => ({}));
  const shareLink = String(data?.shareLink || "").trim();
  if (!shareLink || !isDirectAttributedShareLink(shareLink, path)) {
    throw new Error(
      data?.message || "Unable to generate tracked link attribution.",
    );
  }
  return shareLink;
}

export async function resolveCanonicalShareUrl(
  input: string,
  options?: { fallbackRef?: string | null },
): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("Tracked links are available in the browser session only.");
  }

  const path = normalizeSharePath(input);
  try {
    return await getAffiliateShareUrl(path);
  } catch {
    const fallbackRef =
      String(options?.fallbackRef || "").trim() ||
      String(getStoredAffiliateRef() || "").trim();

    if (
      fallbackRef &&
      isLikelyCleanAffiliateTagSegment(fallbackRef) &&
      isEligiblePublicShareTarget(path)
    ) {
      return buildClientFallbackAttributedUrl(path, fallbackRef);
    }

    return new URL(path, window.location.origin).toString();
  }
}

export function resolveCanonicalShareUrlSync(
  input: string,
  options?: { fallbackRef?: string | null },
): string {
  if (typeof window === "undefined") {
    return normalizeSharePath(input);
  }

  const path = normalizeSharePath(input);
  const fallbackRef =
    String(options?.fallbackRef || "").trim() ||
    String(getStoredAffiliateRef() || "").trim();

  if (
    fallbackRef &&
    isLikelyCleanAffiliateTagSegment(fallbackRef) &&
    isEligiblePublicShareTarget(path)
  ) {
    return buildClientFallbackAttributedUrl(path, fallbackRef);
  }

  return new URL(path, window.location.origin).toString();
}
