import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { dealClaimStatus, dealIntentPath, readClaimList, readClaimResponse, type DealClaimReceipt } from "@/lib/deal-claim-state";

interface DealClaimModalProps {
  dealId: string;
  onClose: () => void;
  isOpen: boolean;
  existingClaim?: DealClaimReceipt;
  onClaimed?: (claim: DealClaimReceipt) => void;
}

export default function DealClaimModal({ dealId, onClose, isOpen, existingClaim, onClaimed }: DealClaimModalProps) {
  const queryClient = useQueryClient();
  const [receipt, setReceipt] = useState<DealClaimReceipt | undefined>(existingClaim);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setPending(false);
    setError("");
    setReceipt(existingClaim);
    return () => { generation.current += 1; };
  }, [dealId, isOpen, existingClaim?.id]);

  const claim = async () => {
    if (busy.current || receipt) return;
    busy.current = true;
    const requestGeneration = generation.current;
    setPending(true);
    setError("");
    try {
      // Reconcile a previous response loss before attempting another write.
      const historyResponse = await apiRequest("GET", "/api/deals/claimed");
      const history = readClaimList(await historyResponse.json());
      const previous = history.find((row) => row.dealId === dealId && !row.isUsed && !row.usedAt);
      let confirmed = previous;
      if (!confirmed) {
        const response = await apiRequest("POST", `/api/deals/${encodeURIComponent(dealId)}/claim`, {});
        confirmed = readClaimResponse(await response.json(), dealId);
      }
      if (generation.current !== requestGeneration) return;
      setReceipt(confirmed);
      onClaimed?.(confirmed);
      void queryClient.invalidateQueries({ queryKey: ["/api/deals/claimed"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
    } catch (failure) {
      if (generation.current !== requestGeneration) return;
      const message = failure instanceof Error ? failure.message : "Claim not confirmed";
      if (/unauthor|not authenticated/i.test(message)) {
        const target = dealIntentPath(window.location.pathname + window.location.search + window.location.hash, "claim");
        window.location.href = `/login?redirect=${encodeURIComponent(target)}`;
        return;
      }
      setError(`${message}. Your request may have completed. Retry checks your wallet first.`);
    } finally {
      if (generation.current === requestGeneration) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  const status = receipt ? dealClaimStatus(receipt) : null;
  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent data-testid="dialog-deal-claim" className="max-w-md" onInteractOutside={(event) => { if (pending) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{receipt ? "Your claim receipt" : "Claim this special"}</DialogTitle>
          <DialogDescription>
            {receipt ? "This saved receipt is also in your claimed deals." : "Claim the special for your account. Sharing is optional."}
          </DialogDescription>
        </DialogHeader>
        {receipt ? (
          <div className="space-y-4" data-testid="claim-receipt">
            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4 text-stone-900">
              <p className="font-bold">{receipt.dealTitle || "Claimed special"}</p>
              {receipt.restaurantName && <p className="mt-1 text-sm">{receipt.restaurantName}</p>}
              <p className="mt-3 font-bold" data-testid="claim-status">{status}</p>
              <p className="mt-1 break-all text-xs">Receipt: <span data-testid="text-claim-id">{receipt.id}</span></p>
              <p className="mt-1 text-xs">Claimed {new Date(receipt.claimedAt).toLocaleString()}</p>
              {receipt.endDate && <p className="mt-1 text-xs">Expires {new Date(receipt.endDate).toLocaleString()}</p>}
            </div>
            <p className="text-sm text-muted-foreground">
              {status === "Active" ? "Show this receipt to the business. The business confirms redemption and any offer terms." : "This receipt is kept for your records and is not currently redeemable."}
            </p>
            <Button asChild className="w-full"><Link href="/orders?view=deals" data-testid="link-claimed-deals">Open claimed deals</Link></Button>
            <Button variant="outline" className="w-full" onClick={onClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
            <Button className="w-full" disabled={pending} onClick={() => void claim()} data-testid="button-confirm-claim">
              {pending ? "Checking and claiming…" : error ? "Check wallet and retry" : "Claim special"}
            </Button>
            <Button asChild variant="outline" className="w-full"><Link href="/orders?view=deals">Check claimed deals</Link></Button>
            <Button variant="ghost" className="w-full" disabled={pending} onClick={onClose}>Cancel</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

