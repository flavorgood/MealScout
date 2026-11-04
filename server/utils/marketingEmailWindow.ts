const FALLBACK_TIMEZONE = "America/Chicago";

function readHourEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(23, Math.floor(raw)));
}

export const MARKETING_EMAIL_TIMEZONE =
  String(
    process.env.SCHEDULER_TIMEZONE ||
      process.env.CRON_TIMEZONE ||
      FALLBACK_TIMEZONE,
  ).trim() || FALLBACK_TIMEZONE;

export const MARKETING_EMAIL_WINDOW_START_HOUR = readHourEnv(
  "MARKETING_EMAIL_WINDOW_START_HOUR",
  8,
);

export const MARKETING_EMAIL_WINDOW_END_HOUR = readHourEnv(
  "MARKETING_EMAIL_WINDOW_END_HOUR",
  20,
);

export function getHourInTimezone(
  timeZone: string,
  date: Date = new Date(),
): number {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        hour12: false,
        timeZone,
      }).format(date),
    );
    return Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : date.getHours();
  } catch {
    return date.getHours();
  }
}

export function isHourWithinWindow(
  hour: number,
  startHour: number,
  endHour: number,
): boolean {
  if (startHour === endHour) return true;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

export function isWithinMarketingEmailWindow(now: Date = new Date()): boolean {
  const localHour = getHourInTimezone(MARKETING_EMAIL_TIMEZONE, now);
  return isHourWithinWindow(
    localHour,
    MARKETING_EMAIL_WINDOW_START_HOUR,
    MARKETING_EMAIL_WINDOW_END_HOUR,
  );
}

export function describeMarketingEmailWindow(): string {
  return `${MARKETING_EMAIL_WINDOW_START_HOUR}:00-${MARKETING_EMAIL_WINDOW_END_HOUR}:00 ${MARKETING_EMAIL_TIMEZONE}`;
}

export const AUTOMATED_MARKETING_EMAILS_FLAG =
  "AUTOMATED_MARKETING_EMAILS_ENABLED";

// On by default (owner direction 2026-11-04, set-it-and-forget-it): the
// drip/automated marketing system runs unless the flag is explicitly set
// to "false". The explicit "false" remains the kill-switch.
export function areAutomatedMarketingEmailsEnabled(): boolean {
  return (
    String(process.env[AUTOMATED_MARKETING_EMAILS_FLAG] || "")
      .trim()
      .toLowerCase() !== "false"
  );
}

export function describeAutomatedMarketingEmailFlag(): string {
  return `${AUTOMATED_MARKETING_EMAILS_FLAG}=false`;
}
