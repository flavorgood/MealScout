# MealScout source-owned public links

This is the first native integration slice of the shared TradeScout backend platform. MealScout keeps its branding, native canonical domain, customer journeys, database, owner authentication, orders and payments. The slice exposes an optional approved name + native public URL for a later ecosystem consumer; it does not merge deployments or databases, enable SSO, embed Scout, or change native public visibility.

## Owner journey

An actual MealScout restaurant owner can open the optional sharing control from the native dashboard. The page shows the native projected public name/link. Approve shares that exact link for seven days. Renew requires a fresh preview; Stop revokes immediately for subsequent source reads. Anonymous users, another owner, staff and generic admin roles cannot approve on the owner's behalf. No customers are automatically opted in. This initial slice covers canonical restaurant profiles only; truck/bar/Sway adapters need their own native admission review.

Approval grants only `public_link_only`: no private fields, contact permission, orders, payments, account authority or full TradeScout onboarding. A quarantined profile can still be publicly visible with MealScout's existing field redactions; optional ecosystem export is separately unavailable.

## Source authority and storage

Migration143 adds source-owned permission metadata and an append-only permission event table in the existing MealScout database. It initializes unapproved metadata, not approved customer state. Native deletion keeps a tombstone. Recreation and owner transfer rotate the generation and public partition; an old approval cannot attach to a new owner or incarnation. Relevant restaurant changes and native owner visibility changes increment revisions and revoke approval through database triggers. Native profile and payment tables are never rewritten by a sharing action.

Approval locks the native owner, restaurant and permission record in the existing native owner-trigger order, rechecks ownership, then compares the current generation, native revision, authority revision and public payload digest with the owner's preview. Source reads join native owner/profile/permission in one SQL statement and use the actual MealScout public projector/guard. Bigint revisions travel as strings. The public envelope contains only app, opaque public partition, source ID, publication state, approved name, native canonical URL, deployed Git revision, publication revision and approval/freshness times. Private owner IDs never leave through that endpoint.

The optional owner trigger runs after the existing migration140 ordering-authority trigger, so native owner updates acquire their restaurant dependencies before optional permission rows. It also locks owned restaurant rows before permission rows for deletion or an absent native trigger. This avoids adding the reverse authority-to-restaurant lock order to native writes. The integration proof executes the actual migration140 owner function and trigger with migration143; independent-session hosted scheduling is still not claimed.

The source reference expires within one second of its consistent read or earlier grant expiry. Readers must reject late, stale or unapproved responses. Revocation affects subsequent source reads; an already issued reference can remain valid for its remaining subsecond lifetime. A consumer must honor that expiry and must not cache a public envelope beyond it. The previous isolated TradeScout consumer enforces this contract; no TradeScout production consumer is installed by this MealScout-only patch.

## Runtime and rollback

The existing Render MealScout service has a pre-deploy `npm run migrate:deploy` gate. Its default `RENDER_GIT_COMMIT` identifies the deployed publisher. No new service, database or paid infrastructure is required. Source reads have a one-second database statement timeout; owner mutations have three-second lock/statement timeouts. These do not prove separate-process availability or eliminate shared database/pool contention. Native requests never call the optional ecosystem endpoint. The native database, runtime and provider remain shared within MealScout.

`MEALSCOUT_ECOSYSTEM_LINKS_ENABLED=false` makes new sharing endpoints unavailable without changing the native profile route. There is no new CORS, CSRF exemption, cookie policy, identity mapping or provider credential. Existing native browser-session CSRF protection applies to owner POSTs. Release rollback can revert the additive code while retaining permission tables/triggers/events; do not drop evidence tables or delete customer records to roll back. A disable/re-enable does not revoke existing grants by itself; use owner revocation or wait for expiry when revocation is intended.

## Release ownership and evidence

The isolated candidate is based on owner commit3b14686. Remote main and the observed Render live deployment remained e16c43d5 when inspected; do not release the owner's unreleased changes independently. Parent and native owners coordinate the reviewed patch and their release windows. TradeScout's shared main/service window belongs to its existing owner; this patch makes no TradeScout or Sway edits.

Local proof uses actual PostgreSQL through existing PGlite0.5.8, persists/reopens a disposable local database, and mounts the actual new native API registration. PGlite serializes transactions; concurrent CAS tests do not prove independent-session lock scheduling on hosted PostgreSQL. Fixture identities test the route's native-session seam; live login/cookies and a production owner approval are not claimed. No production customer grant was made. A live source GET should remain404 until a real owner opts in.

Primary references: [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html), [PGlite API](https://pglite.dev/docs/api), [Render default environment variables](https://render.com/docs/environment-variables).
