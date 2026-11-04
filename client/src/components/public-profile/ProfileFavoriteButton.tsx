/**
 * ProfileFavoriteButton
 *
 * Allows authenticated users to favorite or follow a business directly from
 * the public profile. Saved state changes only after the server acknowledges it.
 *
 * For guests, tapping the button first explains in place that an account is
 * needed to save a place, and offers Log in / Create account actions that
 * carry a continuation path back to this profile. It never bounces a guest
 * straight to /login without that explanation.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { Heart } from "lucide-react";
import { apiUrl } from "@/lib/api";
import {
  publicProfileLoginHref,
  publicProfileSignupHref,
} from "@/lib/public-profile-recovery";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ProfileFavoriteButtonProps = {
  restaurantId: string;
  isAuthenticated: boolean;
  initialIsFavorited?: boolean;
  onToggle?: (isFavorited: boolean) => void;
  profilePath?: string;
};

export function ProfileFavoriteButton({
  restaurantId,
  isAuthenticated,
  initialIsFavorited = false,
  onToggle,
  profilePath,
}: ProfileFavoriteButtonProps) {
  const [isFavorited, setIsFavorited] = useState(initialIsFavorited);
  const [isPending, setIsPending] = useState(false);
  const [showGuestPrompt, setShowGuestPrompt] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setIsPending(false);
    setIsFavorited(initialIsFavorited);
    return () => { generation.current += 1; };
  }, [restaurantId, isAuthenticated]);
  useEffect(() => {
    if (!busy.current) setIsFavorited(initialIsFavorited);
  }, [initialIsFavorited]);

  const handleToggle = useCallback(async () => {
    if (!isAuthenticated) {
      setShowGuestPrompt(true);
      return;
    }

    if (busy.current) return;
    busy.current = true;
    const requestGeneration = ++generation.current;
    const nextState = !isFavorited;
    setIsPending(true);

    try {
      const response = await fetch(
        apiUrl(`/api/restaurants/${encodeURIComponent(restaurantId)}/favorite`),
        {
          method: nextState ? "POST" : "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error("Save not confirmed");
      if (generation.current !== requestGeneration) return;
      setIsFavorited(nextState);
      onToggle?.(nextState);
      void queryClient.invalidateQueries({ queryKey: ["/api/favorites/restaurants"] });
    } catch {
      if (generation.current !== requestGeneration) return;
      toast({ title: "Save not confirmed", description: "Refresh the profile to check your saved places before trying again.", variant: "destructive" });
    } finally {
      if (generation.current === requestGeneration) { busy.current = false; setIsPending(false); }
    }
  }, [isAuthenticated, isFavorited, restaurantId, onToggle, profilePath, queryClient, toast]);

  return (
    <>
      <button
        type="button"
        aria-label={isFavorited ? "Remove from favorites" : "Save to favorites"}
        aria-pressed={isFavorited}
        disabled={isPending}
        onClick={handleToggle}
        aria-busy={isPending}
        className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors ${
          isFavorited
            ? "border-rose-200 bg-rose-50 text-rose-600 shadow-sm"
            : "border-white/70 bg-white/90 text-[#6b4030] shadow-sm backdrop-blur hover:bg-white hover:text-[#d93f24]"
        } ${isPending ? "opacity-60 cursor-not-allowed" : ""}`}
      >
        <Heart
          className={`h-4 w-4 transition-transform ${isFavorited ? "fill-current scale-110" : ""}`}
        />
      </button>

      <Dialog open={showGuestPrompt} onOpenChange={setShowGuestPrompt}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-md border-[#ead9cc] bg-white text-[#2b160d]">
          <DialogHeader>
            <DialogTitle className="text-[#2b160d]">Save this place</DialogTitle>
            <DialogDescription className="text-[#806657]">
              Saving a place takes a free MealScout account, so your favorites
              stay with you on any device. Log in or create an account and
              you will come right back to this page.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setShowGuestPrompt(false)}
              className="min-h-10 rounded-xl border border-[#d8c2b3] bg-white px-4 text-sm font-bold text-[#2b160d] hover:bg-orange-50"
            >
              Not now
            </button>
            <a
              href={publicProfileSignupHref(profilePath)}
              className="inline-flex min-h-10 items-center justify-center rounded-xl border border-[#d8c2b3] bg-white px-4 text-sm font-bold text-[#2b160d] hover:bg-orange-50"
            >
              Create account
            </a>
            <a
              href={publicProfileLoginHref(profilePath, "save")}
              className="inline-flex min-h-10 items-center justify-center rounded-xl bg-[#f4512c] px-4 text-sm font-bold text-white hover:bg-[#dc3f1e]"
            >
              Log in
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
