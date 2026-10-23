# Independent local release-proof review 2

Reviewer `/root/profile_objection_two`; non-author local review. No new agents or consultation with reviewer 1. Scope is the newly authorized local proof, not a repeat of the product audit or a production approval.

## Verdict

**BOUNDED PASS at `579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f`.** No concrete blocking defect found in the three proof files or the claims supported by the inspected receipts. Product files under `client/`, `server/`, `shared/` and `vercel.json` have no diff from the previously reviewed product head `c6608618995bcb328c900260f46bb9ea0c9e8aa2`. The worktree is clean at final observation.

The initial delegated head was `3ea4c3ef0f32299fd284f254a05827bf31ddb2cc`, with the PostgreSQL runner then untracked. Its fully read bytes were subsequently committed unchanged at the final head. Exact source identities:

| Fully read file | Lines | Git blob | SHA-256 |
| --- | ---: | --- | --- |
| `scripts/public-profile-route-and-assets.contract.test.ts` | 134 | `256d3111edc241caf13a35c9d62241f2af490d49` | `20700e0a11e121c1d649076d0a6b5e858452aca1defc77f9df61e85edb2df5d0` |
| `scripts/public-profile-edge-route.behavior.test.ts` | 91 | `bb6c5db8664ec4c611d6f4aba5d7b89913bddb58` | `47ebbd66d5a995b15e8b741d72fdef3199f4de0f0e3803f270298da9bcdf57d4` |
| `scripts/qa/public-profiles-postgres-auth.ts` | 167 | `857229b0c73bdd89b59b5d2143b4ec1b7730dfc9` | `6ca99624190305e373ede8f3d3a13a7d9530ce91ebf38cdf870b7dd2a26d4af3` |

The complete relevant test diff was reviewed: c6608618 → 3ea4c3ef for the contract/edge tests; 3ea4c3ef → 579b6f66 for the PostgreSQL runner. No product source was edited by this reviewer.

## Validity and authority assessment

The corrected contract selects the parameterized catch-all rather than the earlier exact `/index.html` rule (`public-profile-route-and-assets.contract.test.ts:28`–`:39`). It checks actual positive/negative matches for the current expression and retains filesystem/asset-404 ordering and profile-hook assertions. This repairs selection of the wrong rule; it does not change or bypass the route configuration. `vercel.json` is still the base blob `6d2f3fcf0ade073f3fc68bf07960065145dc2df4`.

The edge test explicitly reads the current ordered `routes` table (`public-profile-edge-route.behavior.test.ts:13`), uses a disposable filesystem, and proxies matched destinations only to a loopback stub after asserting the configured target origin. It tests existing JS/CSS content types/cache headers, missing JS/CSS GET/HEAD 404s, seven typed profiles for both synthetic browser/bot user agents, legacy/catalog/API paths, and exact ordinary SPA exceptions. Its comment correctly calls this a configuration behavior model. It is **not** execution on Vercel or proof of Vercel's complete routing semantics, encoded-path handling, redirects, both configuration systems' precedence, CDN/proxy behavior, or production assets.

The PostgreSQL runner fixes its connection to `127.0.0.1`, the disposable database/user, and a caller-provided local port (`public-profiles-postgres-auth.ts:19`–`:40`). It clears provider/database secrets before loading the native bundled server, disables notifications/OAuth configuration, checks the expected database identity and empty users table, and uses synthetic identities/data. Its only source substitution is the DB module; native authentication, storage, ownership and route registrars remain in the bundle (`:70`–`:88`). Nonread server/browser requests outside its bounded allowlists are blocked. The local test writes and teardown were performed by the parent under the delegated authorization; this reviewer did not modify Docker or a database.

Native implementation inspection supports the assertions: bcrypt verification, email-verification rejection, Passport serialization/deserialization, session regeneration/save, sanitized auth response, native owner/membership checks, row/advisory-locked profile update, logout destruction, and PostgreSQL session expiry checks are retained. The deliberately failing PostgreSQL update trigger is fixture-local (`:132`–`:136`), tests rollback plus draft retention, and is removed before retry. Concurrent requests update distinct persisted fields (`:142`–`:144`); that is useful concurrent persistence evidence, not an exhaustive lost-update or lock-removal regression test. The standalone `process.exit` occurs only after awaited browser/server/store/pool cleanup (`:157`–`:167`); the remaining native document-validation interval is an inspected process-lifetime timer, so this exit does not itself invalidate the completed assertions.

## Complete read coverage of relevant native paths

- `server/unifiedAuth.ts`: imports/dependencies; complete `getSession`, cookie options, session establishment, Passport serializer/deserializer, both password-login route handlers, logout route, authentication middleware; relevant setup wiring and provider-configuration boundaries.
- `server/routes/authAccountRoutes.ts`: complete `/api/auth/user` handler, including sanitization and continuation.
- `server/storage.ts`: actual exported `new DatabaseStorage()`, user/email lookup delegates, ownership delegate. `server/storage/usersRepository.ts`: safe projection/table introspection, complete ID/email lookup and disabled-user handling. `server/storage/restaurantsDealsRepository.ts`: complete `verifyRestaurantOwnership`.
- Complete `server/services/businessTeamAccess.ts`, `server/utils/sanitize.ts`, `server/routes/accessPolicyDependencies.ts`, `server/db.ts`, and `drizzle.config.ts`.
- Installed `connect-pg-simple/index.js`: complete relevant close, query/get, set, destroy, touch methods, including the persisted `expire` predicate.
- Native profile mutation/lock route and owner UI were already read in full at c6608618 and remain unchanged. This review resumed that evidence rather than rereading unrelated product modules.
- Complete current `vercel.json`; all three test files in full, including unmodified portions. Text batches were below 64 KB.

## Inspected execution evidence

`postgres-auth/receipt.json`: **43 recorded passing checks**, PostgreSQL **17.11**, **484 public-schema constraints**, status PASS, browser/server/session-store/database-pool cleanup all true. SHA-256 `3081595e3c7788674188fe7e5df81de5b09938d83da329ad4f7d343b30e9049d`.

`postgres-auth-final.log`: inspected complete 126-line final log, ending `{"status":"PASS","checks":43,...}`. SHA-256 `82cbd3ca0e6d5c80ae0dc11a228ee1699dd0e9ea0b8ca1f7440502816a5ad6cb`. Expected rejected publication/persistence-failure messages correspond to the adverse assertions. The parent separately confirmed the final tool process exited **0**. The earlier run's post-cleanup timer hang is not silently counted as a clean exit; the final runner/log supersedes it.

`postgres-schema-final.log`: complete six-line log records the native `drizzle.config.ts`, pg driver, schema pull and successful changes applied. `postgres-cleanup.json` records removal of the specifically owned container/tmpfs database, no other containers modified, exit 0 and all resources closed. This reviewer did not independently operate Docker to re-prove the teardown.

`edge-route-current.log`: **1/1 test passed**, zero failures. The corrected contract's passing result is supplied in the parent execution evidence; its complete implementation and current target configuration were independently reviewed. No broad/full suites or PostgreSQL scenario were rerun by this reviewer.

## Remaining proof limits

These local results close the previously synthetic authentication/storage gap for the exercised password-login/session/owner-edit paths. They do not prove production secure/SameSite=None/domain/reverse-proxy cookie behavior: the runner deliberately uses development HTTP and checks SameSite=Lax. They do not prove OAuth, provider sessions, Neon/serverless behavior, deployment/CDN behavior, or real account/owner consent.

The adapter replaces the `server/db` module with `drizzle-orm/node-postgres` and a TCP `pg.Pool`, so its boundary includes the driver and Drizzle DB binding, not only wire transport. The native query/storage source is exercised; native Neon pool/search-path setup is not. The native schema is pushed into a fresh owned database; this is not a historical migration upgrade, mixed-version or production-data acceptance result. A count of 484 constraints is corroborating schema evidence, not proof that every constraint was adversely exercised.

The PostgreSQL runner does not create a manual stop, seed/accept a populated supplier catalog, or test live location/publication. No such acceptance is inferred; earlier synthetic manual-stop evidence keeps its original PGlite boundary. The runner is not an exhaustive membership/access revocation, privacy, financial, concurrency, or disabled-account suite. The prior full-file product review and its unaffected focused evidence remain separate.

No release, PR creation, hosted evidence publication, real-data/access mutation, payment/order action, Safari/location-publication probe, robots/access-policy change, held-PR mutation or Deals/search reconstruction was performed or authorized by this verdict. The denied draft-PR action was not retried. The four-image helper and unavailable Deals Library artifact remain outside this read-only review; no alternate route was attempted.

## Source-identity addendum — efc0475f

Source/claim review extends to `efc0475f8a154e30b7b4eff06f47d37a5f4caa90`. I read the **complete revised 168-line** `scripts/qa/public-profiles-postgres-auth.ts` and its exact diff against `579b6f66dbb25a7ff4c339ac3aa1968ad1055a0f`. This is the only committed changed file between those revisions. New blob: `4ca7a6402ecd1cf40c36ee8b9ebcd5b5fe16373c`; SHA-256: `1ed897de66d81da45863181e0e10230dce44fa236b757001c29fdec087093486`.

The two diff hunks only clarify the introductory comment (`:18`–`:19`) and the `report.scope` description (`:35`). They correctly state that the `server/db` Neon driver/Drizzle binding is replaced by local node-postgres/Drizzle, and that native Neon setup and migration upgrades are unexercised. No test logic, assertions, fixture operations, route wiring, resource cleanup, or exit behavior changed. No new objection arises; the bounded source/claim PASS extends to this revision.

**Runtime proof remains pinned to 579b6f66, not efc0475f.** No test, PostgreSQL, Docker, browser, or external action was run for this wording change. The original 43-check runtime receipt remains byte-identical, SHA-256 `3081595e3c7788674188fe7e5df81de5b09938d83da329ad4f7d343b30e9049d`; its older “transport only” scope text is qualified by this independent review and the corrected source description, not silently rewritten as a new execution. All previously recorded production/provider/migration/edge proof limits remain.

At this addendum's observation, HEAD is efc0475f and the harness has no uncommitted diff. Parent-owned evidence drafts (`docs/evidence/public-profile-repair-20261022.md` and `docs/evidence/public-profile-postgres-auth-20261022.json`) are present separately; this addendum neither reviews nor mutates them. Only this review evidence file was changed by the reviewer.
