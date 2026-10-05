import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ReverseOsmosisError } from "@tradescout-infinity/reverse-osmosis";
import { isAuthenticated } from "../unifiedAuth";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { assertActualRestaurantOwner, createOwnerAiDraft } from "../services/ownerAiActions";
import { prepareMealScoutReverseOsmosisSourceDraftInput, readMealScoutReverseOsmosisOutcome } from "../services/reverseOsmosis";
import { withSourceCaptureBudget } from "../services/reverseOsmosisCaptureGuard";

const requestSchema = z.object({
  postId: z.string().trim().min(1).max(512),
  publishPlatforms: z.array(z.literal("facebook")).max(1).default([]),
}).strict();

// A link selects one post. It never selects an account, owner or native profile.
export function businessPostIdentifier(value: string): string {
  if (/^\d+(?:_\d+)?$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("BUSINESS_POST_LINK_REQUIRED"); }
  if (url.protocol !== "https:" || !["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("BUSINESS_POST_LINK_REQUIRED");
  const story = url.searchParams.get("story_fbid");
  const page = url.searchParams.get("id");
  if (story && /^\d+$/.test(story)) return page && /^\d+$/.test(page) ? `${page}_${story}` : story;
  const match = url.pathname.match(/^\/([^/]+)\/posts\/(\d+)\/?$/);
  if (match) return /^\d+$/.test(match[1]) ? `${match[1]}_${match[2]}` : match[2];
  throw new Error("BUSINESS_POST_LINK_REQUIRED");
}

const route = (fn: (req: any, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

export function registerReverseOsmosisRoutes(app: Express) {
  const limiter = distributedRateLimit({ scope: "owner-ai:reverse-osmosis", limit: 12, windowMs: 60_000, key: (req: any) => String(req.user?.id || "unresolved") });
  app.post("/api/owner-ai/restaurants/:restaurantId/reverse-osmosis/source-draft", isAuthenticated, limiter, route(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const restaurantId = z.string().uuid().parse(req.params.restaurantId);
    const userId = String(req.user.id);
    const controller = new AbortController();
    const aborted = () => controller.abort();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    req.on("aborted", aborted);
    res.on("close", closed);
    if (req.aborted || res.destroyed) controller.abort();
    try {
      return await withSourceCaptureBudget({ signal: controller.signal }, async guard => {
        await guard.wait(() => assertActualRestaurantOwner(userId, restaurantId));
        guard.checkpoint();
        const body = requestSchema.parse(req.body);
        let postId: string;
        try { postId = businessPostIdentifier(body.postId); } catch {
          return res.status(400).json({ code: "BUSINESS_POST_LINK_REQUIRED", error: "Paste the public post link from the connected Facebook business Page." });
        }
        const request = await prepareMealScoutReverseOsmosisSourceDraftInput({ restaurantId, userId, postId, publishPlatforms: body.publishPlatforms }, { signal: guard.signal });
        guard.checkpoint();
        if (!request.packet) return res.status(200).json({ draft: null, holds: request.holds, mutationPerformed: false });
        const draft = await createOwnerAiDraft({ restaurantId, createdByUserId: userId, request: { packet: request.packet, expectedVersions: request.expectedVersions } }, { signal: guard.signal });
        guard.checkpoint();
        if (controller.signal.aborted && (req.aborted || res.destroyed)) return;
        return res.status(201).json({ draft, holds: request.holds, mutationPerformed: false });
      });
    } catch (error) {
      if (controller.signal.aborted && (req.aborted || res.destroyed)) return;
      throw error;
    } finally {
      req.off("aborted", aborted);
      res.off("close", closed);
    }
  }));
  app.get("/api/owner-ai/drafts/:draftId/reverse-osmosis", isAuthenticated, route(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    return res.json(await readMealScoutReverseOsmosisOutcome({ draftId: z.string().uuid().parse(req.params.draftId), userId: String(req.user.id) }));
  }));
  app.post("/api/owner-ai/drafts/:draftId/reverse-osmosis/reconcile", isAuthenticated, limiter, route(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    z.object({}).strict().parse(req.body);
    return res.json(await readMealScoutReverseOsmosisOutcome({ draftId: z.string().uuid().parse(req.params.draftId), userId: String(req.user.id), reconcile: true }));
  }));
  app.use("/api/owner-ai", (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ReverseOsmosisError) return res.status(409).json({ code: error.code, error: "Reverse Osmosis held this operation. Refresh the source and review a new draft; uncertain delivery requires reconciliation." });
    next(error);
  });
}
