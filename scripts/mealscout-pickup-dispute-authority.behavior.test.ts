import assert from "node:assert/strict";
import type Stripe from "stripe";

import { retrieveAuthoritativePickupOrderDispute } from "../server/services/pickupOrderDisputeTruth";
import {
  doesPickupDisputeRequireMerchantRecovery,
  isTerminalPickupDisputeStatus,
  pickupOrderReconciledPayoutStatus,
  resolveConvergedPickupDisputeStatus,
} from "../server/services/pickupOrderNetSettlementPolicy";

function dispute(status: Stripe.Dispute.Status) {
  return {
    id: "dp_ordering_truth",
    object: "dispute",
    amount: 10_000,
    currency: "usd",
    payment_intent: "pi_ordering_truth",
    status,
  } as Stripe.Dispute;
}

let currentDispute = dispute("won");
const stripe = {
  disputes: {
    retrieve: async (id: string) => {
      assert.equal(id, currentDispute.id);
      return currentDispute;
    },
  },
} as unknown as Stripe;

const staleActiveAfterWon = await retrieveAuthoritativePickupOrderDispute({
  stripe,
  webhookDispute: dispute("needs_response"),
});
assert.equal(
  staleActiveAfterWon.status,
  "won",
  "A delayed active event must reconcile Stripe's current won state",
);

currentDispute = dispute("lost");
const staleWonAfterLost = await retrieveAuthoritativePickupOrderDispute({
  stripe,
  webhookDispute: dispute("won"),
});
assert.equal(
  staleWonAfterLost.status,
  "lost",
  "A delayed won event must reconcile Stripe's current lost state",
);

await assert.rejects(
  retrieveAuthoritativePickupOrderDispute({
    stripe,
    webhookDispute: {
      ...dispute("lost"),
      amount: 9_999,
    },
  }),
  /changed immutable payment identity/,
  "A webhook whose financial identity disagrees with Stripe must fail closed",
);

// The dispute object is retrieved before the per-order advisory lock is
// taken, so a delivery can carry a snapshot from just before the dispute
// closed. A terminal stored status must never move backwards: the
// reconcile converges on the stored status, issues no reversal for a
// merchant-won dispute, and never lands the order in "disputed".
for (const terminalStatus of ["won", "prevented", "warning_closed", "lost"]) {
  assert.equal(
    isTerminalPickupDisputeStatus(terminalStatus),
    true,
    `${terminalStatus} is a terminal dispute status`,
  );
  const converged = resolveConvergedPickupDisputeStatus({
    storedStatus: terminalStatus,
    incomingStatus: "needs_response",
  });
  assert.equal(
    converged,
    terminalStatus,
    `A stale needs_response snapshot must not move a stored ${terminalStatus} dispute backwards`,
  );
}
const convergedWon = resolveConvergedPickupDisputeStatus({
  storedStatus: "won",
  incomingStatus: "under_review",
});
assert.equal(convergedWon, "won");
assert.equal(
  doesPickupDisputeRequireMerchantRecovery(convergedWon),
  false,
  "A converged won dispute must not trigger merchant recovery or transfer reversal",
);
assert.equal(
  pickupOrderReconciledPayoutStatus({
    totalCents: 10_000,
    succeededRefundAmountCents: 0,
    stripeDisputeStatus: convergedWon,
  }),
  "transferred",
  "A converged won dispute must not leave the order in the disputed payout state",
);

// Forward transitions still follow the incoming status.
assert.equal(
  resolveConvergedPickupDisputeStatus({
    storedStatus: "needs_response",
    incomingStatus: "won",
  }),
  "won",
  "An open dispute must still close as won",
);
assert.equal(
  resolveConvergedPickupDisputeStatus({
    storedStatus: "under_review",
    incomingStatus: "lost",
  }),
  "lost",
  "An open dispute must still close as lost",
);
assert.equal(
  resolveConvergedPickupDisputeStatus({
    storedStatus: null,
    incomingStatus: "needs_response",
  }),
  "needs_response",
  "A first dispute binding must record the incoming status",
);
// Terminal-to-terminal re-decisions are not the stale-write case and
// keep following Stripe's latest outcome.
assert.equal(
  resolveConvergedPickupDisputeStatus({
    storedStatus: "won",
    incomingStatus: "lost",
  }),
  "lost",
  "A terminal re-decision must follow the incoming terminal status",
);

console.log("MealScout authoritative pickup dispute behavior: PASS");
