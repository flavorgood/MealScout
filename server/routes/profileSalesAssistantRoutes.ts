import type { Express } from "express";
import { isAuthenticated } from "../unifiedAuth";
import { isInternalTeamUserType } from "../roleAccess";
import { distributedRateLimit } from "../middleware/distributedRateLimit";
import {
  isProfileSalesKind,
  publicSalesProjection,
} from "@shared/profileSalesAssistant";
import {
  backfillExistingProfileSalesAssistants,
  inquireOnProfileSalesAssistant,
  readPublicProfileSalesAssistant,
} from "../services/profileSalesAssistantStore";

const inquireLimiter = distributedRateLimit({
  scope: "profile-sales-assistant:inquire",
  limit: 20,
  windowMs: 10 * 60 * 1000,
});

export function registerProfileSalesAssistantRoutes(app: Express) {
  app.get("/api/public/profile-sales-assistant/:kind/:id", async (req, res) => {
    const kind = String(req.params.kind || "");
    const id = String(req.params.id || "").trim();
    if (!isProfileSalesKind(kind) || !id) {
      return res.status(400).json({ message: "Profile is required." });
    }
    try {
      const config = await readPublicProfileSalesAssistant(kind, id);
      if (!config) {
        return res.status(404).json({ message: "Profile not found." });
      }
      return res.json(publicSalesProjection(config));
    } catch (error) {
      console.error("[profile-sales-assistant] read failed", error);
      return res.status(500).json({ message: "Unable to load this profile." });
    }
  });

  app.post(
    "/api/public/profile-sales-assistant/:kind/:id/inquire",
    inquireLimiter,
    async (req, res) => {
      const kind = String(req.params.kind || "");
      const id = String(req.params.id || "").trim();
      if (!isProfileSalesKind(kind) || !id) {
        return res.status(400).json({ message: "Profile is required." });
      }
      try {
        const result = await inquireOnProfileSalesAssistant({
          profileKind: kind,
          profileId: id,
          what: req.body?.what,
          where: req.body?.where,
          when: req.body?.when,
          headcount: req.body?.headcount,
          marketingOptIn: req.body?.marketingOptIn,
          customerName: req.body?.customerName,
          customerEmail: req.body?.customerEmail,
          customerPhone: req.body?.customerPhone,
        });
        if (!result.ok) {
          return res.status(result.status).json({
            code: result.code,
            message: result.customerMessage,
          });
        }
        return res.status(201).json({
          inquiryId: result.inquiryId,
          qualification: result.record.qualification,
          quote: result.record.quote,
          completion: result.record.completion,
          marketingOptIn: result.record.marketingOptIn,
          crm: result.record.crm,
        });
      } catch (error) {
        console.error("[profile-sales-assistant] inquire failed", error);
        return res.status(500).json({ message: "Unable to save this request." });
      }
    },
  );

  app.post(
    "/api/admin/profile-sales-assistants/backfill",
    isAuthenticated,
    async (req: any, res) => {
      if (!isInternalTeamUserType(req.user?.userType)) {
        return res.status(403).json({ message: "Staff access required" });
      }
      try {
        const result = await backfillExistingProfileSalesAssistants();
        return res.json(result);
      } catch (error) {
        console.error("[profile-sales-assistant] backfill failed", error);
        return res.status(500).json({ message: "Backfill failed" });
      }
    },
  );
}
