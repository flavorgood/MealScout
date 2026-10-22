# MealScout public-profile repair candidate

Base: `2a49c732ac6b51df54c30ba4224e44d0ad6936c9` on `flavorgood/MealScout` main.
Product source: `85060be6`; source/test candidate: `588f555d4ca8c3ba34d975a0dfb0d546dd1d1bbf`.
Branch: `fix/public-profiles-20261022`. This is a source candidate, not a production release.

## Result

Restaurant, food truck, bar, caterer, private chef, host/location and supplier continue to use MealScout's existing warm food-led UI. Host/supplier HTML now has a bounded continuation to the existing React profile; the existing supplier catalog is reachable without a login requirement for browsing. Supplier desktop actions, exact-address directions without coordinates, and valid coordinate projection are restored. Truck current/next stops have truthful scheduled labels, a working full-schedule anchor and next-stop directions. Contact information does not present a truck's administrative base as its current stop. Unknown host activity counts are no longer described as zero.

The owner profile editor links directly to the same selected truck's native dated-stop editor. A mobile synthetic owner created a public manual stop through the registered booking API and actual DatabaseStorage method, with device geolocation unavailable, and the native public API returned that stop. An already-public unverified listing can save ordinary edits; a hidden unverified listing still cannot be published and receives the concrete verification reason. No private, unclaimed or unpublished source state was overridden.

Canonical identity now comes from the native server DTO for typed/clean/affiliate routes. Public React views include structured data from public fields. Failed/private reads clear stale public structured data and identify the unavailable page. The server's existing indexability/visibility policy, robots.txt, access rules, sitemap policy and cross-brand/owner-AI bridge are unchanged. AI remains optional in the existing owner profile editor.

## Proof and its limits

- 120 passing focused journey checks: real Express public profile, menu, supplier, booking and profile-basics registrars; real projections; PGlite relational fixture; actual Vite/App routes; installed Chromium at desktop 1365x900 and mobile 390x844. Seven profile types, HTML/canonicals, public API/rendering, menu/photo presentation, no horizontal overflow, supplier catalog, scheduled current/next directions, failed read/retry and metadata cleanup, owner failed-save draft retention/save/reload, mobile manual stop, private field redaction, free/paid metadata parity, unpublished 404 and unverified publication rejection.
- Two native HTTP adverse groups reject stale IDs/types/canonical paths, malformed/duplicate app flags, unsafe query continuation, revoked public access and loader failure for locations and suppliers, including catalog binding.
- Six existing focused suites pass: schedule-state consistency, action policy, asset rendering, universal profile access, public evidence projection and truck availability truth.
- Six existing native app/asset boundary tests pass, including a real Chromium production-CSP CSS/continuation check. The installed system Chromium was selected by a local test-only launch adapter; a new Playwright browser download was unavailable (HTTP 403 domain restriction) and was not manually retried. No Safari/location-publication probe was performed.
- `npm run check` and the standard local production build pass. The build includes the repository's eight mocked parking-provider readiness checks; no real provider acceptance is inferred. Compiled chunks contain the final manual-link, schedule and unknown-host-state repairs.
- One older route/assets source contract fails before reaching profile assertions on its Vercel SPA-fallback predicate. Base and candidate `vercel.json` are the same Git blob `6d2f3fcf0ade073f3fc68bf07960065145dc2df4`. It is an unchanged baseline failure, not a passed gate, and was not repaired in this profile slice.

Authentication/current-actor and selected storage reads are explicit synthetic boundaries. Manual schedule create/read and parking-report reads use the original DatabaseStorage methods against PGlite. This fixture does not prove real PostgreSQL migrations/concurrency, production sessions, OAuth, live geocoding/providers, CDN routing, real owner consent, indexing/ranking, payments, bookings or orders. The private fixture may create isolated synthetic public stops; it never connects to a real database.

Before captures use the unchanged base product source. Host/supplier baseline HTML captures show the original self-loop; their baseline component captures explicitly select the existing App view inside the fixture because the natural SSR transition is broken. Candidate captures use the actual routed continuation. All photos and businesses in these captures are synthetic. The test harness evolved to add adverse checks; baseline and candidate assertion counts are not presented as identical suites.

## Objection passes

Two local objection passes considered complete affected modules, their native callers, source diffs and routed evidence. The first found the misleading scheduled/live label, missing anchor, manual-link destination, unknown-count assertion and catalog continuation/desktop omission; the repairs are included. The second examined canonical/type/ID binding, auth/state transitions, privacy redaction, supplier catalog access, metadata cleanup, hook ordering, retained menu/media/share/AI behavior and release exclusions. Adverse native HTTP and routed tests pass. These were local reviews by the implementing assistant, not an independent human/GitHub approval or an independent-agent approval.

## Release requirements

1. Obtain a non-author source review (including the requested independent objection review) for this exact candidate and current main. Preserve the separate Deals/search candidate `741179d97a438c9bea9a2aee13a8dd1248bb7851`; no Deals/search paths or behavior were changed here.
2. Run existing required CI/repository gates against the final integrated head and resolve or explicitly accept the unchanged routing-contract failure through the normal process. No bypass is authorized.
3. Reconcile the separate held PR427/431/433 and their overlapping source hunks through their own explicit release decisions. This candidate neither applies nor approves those held changes. Location broadcast/session and Parking Pass behavior outside the tested manual profile continuation remain in that separate held lane.
4. Validate the integrated candidate in the existing staging/preview infrastructure with standard PostgreSQL and real authentication, checking seven public types, hidden/disabled records, editor save/retry, manual stops, catalog/menu links and canonical HTML/API parity. Real-profile or publication tests require their own authorization.
5. Obtain explicit production release authorization, release the same integrated source to the existing MealScout hosts, then verify CDN/HTML/app/API behavior. This task does not authorize deployment or the denied Safari location-publication probe. Search-engine indexing/ranking is not guaranteed.

Rollback: revert only this candidate's owned commits through ordinary review/release gates. No database migration, membership/permission change or provider configuration rollback is needed.

## Resume checkpoint

Objective: tested native public-profile source candidate, no production deployment.
Base branch/commit: main / 2a49c732ac6b51df54c30ba4224e44d0ad6936c9.
Current branch/commit: fix/public-profiles-20261022 / 588f555d (product source at 85060be6; this documentation checkpoint adds no product changes).
Verified completed work: changes, synthetic journey proof, focused regressions, compiler/build, branch push verified.
Changed but unverified work: production integration/release/runtime and real account/provider acceptance.
Files changed: ten product modules, two focused test files, this evidence checkpoint; see Git diff for exact paths.
Tests/evidence already run: results and limitations above; before/after receipts and captures are preserved in the separate source/evidence packet.
Tests/evidence invalidated by later changes: no product changes after successful product proof; new native adverse tests and fixture parking-report read correction are separately bounded.
Known blockers/risks: independent non-author review and exact integrated CI/preview checks remain release requirements; one unchanged source contract fails. No external tool currently blocks local source delivery.
External side effects and retry safety: only task branch commits/push and planned draft PR/Library source packet. No production writes, communication, payment, real publishing or deployment.
Next exact action: review this candidate, integrate under normal gates, then perform only authorized release checks.
Actions that must NOT be repeated: denied Safari location-publication probe; any production publication without new authority; held PR mutation; Deals/search duplication; TradeScout edits; robots policy changes.
