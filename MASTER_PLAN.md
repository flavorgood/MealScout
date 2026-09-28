# MealScout Master Plan

Last reconciled: 2026-07-22
Repository baseline reviewed: `f7fa4da1`

## Product spine

MealScout is profile-first local food infrastructure.

- The business profile is the one surface a restaurant, food truck, bar,
  caterer, or chef actively manages.
- Menu, schedule, hours, deals, ordering, media, location, and customer-facing
  information flow outward from that profile.
- Scout is food discovery and search, not a chatbot.
- The consumer experience is warm, bright, visual, and food-led.
- Recommendations and verified evidence replace star/review theater.
- Missing facts stay missing. Do not invent menus, prices, hours, schedules,
  locations, approval, deployment, or production state.
- Parking Pass is a MealScout subsystem.
- Infinity may provide shared infrastructure through thin, selective adapters;
  MealScout remains authoritative for MealScout business logic and records.

## Current code reality

Confirmed on the repository baseline:

- Unified consumer shell and business workspace exist for profile, menu,
  schedule, photos, deals, orders, audience, team, payments, and settings.
- Scout uses a compact MapLibre/CARTO decision surface and reserves Google Maps
  for full interactive exploration.
- Parking Pass uses Google Maps and has list fallback behavior.
- Public restaurant, truck, and bar profiles use canonical profile builders.
- Playwright is configured for desktop Chrome, Firefox, Safari, mobile Chrome,
  and mobile Safari.
- Automated marketing email volume is behind a default-off kill switch; the
  Premium summary cadence is monthly.
- Infinity referral and signup-evidence mirroring are shadow-only. No active
  Infinity product-field inheritance consumer exists.
- Manual profile asset intake is review-gated.
- The 3D Eats FRUI-TEA sauce classification/description update is recorded.
- Date-only public event normalization and explicit `501
ACTION_NOT_IMPLEMENTED` guards for reserved county actions are present.

Repository state does not by itself prove current production deployment or
third-party provider health. Those require separate live verification.

## Active program

### P0 — Safety and truth alignment

- Keep manual production tools fail-closed for the apex domain, ports, and all
  MealScout subdomains.
- Keep Infinity mirroring limited to non-PII attribution and conversion
  evidence.
- Apply team permissions per selected business, not as account-wide aggregate
  permission leakage.
- Keep one deterministic global navigation instance.
- Keep Action API documentation aligned with runtime availability.

### P0 — Scout recovery

- Never show a blank or near-black compact map when WebGL or tiles fail.
- Keep an always-visible full-map control and working pull gesture.
- Maintain Advanced Marker compatibility and avoid viewport resets during
  ordinary rerenders.
- Canonicalize business identity across sources and stop the same profiles from
  dominating multiple discovery rails.
- Keep food trucks out of restaurant-only rails.
- Hide empty community-pick rails instead of filling them with unrelated cards.

### P1 — Profile completeness

- Make every business type manageable from its profile workspace.
- Preserve owner approval for menus, logos, schedules, live locations, and
  conflicting evidence.
- Finish 3D Eats only from supplied evidence and explicit approvals. Current
  blockers are the approved logo, current full menu approval, operating
  schedule/location, and conflicting address/YouTube identity.

### P1 — Production verification

- Verify Scout map tiles, pins, expansion, canonical links, and rail diversity
  on normal desktop and mobile browsers.
- Verify Parking Pass map/provider readiness separately from its list fallback.
- Run credential-free browser gates on the five configured projects.
- Run authenticated owner/team/admin smoke checks with approved credentials.

### P2 — Growth after repair gates pass

- Improve profile acquisition, claim, and done-for-you onboarding.
- Grow menus, schedules, event/pop-up discovery, and local food coverage.
- Measure profile views, menu opens, directions, follows, requests, and ordering
  actions without pay-to-play ranking.
- Continue mobile wrapper/store work only after web auth, deep-link, location,
  notification, and payment gates are stable.

## Refactor posture

No backend refactor lane is active by default.

Permitted lanes are storage seam extraction, admin domain split, and event
domain split. Activation requires the controls in:

- `docs/refactor/EXECUTION_DISCIPLINE_PROTOCOL.md`
- `docs/refactor/HOTSPOT_OWNERSHIP_MATRIX.md`
- `docs/refactor/REFACTOR_BOARD.md`

Product repair must not be mixed into refactor PRs.

## Release gates

- Typecheck and relevant contract tests pass.
- Browser tests cover the repaired user path.
- No auth, session, team-permission, map-pin, payment, ordering, booking, or
  event-state regression.
- Public copy and API documentation match real capability.
- Rollback path is explicit.
- Production claims are made only after live verification.

## Deferred unless explicitly activated

- Broad backend refactor expansion beyond the three governed seams.
- Automatic publication of unapproved profile evidence.
- County transparency, ledger, and vault Action API calls.
- Infinity write authority over MealScout profile records.
- New discovery surfaces that increase duplication before Scout recovery is
  verified.
