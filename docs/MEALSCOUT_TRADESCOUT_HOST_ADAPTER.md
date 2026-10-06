# MealScout consumer boundary for the TradeScout hosting hub

Thomas's current direction is that TradeScout profiles form the hosting hub alongside tools, while MealScout retains its food product and permissions. Shared profile/domain/hosting primitives belong to the TradeScout owner. This source slice changes only the existing MealScout SDK/API consumer; it creates no hosting backend, database, DNS policy or public redirect.

## Implemented consumer repair

MealScout already exports the full `MealScoutApp` through `vite.lib.config.ts`. Its `performMealScoutSSO` helper now uses the same `apiUrl` resolver as the embedded application's native API requests when its optional `baseUrl` is omitted. For an embedding TradeScout page, the old default incorrectly posted to the embedding origin's `/api/auth/tradescout/sso` even when the application's API resolver selected the MealScout API. Explicit SDK base overrides, including an explicit empty same-origin override, retain their existing behavior.

TradeScout API/auth context recognition now requires `thetradescout.com` or its actual subdomains. A hostname merely containing `tradescout`, such as `evil-tradescout.example`, no longer receives the MealScout fallback or TradeScout OAuth app context. This origin recognition chooses transport; it grants no role, restaurant ownership, publication or payment authority. Native MealScout and isolated deployment API/session behavior remains covered by focused source-only regressions.

The SDK context's `user`, `location` and `scoutBridge` are not proof of native authentication or profile ownership. MealScout still reads its server-owned session and business permissions. The current receiver at `server/unifiedAuth.ts` and existing SSO identity-hardening work require their own coordinated acceptance; this consumer repair changes neither JWT verification nor identity linking or role mapping.

## Interface coordination required from the hosting owner

The TradeScout owner must supply the authoritative hosting contract revision before a complete host adapter can be connected:

- Actual TradeScout profile/tenant binding and the MealScout source restaurant/profile ID; an opaque public-link tenant is not an authenticated account mapping.
- The mounted full-app route and native public profile mapping, including deep links, assets and native food/order/checkout/workspace journeys.
- The MealScout API/proxy base and session/CSRF/auth handoff contract, with issuer/audience/identity boundaries, cookie isolation and supported origins. No browser token or unreviewed SDK context may confer native owner access.
- Custom-domain host admission, TLS and canonical/SEO ownership, including conflict, revocation, owner transfer and disabled/hidden/quarantined profiles. A DNS match alone does not authorize a hosting tenant or an application session.
- The online-presence scoring input/version contract, with server-owned subject, source evidence, freshness and permitted public projection. Existing MealScout completion status and client-reported quality events are separate evidence kinds and must not be silently reinterpreted as a shared hosting score.

`docs/ECOSYSTEM_PUBLIC_LINKS.md` and migration143 currently authorize only source-owned optional `public_link_only` sharing. That approval does not authorize full hosted profile data, cross-product account permissions or contact/order/payment access. It must retain its generation/revision/digest/expiry and revocation guards. Native public admission/projection, canonical food-type routes and custom-domain current-owner checks remain source-owned.

## Verification and remaining coverage

Focused runtime fixtures evaluate the actual API module and SDK helper with synthetic browser/environment/React/App/fetch ports. They perform two isolated syntax transpiles, create no semantic program, mount no app and make no real SSO/network/provider call. These checks do not prove a library build, hosted routes, cookie/session behavior, shared scoring or live domain/owner admission. Those checks await the shared-owner contract and a coordinated resource slot; no unchanged failed low-memory compiler attempt should be repeated.

The Meal onboarding branch and its heap-failure/owner-readback evidence remain separate. This four-file consumer patch is reversible and can be integrated independently by its native owner; it supplies no merge, public deployment, DNS, credential, consent or spending authority.
