# MealScout Account Lifecycle + Discovery Boundary Audit

Status: C9 account lifecycle + discovery boundary audit complete. This is a docs/contract-only stabilization audit inserted before runtime cleanup; C8 remains NEXT and the queued payment/webhook C9 remains queued in `CLEANUP_MAP.md`.

## Scope

This audit documents existing MealScout account lifecycle, public discovery, referral, login, verification, dashboard continuation, Parking Pass, and recovery boundaries. It does not add features, create routes, change auth middleware, rename concepts, alter role rules, change Parking Pass behavior, change affiliate behavior, change payment behavior, change registration behavior, or create sample records.

## Discovery Entry Points

Guest-safe discovery routes are registered in `client/src/App.tsx` and include `/`, `/scout`, `/search`, `/map`, `/restaurant/:id`, `/truck/:slug`, `/bar/:slug`, `/location/:slug`, `/city/:city`, `/city/:city/:mode`, `/food-trucks-today/:city`, `/deals-today/:city`, `/events-today/:city`, `/cuisine/:cuisine/:city`, `/locations-with-trucks/:city`, `/food-trucks/:citySlug`, `/food-trucks/:citySlug/:cuisineSlug`, `/p/:profileType/:profileId`, `/p/:profileType/:profileId/:profileSlug`, `/parking-pass`, supplier pages, event pages, deal pages, video pages, and static policy/support pages. Authenticated users still have access to discovery routes, but authenticated management routes are separate.

`/scout?ref=<tag>` is a valid public discovery entry. The `ref` query is attribution metadata only and must not decide user type, business type, role, dashboard access, account ownership, email verification, admin/staff affiliate assignment, Parking Pass eligibility, or payment state.

Affiliate is not a standalone account role in MealScout. It is an attribution/campaign layer expressed through share/tag state and referral capture. User role remains authority; current intent and entity state decide what the UI prioritizes.

## Referral Entry

Guest referral capture exists in three layers:

- `server/index.ts` captures affiliate `?ref=` on requests and stores `referralId` as a cookie.
- `client/src/hooks/useAuth.ts` captures URL refs with `captureUrlAffiliateRef`, stores them through `setAffiliateRef`, and does not clear them when `/api/auth/user` returns 401 or `user` is undefined.
- `client/src/pages/customer-signup.tsx` and `client/src/pages/login.tsx` preserve stored refs in links and pass `referralId` during signup or OAuth navigation.

Internal `admin`, `duper_admin`, and `super_admin` accounts are not affiliate-assigned through a public `ref`; `server/unifiedAuth.ts` skips affiliate referral application for admin user types. Protected account endpoints such as `/api/affiliate/tag` and `/api/business-access/me` wait for confirmed auth.

## Session-Stitch Boundary

Guest users can enter through discovery with `?ref` and then move through signup, login, or OAuth surfaces. OAuth callback `auth=success` remains a hint only; session confirmation is only established when `/api/auth/user` returns 200. Guest-safe `/api/auth/user` 401 remains a non-authenticated state and must not flush stored guest referral attribution before auth/session stabilization is complete.

## Account Creation Paths

| Path | Visible concept | Existing behavior |
| --- | --- | --- |
| `/customer-signup?role=diner` | Customer | Legacy URL alias maps to the Customer signup card. It submits `accountType: "customer"` through `/api/auth/customer/register`; there is no backend diner user type. |
| `/customer-signup?role=business&businessType=restaurant` | Restaurant | Business signup redirects to `/restaurant-signup` and uses `/api/auth/restaurant/register`; continuation is restaurant owner setup. |
| `/customer-signup?role=business&businessType=food_truck` | Food Truck | Business signup redirects to `/restaurant-signup?businessType=food_truck`; after the truck is attached, incomplete schedule setup continues through `/restaurant-owner-dashboard?setup=schedule` with the selected business context. |
| `/customer-signup?role=business&businessType=bar` | Bar | Business signup uses the existing restaurant owner account path with business subtype metadata. |
| `/customer-signup?role=business&businessType=caterer` | Caterer | Business signup uses the existing restaurant owner account path with business subtype metadata. |
| `/customer-signup?role=business&businessType=private_chef` | Private Chef | Business signup uses the existing restaurant owner account path with business subtype metadata. |
| `/customer-signup?role=host` | Host | Host signup redirects to `/host-signup`; management lives on `/host/dashboard`. |
| `/customer-signup?role=event_coordinator` | Event Organizer | Event setup continues to `/event-coordinator/dashboard?setup=onboarding`. |
| `/customer-signup?role=supplier` | Supplier | Supplier registration uses `/api/auth/supplier/register` and continues to `/supplier/dashboard`. |
| `/account-setup?token=...` and `/owner/verify?token=...` | Invited/admin-created setup | Setup token validation and completion use `/api/auth/validate-setup-token` and `/api/auth/complete-setup`; bare `/account-setup` is not a valid setup completion surface without a token. |
| `/claim-truck` | Truck claim | Public claim discovery and authenticated claim submission lead to a food truck business profile or setup reminder without creating a new role. |

Customer mapping note: Customer is the canonical account concept; legacy `diner` is a URL alias only where still present in links.

Affiliate sharing signup note: affiliate intent may be expressed as an intent/capability hint such as `?intent=affiliate-sharing`, but it must not use `role=affiliate` and must not create a distinct affiliate account type.

## Login Paths

Email/password login uses `/api/auth/login`. Restaurant email/password login also exists at `/api/auth/restaurant/login`. Google customer OAuth starts at `/api/auth/google/customer`; Google restaurant OAuth starts at `/api/auth/google/restaurant`; Facebook starts at `/api/auth/facebook?userType=customer`.

OAuth success query params are hints only. `/api/auth/user` returning 200 is the confirmed signed-in state. `client/src/hooks/useAuth.ts` uses `oauthConfirmationPending` while it confirms the session and treats `/api/auth/user` 401 with `on401: "returnNull"` as a guest-safe state.

Wrong-password recovery is passive. `client/src/pages/login.tsx` offers `/forgot-password` navigation when login fails, but normal login does not call `/api/auth/forgot-password`, create reset tokens, or send reset emails. Password reset email is sent only by explicit `/forgot-password` form submit. Forced password change uses `/change-password` and does not send reset email automatically.

## Claim And Setup Boundaries

Account setup tokens can be missing, invalid, expired, or already used. The UI and backend keep those token failures distinct from normal login and from business/profile verification. `post-verification` is a handoff/checkpoint page after signup, email verification, or setup completion; it preserves safe redirects and avoids turning bare `/account-setup` into a setup completion route.

Food truck claim routes distinguish public search/request flows from authenticated claim submission. Claim status, import listing linkage, owner verification, and email verification are separate from public discovery and from affiliate attribution.

## Verification Boundaries

Email verification, business/profile setup, insurance verification, claim verification, password reset, and forced password change are separate lifecycle steps. Email verification gates first login for new customer/business/supplier registration. Business/profile setup gates owner tooling. Insurance verification gates Parking Pass booking eligibility where the existing Parking Pass logic requires it. Claim verification links imported truck listings to account-owned profiles.

## User Profile Versus Business Profile

User identity is stored on the user account and drives auth state, role, internal admin/staff status, email verification, password state, and continuation. Business profiles are separate linked entities such as restaurants, food trucks, hosts, and suppliers. `/api/business-access/me` represents linked business-team access and must not collapse admin identity into business identity.

Public profile URLs expose business discovery surfaces, not account ownership. Admin user cards and dashboard switcher context must preserve system permissions while allowing explicit dashboard views.

## Dashboard Continuation Targets

Existing continuation targets are:

- Customers return to discovery/customer dashboard surfaces such as `/scout` or `/dashboard`.
- Restaurant owners continue incomplete profile and media setup through `/restaurant-owner-dashboard?setup=profile` and `/restaurant-owner-dashboard?setup=profile-media`, menu setup through `/menu-builder`, and schedule setup through `/restaurant-owner-dashboard?setup=schedule`. The selected business context is retained. AI remains an optional action inside the profile editor.
- Food truck schedule-required continuation uses `/restaurant-owner-dashboard?setup=schedule` with the selected business context; business-document verification remains `/restaurant-owner-dashboard?setup=verification`.
- Hosts use `/host/dashboard`.
- Event organizers use `/event-coordinator/dashboard?setup=onboarding`.
- Suppliers use `/supplier/dashboard`.
- Staff use `/staff`; admin, duper_admin, and super_admin use `/admin/dashboard`.
- Restaurant owner or food truck users without linked business profile are sent to `/restaurant-signup` with the existing `source=auth&claim=1` continuation.

## Owner AI Identity And Consent Boundary

The minimum remote-AI chain is three linked identities: the actual owner is signed into MealScout, the owner's chosen AI is OAuth-bound to one exact MealScout owner/business pair, and that MealScout business has at least one usable social publishing connection. `/owner-ai/authorize` is the protected OAuth consent surface. It lists only businesses actually owned by the signed-in user and does not complete authorization until a social account with stored publishing access is available.

OAuth connection consent and content consent are separate. Connecting the AI grants bounded context/draft/read/approval scopes; it does not pre-approve content. The AI must create and display an immutable revision, including every MealScout change, destination, description, and image. After the actual owner explicitly consents in that AI chat, the AI may call MealScout's approval tool. MealScout revalidates owner/business binding, revision, content fingerprint, current canonical versions, and requested social connections before applying that exact revision and publishing its exact posts. Manually copied legacy keys remain draft-only. The authenticated `/owner-ai` review page remains a fallback for AIs without remote-tool support.

## Parking Pass Boundaries

`/parking-pass` is a public discovery/search and truck-side booking/schedule surface. `/parking-pass-manage` is authenticated management. Host management remains host/account-bound through `/host/dashboard` and host Parking Pass tools. Food truck booking and schedule work stays on `/parking-pass` and `/restaurant-owner-dashboard?setup=schedule`; food truck owners must not be routed into host-only management.

Parking Pass booking eligibility is separate from discovery: food truck profile linkage and insurance verification can be required before booking. Existing no-cost or paid booking management rules, platform fee rules, Stripe Connect host payout rules, and Premium schedule gating are payment/product behavior and are outside this docs-only audit. The known class of failure to guard is a food truck or claimed truck flow being sent to a host-only Parking Pass management surface instead of the food truck owner/schedule path.

## Failure Recovery

Guest 401 from `/api/auth/user` remains safe and does not erase referral context. Wrong password shows a reset/recovery path without triggering reset email. Unverified accounts can use resend verification, which is public and non-enumerating. Partial signup, missing business/profile, missing schedule, invalid setup token, stale OAuth success hints, missing linked business access, and missing insurance each stay on their existing recovery path.

Password reset requests must not reveal whether an email exists. Reset emails are sent only from explicit reset-request form submission and only when email infrastructure is configured.

## SetupMode URL Boundary And Preservation Edge

Setup context such as `?setup=schedule` on a manual workspace or `?src=onboarding&focus=schedule` on `/owner-ai` is a URL-level hint that must be validated through existing safe continuation logic. OAuth parameters on `/owner-ai/authorize` must likewise survive the login redirect without being treated as authority before MealScout validates the client, redirect URI, PKCE challenge, resource, requested scopes, session owner, selected business, and social readiness. If a user hits auth timeout or `/api/auth/user` 401 and returns through login, safe intended setup targets can be preserved after auth is re-confirmed. Invalid or unsafe setup targets must not be blindly trusted.

## Blessed Berry Isolation Boundary

The Blessed Berry class of failure is a routing-context isolation issue, not a role-repair issue. Schedule-required `food_truck` users continue to `/restaurant-owner-dashboard?setup=schedule` with the selected business context. `food_truck` users must not be routed into host-only `/parking-pass-manage`, and host rows must not be created to repair truck routing.

## Multi-Role And Admin Context

Admin, duper_admin, super_admin, and staff permissions remain system permissions. Dashboard switching is an explicit admin/staff viewing tool and must not mutate account roles, erase admin permissions, or assign affiliate referral state from public refs. Business-team access is linked-business access, not proof that the system user became that business identity.

## Do-Not-Touch Rules

- Do not add features.
- Do not change business logic.
- Do not rename routes, roles, events, files, or user-facing product concepts.
- Do not add roles or invent a new diner user type.
- Do not change auth middleware, OAuth callback behavior, or `/api/auth/user` semantics.
- Do not change Parking Pass booking, schedule, host, truck, insurance, payout, Premium, or Stripe behavior.
- Do not change affiliate attribution, affiliate assignment, referral tags, or payout logic.
- Do not change registration, onboarding, claim, setup token, verification, or password reset behavior.
- Do not create fake users, fake contractors, fake analytics, placeholder records, or sample data.
