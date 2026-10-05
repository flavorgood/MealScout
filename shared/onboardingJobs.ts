import { z } from "zod";

export const ONBOARDING_RESEARCH_MAX_ATTEMPTS = 3;
export const ONBOARDING_RESEARCH_RECEIPT_MAX_BYTES = 65_536;
export const ONBOARDING_SERVICE_BUILD_ENABLED = false;

const publicLink = z.string().trim().max(2_048).url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, { message: "HTTPS_LINK_REQUIRED" }).transform(value => {
  const url = new URL(value);
  url.hash = "";
  return url.href;
});

// Links are owner declarations. This contract does not fetch or verify them.
export const onboardingResearchInputSchema = z.object({
  businessName: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(500),
  officialLinks: z.array(publicLink).max(4).default([]),
}).strict().transform(input => ({
  ...input,
  officialLinks: [...new Set(input.officialLinks)].sort(),
}));

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const onboardingResearchReceiptSchema = z.object({
  version: z.literal(1),
  requestHash: digest,
  sources: z.array(z.object({
    url: publicLink,
    capturedAt: z.string().datetime(),
    contentHash: digest,
    excerpt: z.string().max(2_048),
  }).strict()).max(4),
  observations: z.array(z.object({
    field: z.string().trim().min(1).max(100),
    value: z.string().max(2_048),
    sourceUrl: publicLink,
  }).strict()).max(24),
  unknowns: z.array(z.string().trim().min(1).max(200)).max(24),
  // No new score runner. An established scoring integration can be added later.
  currentScore: z.null().default(null),
  conditionalProjectedScore: z.null().default(null),
}).strict();

export type OnboardingResearchInput = z.infer<typeof onboardingResearchInputSchema>;
export type OnboardingResearchReceipt = z.infer<typeof onboardingResearchReceiptSchema>;
export type OnboardingJobStatus = "queued" | "running" | "retry_wait" | "completed" | "failed";

export const onboardingIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export const onboardingScopeSchema = z.object({
  ownerId: z.string().min(1).max(200),
  restaurantId: z.string().uuid(),
}).strict();

export type OnboardingScope = z.infer<typeof onboardingScopeSchema>;
