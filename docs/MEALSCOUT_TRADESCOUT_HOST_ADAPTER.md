# MealScout consumer boundary for the TradeScout hosting hub

Thomas's current direction is that TradeScout profiles form the hosting hub alongside tools, while MealScout retains its food product and permissions. Shared profile/domain/hosting primitives belong to the TradeScout owner. This consumer slice aligns the existing SDK/API transport and supplies a handler to the existing native HTTP runtime; it creates no parallel hosting backend, database, DNS policy or public redirect.

## Implemented consumer repair

MealScout already exports the full `MealScoutApp` through `vite.lib.config.ts`. Its `performMealScoutSSO` helper now uses the same `apiUrl` resolver as the embedded application's native API requests when its optional `baseUrl` is omitted. For an embedding TradeScout page, the old default incorrectly posted to the embedding origin's `/api/auth/tradescout/sso` even when the application's API resolver selected the MealScout API. Explicit SDK base overrides, including an explicit empty same-origin override, retain their existing behavior.

TradeScout API/auth context recognition now requires `thetradescout.com` or its actual subdomains. A hostname merely containing `tradescout`, such as `evil-tradescout.example`, no longer receives the MealScout fallback or TradeScout OAuth app context. This origin recognition chooses transport; it grants no role, restaurant ownership, publication or payment authority. Native MealScout and isolated deployment API/session behavior remains covered by focused source-only regressions.

The SDK context's `user`, `location` and `scoutBridge` are not proof of native authentication or profile ownership. MealScout still reads its server-owned session and business permissions. The current receiver at `server/unifiedAuth.ts` and existing SSO identity-hardening work require their own coordinated acceptance; this consumer repair changes neither JWT verification nor identity linking or role mapping.

## Interface coordination required from the hosting owner

The shared registration contract is now pinned below. A live registration still needs verified existing identities and native configuration for these boundaries:

- Actual TradeScout profile/tenant binding and the MealScout source restaurant/profile ID; an opaque public-link tenant is not an authenticated account mapping.
- The mounted full-app route and native public profile mapping, including deep links, assets and native food/order/checkout/workspace journeys.
- The MealScout API/proxy base and session/CSRF/auth handoff contract, with issuer/audience/identity boundaries, cookie isolation and supported origins. No browser token or unreviewed SDK context may confer native owner access.
- Custom-domain host admission, TLS and canonical/SEO ownership, including conflict, revocation, owner transfer and disabled/hidden/quarantined profiles. A DNS match alone does not authorize a hosting tenant or an application session.
- The online-presence scoring input/version contract, with server-owned subject, source evidence, freshness and permitted public projection. Existing MealScout completion status and client-reported quality events are separate evidence kinds and must not be silently reinterpreted as a shared hosting score.

`docs/ECOSYSTEM_PUBLIC_LINKS.md` and migration143 currently authorize only source-owned optional `public_link_only` sharing. That approval does not authorize full hosted profile data, cross-product account permissions or contact/order/payment access. It must retain its generation/revision/digest/expiry and revocation guards. Native public admission/projection, canonical food-type routes and custom-domain current-owner checks remain source-owned.

## Verification and remaining coverage

Focused runtime fixtures evaluate the actual API module and SDK helper with synthetic browser/environment/React/App/fetch ports. They perform two isolated syntax transpiles, create no semantic program, mount no app and make no real SSO/network/provider call. These checks do not prove a library build, hosted routes, cookie/session behavior, shared scoring or live domain/owner admission. Those checks await the shared-owner contract and a coordinated resource slot; no unchanged failed low-memory compiler attempt should be repeated.

The Meal onboarding branch and its heap-failure/owner-readback evidence remain separate. The initial four-file SDK repair and subsequent native HTTP adapter are reversible consumer changes; they supply no merge, public deployment, DNS, credential, consent or spending authority.

## Pinned native HTTP adapter

The shared owner's stable module is server/profileHostedRuntime.ts at c9b478337d86de60a56e23c9edec68808e78a7e1 (unchanged at hosting head b9aad0aba5e7b2ab6101b826bbecb7321eaacb64). Its machine-readable contract SHA256 is ac450cf287a207c43bf744485e78ee21680643b5a4bddfbff15a8294d2e2ee6e.

server/integrations/tradeScoutHostedRuntime.ts now supplies createMealScoutHostedRuntimeBinding({ host, profileId, ownerUserId, upstreamOrigin }). The returned immutable object has exactly appId: "mealscout", host, profileId, ownerUserId and a complete Express handle. The shared server owner passes it to profileHostedRuntimeRegistry.register(binding) and retains that registry's identity-checked disposer. This module imports only native HTTP transport; construction starts no listener, worker, database, migration or external call. Nothing registers automatically.

The owner selects one fixed, existing HTTPS native runtime (literal loopback HTTP is available for an existing local runtime). No request, profile content, environment activation flag, query, SDK user or forwarded host can choose or change that upstream. The exact public host/profile/owner eligibility gate in the pinned gateway remains mandatory before every request. Trade routing identities do not become native restaurant owners or database tenants.

The adapter relays the entire unprefixed original method, encoded URL/query, raw body stream, native authorization/cookies/origin/signature headers and native response status/redirect/cookie values. Assets, APIs, OAuth callbacks, media ranges, HTTP streams and trailers go through the existing full MealScout runtime. HTTP framing/hop headers are regenerated for the new connection; payload bytes are never JSON-parsed, decompressed, accumulated or reserialized. Forwarding claims are replaced with the bound public host, HTTPS and the captured immediate peer; authentic end-user IP handling behind an additional edge needs an operator-reviewed trust policy. Reset, idle timeout, malformed target, parsed body and wrong-host failures end within the app boundary and cannot call TradeScout routes.

The existing Meal server retains its own PUBLIC_BASE_URL, session secret/store/cookie policy, CSRF/allowed origins, OAuth receiver/identity mapping, role/business permissions, database, signed payment processing and workers. The adapter neither copies those configuration values into TradeScout nor rewrites cookie domains, callbacks, payment redirects, CSP or public canonicals to claim compatibility. Server assembly must verify the actual approved custom host/profile/owner and fixed native upstream and these native configuration boundaries before registration. No production registration or cutover is included.

The fixed native ingress must accept the bound public HTTP Host; a public Render URL alone does not prove that routing policy. The native browser API base must also target the approved runtime: a hosted TradeScout subdomain still enters the existing SDK's Trade API fallback unless its native build has the correct explicit API base. Native public-profile chrome/canonical composition and actual OAuth/cookie/CSRF configuration are compatibility decisions, not transformations performed by this byte-stream adapter.

A focused integration script uses real installed Express/HTTP, express-session with an isolated MemoryStore and the Stripe SDK's local HMAC verification, together with the exact pinned gateway module and a synthetic authority resolver. It checks transport transparency only. It does not start server/index.ts, create native owners/sessions in PostgreSQL, process payment journals, call providers, or prove production SSO/public-domain authority. Scoped semantic acceptance, if completed, concerns only this new adapter and its actual installed types; older onboarding typechecking remains separate.

The ten-second connection deadline ends at TCP connection or TLS secureConnect; connected uploads use the configured idle allowance. Request and response completion are tracked independently, and chunked payload framing is restored for every method carrying a body, including GET and DELETE. Focused checks include an actively flowing upload beyond ten seconds and early native denial; these checks must execute under the recorded guards before being counted as runtime acceptance.

Additional Transfer-Encoding codings fail explicitly on either leg instead of silently losing their declaration; standard chunked transfer, HTTP trailers and native Content-Encoding gzip remain supported. An actual native requirement for another transfer coding needs a reviewed extension. Trailer values use the installed Node API's name/value pair format.

## Explicit full-functionality gaps

MealScout's existing server/websocket.ts installs Socket.IO at /socket.io with both polling and WebSocket transports, including food-truck location updates and kitchen order subscriptions. The shared hosting contract supplies no WebSocket/HTTP upgrade boundary. This adapter does not silently disable native WebSockets or force polling. Actual upgraded requests bypass an Express handler; HTTP upgrade headers reaching the handler receive 426. Full hosted realtime acceptance requires the hosting owner to extend/review the shared server upgrade contract or independently approve a compatible existing-runtime transport.

Existing native OAuth callbacks use PUBLIC_BASE_URL; browser mutation CSRF checks use the existing ALLOWED_ORIGINS; native sessions are named tradescout.sid with optional SESSION_COOKIE_DOMAIN. Exact callback/origin/cookie isolation and the reviewed native SSO issuer/audience/subject boundary are required before a live host is admitted. The shared contract keeps private TradeScout onboarding and online-presence scores on TradeScout's canonical origin; no cross-product score endpoint or data export is supplied. Native completion and quality evidence retain their existing meanings.
