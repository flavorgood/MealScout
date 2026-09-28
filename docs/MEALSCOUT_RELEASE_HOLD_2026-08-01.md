# MealScout Release Hold — August 1, 2026

Status: `PARTIAL / HOLD`

Canonical security deployment baseline: `231f06a0db4120416c47088e659db9f2a9076f21`

Reviewed projection source: `cfc2e949aa1f65350965ba66fa24cf91601d0159`

Reviewed branch head: `186cd2f4ee131d562035f32b0965182e9e9b1559`

Reviewed and deployed application tree: `45f3f2678637746a031db5b953a06eb8293fb00c`

This record supersedes earlier MealScout product-readiness summaries for the
August 1 release decision. It does not roll back `origin/main` and it does not
authorize a merge, deployment, migration, payment, provider operation, branch
deletion, or credential rotation.

## Release boundary

Until the hold is lifted, `main` accepts only release-control repairs, Action
API containment or authorization work, validation infrastructure, semantic
rescue reconciliation, independently reviewed PR #322 salvage slices, and
defects found by the exact release-validation matrix. New product surfaces and
unrelated UX, monetization, discovery, supplier, profile, category, or job work
remain outside the release lane.

## Confirmed blockers

1. GitHub Actions workflow records were created, but no GitHub Actions job
   execution was inspected or accepted as release evidence. The owner-directed
   CI-unavailable security exception relied on independently reviewed local
   validation, remote tree identity, an exact Render build marker, and
   controlled production smoke. Executable CI evidence remains open.
2. Repository ruleset `20202108` now provides baseline `main` enforcement, but
   no successful CI status checks are bound to it yet. Executable CI and final
   required-check enforcement therefore remain open control-plane work.
3. PR #322 is draft, conflicting, based on an older payment/delivery baseline,
   and must not be merged wholesale.
4. Static Action API integration tokens establish no user principal,
   delegation, scopes, or credential-specific attribution.
5. The rescue branch has one unique preservation commit and must remain intact
   until its semantic classification is accepted and any required behavior is
   reimplemented from current `main`.
6. The remaining hold-lift matrix still lacks complete browser, migration,
   provider, payment, cross-tenant trusted-principal, and enforced required-check
   proof on one exact release SHA.

## Production Action API containment

Write-containment PR: `#325`

Public-read projection PR: `#326`

Public-read PR base: `8c437e0f254176e66b765b99e93ac503e1222a45`

Public-read squash merge: `231f06a0db4120416c47088e659db9f2a9076f21`

Behavior:

- `ADDED`: a fail-closed public-discovery read allowlist for static integration
  tokens.
- `REMOVED`: integration-token authority to dispatch user-scoped reads or
  writes using a submitted `userId`.
- `ADDED`: explicit positive database projections, strict runtime response
  schemas, canonical public-eligibility checks, and exact-key response
  allowlists for all five integration reads.
- `UNCHANGED and protected`: token authentication, public discovery reads, and
  all normal signed-in MealScout routes outside `/api/actions`.
- No environment escape hatch can re-enable integration-token writes.

Allowed actions:

- `FIND_DEALS`
- `FIND_RESTAURANTS`
- `GET_RESTAURANT_DETAILS`
- `GET_FOOD_TRUCKS`
- `GET_PARKING_PASS_SPOTS`

Every implemented user-scoped action fails before handler dispatch with HTTP
`403` and `ACTION_REQUIRES_TRUSTED_PRINCIPAL`. Reserved unimplemented actions
remain `501`; unknown names remain `400`.

## Main baseline enforcement — August 1, 2026

Repository ruleset `20202108` (`main baseline enforcement`) is active for the
default branch. It requires a pull request, requires review conversations to be
resolved, and blocks branch deletion and non-fast-forward updates. It requires
zero approving reviews and no status checks, preserving the current
owner-directed review model while executable CI remains unavailable.

The sole bypass actor is the `infotradescout` repository owner and its bypass
mode is `pull_request`: even an emergency-security bypass must retain a pull
request and audit trail, and it cannot be used as a routine direct push. The
rollback is to disable ruleset `20202108`, verify that its three rules no longer
apply, and delete it only if restoring the previously unprotected state is
explicitly authorized.

## Production proof — August 1, 2026

PR #326 was remotely verified as exactly two commits and seven intended files.
Its base contained `8c437e0f`, its remote final tree matched the reviewed local
tree `45f3f2678637746a031db5b953a06eb8293fb00c`, and the squash merge kept that
same tree. Both `https://www.mealscout.us/api/version` and the Render service
alias reported the exact deployed merge `231f06a0db4120416c47088e659db9f2a9076f21`,
`RENDER_GIT_COMMIT`, `render`, `production`, and a present frontend asset
manifest before smoke testing.

GitHub Actions workflow records were created, but no GitHub Actions job
execution was inspected or accepted as release evidence. The following
independent local validations passed on the reviewed branch head:

- `npm run test:action-api-public-read-projection`
- `npm run test:action-api-containment`
- `npm run test:action-availability`
- `node --test --import tsx scripts/public-discovery-integrity.contract.test.ts`
- `npm run test:public-data-boundary`
- `npm run test:consumer-entity-foundation`
- `node --test --import tsx scripts/profile-evidence-public-projection.behavior.test.ts`
- `node --test --import tsx scripts/food-truck-location-separation.contract.test.ts`
- `node --test --import tsx scripts/scout-truck-menu-schedule-regression.contract.test.ts`
- `node --test --import tsx scripts/scout-parking-pass-host-truth.contract.test.ts`
- `node --test --import tsx scripts/parking-pass-listing-revenue.contract.test.ts`
- `npm run check`
- `npm run build`
- `git diff --check 8c437e0f254176e66b765b99e93ac503e1222a45...186cd2f4ee131d562035f32b0965182e9e9b1559`

Authenticated production smoke used the accepted integration credential from
the existing `TRADESCOUT_API_TOKENS` environment variable. No credential value,
database URL, restaurant identifier, or response record was persisted in this
ledger. The known inactive comparison fixture was selected inside a read-only
database transaction; the smoke issued no database write, payment, credit,
notification, ownership, or provider mutation.

| Production check | Sanitized result |
|---|---|
| `FIND_DEALS` | HTTP success; 1 current public deal; exact envelope and exact deal keys |
| `FIND_RESTAURANTS` | HTTP success; 20 eligible public summaries; exact envelope and exact restaurant keys |
| `GET_RESTAURANT_DETAILS` | HTTP success; approved detail shape; 0 current active deals for the sampled public restaurant |
| `GET_FOOD_TRUCKS` | HTTP success; 0 currently live trucks in the bounded search; exact success envelope |
| `GET_PARKING_PASS_SPOTS` | HTTP success; 13 published spots; exact spot and pricing keys |
| Hidden versus nonexistent detail | Identical HTTP status and exact `{success,error}` body: `Restaurant not found` |
| Recursive disclosure scan | 0 prohibited-key hits and 0 internal `SECRET_` sentinel hits |
| User-scoped containment | All 22 actions returned HTTP `403` with `ACTION_REQUIRES_TRUSTED_PRINCIPAL` before dispatch |
| Unknown action | HTTP `400` |
| Reserved unimplemented action | HTTP `501` with `ACTION_NOT_IMPLEMENTED` |

The zero-result live-truck response is a truthful current-inventory result, not
an execution failure: the endpoint returned the approved success envelope and
no broadened fields. It did not, however, provide a live truck item whose
location, distance, and exact item keys could be inspected in production. The
sampled restaurant detail likewise had no nested active-deal item. Those two
positive, inventory-dependent item witnesses remain open until natural
production inventory is available; no inventory should be manufactured for a
smoke test. Their exact deployed shapes are supported by the reviewed local
contracts and exact deployed tree, not by positive production items in this
run. The hidden and nonexistent checks used no identifier in the recorded
evidence and were byte-equivalent at the parsed JSON boundary.

Updated release ledger:

```text
Action API writes:                              CONTAINED IN PRODUCTION
Action API public-read leakage:                 CONTAINED IN PRODUCTION
Public-read contract (runtime/API_ACTIONS):     EXPLICIT / PRODUCTION SMOKE PARTIAL
Positive truck/detail-deal item witnesses:      PENDING NATURAL INVENTORY
EMBED v1 envelope wording:                      CORRECTED BY REVIEWED ERRATUM
Trusted-principal model:                        PENDING
GitHub Actions execution evidence:              ABSENT
Main enforcement:                               BASELINE ACTIVE / CI CHECKS PENDING
PR #322:                                        HOLD / DECOMPOSED (step 5 branches opened; proofs pending)
Rescue branch:                                  PRESERVED
Overall status:                                 PARTIAL / HOLD
```

## Rescue branch semantic classification

Source branch: `rescue/2026-07-28-mealscout-local-state`

Source commit: `71b7d134d99ed6b2da6e55645ad005db90a84964`

The branch remains untouched.

| File/hunk | Classification | Evidence and disposition |
|---|---|---|
| `client/src/App.tsx`: `/admin/login` and `/admin/dashboard` redirect behavior | Absorbed | Current `origin/main` still contains both redirects in guest and authenticated route groups. The rescue helper only deduplicates JSX and adds no missing behavior. Do not replay it as release repair. |
| `server/routes/admin/adminCoreOpsRoutes.ts`: replace `/admin-dashboard?...` with `/admin?...` | Still required | Current `origin/main` still emits nine `/admin-dashboard` targets, while the routed canonical admin surface is `/admin`. Extract this URL correction into a separate current-main branch with a focused route/action-link contract. |
| `server/routes/admin/adminCoreOpsRoutes.ts`: indentation near `topRecommendedActionUrl` | Obsolete | Formatting has no independent behavior and should not be carried into a semantic repair. |

No rescue hunk is classified `Conflicting` on the current evidence. The branch
must not be merged, rebased, replaced, or deleted as part of this record.


## Locked release order progress (2026-08-07)

- Step 3 landed on main: PR #330 (`fix: restaurant follow duplicate idempotency`).
- Step 4 landed on main: PR #331 (`Bound search and live-truck response size and count`).
- Current `origin/main` tip at decomposition: `caa9a56639c68da52d4f60d73b6373cdc22c6060`.
- Step 5 (this record): PR #322 decomposed into separate current-main salvage branches. **Not merged wholesale.** Independent proofs are step 6+.
- GitHub Actions remains **retired as release evidence**. Use Actions-free exact-commit / Render / local matrix evidence only.
- No production deploy or production migration was performed for step 5.
- Rescue branch `rescue/2026-07-28-mealscout-local-state` remains untouched.

Detailed file attribution: `docs/PR322_STEP5_DECOMPOSITION_MAP.md`.

## PR #322 behavioral salvage map

Source: `repair/2026-07-28-mealscout-preview-validation` at `e897188f`.

Step 5 opened current-main salvage branches/charters (see table). Rows stay
`PENDING PROOF` until step 6+ independent evidence. Branches must not be
treated as PASS from decomposition alone. `server/routes/actionRoutes.ts` is explicitly
excluded from payment/delivery salvage.

| Ordered slice | Candidate owners from PR #322 | Initial disposition | Required proof boundary |
|---|---|---|---|
| 1. Schema and stateful-test foundation | `migrations/119_menu_inventory_auto_availability.sql`, `shared/schema/legacy.ts`, PostgreSQL pickup/replay fixtures | **RETAIN** — branch `salvage/pr322-lane1-schema-stateful-foundation` (schema/migration extracted; fixtures charter) | Production-like PostgreSQL apply, replay, rollback or roll-forward statement, mixed-version compatibility |
| 2. Idempotency and Stripe state transitions | `server/middleware/idempotency.ts`, `server/routes/stripeWebhookRoutes.ts`, payment cancellation/state services, webhook contracts | **RETAIN** — branch `salvage/pr322-lane2-idempotency-stripe` (classifier extracted; webhook/idempotency charter) | Duplicate, stale, out-of-order and terminal-state replay; no real provider claim |
| 3. Pickup checkout and confirmation | pickup routes/pages, order confirmation, orders-workspace tests | **RETAIN** — branch `salvage/pr322-lane3-pickup-checkout` (charter + promotion TX hook) | Authoritative totals, stale reconfirmation, order creation, refund and exactly-once notification behavior |
| 4. Merchant delivery lifecycle | merchant delivery route/page, eligibility/timezone services and lifecycle contract | **RETAIN** — branch `salvage/pr322-lane4-merchant-delivery` (schedule/lifecycle code extracted) | Merchant authority, lifecycle transitions, customer visibility, pickup interaction |
| 5. Inventory availability | migration 119 plus menu routes/schema behavior | **RETAIN** — branch `salvage/pr322-lane5-inventory-availability` (column + owner clears; checkout SET pending lanes 2/3) | Sold-out/zero-inventory truth, concurrency behavior and migration compatibility |
| Excluded security lane | `server/routes/actionRoutes.ts` | Reject from PR #322 salvage | Rebuild only under trusted principal/delegation authorization work |
| Incidental overlap | route map, workspace shell, package scripts, affiliate cleanup and promotion service | **ATTRIBUTED** — route map/affiliate slug → lane 4; promotion TX → lane 3; workspace shell + package deletions + App.tsx → **REJECT/SUPERSEDED** | Retain only when required by one of the five slices; otherwise reject as unrelated or superseded |

The original PR closes without merge only after every hunk and intended
behavior is marked retained, reimplemented, superseded, or rejected with
evidence.

## Hold-lift evidence

One exact release SHA must have all of the following:

- TypeScript and production build
- full contract suite
- Chrome, Firefox, WebKit, and mobile browser coverage
- store-readiness checks
- production-like PostgreSQL migration rehearsal
- stateful Stripe duplicate, stale, and out-of-order replay
- provider sandbox and authenticated checkout validation
- pickup and merchant-delivery lifecycle validation
- cross-tenant Action API authorization negatives
- deployment pinned to the validated SHA
- controlled post-deployment smoke checks
- documented rollback or roll-forward boundaries
- executed required checks enforced through branch protection

The local and production checks recorded above remain valid only for their
tested Action API and build-marker surfaces. They establish containment of the
public-read disclosure boundary, not a full MealScout release verdict.
