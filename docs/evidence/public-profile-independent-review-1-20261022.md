# Independent public-profile objection pass 1

**Final correction verdict: BOUNDED PASS at `c6608618995bcb328c900260f46bb9ea0c9e8aa2`.** R1-1 and R1-2 are resolved and independently rechecked. Original findings and original revision remain below for auditability. This is a local independent-agent source review, not a GitHub/human approval, integration, deployment, or real-account acceptance.

Original verdict: **CHANGES REQUIRED** for candidate `1ae0db3b3876bdaf20e910e0f691231d60be8b65` on `fix/public-profiles-20261022`, against base `2a49c732ac6b51df54c30ba4224e44d0ad6936c9`. This pass was performed by `/root/profile_objection_one`, an independent reviewer agent that did not implement the candidate. It is not a human or GitHub non-author approval, and does not authorize integration or release.

## Findings

### R1-1 — P2: location discovery failures are presented as confirmed absence of food

Location: `client/src/pages/public-profile.tsx:1128`, `:1143`, `:1309` (complete `LocationTruckOptionsSection`, lines 1111–1319). The error-to-zero code predates this diff; the candidate newly makes the natural host SSR → native-app continuation reachable and claims to repair unknown host activity. The full affected module still contains this second contradictory food-activity panel.

Both feed readers return `{totalTrucks:0,trucks:[]}` for every non-OK HTTP response. After two 503s the section renders “No trucks listed right now.” and offers no retry. This is a factual availability assertion based on an outage. The adjacent repaired `#menu` panel correctly says to check posted schedules, making the page internally contradictory.

Reproducer: run the preserved loopback-only review probe below; open the synthetic host through its actual canonical `?view=app` continuation and intercept only `/api/public/discovery/location/.../time/now` and `/time/tonight` with HTTP 503. The probe recorded exactly two failed discovery requests and the empty-food message in `review-1-probe/observations.json`; `review-1-probe/location-discovery-503.png` captures the rendered result.

Required fix: preserve unavailable/unknown separately from a successful empty result; show an honest unavailable state with retry, and retain any valid data without implying it is fresh. Validate successful empty, failed reads, and recovery, including the full page rather than only `#menu`. The original QA registrar fixture does not register `registerDiscoveryRoutes`; its `/api` catch-all returns `{}`, and its unknown-host assertion examines only `#menu`, so its 120 passing checks do not cover this behavior.

### R1-2 — P2: the new React JSON-LD changes the server-owned entity identity

Location: `client/src/pages/public-profile.tsx:3118`–`:3133`, especially `:3125`–`:3127`; compare native SSR `server/seo/publicProfilePrerender.ts:846` and `:1278`.

The new React schema always uses `canonicalUrl#business`, whereas native HTML declares a host as `canonicalUrl#location` and a supplier as `canonicalUrl#supplier`. The same canonical URL therefore describes different graph entities between HTML and app representations. The page type also changes from native `WebPage` to `ProfilePage`; truck/caterer/private-chef entity types change from `FoodTruck`/`FoodEstablishment` to generic `LocalBusiness`. Identical canonical URL strings alone do not prove schema parity.

Reproducer: GET the synthetic host/supplier canonical SSR HTML, parse its JSON-LD IDs, then use the normal `?view=app` continuation and parse `script[data-page-schema]`. The probe records all seven types. For the host it observed `...#location` in SSR and `...#business` in the app; for supplier, `...#supplier` vs `...#business`. Restaurant/bar IDs and entity types match; truck/service types differ as described.

Required fix: derive entity IDs, type mapping, and page identity from a shared owner or an explicit DTO contract matching native HTML. Preserve only public projected fields. Add behavioral comparison of actual native HTML and app JSON-LD across all seven types, privacy settings, and failure cleanup. No robots or access-policy change is required for this fix.

## Full-file and dependency review

Read AGENTS.md and `docs/evidence/public-profile-repair-20261022.md` first, confirmed clean HEAD `1ae0db3b3876bdaf20e910e0f691231d60be8b65`, then obtained the exact diff. Read **all ten affected product modules and both added test modules completely**, not only their diff or AST. The 3,397-line public page, 3,872-line restaurant operations registrar, 2,006-line prerender module, and other large files were read in consecutive bounded chunks, each below 64 KB. Truncated combined outputs were re-read at the omitted ranges. Additional full readers included both supplier DTO paths/catalog API, public restaurant/location/SEO projection, truck schedule truth, CTA policy, native supplier catalog page, owner navigation parser, and the truck hero. Relevant other handlers/callers were read in the bounded complete units listed in the machine manifest.

The exact immutable source inventory (paths, read ranges, line/byte counts, Git blob IDs and SHA-256) is [`review-1-source-manifest.json`](review-1-source-manifest.json). The commit-to-commit diff is [`review-1-exact.diff`](review-1-exact.diff), SHA-256 `93fbf4cbb215ba933cd5fa1b9fecccc0e29e89848098e2ee77728a0ee35a08e5`.

Reviewed behaviors without additional objections in this bounded pass: supplier coordinates use the canonical pair validator and suppress exact location/contact fields through owner visibility; new supplier catalog links survive desktop/mobile CTA filtering and use the native catalog route/API; public app admission remains bound to current entity/type/canonical path and safe query normalization; owner ordinary-save change remains within the authenticated ownership check and locked restaurant transaction; hidden→public verification gate remains; manual fallback preserves selected restaurant ID and reaches the native dated-stop UI; schedule current/next selection, anchor and directions use the existing truth/projection; public page and owner UI retain their native menu/media/share/optional-AI paths. Existing free/paid public metadata parity is source-supported and fixture-checked, but has no real-account acceptance evidence. Bridge URLs and HTTP discovery headers remain in the existing prerender contract. No robots policy recommendation is made.

## Evidence and independently executed checks

- `env -u DATABASE_URL -u STRIPE_SECRET_KEY -u BREVO_API_KEY NODE_ENV=development node --import tsx --test scripts/public-profile-native-continuation.behavior.test.ts` — exit 0; 2 tests, 2 pass. Preserved at `review-1-native-continuation.log`. Runs real Express gate code with injected eligibility loader, no real DB or external writes.
- `node --import tsx .tmp-tests/review-1-probe.ts` — exit 0; 8 observation groups. This reviewer-owned safe probe reuses the candidate's isolated PGlite/Vite/Express setup in a unique generated bundle, then performs GET-only browser/API work for all seven canonical SSR/app representations and forced discovery-503 reads. Browser external requests and all mutation requests are blocked. It does **not** create a new stop, invoke geolocation, publish a location, order, or pay. Probe source is preserved as `review-1-probe.ts`; result and screenshot in `review-1-probe/`.
- Inspected existing `after/receipt.json`: 120 checks true, no defects, 14 seven-type desktop/mobile capture entries. Its scope explicitly states loopback PGlite and synthetic auth/storage boundaries. Inspected `candidate-exact.log`, `candidate-final.log`, `candidate.log`, `baseline.log`, `native-continuation.log`, `app-boundaries.log`, typecheck logs, and build log summary. Latest exact journey log reports 120 checks without the earlier missing parking-report reader; earlier logs did have fixture reader/telemetry issues and are not stronger evidence than the latest exact run.
- Existing typecheck/build and six native boundary tests are recorded as passing; they were not redundantly re-run here. The build's eight parking-readiness checks use mocks. The known unchanged Vercel route/assets predicate failure is retained as a release limitation, not reclassified as passing. `vercel.json` is unchanged.

These tests establish local source behavior only. They do not prove real PostgreSQL migrations/locking/concurrency, production sessions or account consent, providers/geocoding, CDN routing, native Safari, crawler indexing/ranking, real owners, orders, payments or bookings. The original manual-schedule evidence is a synthetic-auth/storage/PGlite acceptance boundary, not real owner publication acceptance.

## Authority and remaining state

No product files were edited by this reviewer, no source was committed/pushed, and no PR, deployment, real data/membership/permission/order/payment write, outreach, or location-publication probe was attempted. Separate Deals/search candidate `741179d97a438c9bea9a2aee13a8dd1248bb7851`, held PR427/431/433 and robots/access hold were untouched.

The prior draft-PR creation is **DENIED, not executed**, per task authority/checkpoint: automatic approval review said source preparation/push lacked explicit authority to open a PR. It was not retried through any executor. It is not a blocker to this local review.

Next state: author repair and independently recheck R1-1/R1-2 at the exact new commit. This report deliberately remains pinned to the original candidate and is not a PASS for a later unreviewed revision.


## Correction addendum — c6608618995bcb328c900260f46bb9ea0c9e8aa2

The author committed the bounded corrections at `c6608618995bcb328c900260f46bb9ea0c9e8aa2`. I independently read **the complete revised** `client/src/App.tsx` (772 lines), `client/src/pages/public-profile.tsx` (3,415 lines) and `scripts/qa/public-profiles-repair.ts` (228 lines), again in consecutive chunks under 64 KB. Their blobs before/after reread match the commit. All other originally reviewed product/test blobs are unchanged; original full-file review remains valid. This expands the final product scope to eleven product modules plus two test modules. Clean tracked worktree observed at this correction head.

R1-1: resolved. Non-OK and missing-trucks-array responses throw, independent query failures produce an alert and retry control, and the empty-food assertion is gated on successful reads. A successful other period remains usable while a failed period is retried. R1-2: resolved. The app now uses native `WebPage`, correct host/supplier entity suffixes, and the native type mapping for all seven profiles. The other reviewer's App shell fix adds only caterer/private-chef to the existing self-contained profile classification; my full App read and all-seven mobile hit tests independently confirm it does not leave global navigation over the service-profile dock.

Independent targeted correction execution: `node --import tsx .tmp-tests/review-1-recheck.ts` exited 0 with **18 observation groups**. Preserved source: `review-1-recheck.ts`; log: `review-1-recheck.log`; detailed results: `review-1-recheck/observations.json`.

The reviewer-owned probe compared real native SSR JSON-LD with actual routed React JSON-LD for all seven profiles, asserting matching page type, page reference, graph entity ID/type and canonical URL; independently tested center-point hit reachability of all seven mobile action docks; forced host 503 and malformed reads without an empty-food assertion; recovered via retry to a verified empty result; tested one successful feed plus one failed feed; proved retry fetched only the failed period and retained the successful period using request counts; and checked all-seven React schemas after setting isolated fixture privacy flags to hide address/contact. All checks passed. It performed GET-only browser/API work with mutation/external requests blocked; no real account, provider or database was used.

`git diff --check 2a49c732ac6b51df54c30ba4224e44d0ad6936c9 c6608618995bcb328c900260f46bb9ea0c9e8aa2` passed. Exact comparison confirmed all other previously reviewed modules unchanged. Inspected the author's separate `review-corrections/receipt.json`: 146 checks, all true, no defects, including seven-type desktop/mobile schema identity, mobile dock hit targets and host failure/recovery cases. That is separate synthetic evidence, not counted as an independent reviewer execution. Existing native continuation test 2/2 still applies because its source and server gate did not change.

Final affected source inventory (all fully read, with unchanged-file proof as above):

| File | Lines | Exact Git blob |
| --- | ---: | --- |
| `client/src/App.tsx` | 772 | `1e307665fa76c458a4dce5822c357a8215df55c8` |
| `client/src/components/owner-profile-workspace.tsx` | 800 | `698c651af788ad13e4abecdeb19c8d98b5da7632` |
| `client/src/components/public-profile/MobileActionDock.tsx` | 141 | `fb5af96b7f26376cff06ad89ec34423b67d80b33` |
| `client/src/components/public-profile/PlanYourVisitPanel.tsx` | 147 | `24cb7a3b2ef2c2b1148009a40cfeaf7156014eff` |
| `client/src/components/public-profile/PublicProfileDecisionBar.tsx` | 251 | `a16c66e1e7cba729c29994cf4ea0113f0953efac` |
| `client/src/components/public-profile/TruckSchedulePanel.tsx` | 235 | `89f23359e28a7ca30c1ee5eb2fab6401261f8928` |
| `client/src/components/seo-head.tsx` | 212 | `237566ffb0341a6393bf5a001382d335200ce752` |
| `client/src/pages/public-profile.tsx` | 3415 | `7dc5b93cfbf9d1a227de90ad682462ab7172382e` |
| `scripts/public-profile-native-continuation.behavior.test.ts` | 40 | `4a8b332220cd8e3d57f5ed1f66a66cecf53ca1a7` |
| `scripts/qa/public-profiles-repair.ts` | 228 | `c01a64527db45ce5ba814a8715a3902213df2c19` |
| `server/publicProfiles/toPublicSupplierProfile.ts` | 85 | `ab6559a94bcee9a184389bda3b204b877f05ca97` |
| `server/routes/restaurantOperationsRoutes.ts` | 3872 | `68745f21f6b06334b0bde185c88a365a2ce9e205` |
| `server/seo/publicProfilePrerender.ts` | 2006 | `188c911dbe7e25abc30f79b610268c3178cd876e` |

Full SHA-256 and byte counts are also recorded in `review-1-final-source-manifest.json`; final base-to-correction diff is `review-1-final-exact.diff`, SHA-256 `252f374bf60a3b14af0c7811a6c710a943913049a1b71b92de5b2614a53dc829`.

No additional objection remains within this review's bounded source/local-fixture scope. Integration CI and preview with ordinary PostgreSQL/real authentication remain release requirements, as do reconciliation of held changes and explicit release authority. Robots/access policy hold and the denied PR action remain untouched. Schema parity here means entity/page identity and type consistency plus public-field redaction; it does not assert identical optional properties or indexing outcomes. No broader or real acceptance is inferred.
