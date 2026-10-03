import type { Express, Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { isAuthenticated } from "../unifiedAuth";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import { NativeProfileDraftError, listNativeOwnerProfiles, getNativeOwnerContext, listNativeOwnerDrafts, createNativeOwnerDraft, createNativeOfficialSourceDraft, approveNativeOwnerDraft, getNativeOwnerMediaPreview } from "../services/ownerAiNativeProfiles";

const target = z.object({ kind: z.enum(["location", "host", "supplier"]), id: z.string().uuid() });
const empty = z.object({}).strict();
const manual = z.object({ packet: z.unknown(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const consent = z.object({ expectedRevision: z.literal(1), expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const route = (fn: (req: any, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "private, no-store");
  Promise.resolve(fn(req, res)).catch(error => {
    if (error instanceof NativeProfileDraftError) return res.status(error.status).json({ code: error.code, message: error.code.replace(/_/g, " ").toLowerCase() });
    if (error instanceof ZodError) return res.status(400).json({ code: "INVALID_NATIVE_DRAFT_REQUEST", message: "Use the supported content fields and exact draft revision." });
    next(error);
  });
};
export function registerOwnerAiNativeProfileRoutes(app: Express) {
  const base = "/api/owner-ai/native-profiles";
  const limit = distributedRateLimit({ scope: "owner-ai-native-profile-content", windowMs: 60_000, limit: 60 });
  app.get(base, isAuthenticated, route(async (req, res) => { res.json(await listNativeOwnerProfiles(String(req.user.id))); }));
  app.get(base + "/:kind/:id/context", isAuthenticated, route(async (req, res) => { const p = target.parse(req.params); res.json(await getNativeOwnerContext(String(req.user.id), p.kind, p.id)); }));
  app.get(base + "/:kind/:id/drafts", isAuthenticated, route(async (req, res) => { const p = target.parse(req.params); res.json(await listNativeOwnerDrafts(String(req.user.id), p.kind, p.id)); }));
  app.post(base + "/:kind/:id/drafts", isAuthenticated, limit, route(async (req, res) => {
    const p = target.parse(req.params), body = manual.parse(req.body);
    res.status(201).json(await createNativeOwnerDraft(String(req.user.id), p.kind, p.id, body.packet, body.expectedVersion));
  }));
  app.post(base + "/:kind/:id/source-draft", isAuthenticated, limit, route(async (req, res) => {
    const p = target.parse(req.params); empty.parse(req.body);
    const result = await createNativeOfficialSourceDraft(String(req.user.id), p.kind, p.id);
    res.status(result.draft ? 201 : 200).json(result);
  }));
  app.get(base + "/drafts/:draftId/media/:assetKey", isAuthenticated, route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.draftId);
    const preview = await getNativeOwnerMediaPreview(String(req.user.id), id, req.params.assetKey);
    res.setHeader("Content-Type", preview.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(preview.buffer);
  }));
  app.post(base + "/drafts/:draftId/approve", isAuthenticated, limit, route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.draftId), body = consent.parse(req.body);
    res.json(await approveNativeOwnerDraft(String(req.user.id), id, body.expectedRevision, body.expectedContentHash));
  }));
}
