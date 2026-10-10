const shouldThrottle = (key: string, ms: number) => {
  if (typeof window === "undefined") return false;
  const now = Date.now();
  const existing = sessionStorage.getItem(key);
  if (existing && now - Number(existing) < ms) {
    return true;
  }
  sessionStorage.setItem(key, String(now));
  return false;
};

export const trackUxEvent = async (
  eventName: string,
  properties?: Record<string, unknown>,
) => {
  if (!eventName) return;

  const throttleKey = `ux:${eventName}`;

  try {
    if (shouldThrottle(throttleKey, 500)) return;
    await fetch("/api/telemetry/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ eventName, properties: properties || {} }),
    });
  } catch {
    // Ignore telemetry failures
  }
};
