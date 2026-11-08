import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  AUTOMATED_MARKETING_EMAILS_FLAG,
  areAutomatedMarketingEmailsEnabled,
  describeAutomatedMarketingEmailFlag,
} from "../server/utils/marketingEmailWindow";

const previousFlag = process.env[AUTOMATED_MARKETING_EMAILS_FLAG];
// Off by default (owner ruling: marketing OFF): unset means OFF; only an
// explicit "true" — a deliberate opt-in — turns automated marketing on.
delete process.env[AUTOMATED_MARKETING_EMAILS_FLAG];
assert.equal(areAutomatedMarketingEmailsEnabled(), false);
assert.equal(
  describeAutomatedMarketingEmailFlag(),
  "AUTOMATED_MARKETING_EMAILS_ENABLED=true not",
);
process.env[AUTOMATED_MARKETING_EMAILS_FLAG] = "true";
assert.equal(areAutomatedMarketingEmailsEnabled(), true);
process.env[AUTOMATED_MARKETING_EMAILS_FLAG] = "false";
assert.equal(areAutomatedMarketingEmailsEnabled(), false);
process.env[AUTOMATED_MARKETING_EMAILS_FLAG] = "yes";
assert.equal(areAutomatedMarketingEmailsEnabled(), false);
if (previousFlag === undefined) {
  delete process.env[AUTOMATED_MARKETING_EMAILS_FLAG];
} else {
  process.env[AUTOMATED_MARKETING_EMAILS_FLAG] = previousFlag;
}

const onboardingDrip = readFileSync("server/onboardingDripService.ts", "utf8");
const emailService = readFileSync("server/emailService.ts", "utf8");
const schedulers = readFileSync("server/bootstrap/registerSchedulers.ts", "utf8");
const recurringJobs = readFileSync("server/bootstrap/registerRecurringJobs.ts", "utf8");
const healthRoutes = readFileSync("server/routes/health.ts", "utf8");

[
  "areAutomatedMarketingEmailsEnabled()",
  "[OnboardingDrip] skipped: automated marketing emails disabled",
  "skippedDisabled: true",
].forEach((snippet) => {
  if (!onboardingDrip.includes(snippet)) {
    throw new Error(`OnboardingDrip missing production email safety snippet: ${snippet}`);
  }
});

[
  "marketing_disabled",
  "Marketing email skipped",
  "areAutomatedMarketingEmailsEnabled()",
  "automatedMarketingEmailsEnabled",
].forEach((snippet) => {
  if (!emailService.includes(snippet)) {
    throw new Error(`Email service missing marketing kill-switch snippet: ${snippet}`);
  }
});

[
  "automated marketing/drip emails disabled",
  "describeAutomatedMarketingEmailFlag",
].forEach((snippet) => {
  if (!schedulers.includes(snippet)) {
    throw new Error(`Scheduler missing disabled drip logging snippet: ${snippet}`);
  }
});

[
  "OPS_CLEANUP_VERBOSE",
  "MARKETPLACE_HEALTH_AUDIT_VERBOSE",
  "if (deletedTotal === 0 && !verboseOpsCleanup)",
  "if (demandTotal > 0 || verboseMarketplaceHealth)",
].forEach((snippet) => {
  if (!recurringJobs.includes(snippet)) {
    throw new Error(`Recurring jobs missing no-op noise guard: ${snippet}`);
  }
});

[
  'healthRouter.get(["/api/version", "/health/version"]',
  'healthRouter.get("/health/ready"',
].forEach((snippet) => {
  if (!healthRoutes.includes(snippet)) {
    throw new Error(`Health/version/readiness route unexpectedly missing: ${snippet}`);
  }
});

console.log("production-ops-email-noise.contract: PASS");
