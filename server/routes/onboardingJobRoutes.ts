import { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z, ZodError } from "zod";
import { createOnboardingJobService, OnboardingJobError, type OnboardingDatabase } from "../services/onboardingJobs";

export function registerOnboardingJobRoutes(app: Express, dependencies: {
  database: OnboardingDatabase;
  isAuthenticated: RequestHandler;
  limiter: RequestHandler;
  enabled: () => boolean;
}) {
  const router = Router({ mergeParams: true });
  const service = createOnboardingJobService(dependencies.database);
  const route = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    (req, res, next) => { void Promise.resolve().then(() => fn(req, res)).catch(next); };
  const scope = (req: Request) => ({
    ownerId: String((req as Request & { user?: { id?: string } }).user?.id || ""),
    restaurantId: z.string().uuid().parse(req.params.restaurantId),
  });
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  router.use(dependencies.isAuthenticated, dependencies.limiter);
  // This stays disabled even if research persistence is enabled.
  router.post("/service-build", route(async () => service.startServiceBuild()));
  const requireEnabled: RequestHandler = (_req, res, next) => {
    if (dependencies.enabled()) return next();
    res.status(503).json({ code: "ONBOARDING_PERSISTENCE_DISABLED", error: "Durable onboarding integration is not enabled" });
  };
  router.post("/jobs", requireEnabled, route(async (req, res) => {
    const result = await service.enqueue(scope(req), req.get("Idempotency-Key") || "", req.body);
    return res.status(result.reused ? 200 : 201).json(result);
  }));
  router.get("/jobs/:jobId", requireEnabled, route(async (req, res) => {
    return res.json({ job: await service.read(scope(req), z.string().uuid().parse(req.params.jobId)) });
  }));
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof OnboardingJobError) return res.status(error.status).json({ code: error.code, error: error.message });
    if (error instanceof ZodError) return res.status(400).json({ code: "ONBOARDING_REQUEST_INVALID", error: "Invalid onboarding request" });
    next(error);
  });
  app.use("/api/owner-ai/restaurants/:restaurantId/onboarding", router);
}
