import type { RequestHandler } from "express";
import { distributedRateLimit } from "./distributedRateLimit";

// Live GPS updates are a stream, separate from saved-profile content edits.
// Start and movement share one bounded account/truck counter.
export const liveRestaurantLocationLimiter = distributedRateLimit({
  scope: "restaurant:live-location",
  limit: 60,
  windowMs: 60_000,
  key: (req) => `${String(req.user?.id || req.ip || "unknown")}:${req.params.restaurantId}`,
});

export function savedRestaurantLocationLimiter(contentLimiter: RequestHandler): RequestHandler {
  return (req, res, next) => {
    // Mounted only at /api/restaurants/:restaurantId/location. POST has its
    // authenticated live limiter at the route; PATCH retains the content cap.
    if (req.method === "POST") return next();
    return contentLimiter(req, res, next);
  };
}
