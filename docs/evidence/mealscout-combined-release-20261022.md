# MealScout combined profile and Deals/search candidate — 2026-10-22

Sources: profile PR434 (`2b1fe1e8`) and canonical published Deals/search PR435 (`741179d9`), both based on `2a49c732`. The merge had no path conflicts and preserved all source blobs before the independent integration corrections below. Held PR427/431/433 are excluded.

## Integration corrections

- Native detail Claim/Save targets retain the existing food-led header/footer with safe-area spacing, without overlapping global navigation. A center-only pre-fix probe passed; a stronger vertical-edge hit-target probe on the actual mobile App failed before correction and passed afterward. Rounded decorative corners are excluded from this hit test.
- Used receipt history permits an explicit subsequent claim within the offer allowance. Unused receipts and exhausted allowances open the existing receipt. Every write still reconciles native history and requires server authorization.
- Explicit consumer wallet links work for merchant roles; default merchant orders retain their native workspace.
- Card/detail Save use the existing restaurant favorites API and Saved screen, with failure/refresh/retry and account-scoped caches. No new bookmark product or endpoint is introduced.
- Fixed-discount share previews retain actual terms and do not invent a minimum. The existing canonical share fallback preserves native attribution behavior during a generator outage. No provider share was executed.
- Offer removal locks the parent row and deactivates offers with issued receipts, retaining their required foreign-key parent and history. Claim-free offers still delete. Retained inactive offers remain visible in owner management; no schema or permissions changed.
- Local menu projection carries only canonical already-public live/static coordinates. Stale/private truck administration coordinates never become a distance fallback.
- Same-path search query navigation subscribes to the native query-string hook, so browser Back restores query/results.

## Executed proof

- Combined native profile harness: 146 routed/API/desktop/mobile checks PASS, synthetic PGlite fixtures.
- Disposable PostgreSQL17.11: 53 native-schema/password/Passport/session/ownership/profile/claim/removal checks PASS, exit0. Five simultaneous claims create one receipt/capacity reservation and one synthetic notification; subsequent used claim and concurrent deletion preserve issued history. Native Neon transport/migration upgrades are outside this local proof. All browser, HTTP, session-store and pool resources closed; owned tmpfs container removed. Receipt: `mealscout-combined-native-release-20261022.json`.
- Deals/search focused behavior: 27 tests PASS, including canonical public menu location/privacy.
- First combined browser run:50 passed; four failed assertions exposed a rounded-corner probe artifact and an unstubbed attribution request. Corrected fixtures/geometry then14 targeted cases PASS on desktop/mobile Chromium. Four further card/account-cache cases PASS. Full frozen-head CI remains required.
- Typecheck, production build, and native owner-order regression PASS locally. Build ran without connected provider credentials/service marker; existing provider diagnostic was not invoked locally.
- Screenshots and request/response receipts: `/workspace/mealscout-combined-release-evidence/`; original profile before/after proof and two independent objection reports remain in `/workspace/mealscout-profile-evidence/`. These are actual rendered synthetic records, not generated images.

## Release gates and boundaries

Two independent reviewers fully read the21 new Deals files and relevant native callers, retaining prior unchanged-profile full-file verdicts. Original combined `dbb1672a` required the corrections above; corrected frozen-source rereviews and exact-head GitHub CI are pending at this document's creation. Local agents are not GitHub human approvals. No gates were removed; the focused unit and two routed browser suites are added to the existing CI commands.

Existing Render service `srv-d5escdh5pdvs73foo41g` auto-deploys main commits; no merge until reviews/checks pass. Its predeploy migration path is unchanged, and this source introduces no migrations. The last live base deploy's diagnostic reports no sandbox key, no sandbox writes and zero live mutations. No payment/provider/auth/access configuration changes are part of this candidate. Production metrics, indexing and AI-search ranking are not measured or guaranteed. Robots access policy, private/unpublished visibility and bridge contracts remain intact. Denied Library/Safari publication routes are not retried. No real claims, coupons, orders, payments, customer messages or profile edits were made.

## Saved response boundary correction

The next full-file review at5acb7df0 found that the newly connected Saved journey still consumed the legacy raw nested restaurant response. The native authenticated GET now applies existing canonical owner visibility, public eligibility/quarantine checks and the public allowlist; saving does not grant access to private address/contact/admin fields. Hidden/disabled/nonpublic businesses are omitted, and the personal collection is private/no-store. No stored consent or access setting changes. Three exact-native-handler HTTP checks execute the real canonical projector against synthetic storage/owner-read seams: private address/admin data suppressed, explicitly public address preserved, visibility failure returns500 with retryable error instead of raw/empty200. They pass locally and are added to the existing CI behavior step. Native auth/session and PostgreSQL receipt proofs remain unchanged; no full-suite rerun was used for this bounded correction. Corrected-source independent reviews/fullCI still gate merge.
