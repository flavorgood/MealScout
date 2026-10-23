import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./ui-refinement.css";
import "./pages/welcome.css";
import { LocaleProvider } from "@/lib/i18n";

function installPerformanceCompatShim() {
  if (typeof window === "undefined") return;
  const perf = window.performance as Performance | undefined;
  if (!perf) return;
  const perfAny = perf as any;

  if (typeof perf.mark !== "function") {
    perfAny.mark = () => {
      // no-op compatibility fallback
      return undefined;
    };
  }

  if (typeof perf.measure !== "function") {
    perfAny.measure = () => {
      // no-op compatibility fallback
      return undefined;
    };
  }

  if (typeof perf.clearMarks !== "function") {
    perfAny.clearMarks = () => {
      // no-op compatibility fallback
    };
  }

  if (typeof perf.clearMeasures !== "function") {
    perfAny.clearMeasures = () => {
      // no-op compatibility fallback
    };
  }
}

installPerformanceCompatShim();

function shouldEnablePwaRuntime() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host === "www.mealscout.us" || host === "mealscout.us") return true;
  if (host === "mealscout.onrender.com") return true;
  return false;
}

function ensureManifestLink() {
  if (typeof document === "undefined") return;
  const existing = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = "/manifest.json";
  document.head.appendChild(link);
}

if (import.meta.env.PROD) {
  const reloadKey = `mealscout_chunk_recovery:${window.location.pathname}`;
  const maxRecoveryAttempts = 3;
  const nextRecoveryAttempt = () => {
    try {
      const current = Number(sessionStorage.getItem(reloadKey) || "0");
      if (!Number.isFinite(current) || current < 0) return 1;
      if (current >= maxRecoveryAttempts) return null;
      const next = current + 1;
      sessionStorage.setItem(reloadKey, String(next));
      return next;
    } catch {
      return 1;
    }
  };

  const clearRuntimeCaches = async () => {
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations.map((registration) => registration.unregister()),
        );
      }
    } catch {
      // Ignore cleanup failures. The reload is still the important recovery.
    }
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith("mealscout-sw-"))
            .map((key) => caches.delete(key)),
        );
      }
    } catch {
      // Ignore cleanup failures.
    }
  };

  const reloadWithBust = async () => {
    const attempt = nextRecoveryAttempt();
    if (attempt === null) return;
    await clearRuntimeCaches();
    const url = new URL(window.location.href);
    url.searchParams.set("reload", `${Date.now()}-${attempt}`);
    window.location.replace(url.toString());
  };

  const isChunkError = (message?: string) =>
    Boolean(
      message &&
        (message.includes("Failed to fetch dynamically imported module") ||
          message.includes("Loading chunk") ||
          message.includes("module script") ||
          message.includes("MIME type")),
    );

  window.addEventListener("vite:preloadError", () => {
    void reloadWithBust();
  });
  window.addEventListener("error", (event) => {
    if (isChunkError(event.message)) {
      void reloadWithBust();
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as Error | string | undefined;
    const message =
      typeof reason === "string" ? reason : reason?.message || "";
    if (isChunkError(message)) {
      void reloadWithBust();
    }
  });
}

// Keep manifest for installability, but disable SW runtime caching to prevent
// stale chunk and MIME-type failures after deploys.
if (import.meta.env.PROD && shouldEnablePwaRuntime()) {
  ensureManifestLink();
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      )
      .catch(() => {
        // ignore
      });

    if ("caches" in window) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {
          // ignore
        });
    }
  });
}

createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
);
