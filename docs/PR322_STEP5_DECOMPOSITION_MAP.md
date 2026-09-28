# PR #322 Step 5 — Decomposition map (vs current main)

- Source PR: https://github.com/infotradescout/MealScout/pull/322
- Source branch: `repair/2026-07-28-mealscout-preview-validation`
- Verified head: `e897188f38c4efd12e87c0f9adaaf94c8ba7f710` (unchanged from historical tip)
- Decomposition base: `origin/main` @ `caa9a56639c68da52d4f60d73b6373cdc22c6060`
- Rule: **do not merge PR #322 wholesale**
- Excluded from payment/delivery salvage: `server/routes/actionRoutes.ts`

## File → disposition

| File | Lane / disposition | Notes |
|---|---|---|
| `migrations/119_menu_inventory_auto_availability.sql` | **1 + 5 RETAIN** | Extracted on foundation and inventory branches |
| `shared/schema/legacy.ts` (`inventoryAutoUnavailable` only) | **1 + 5 RETAIN** | Wholesale formatting / `.notNull()` churn **REJECT** |
| `scripts/mealscout-pickup-order-postgres.integration.test.ts` | **1 RETAIN (charter)** | Needs lanes 2/3 implementation |
| `scripts/mealscout-stripe-webhook-stateful-replay.integration.test.ts` | **1+2 RETAIN (charter)** | Foundation + webhook behavior |
| `server/services/pickupOrderPaymentIntentState.ts` | **2 RETAIN (extracted)** | Pure classifier |
| `scripts/mealscout-pickup-payment-intent-state.behavior.test.ts` | **2 RETAIN (extracted)** | |
| `server/middleware/idempotency.ts` | **2 RETAIN (charter)** | Durable gate |
| `server/routes/stripeWebhookRoutes.ts` | **2 RETAIN (charter)** | Surgical port only |
| `server/services/pickupOrderPaymentCancellation.ts` | **2 RETAIN (charter)** | Needs inventory column |
| `scripts/mealscout-stripe-webhook-idempotency-guards.contract.test.ts` | **2 RETAIN (charter)** | |
| `scripts/mealscout-payment-webhook-safety-map.contract.test.ts` | **REJECT** | Conflicts with free-profile main |
| `server/services/merchantPromotionService.ts` (tx arg) | **3 RETAIN (extracted)** | Support hook |
| `server/routes/pickupOrderRoutes.ts` | **3 RETAIN (charter)** | Entangled; surgical later |
| `client/src/pages/pickup-checkout.tsx` | **3 RETAIN (charter)** | |
| `client/src/pages/order-confirmation.tsx` | **3 RETAIN (charter)** | |
| `scripts/mealscout-orders-workspace.contract.test.ts` | **3 RETAIN (charter)** | |
| `scripts/testOrderingSubscriptionScope.ts` + package script swap | **REJECT / SUPERSEDED** | Main free-profile ordering tests win |
| `server/services/deliveryEligibility.ts` | **4 RETAIN (extracted)** | |
| `server/services/cityTimeZone.ts` | **4 RETAIN (extracted)** | AZ + strict resolve |
| `server/routes/merchantDeliveryRoutes.ts` | **4 RETAIN (extracted)** | |
| `scripts/merchant-delivery-lifecycle.contract.test.ts` | **4 RETAIN (extracted)** | |
| `client/src/pages/merchant-delivery.tsx` activeModule | **4 RETAIN (extracted)** | |
| `shared/cleanAffiliateLinks.ts` slug | **4 RETAIN (extracted)** | |
| `MEALSCOUT_ROUTE_MAP.md` + route-map contract delivery lines | **4 RETAIN (extracted)** | |
| `client/src/components/business-workspace-shell.tsx` | **REJECT** | Regresses main delivery module / payments copy |
| `server/routes/menuRoutes.ts` inventory clears | **5 RETAIN (extracted)** | |
| `server/routes/menuRoutes.ts` subscription-readiness rewrite | **REJECT / SUPERSEDED** | |
| `client/src/App.tsx` | **REJECT** | Unrelated route remap vs current main |
| `server/routes/actionRoutes.ts` | **EXCLUDE** | Trusted-principal lane |
| `package.json` script deletions / renames from PR #322 | **REJECT** | Keep main scripts; additive only |
| `origin/agent/merchant-delivery-lifecycle` | **SUPERSEDED** | Older than main migration 118 baseline |

## Salvage lane branches (local tips at decomposition)

| Lane | Branch |
|---|---|
| 1 Schema / stateful foundation | `salvage/pr322-lane1-schema-stateful-foundation` |
| 2 Idempotency / Stripe | `salvage/pr322-lane2-idempotency-stripe` |
| 3 Pickup checkout | `salvage/pr322-lane3-pickup-checkout` |
| 4 Merchant delivery | `salvage/pr322-lane4-merchant-delivery` |
| 5 Inventory availability | `salvage/pr322-lane5-inventory-availability` |
