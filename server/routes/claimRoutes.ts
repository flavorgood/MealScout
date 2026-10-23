import type { Express } from "express";
import { z } from "zod";

import { storage } from "../storage";
import { isAuthenticated } from "../unifiedAuth";
import { createDealClaimHandler } from "./dealClaimHandler";

type ClaimRouteDependencies = {
  sendDealClaimedNotification: (
    dealId: string,
    userId: string,
  ) => Promise<void>;
};

export function registerClaimRoutes(
  app: Express,
  { sendDealClaimedNotification }: ClaimRouteDependencies,
) {
  app.patch(
    "/api/deal-claims/:claimId/use",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { claimId } = req.params;
        const { orderAmount } = z
          .object({
            orderAmount: z.number().positive().min(0.01).max(10000).optional(),
          })
          .parse(req.body ?? {});

        const isAuthorized = await storage.verifyRestaurantOwnershipByClaim(
          claimId,
          req.user.id,
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only mark claims as used for your own restaurants",
          });
        }

        const updatedClaim = await storage.markClaimAsUsed(
          claimId,
          orderAmount ?? null,
        );
        if (!updatedClaim) {
          return res
            .status(400)
            .json({ message: "Claim not found or already used" });
        }

        res.json({ success: true, claim: updatedClaim });
      } catch (error) {
        console.error("Error marking claim as used:", error);
        res.status(400).json({
          message:
            error instanceof Error
              ? error.message
              : "Failed to mark claim as used",
        });
      }
    },
  );

  app.post(
    "/api/deals/:dealId/claim",
    isAuthenticated,
    createDealClaimHandler(storage, sendDealClaimedNotification),
  );

  app.get(
    "/api/restaurants/:restaurantId/claims",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { restaurantId } = req.params;
        const { status } = req.query;

        const isAuthorized = await storage.verifyRestaurantOwnership(
          restaurantId,
          req.user.id,
          "manageDeals",
        );
        if (!isAuthorized) {
          return res.status(403).json({
            message:
              "Unauthorized: You can only access analytics for restaurants you own",
          });
        }

        const claims = await storage.getRestaurantDealClaims(
          restaurantId,
          status as string,
        );
        res.json(claims);
      } catch (error) {
        console.error("Error fetching restaurant claims:", error);
        res.status(500).json({ message: "Failed to fetch restaurant claims" });
      }
    },
  );
}
