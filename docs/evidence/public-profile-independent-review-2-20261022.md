# Independent full-file objection pass 2

Reviewer: `/root/profile_objection_two`, a separate non-author agent. No consultation with reviewer 1. This is local source/runtime review, not human or GitHub reviewer approval.

Original exact comparison: base `2a49c732ac6b51df54c30ba4224e44d0ad6936c9`; candidate `1ae0db3b3876bdaf20e910e0f691231d60be8b65`; branch `fix/public-profiles-20261022`. The worktree was clean at review start. All affected product modules were read in full, including unchanged portions; this was not a diff-only or AST-only review. Reads were chunked below 64 KB, and tool-output truncation gaps were reread.

## Original candidate verdict: objections

### P2 — Caterer and private-chef native mobile actions are covered by the global navigation

Exact locations: `client/src/App.tsx:694` omits `caterer` and `private-chef` from the self-contained public-profile shell predicate; `client/src/components/public-profile/MobileActionDock.tsx:102` places the action dock at `z-50`, while `client/src/components/navigation.tsx:685` places the global bottom navigation at `z-[1100]`.

Safe reproducer: at 390×844, load the existing synthetic caterer or chef DTO through the actual App route. At the center of each visible profile dock anchor, call `document.elementFromPoint`. The pinned-source local reproducer found all three caterer and both private-chef action centers covered: caterer Call hit Scout, and Directions hit More. `before/` and `after/` service-type screenshots show the same collision. This is an unresolved acceptance defect already present in the base, not a regression newly introduced by this diff.

Required fix: include both registered native service-profile routes in the existing self-contained shell policy. Verify pointer hit targets, rather than visibility alone, at mobile width for all seven profile types. Preserve the ordinary global navigation on other routes.

### P2 — Host discovery failures are rendered as confirmed empty inventory

Exact locations: `client/src/pages/public-profile.tsx:1128` and `:1143` return `{totalTrucks:0,trucks:[]}` for every non-OK discovery response; `:1309`–`:1313` then render “No trucks listed right now.” The separate changed `LocationNowSection` at `:633`–`:671` improves missing counts, but does not repair this adjacent section.

Safe reproducer: return HTTP 503 for both GET `/api/public/discovery/location/<synthetic-host-id>/time/{now,tonight}` requests while returning the existing public host DTO. The actual App view rendered the empty-inventory assertion. The real unchanged server route (`server/routes/discoveryRoutes.ts:844`–`:1074`) can return 500 on discovery failure, so this is a reachable failure state. The existing QA assertion (`scripts/qa/public-profiles-repair.ts:105`) examines only `#menu`, missing the contradictory next section. `after/location-1365.png` shows that next section still claiming empty inventory.

Required fix: preserve error/unknown state for non-OK and malformed responses; show an honest unavailable notice with a local retry. Show confirmed empty inventory only after valid successful discovery reads. Check partial success, malformed payloads, retry, and stale cached data after an error. This adjacent behavior also exists in the base; it remains within the requested full-profile truth/recovery acceptance scope.

### P2 — New client structured identities differ from server structured identities

Exact locations: `client/src/pages/public-profile.tsx:3120` emits `ProfilePage`, `:3125`–`:3127` gives non-restaurant/bar entities generic `LocalBusiness` and all entities `#business`. The native SSR uses `WebPage` (`server/seo/publicProfilePrerender.ts:664`, `:889`, `:1304`), `FoodTruck`/`FoodEstablishment` (`:608`–`:614`), `#location` (`:846`), and `#supplier` (`:1278`).

Safe reproducer: compare `after/*-ssr.html` JSON-LD with the script inserted after loading the same profile's App view, matching entities by canonical URL and ID. In particular host and supplier acquire a second identity fragment; truck and service entity types also change. The new client schema should describe the same server-owned entity.

Required fix: use the same page/entity IDs and types as native SSR, with an explicit seven-type SSR/App parity check. Canonical origin itself is correctly taken from the native DTO. No robots/access policy change is requested or authorized.

## Full-file coverage

All ten originally affected product files were read completely at the original candidate:

- `client/src/components/owner-profile-workspace.tsx` (800 lines)
- `client/src/components/public-profile/MobileActionDock.tsx` (141)
- `client/src/components/public-profile/PlanYourVisitPanel.tsx` (147)
- `client/src/components/public-profile/PublicProfileDecisionBar.tsx` (251)
- `client/src/components/public-profile/TruckSchedulePanel.tsx` (235)
- `client/src/components/seo-head.tsx` (212)
- `client/src/pages/public-profile.tsx` (3397)
- `server/publicProfiles/toPublicSupplierProfile.ts` (85)
- `server/routes/restaurantOperationsRoutes.ts` (3872)
- `server/seo/publicProfilePrerender.ts` (2006)

Both affected tests were read completely: `scripts/public-profile-native-continuation.behavior.test.ts` (40 lines) and `scripts/qa/public-profiles-repair.ts` (197). The exact base-to-candidate diff and checkpoint `docs/evidence/public-profile-repair-20261022.md` were read. The repository AGENTS and current cloud Selective Intelligence skill were read.

Relevant unchanged readers/callers read in full or as complete relevant functions: ProgressiveContactLink; truckScheduleTruth; profileActionPolicy; publicProfileUtils; toPublicProfileSeo; publicRestaurantIndexability; toPublicLocationProfile; App's SharedPublicRoutes, shell policy, and App shell branches; SupplierDetailPage; supplier catalog registrars; public profile API's complete seven-entity route and enabled-owner/canonical-origin helpers; location discovery complete GET route; owner draft builder, selected-business setup-link builder, profile save mutation and workspace wiring; parking-pass selected-accessible-truck load and manual-stop save function; native public app asset registrar and server route-registration order. Source-only unchanged code was not represented as real auth/provider execution.

## Evidence and tests

- Inspected `after/receipt.json`: 120 checks, no reported defects. SHA-256 `92ea7e99fbce21d959e0e1d339ae1ceda6d43e8ee3a1971dc9b03a8fd28bbffd`. It explicitly scopes proof to synthetic PGlite/auth/storage boundaries. Its host #menu and heading/overflow checks do not detect the first two objections.
- Visually inspected all 28 before/after native profile screenshots: seven types at 1365 and 390 widths. Also inspected after owner mobile/desktop, manual fallback, and supplier catalog captures. Baseline host/supplier component captures use the fixture's explicit App selection; they do not establish a working baseline SSR handoff.
- Ran `env -u DATABASE_URL -u NEON_DATABASE_URL node --import tsx --test scripts/public-profile-native-continuation.behavior.test.ts`: **2/2 passed**. Explicit no-DB warning and injected unavailable-loader logs were expected. No real database was connected.
- Independent adverse browser run: `.tmp-tests/review2-adverse.mjs`, with pinned `git show` source for App/public-profile so concurrent author edits could not alter the original verdict. Actual Vite/App at 390×844; synthetic DTOs read from the existing receipt; all browser nonreads blocked, external requests blocked, no DB. Results: `review2-adverse.json`; viewport images `review2-{caterer,private_chef,location}-390.png`. Both first objections reproduced. An earlier preliminary run saw working edits; it was superseded by this explicitly pinned run and is not claimed as original-head evidence.

## Preserved behavior and proof limits

No other concrete new blocker was found in supplier canonical/ID/type binding, bounded app query continuation, private fields, route-revocation handling, ordinary owner failed-save draft retention/retry, already-public unverified edit semantics, hidden-to-public rejection, manual selected-business link, menu/gallery/share preservation, optional owner-AI entry, warm MealScout brand, or bridge headers. Existing screenshots and receipt support those claims only within their synthetic scope. Supplier catalog proof uses an empty catalog; real populated catalog/provider/account flows were not accepted by this review.

The candidate does not itself prove current integrated CI, standard PostgreSQL migrations/concurrency, production sessions/OAuth, provider operations, CDN routing, indexing/ranking, real publication/owner consent, orders/payments/bookings, or production deployment. The unchanged Vercel route/assets predicate failure remains an unpassed gate. Public default/free versus paid metadata has fixture parity, and the indexability code has no subscription gate; this is not evidence of actual search-engine indexing. Robots/access policy remains held and untouched.

No product file was edited by this reviewer. No push, PR creation, deployment, message to third parties, real data/access/membership mutation, payment/order action, or location-publication probe was attempted. The denied draft-PR action was not retried. Deals/search candidate `741179d97a438c9bea9a2aee13a8dd1248bb7851` and held PR427/431/433 were untouched.

## Continuation

Parent accepted these objections and is preparing a correction on the same task branch. Original findings above remain bound to `1ae0db3b3876bdaf20e910e0f691231d60be8b65`. Next action: independently reread the complete revised App.tsx, public-profile.tsx and QA test, compare exact correction diff, inspect bounded correction evidence, then append an exact revised-head verdict. Do not infer release approval from a local review.

## Correction addendum — bounded PASS

Revised exact head: `c6608618995bcb328c900260f46bb9ea0c9e8aa2`. Verified clean worktree before and after the independent correction check. The only correction files relative to the original reviewed head are `client/src/App.tsx`, `client/src/pages/public-profile.tsx`, and `scripts/qa/public-profiles-repair.ts`. I read their exact correction diff and then reread **each complete revised file**: App.tsx 772 lines, public-profile.tsx 3415 lines, QA test 228 lines. The other nine originally affected product modules and the native continuation test are unchanged from the full-file original review. App.tsx is an additional affected product module, making eleven product modules in the final base-to-head review scope.

All three objections above are **closed for this revision within the local source/browser scope**:

1. The shell predicate includes both service types. The independent pinned revised-source browser check found every mobile dock action center receives its own pointer target for all seven profile types; the service-type global-navigation collision is gone. Revised caterer/chef mobile captures were visually inspected.
2. Discovery HTTP failures and top-level malformed payloads missing the `trucks` array enter the unavailable/retry path. The independent check forced 503, verified the unavailable notice without the false empty assertion, clicked retry into a valid empty response, then verified a malformed response stays unknown. The reviewed native correction receipt also records successful partial-result preservation and partial-error retry. No real location-publication probe was made.
3. The client now uses SSR's `WebPage`, entity fragment (`business`, `location`, or `supplier`), and seven-type business class. The independent browser check compared the actual inserted client schema against the saved actual native SSR JSON-LD for each of the seven types; all matched on page ID/type, main-entity ID, and entity type. I separately inspected all fourteen desktop/mobile schema comparisons in the correction receipt. This proves identity parity, not byte-for-byte field equality, search ranking, or production indexing.

Independent correction execution: `.tmp-tests/review2-corrections.mjs`, source modules explicitly pinned via `git show c6608618995bcb328c900260f46bb9ea0c9e8aa2`; actual Vite/App routes at 390×844; existing synthetic receipt DTOs; external requests and nonread requests blocked; no DB. **Exit 0**. Seven pointer-target groups and seven schema comparisons passed; the host 503/retry/malformed checks passed. Durable results: `review2-corrected.json`, SHA-256 `abf5f96424e737fe69e696233834c4f7e922964f8ddb4c1cb89ce9ad7a85d598`; seven viewport captures `review2-corrected-<type>-390.png`. Reproducer copies are saved as `review2-original-reproducer.mjs` and `review2-correction-reproducer.mjs` (run from the repository's ignored `.tmp-tests` directory so package resolution uses its installed dependencies).

Inspected the revised author journey evidence at `review-corrections/receipt.json`: **146 checks, zero reported defects**, SHA-256 `79c3458df02c2ae7d0d9551673101e570f3299bb898baf2846c21ab94090ea36`. The added test assertions now examine all seven dock hit targets, all seven actual SSR/App schema identities at both viewports, host 503/missing-array malformed/partial states and retry. These results supplement, rather than replace, the independent read-only execution. No unchanged broad suite was rerun by this reviewer.

**Final review verdict: BOUNDED PASS at c6608618995bcb328c900260f46bb9ea0c9e8aa2.** No unresolved concrete source objection remains from this full-file pass. The production/auth/PostgreSQL/provider/CDN/indexing and baseline CI limitations above remain unproved release gates. This verdict is neither deployment authority nor a GitHub/human approval, and does not release the robots/access hold, held PRs, or separate Deals/search candidate. No blocked external action was retried.
