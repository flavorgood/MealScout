# Local release proof — independent review 1

**BOUNDED PASS at `579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f`.** No test-validity or authority objection requiring a source change remains in this local proof. This is independent review of tests and evidence, not a claim that this reviewer personally reran the PostgreSQL fixture, a non-author GitHub approval, or production release approval.

Product modules are byte-identical to the previously independently reviewed correction head `c6608618995bcb328c900260f46bb9ea0c9e8aa2`. The later commits add documentation and tests only. I confirmed the exact diff and clean tracked worktree at `579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f`; I did not restart the product audit.

## Files read completely and exact identity

Read all three affected test files completely, including the entire 167-line PostgreSQL runner first as an uncommitted file and then confirmed byte-identical at its committed revision. The new-file diff is the complete runner source; the contract/edge diff was read exactly. Full native callers were read where compact; larger unchanged modules were inspected at the complete relevant function/handler boundaries listed in `local-release-review-1-source-manifest.json`.

| Test file | Lines | Git blob at 579b6f66 | SHA-256 |
| --- | ---: | --- | --- |
| `scripts/public-profile-route-and-assets.contract.test.ts` | 134 | `256d3111edc241caf13a35c9d62241f2af490d49` | `20700e0a11e121c1d649076d0a6b5e858452aca1defc77f9df61e85edb2df5d0` |
| `scripts/public-profile-edge-route.behavior.test.ts` | 91 | `bb6c5db8664ec4c611d6f4aba5d7b89913bddb58` | `47ebbd66d5a995b15e8b741d72fdef3199f4de0f0e3803f270298da9bcdf57d4` |
| `scripts/qa/public-profiles-postgres-auth.ts` | 167 | `857229b0c73bdd89b59b5d2143b4ec1b7730dfc9` | `6ca99624190305e373ede8f3d3a13a7d9530ce91ebf38cdf870b7dd2a26d4af3` |

Exact test diff from `c6608618995bcb328c900260f46bb9ea0c9e8aa2` is `local-release-review-1-exact.diff`, SHA-256 `40508b4e05085bbb0c13a5f2c1d1207f5b4f2dc9472668620b159dfddf34bcc2`. Complete read coverage and hashes for native auth, ownership, storage, sessions, router configuration, schema configuration and cleanup implementation are in `local-release-review-1-source-manifest.json`. Evidence hashes are in `local-release-review-1-evidence-manifest.json`.

## Independent objections and disposition

1. **Is the repaired routing contract merely bypassing its old failure? No.** The old `.find(destination === /index.html)` selected the earlier exact `/deals/featured` rewrite. The repaired predicate selects the actual parameterized `/:path(...)` fallback and checks both exclusion of static assets and inclusion of ordinary app routes. Existing filesystem-order and static-404 assertions remain. No `vercel.json` or runtime routing changes are hidden in this test repair.
2. **Does the edge test prove deployed Vercel behavior? No; its claimed local scope is valid.** It uses the actual ordered regex table, a disposable filesystem, two loopback Express listeners, and a fake backend that returns the native path. It verifies native destination/query preservation for seven typed routes and selected API/legacy/catalog routes, plus real static content and missing JS/CSS terminal 404s. It deliberately does not exercise Vercel's platform parser, external Render proxy, deployment/CDN, TLS, redirects/cookies/cache behavior, or every rewrite/route. The browser/bot labels do not transform it into crawler acceptance. These are limitations, not failures of its stated configuration-behavior claim.
3. **Is PostgreSQL/auth still synthetic at the same boundaries as the older fixture? No.** The esbuild substitution replaces only `server/db` with native `drizzle-orm/node-postgres` and a loopback `pg.Pool`. It does not replace unified auth, Passport, user storage repositories, ownership checks, access-policy factory, route registrars or session store. `getSession()` itself creates a real `connect-pg-simple` store from the owned local URL; its own pool is separate from the test pool and is closed by the awaited native store `close()`. Native bcrypt comparison and PostgreSQL session persistence/deserialization/logout/expiry are exercised. `/api/auth/user` sanitizes the response; Passport's internal `req.user` is not falsely assumed to be an allowlisted DTO.
4. **Does explicit runner exit hide unclosed test resources? The recorded final run does not.** The source awaits browser, HTTP server, Vite, session store and DB pool closure before writing the final receipt and exiting. The installed session store's `close()` clears its pruning timer and awaits its owned pool. `documentValidation.ts:162–176` does create the reported process-lifetime interval. The first run's forced termination after resource closure is retained as historical process-liveness failure; it is not presented as the final successful runner. The final receipt reports 43 PASS/all four cleanup booleans true, and the parent supplied successful tool-session exit code 0. `postgres-cleanup.json` independently records that terminal status and the owned-container removal.
5. **Do names imply broader coverage than proved? Retain the stated limits below.** One pair of simultaneous PATCHes changes different scalar fields; both values persisting is useful PostgreSQL behavior proof, but does not establish a deterministic race under overlapping JSON settings writes, long contention, or every owner/team permission. The failed-save trigger shows a real PostgreSQL error and rollback/retained draft; it is not proof of all multi-statement failure modes.

## Executed and inspected evidence

I independently executed only the newly affected safe routing checks:

- `node --import tsx scripts/public-profile-route-and-assets.contract.test.ts` — exit 0; `public-profile-route-and-assets.contract: PASS`; log `local-release-review-1-route-contract.log`.
- `node --import tsx --test scripts/public-profile-edge-route.behavior.test.ts` — exit 0; 1 test passed, 0 failed; log `local-release-review-1-edge.log`. This ran only loopback HTTP and disposable `/tmp` files.
- `git diff --check c6608618995bcb328c900260f46bb9ea0c9e8aa2 579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f` — exit 0. Git diff confirms no product-module changes after the reviewed correction head.

I inspected the native PostgreSQL runner, `postgres-schema-final.log`/`postgres-schema-push.log`, `postgres-auth/receipt.json`, `postgres-auth-final.log`, and `postgres-cleanup.json`, without running Docker, touching the database or rerunning the fixture. The recorded command is the standalone `node --import tsx scripts/qa/public-profiles-postgres-auth.ts` with an explicitly selected `PROFILE_QA_POSTGRES_PORT`; schema preparation uses the repository's `drizzle-kit push` configuration. The author/parent reports final tool session 53483 exited 0.

The receipt names database `mealscout_profiles_qa`, actor `profile_qa`, PostgreSQL 17.11, and 484 public constraints. It records **43 passing checks**: seven public types through PostgreSQL-backed API/SSR and real routed UI/canonical; logged-out/foreign edits rejected; wrong password and unverified email rejected; real UI password login; HTTP-only local SameSite-Lax session; native PostgreSQL session row/deserialization with safe auth response; hidden unverified publication blocked; real save failure/draft preservation/rollback, retry/reload and desktop readback; two concurrent scalar saves; logout/session destruction/cookie replay rejection; restaurant-login endpoint; and expired session rejecting edits.

The cleanup receipt at `2026-10-22T18:30:28.523646+00:00` says the identified owned container `mealscout-profiles-qa-20261022` / `253eb57e5ac465c1255983b4497e3f43e6ddde10f1076dbc7286c4762f662f48` was removed, its tmpfs database removed, and no other containers modified. This review trusts that inspected cleanup receipt and parent terminal evidence; I did not independently issue Docker commands.

## Scope that remains unproved

This local proof uses seeded synthetic owners/businesses and manually applies the native schema to a fresh owned PostgreSQL fixture. It does not prove a production migration chain, deployed Neon transport/configuration, real owner identity/consent, production cookie domain/Secure/SameSite-None behavior across Vercel/Render, OAuth, provider/geocoding behavior, CI integration with current main, CDN/edge deployment, Safari, indexing/ranking, payment/order/booking transactions or live release behavior.

The PostgreSQL runner does not create/read a dated manual stop, browse a populated supplier catalog, exercise hidden/disabled owners across all seven types, or test same-document concurrent settings merges. Earlier manual-stop/catalog evidence remains explicitly PGlite/synthetic-auth evidence; these 43 checks do not upgrade those particular flows to native PostgreSQL/session acceptance. Its positive public profile run is mobile, with desktop coverage focused on saved owner data. These limits must remain visible in release claims. The prior independent product verdict remains bounded as documented in `independent-review-1.md`.

## Authority, excluded work and blockers

The newly authorized local fixture work is consistent with the parent task packet: owned disposable PostgreSQL and synthetic accounts only. The runner fixes the host at `127.0.0.1`, fixes fixture database/user/password, requires an explicit local port and empty user table, clears real database/provider credentials, blocks unrelated writes and browser external requests, and disables device geolocation. I made no product/test source edit, Docker/database operation, external write, source push, PR, deployment, outreach or location-publication probe.

The prior draft-PR action remains **DENIED, not executed** because automatic approval review found no explicit authorization to open a PR; it was not retried. The denied Safari/location-publication probe, robots/access policy hold, held PR427/431/433 and separate Deals/search candidate remain untouched.

Delivery blockers are separate from local proof: the authorized four-image SAME helper retry failed at `tools/list` network discovery before any prepare/write, with no returned IDs and no fallback; retrieval of Library Deals source `libfile_aacfaae135488191ab54bc8a813fb3d0` remains unavailable because there is no exposed reader/materializer and helper discovery fails. This reviewer did not retry either blocked external operation or reconstruct unseen Deals fixes. Production/integration steps still require their own available authority and evidence.


## Source/claim-only addendum — efc0475f8a154e30b7b4eff06f47d37a5f4caa90

Independently reread the complete **168-line** `scripts/qa/public-profiles-postgres-auth.ts` and verified the exact diff against `579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f`. Only its explanatory comment and `report.scope` text changed. After excluding those comments and the one scope-initializer line, source comparison is byte-identical; no test logic, assertion, fixture, auth/storage operation, or cleanup changed.

The refined wording is accepted: the entire `server/db` Neon driver **and Drizzle binding** is replaced by test-only local node-postgres/Drizzle. This does not exercise native Neon setup or migration upgrades. It clarifies the prior evidence boundary; it does not add a new runtime result or retrospectively execute the revised scope text.

Source/claim review now extends to `efc0475f8a154e30b7b4eff06f47d37a5f4caa90`. The **43-check runtime PASS remains pinned to `579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f`**, with its original final log/receipt/cleanup evidence. No suite, database, Docker, deployment, external-helper or other action was rerun for this refinement.

Exact new Git blob: `4ca7a6402ecd1cf40c36ee8b9ebcd5b5fe16373c`. SHA-256: `1ed897de66d81da45863181e0e10230dce44fa236b757001c29fdec087093486`. Complete read identity and comparison: `local-release-review-1-claim-refinement.json`; preserved exact diff: `local-release-review-1-claim-refinement.diff` (SHA-256 `d46880804d640e13e5616157b9462407d159b0e506391251fa06b1d967702156`). Parent-owned documentation changes were observed in the worktree and left untouched. All earlier release limits, delivery blockers and denied-action restrictions remain in force.
