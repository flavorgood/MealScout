import type { Express, Request, Response } from "express";

import { loadPublicSeoLandingData } from "../services/publicSeoLandingData";
import type {
  PublicSeoLandingRequest,
  PublicSeoLandingRouteKey,
} from "../services/publicSeoLandingModel";
import {
  publicSeoCityRequest,
  publicSeoCuisineRequest,
  publicSeoFoodTruckCuisineRequest,
} from "../services/publicSeoLandingModel";

type PublicSeoRequestFactory = (req: Request) => PublicSeoLandingRequest;
export type PublicSeoLandingLoader = typeof loadPublicSeoLandingData;

const cityRequest =
  (routeKey: Exclude<PublicSeoLandingRouteKey, "cuisine" | "food-trucks-cuisine">): PublicSeoRequestFactory =>
  (req) => publicSeoCityRequest(routeKey, String(req.params.city ?? ""));

const cuisineRequest: PublicSeoRequestFactory = (req) =>
  publicSeoCuisineRequest(
    String(req.params.cuisine ?? ""),
    req.params.city === undefined ? null : String(req.params.city),
  );

const foodTruckCuisineRequest: PublicSeoRequestFactory = (req) =>
  publicSeoFoodTruckCuisineRequest(req.params.city, req.params.cuisine);

const registerLandingRoute = (
  app: Express,
  path: string,
  requestFor: PublicSeoRequestFactory,
  loadLanding: PublicSeoLandingLoader,
) => {
  app.get(path, async (req: Request, res: Response) => {
    try {
      const resolution = await loadLanding(requestFor(req));
      if (resolution.kind === "not_found") {
        const label = resolution.reason === "city" ? "City" : "Cuisine";
        return res.status(404).json({ message: `${label} not found` });
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json(resolution.payload);
    } catch (error) {
      console.error(`[public-seo] ${path} failed`, error);
      res.setHeader("Retry-After", "60");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex,follow");
      return res
        .status(503)
        .json({ message: "Page data is temporarily unavailable" });
    }
  });
};

export function registerPublicSeoLandingRoutes(
  app: Express,
  loadLanding: PublicSeoLandingLoader = loadPublicSeoLandingData,
) {
  const register = (path: string, requestFor: PublicSeoRequestFactory) =>
    registerLandingRoute(app, path, requestFor, loadLanding);

  register(
    "/api/public/seo/food-trucks/:city/:cuisine",
    foodTruckCuisineRequest,
  );
  register(
    "/api/public/seo/food-trucks/:city",
    cityRequest("food-trucks"),
  );
  register(
    "/api/public/seo/food-trucks-today/:city",
    cityRequest("food-trucks-today"),
  );
  register(
    "/api/public/seo/food-truck-catering/:city",
    cityRequest("food-truck-catering"),
  );
  register(
    "/api/public/seo/book-food-truck/:city",
    cityRequest("book-food-truck"),
  );
  register(
    "/api/public/seo/deals-today/:city",
    cityRequest("deals-today"),
  );
  register(
    "/api/public/seo/events-today/:city",
    cityRequest("events-today"),
  );
  register(
    "/api/public/seo/city/:city/food",
    cityRequest("city"),
  );
  register(
    "/api/public/seo/cuisine/:cuisine/:city?",
    cuisineRequest,
  );
  register(
    "/api/public/seo/locations-with-trucks/:city",
    cityRequest("locations-with-trucks"),
  );
}
