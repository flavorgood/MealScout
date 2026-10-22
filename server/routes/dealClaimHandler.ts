import type { DealClaimResult } from "../services/dealClaimLifecycle";

type ClaimStorage = {
  getDeal: (id: string) => Promise<any>;
  getRestaurant: (id: string) => Promise<any>;
  claimDealAtomic: (dealId: string, userId: string, limit: number) => Promise<DealClaimResult>;
  getUserDealClaimsWithDetails: (userId: string) => Promise<any[]>;
};

export function createDealClaimHandler(
  storage: ClaimStorage,
  notify: (dealId: string, userId: string) => Promise<void>,
) {
  return async (req: any, res: any) => {
    try {
      const dealId = req.params.dealId;
      const userId = req.user.id;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      const restaurant = await storage.getRestaurant(deal.restaurantId);
      if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });

      const result = await storage.claimDealAtomic(dealId, userId, deal.perCustomerLimit || 1);
      if (!result.ok) {
        return res.status(409).json({
          code: result.reason,
          message: result.reason === "sold_out"
            ? "This deal has no claims remaining."
            : "This deal is no longer available to claim.",
        });
      }

      const receipts = await storage.getUserDealClaimsWithDetails(userId);
      const receipt = receipts.find((row) => row.id === result.claim.id);
      if (!receipt) throw new Error("The saved claim receipt could not be loaded");

      // Retried requests recover the saved receipt without sending a second
      // notification or consuming a second use.
      if (!result.replayed) {
        try { await notify(dealId, userId); }
        catch (error) { console.error("Failed to send deal claimed notification:", error); }
      }
      const discount = deal.dealType === "fixed"
        ? `$${deal.discountValue} off` : `${deal.discountValue}% off`;
      const minimum = deal.minOrderAmount == null ? "" : ` (minimum order $${deal.minOrderAmount})`;
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        success: true,
        claimId: result.claim.id,
        claim: receipt,
        replayed: result.replayed,
        dealTitle: receipt.dealTitle,
        restaurantName: receipt.restaurantName,
        restaurantAddress: receipt.restaurantAddress,
        facebookPostData: {
          message: `${restaurant.name}: ${deal.title}\n${discount}${minimum}\nFound on MealScout.`,
          place: restaurant.facebookPlaceId || undefined,
        },
      });
    } catch (error) {
      console.error("Error claiming deal:", error);
      return res.status(500).json({
        message: "The claim could not be confirmed. Check your claimed deals before trying again.",
      });
    }
  };
}
