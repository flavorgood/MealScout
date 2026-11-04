/**
 * ProfileRecommendButton
 *
 * Lets authenticated users recommend a business directly from the public
 * profile, independent of any specific menu item. This matters most for thin
 * (mostly unclaimed) profiles, which have no menu items to hang a per-dish
 * recommend on but should still be recommendable.
 *
 * One-way action (no un-recommend) - the API already treats a duplicate
 * recommend as a graceful no-op. The button confirms only acknowledged success.
 *
 * For guests, tapping the button first explains in place that an account is
 * needed to recommend a place, and offers Log in / Create account actions
 * that carry a continuation path back to this profile. It never bounces a
 * guest straight to /login without that explanation.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { ThumbsUp } from "lucide-react";
import { apiUrl } from "@/lib/api";
import {
  publicProfileLoginHref,
  publicProfileSignupHref,
} from "@/lib/public-profile-recovery";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

type ProfileRecommendButtonProps = {
  restaurantId: string;
  isAuthenticated: boolean;
  profilePath?: string;
};

const QUICK_REVIEW_SCORE_KEYS = ["food", "value", "speed", "vibe"] as const;
type QuickReviewScoreKey = (typeof QUICK_REVIEW_SCORE_KEYS)[number];

export function ProfileRecommendButton({
  restaurantId,
  isAuthenticated,
  profilePath,
}: ProfileRecommendButtonProps) {
  const { toast } = useToast();
  const actionBusy = useRef(false);
  const [isRecommended, setIsRecommended] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [showGuestPrompt, setShowGuestPrompt] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSubmittingContext, setIsSubmittingContext] = useState(false);
  const [contextSaved, setContextSaved] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [recommendationText, setRecommendationText] = useState("");
  const [proofImage, setProofImage] = useState<File | null>(null);
  const [scores, setScores] = useState({
    food: 50,
    value: 50,
    speed: 50,
    vibe: 50,
  });
  const [touchedScores, setTouchedScores] = useState<
    Partial<Record<QuickReviewScoreKey, true>>
  >({});

  const hasDraftContext = Boolean(
    recommendationText.trim() ||
      proofImage ||
      QUICK_REVIEW_SCORE_KEYS.some((key) => touchedScores[key]),
  );

  useEffect(() => {
    setIsRecommended(false);
    setIsPending(false);
    setShowGuestPrompt(false);
    setIsDialogOpen(false);
    setIsSubmittingContext(false);
    setContextSaved(false);
    setContextError(null);
    setRecommendationText("");
    setProofImage(null);
    setScores({ food: 50, value: 50, speed: 50, vibe: 50 });
    setTouchedScores({});
  }, [restaurantId]);

  const submitShallowRecommend = useCallback(async () => {
    if (isRecommended) {
      return { ok: true, contextAlreadySaved: contextSaved };
    }
    setIsPending(true);
    try {
      const res = await fetch(
        apiUrl(
          `/api/restaurants/${encodeURIComponent(restaurantId)}/recommend`,
        ),
        { method: "POST", credentials: "include" },
      );
      const responseBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error("Failed to recommend");
      setIsRecommended(true);
      const contextAlreadySaved =
        responseBody?.contextAlreadySaved === true ||
        Boolean(responseBody?.contextSubmittedAt);
      if (contextAlreadySaved) setContextSaved(true);
      return { ok: true, contextAlreadySaved };
    } catch {
      setIsRecommended(false);
      return { ok: false, contextAlreadySaved: false };
    } finally {
      setIsPending(false);
    }
  }, [contextSaved, isRecommended, restaurantId]);

  const handleRecommend = useCallback(async () => {
    if (!isAuthenticated) {
      setShowGuestPrompt(true);
      return;
    }
    if (isPending || actionBusy.current) return;
    actionBusy.current = true;
    try {
      const result = await submitShallowRecommend();
      if (result.ok && !result.contextAlreadySaved) setIsDialogOpen(true);
      if (!result.ok) toast({ title: "Recommendation not confirmed", description: "Please refresh to check before trying again.", variant: "destructive" });
    } finally { actionBusy.current = false; }
  }, [isAuthenticated, isPending, profilePath, submitShallowRecommend, toast]);

  const handleSubmitContext = useCallback(async () => {
    const text = recommendationText.trim();
    const submittedScores = Object.fromEntries(
      QUICK_REVIEW_SCORE_KEYS.filter((key) => touchedScores[key]).map((key) => [
        key,
        scores[key],
      ]),
    );
    if (!text && !proofImage && Object.keys(submittedScores).length === 0) {
      return;
    }
    setIsSubmittingContext(true);
    setContextError(null);
    try {
      const formData = new FormData();
      if (text) formData.append("comment", text);
      if (Object.keys(submittedScores).length > 0) {
        formData.append("scores", JSON.stringify(submittedScores));
      }
      if (proofImage) formData.append("image", proofImage);
      const res = await fetch(
        apiUrl(
          `/api/restaurants/${encodeURIComponent(restaurantId)}/recommend`,
        ),
        {
          method: "POST",
          credentials: "include",
          body: formData,
        },
      );
      const responseBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          String(responseBody?.message || "").trim() ||
            "Failed to save quick review",
        );
      }
      if (responseBody?.contextSaved !== true) {
        throw new Error("Quick review was not saved. Please try again.");
      }
      setContextSaved(true);
      setIsDialogOpen(false);
    } catch (error) {
      setContextError(
        error instanceof Error
          ? error.message
          : "Failed to save quick review. Please try again.",
      );
    } finally {
      setIsSubmittingContext(false);
    }
  }, [proofImage, recommendationText, restaurantId, scores, touchedScores]);

  const updateScore = (key: QuickReviewScoreKey, value: number) => {
    setScores((current) => ({ ...current, [key]: value }));
    setTouchedScores((current) => ({ ...current, [key]: true }));
    setContextError(null);
  };

  return (
    <>
      <button
        type="button"
        aria-label={isRecommended ? "Recommended" : "Recommend this place"}
        aria-pressed={isRecommended}
        disabled={isPending}
        onClick={handleRecommend}
        aria-busy={isPending}
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm font-bold transition-colors ${
          isRecommended
            ? "border-orange-200 bg-orange-50 text-orange-800"
            : "border-[color:var(--profile-border-strong)] bg-white text-[color:var(--profile-ink-soft)] hover:border-orange-300 hover:bg-orange-50 hover:text-orange-800"
        } ${isPending ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <ThumbsUp
          className={`h-4 w-4 transition-transform ${isRecommended ? "scale-110 fill-current" : ""}`}
        />
        {isRecommended ? "Recommended" : "Recommend"}
      </button>

      <Dialog open={showGuestPrompt} onOpenChange={setShowGuestPrompt}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-md border-[#ead9cc] bg-white text-[#2b160d]">
          <DialogHeader>
            <DialogTitle className="text-[#2b160d]">Recommend this place</DialogTitle>
            <DialogDescription className="text-[#806657]">
              Recommending takes a free MealScout account, so your
              recommendations are tied to you and count toward this place.
              Log in or create an account and you will come right back to
              this page.
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
              href={publicProfileLoginHref(profilePath, "recommend")}
              className="inline-flex min-h-10 items-center justify-center rounded-xl bg-[#f4512c] px-4 text-sm font-bold text-white hover:bg-[#dc3f1e]"
            >
              Log in
            </a>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-h-[86vh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto border-[#ead9cc] bg-white text-[#2b160d]">
          <DialogHeader>
            <DialogTitle className="text-[#2b160d]">Quick review</DialogTitle>
            <DialogDescription className="text-[#806657]">
              Add only the details you want to share. Untouched scores are not
              submitted, and closing this keeps your recommend either way.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Textarea
              value={recommendationText}
              onChange={(event) => {
                setRecommendationText(event.target.value);
                setContextError(null);
              }}
              placeholder="Optional: what should someone know before they go?"
              className="min-h-24 border-[#ead9cc] bg-[#fffaf5] text-[#2b160d] placeholder:text-[#806657]"
            />

            <label className="block rounded-xl border border-[#ead9cc] bg-[#fff8f1] p-3">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-[#806657]">
                Photo proof
              </span>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  setProofImage(event.target.files?.[0] || null);
                  setContextError(null);
                }}
                className="mt-2 block w-full text-xs text-[#806657] file:mr-3 file:rounded-lg file:border-0 file:bg-orange-100 file:px-3 file:py-2 file:text-xs file:font-bold file:text-orange-900 hover:file:bg-orange-200"
              />
              {proofImage ? (
                <span className="mt-2 block truncate text-xs text-orange-700">
                  {proofImage.name}
                </span>
              ) : null}
            </label>

            <div className="space-y-3">
              {(
                [
                  ["food", "Food"],
                  ["value", "Value"],
                  ["speed", "Speed"],
                  ["vibe", "Vibe"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block">
                  <div className="mb-1 flex items-center justify-between text-xs font-semibold text-[#5f4435]">
                    <span>{label}</span>
                    <span>{touchedScores[key] ? scores[key] : "Not rated"}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={scores[key]}
                    onChange={(event) =>
                      updateScore(key, Number(event.target.value))
                    }
                    className="w-full accent-orange-500"
                  />
                </label>
              ))}
            </div>

            {contextError ? (
              <p className="text-sm font-semibold text-red-700" role="alert">
                {contextError}
              </p>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setIsDialogOpen(false)}
                className="min-h-10 rounded-xl border border-[#d8c2b3] bg-white px-4 text-sm font-bold text-[#2b160d] hover:bg-orange-50"
              >
                Done
              </button>
              <button
                type="button"
                disabled={isSubmittingContext || !hasDraftContext || contextSaved}
                onClick={handleSubmitContext}
                className="min-h-10 rounded-xl bg-[#f4512c] px-4 text-sm font-bold text-white hover:bg-[#dc3f1e] disabled:opacity-60"
              >
                {isSubmittingContext ? "Saving..." : "Share quick review"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
