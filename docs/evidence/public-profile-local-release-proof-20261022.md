# MealScout public profiles: local release proof

Main remains `2a49c732ac6b51df54c30ba4224e44d0ad6936c9`. Product modules are unchanged from independently reviewed `c6608618995bcb328c900260f46bb9ea0c9e8aa2`. New routing tests were committed in `3ea4c3ef`; the PostgreSQL/auth runner and its executed assertions are pinned to `579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f`. `efc0475f8a154e30b7b4eff06f47d37a5f4caa90` changes only the runner's explanatory comment and receipt-scope label to make the database adapter boundary precise. Later evidence-only commits add no executable changes.

## Routing failure closed

The former route/assets contract selected the first rewrite whose destination was `/index.html`. Current configuration places the exact `/deals/featured` app route before the generic fallback, so that selector inspected the wrong rule. The actual fallback already excludes `assets/` and `static/`.

The corrected contract selects the parameterized `/:path(...)` catch-all, checks positive app-path matches and negative static-path matches, and retains the existing filesystem/asset-404 ordering and profile-hook checks. It passes. No production route, `vercel.json`, robots or crawler-access rule changed.

The new `scripts/public-profile-edge-route.behavior.test.ts` also passes (1/1). It interprets the current ordered regex `routes` table over two loopback Express listeners and a real disposable static filesystem. It verifies existing JS/CSS content/cache headers, terminal missing GET/HEAD JS/CSS 404s, all seven typed public-profile routes with synthetic browser/bot user agents, legacy/catalog/API query forwarding and the exact ordinary SPA exceptions. The backend is a loopback path-echo fixture. This is stronger configuration behavior evidence; it is not hosted Vercel acceptance, validation of every configuration feature, or proof of the precedence/compatibility of the two configuration systems.

## Native PostgreSQL and password/session proof

The owned Docker fixture used the existing `postgres:17-alpine` image, loopback-only host binding, a dedicated synthetic database/user/password and tmpfs data. The repository's unmodified `drizzle.config.ts` and `drizzle-kit push --force` applied the native schema to an empty fixture. PostgreSQL reported version 17.11 and 484 public-schema constraints. No production database URL, account, credential or OAuth configuration was used.

`scripts/qa/public-profiles-postgres-auth.ts` retained native bcrypt password comparison, unified-auth handlers, Passport serialization/deserialization, `getSession()`/connect-pg-simple PostgreSQL session store, storage repositories, ownership and profile-access policy functions, API/SSR registrars and the actual Vite/App routes. Its one source substitution replaces the `server/db` module with local node-postgres and its Drizzle binding. Consequently, native Neon pool/search-path setup and the deployed driver/configuration remain untested.

The final runner exited **0** with [43 passing checks](public-profile-postgres-auth-20261022.json):

- Seven public types through PostgreSQL-backed logged-out API/HTML, actual mobile routed UI and native canonical identity.
- Native email/password UI login reaching the selected owner profile editor, HTTP-only local SameSite-Lax cookie, real PostgreSQL session persistence and native sanitized-user deserialization.
- Wrong-password/unverified-email rejection; logged-out/foreign-owner edit rejection; hidden unverified publication rejection and public API 404.
- A real fixture-local PostgreSQL update failure, rollback and retained owner draft, followed by successful retry/save/reload and desktop readback of the mobile edit.
- Two simultaneous native PATCHes to different scalar fields both persisting through the existing lock path.
- Logout, persisted-session destruction, old-cookie replay rejection, business-password login and expired-session edit rejection.

The first runner completed those assertions and closed its resources but stayed alive because native `documentValidation.ts` installs a process-lifetime cache-cleanup interval. Only that owned runner was terminated. The final standalone runner explicitly exits after awaited resource cleanup and was verified again on a fresh native-schema fixture. Its final receipt has browser/server/session-store/database-pool cleanup all true. The identified owned container `253eb57e5ac465c1255983b4497e3f43e6ddde10f1076dbc7286c4762f662f48` and tmpfs data were removed at `2026-10-22T18:30:28.523646+00:00`; no other containers were modified.

The PostgreSQL test does not upgrade every earlier flow's proof boundary. Native manual-stop create/read and catalog browsing retain their previous PGlite/synthetic-auth evidence; populated supplier catalog, every hidden/disabled owner state, same-document settings contention, production migration history, OAuth, providers/geocoding, deployed cookies/origins, Neon, CDN and indexing remain outside these 43 checks. Desktop PostgreSQL UI coverage concerns owner edit continuity; the earlier 146-check run separately covers all seven public desktop/mobile views. No unchanged broad suite was rerun; the fresh PostgreSQL rerun specifically verified the runner-liveness correction.

## Independent review

[Local release review 1](public-profile-local-release-review-1-20261022.md) and [review 2](public-profile-local-release-review-2-20261022.md) independently read all three affected test files completely, exact diffs and relevant native auth/session/storage callers. Both give bounded PASS at the executed `579b6f66` revision and recheck the claim-only `efc0475f` refinement. Reviewer 1 independently reran only the two newly affected safe routing checks. The PostgreSQL scenario was executed by the implementing assistant and independently inspected through source, receipts and terminal evidence; it was not falsely counted as two independently executed database runs. These reviews do not constitute GitHub/human non-author approval or release authority.

## Delivery and remaining gates

The existing complete Library ZIP `libfile_b120abc68d488191a09b29dc68ccc802`, version 2, remains unchanged and valid for the repaired product. This continuation supplies additional committed test/evidence source, a complete current patch/bundle and local proof supplement, without repeatedly uploading that ZIP.

The latest visual request reduced delivery to four existing representative captures: caterer mobile before/after and truck desktop before/after. All staged copies were SHA-256 identical to their original files. The one expressly permitted retry of the same supported Library helper failed again at `hosted apps tools/list` with `network`, before preparation/transfer/finalization. There are zero new image IDs and no uncertain write. No explicit access-denial response was returned; the underlying transport cause is unconfirmed. No additional retry, direct prepare/finalize call or alternate transfer was attempted.

Separate Deals/search candidate `741179d97a438c9bea9a2aee13a8dd1248bb7851` has source ZIP `libfile_aacfaae135488191ab54bc8a813fb3d0`. Its retrieval is **unavailable**, not denied: this execution context exposes no Library reader/materializer, and hosted-app discovery is unavailable. The archive was not retrieved, its fixes were not reconstructed, and source-path conflict reconciliation is not claimed. Integration must preserve that lane, including any shared App.tsx hunks.

Remaining release requirements are normal exact-integrated-head CI and required GitHub/human review; obtaining the available Deals/search source for conflict review and separate decisions for held PR427/431/433; hosted preview/CDN/Neon/cookie-origin and migration-upgrade acceptance without assuming local proof covers them; any additional acceptance required for the explicitly unproved flows above; and explicit deployment authority. Public/free basic discovery remains tier-neutral in the existing source; indexing/ranking is not guaranteed.

The draft PR remains **DENIED, not executed**. Automatic approval review said source preparation/push did not explicitly authorize opening a PR. It was not retried, and the parent is handling any batch approval. The denied Safari location-publication probe, robots/access policy, held PRs, production records, real publishing, memberships/permissions, orders/payments and production deployment remain untouched.
