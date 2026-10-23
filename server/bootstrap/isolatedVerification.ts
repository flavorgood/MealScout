const LIVE_MEALSCOUT_RENDER_SERVICE_ID = "srv-d5escdh5pdvs73foo41g";
const ISOLATED_RENDER_SERVICE_NAME = "mealscout-isolated-verification";

export function isRenderService(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.RENDER === "true" || Boolean(environment.RENDER_SERVICE_ID);
}

export function isIsolatedVerificationMode(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const enabled =
    String(environment.MEALSCOUT_ISOLATED_VERIFICATION || "")
      .trim()
      .toLowerCase() === "true";

  if (enabled && environment.RENDER_SERVICE_ID === LIVE_MEALSCOUT_RENDER_SERVICE_ID) {
    throw new Error("Isolated verification cannot disable jobs on the live MealScout service");
  }
  if (
    enabled &&
    isRenderService(environment) &&
    environment.RENDER_SERVICE_NAME !== ISOLATED_RENDER_SERVICE_NAME
  ) {
    throw new Error("Isolated verification requires the dedicated Render service name");
  }

  return enabled;
}

export function useLocalPostgresRuntime(
  databaseUrl: string,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (environment.MEALSCOUT_LOCAL_POSTGRES_RUNTIME !== "true") return false;
  if (!isIsolatedVerificationMode(environment) || isRenderService(environment)) {
    throw new Error("Local PostgreSQL runtime requires an isolated non-Render service");
  }
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Local PostgreSQL runtime requires a PostgreSQL URL");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Local PostgreSQL runtime rejects URL parameters and fragments");
  }
  if (!["127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Local PostgreSQL runtime requires a numeric loopback address");
  }
  if (!/^\/mealscout_isolated_[a-z0-9_]+$/.test(parsed.pathname)) {
    throw new Error("Local PostgreSQL runtime requires an isolated database name");
  }
  return true;
}

export function assertIsolatedVerificationDatabaseUrl(
  databaseUrl: string,
  environment: Record<string, string | undefined> = process.env,
): void {
  if (!isIsolatedVerificationMode(environment)) return;

  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Isolated verification requires a PostgreSQL URL");
  }
  if (!/^\/mealscout_isolated_[a-z0-9_]+$/.test(parsed.pathname)) {
    throw new Error("Isolated verification requires a mealscout_isolated_* database");
  }
  if (parsed.hash) {
    throw new Error("Isolated verification rejects database URL fragments");
  }

  const local = ["127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (local) {
    if (isRenderService(environment) || parsed.search) {
      throw new Error("Isolated local database requires a parameter-free non-Render URL");
    }
    return;
  }

  if (!/\.neon\.tech$/i.test(parsed.hostname)) {
    throw new Error("Hosted isolated verification requires a Neon database URL");
  }
  for (const [key, value] of parsed.searchParams) {
    if (!(
      (key === "sslmode" && value === "require") ||
      (key === "channel_binding" && value === "require")
    )) {
      throw new Error("Hosted isolated verification rejects database URL overrides");
    }
  }
}
