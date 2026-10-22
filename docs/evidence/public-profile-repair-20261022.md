# MealScout public-profile repair candidate

Base: `2a49c732ac6b51df54c30ba4224e44d0ad6936c9` on `flavorgood/MealScout` main.
Product/source-test candidate: `c6608618995bcb328c900260f46bb9ea0c9e8aa2`. Later evidence-only commits preserve those product/test blobs.
Branch: `fix/public-profiles-20261022`. This is a source candidate, not a production release.

## Result

Restaurant, food truck, bar, caterer, private chef, host/location and supplier continue to use MealScout's existing warm food-led UI. Host/supplier HTML now has a bounded continuation to the existing React profile; the existing supplier catalog is reachable without a login requirement for browsing. Supplier desktop actions, exact-address directions without coordinates, and valid coordinate projection are restored. Truck current/next stops have truthful scheduled labels, a working full-schedule anchor and next-stop directions. Contact information does not present a truck's administrative base as its current stop. Unknown host activity counts are no longer described as zero.

The owner profile editor links directly to the same selected truck's native dated-stop editor. A mobile synthetic owner created a public manual stop through the registered booking API and actual DatabaseStorage method, with device geolocation unavailable, and the native public API returned that stop. An already-public unverified listing can save ordinary edits; a hidden unverified listing still cannot be published and receives the concrete verification reason. No private, unclaimed or unpublished source state was overridden.

Canonical identity now comes from the native server DTO for typed/clean/affiliate routes. Public React views include structured data from public fields. Failed/private reads clear stale public structured data and identify the unavailable page. The server's existing indexability/visibility policy, robots.txt, access rules, sitemap policy and cross-brand/owner-AI bridge are unchanged. AI remains optional in the existing owner profile editor.

Independent objections also repaired the existing service-profile shell omission: caterer/private-chef mobile profile actions now receive taps instead of being covered by global navigation. Host discovery HTTP failures and malformed responses show an unavailable notice and retry, rather than claiming zero trucks. Partial successful results remain usable while the failed period is retried. React structured entity/page IDs and types now match the native server HTML across all seven types.

## Proof and its limits

- 146 passing focused journey checks at `c6608618`: real Express public profile, menu, supplier, booking and profile-basics registrars; real projections; PGlite relational fixture; actual Vite/App routes; installed Chromium at desktop 1365x900 and mobile 390x844. Seven profile types, HTML/canonicals and schema identity/type parity, mobile action hit targets, public API/rendering, menu/photo presentation, no horizontal overflow, supplier catalog, scheduled current/next directions, failed read/retry and metadata cleanup, owner failed-save draft retention/save/reload, mobile manual stop, private field redaction, free/paid metadata parity, unpublished 404 and unverified publication rejection. Host discovery failure/malformed/partial/empty/retry states use explicit safe synthetic read responses; this is not backend-discovery/provider acceptance.
- Two native HTTP adverse groups reject stale IDs/types/canonical paths, malformed/duplicate app flags, unsafe query continuation, revoked public access and loader failure for locations and suppliers, including catalog binding.
- Six existing focused suites pass: schedule-state consistency, action policy, asset rendering, universal profile access, public evidence projection and truck availability truth.
- Six existing native app/asset boundary tests pass, including a real Chromium production-CSP CSS/continuation check. The installed system Chromium was selected by a local test-only launch adapter; a new Playwright browser download was unavailable (HTTP 403 domain restriction) and was not manually retried. No Safari/location-publication probe was performed.
- `npm run check` and the standard local production build pass, including fresh checks after the independent-objection corrections. The build includes the repository's eight mocked parking-provider readiness checks; no real provider acceptance is inferred.
- One older route/assets source contract fails before reaching profile assertions on its Vercel SPA-fallback predicate. Base and candidate `vercel.json` are the same Git blob `6d2f3fcf0ade073f3fc68bf07960065145dc2df4`. It is an unchanged baseline failure, not a passed gate, and was not repaired in this profile slice.

Authentication/current-actor and selected storage reads are explicit synthetic boundaries. Manual schedule create/read and parking-report reads use the original DatabaseStorage methods against PGlite. This fixture does not prove real PostgreSQL migrations/concurrency, production sessions, OAuth, live geocoding/providers, CDN routing, real owner consent, indexing/ranking, payments, bookings or orders. The private fixture may create isolated synthetic public stops; it never connects to a real database.

Before captures use the unchanged base product source. Host/supplier baseline HTML captures show the original self-loop; their baseline component captures explicitly select the existing App view inside the fixture because the natural SSR transition is broken. Final candidate captures use the actual routed continuation at `c6608618`. Earlier `1ae0db3b` captures are retained separately; the final proof includes the independently identified corrections. All photos and businesses in these captures are synthetic. The test harness evolved to add adverse checks; baseline and candidate assertion counts are not presented as identical suites.

## Objection passes

The initial implementing-assistant reviews were self-review and are not counted as independent. Two separate non-author reviewer agents subsequently read all ten initially affected product modules, both tests and relevant unchanged callers completely. They independently reproduced the remaining mobile action overlap, failed-discovery-as-zero state and new schema identity mismatch. The author repaired them in `c6608618`; both reviewers then independently read the complete revised public page, App shell and QA module, bringing coverage to eleven product modules and two tests.

Both now report **bounded PASS at `c6608618995bcb328c900260f46bb9ea0c9e8aa2`**, with their own read-only browser proof in addition to the author's 146-check run. [Review 1](public-profile-independent-review-1-20261022.md) records 18 independent observation groups including partial-feed retry request counts and seven-type private React-schema redaction. [Review 2](public-profile-independent-review-2-20261022.md) independently verifies all seven mobile dock hit targets and schema identities plus failed/malformed host discovery and recovery. Original findings and exact revision/full-file inventories are preserved in those reports. These are independent local agent reviews, not GitHub/human non-author approval or release authorization.

## Release requirements

1. Obtain any required GitHub/human non-author source approval for this exact candidate and current main. The two independent local objection passes are complete; they do not satisfy an external approval requirement. Preserve the separate Deals/search candidate `741179d97a438c9bea9a2aee13a8dd1248bb7851`. No Deals/search behavior was changed here; the final additive App.tsx hunk only adds two native profile types to the existing shell predicate and must be integrated without overwriting another lane's changes. The separate candidate object is unavailable in this clone, so absence of source-path overlap is not asserted.
2. Run existing required CI/repository gates against the final integrated head and resolve or explicitly accept the unchanged routing-contract failure through the normal process. No bypass is authorized.
3. Reconcile the separate held PR427/431/433 and their overlapping source hunks through their own explicit release decisions. This candidate neither applies nor approves those held changes. Location broadcast/session and Parking Pass behavior outside the tested manual profile continuation remain in that separate held lane.
4. Validate the integrated candidate in the existing staging/preview infrastructure with standard PostgreSQL and real authentication, checking seven public types, hidden/disabled records, editor save/retry, manual stops, catalog/menu links and canonical HTML/API parity. Real-profile or publication tests require their own authorization.
5. Obtain explicit production release authorization, release the same integrated source to the existing MealScout hosts, then verify CDN/HTML/app/API behavior. This task does not authorize deployment or the denied Safari location-publication probe. Search-engine indexing/ranking is not guaranteed.

Rollback: revert only this candidate's owned commits through ordinary review/release gates. No database migration, membership/permission change or provider configuration rollback is needed.

## Resume checkpoint

Objective: tested native public-profile source candidate, no production deployment.
Base branch/commit: main / 2a49c732ac6b51df54c30ba4224e44d0ad6936c9.
Current branch/commit: fix/public-profiles-20261022 / c6608618 (product/test revision; later evidence-only commits add no product changes).
Verified completed work: changes, 146-check synthetic journey proof, focused regressions, compiler/build, task-branch push verified, two independent full-file objection passes and correction rechecks.
Changed but unverified work: production integration/release/runtime and real account/provider acceptance.
Files changed: eleven product modules, two focused test files, this checkpoint and two independent review reports; see Git diff for exact paths.
Tests/evidence already run: results and limitations above; before/after receipts and captures are preserved in the separate source/evidence packet.
Tests/evidence invalidated by later changes: the older 120-check run does not prove the three correction behaviors; the final 146-check run, two independent correction rechecks and fresh compiler/build prove the final source within their stated scope. Unchanged server/native boundary evidence remains valid.
Known blockers/risks: GitHub/non-author approval and exact integrated CI/preview checks remain release requirements; one unchanged source contract fails. Library screenshot batch is unavailable at helper tool discovery before writes; source delivery is not blocked.
External side effects and retry safety: task branch commits/push and Library ZIP save only. Draft PR creation was denied and not executed. No production writes, communication, payment, real publishing or deployment.
Next exact action: deliver the reviewed source/evidence packet, then obtain the parent's bundled release/PR decisions and normal integration gates.
Actions that must NOT be repeated: denied draft PR without new owner evidence; denied Safari location-publication probe; any production publication without new authority; held PR mutation; Deals/search duplication; TradeScout edits; robots policy changes.

## Individual screenshot Library upload

All 33 existing requested screenshots were staged as byte-identical, distinctly named copies; none were regenerated for upload. The required Library batch helper failed at `hosted apps tools/list` with `network` on 2026-10-22 before preparation, transfer or finalization. No new image IDs exist and no write is uncertain. This is an unavailable execution path, separate from the denied PR action. The prior Library ZIP remains `libfile_b120abc68d488191a09b29dc68ccc802`; the complete packet retains all captures and a per-file hash/status manifest. [Library prepared-upload instructions](skill://plugin_connector_1p_1b8ff8edfc1481918b252c8277e23125/library/references/prepared-uploads.md) explicitly say: “Never switch a started helper write to a direct action.” No direct upload fallback was attempted for that started batch.

## Blocked external action

The attempt to create a draft PR titled “Repair native public profile access, actions and owner continuity” from `fix/public-profiles-20261022` to `flavorgood/MealScout:main` was denied by automatic approval review on 2026-10-22. The stated reason was that preparing and pushing the source candidate did not explicitly authorize opening a PR. The tool reported rejection; no PR was created. Do not retry that action through GitHub CLI, another connector, executor or indirect method. Explicit user approval is required before retrying. The source branch push and the Library source/evidence bundle succeeded independently.
