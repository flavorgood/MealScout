# MealScout Route Map

This map is a cleanup aid, not a refactor plan. Source of truth inspected for this slice: `client/src/App.tsx` and `server/routes.ts`.

## Public Customer Routes

Entry routes:

- `/` - guest welcome; authenticated users redirect toward `/scout`.
- `/scout` - primary customer discovery surface. Routes to `ScoutPageV2` from `client/src/pages/explore-preview-v2.tsx`.
- `/food-trucks` - public alias to the canonical Scout surface for food-truck-first discovery.
- `/search` - customer search.
- `/map` - legacy public entry. `client/src/App.tsx` routes this to `RedirectToScout`, which redirects to the canonical `/scout` surface.
- `/trending` - legacy discovery entry. `client/src/App.tsx` routes this to `RedirectToScout`, which redirects to `/scout`.
- `/deals`, `/deals/featured`, `/deals/:city`, `/deal/:id` - deal discovery/detail.
- `/restaurant/:id`, `/truck/:slug`, `/bar/:slug`, `/location/:slug` - public detail pages.
- `/p/:profileType/:profileId` and `/p/:profileType/:profileId/:profileSlug` - public profile routes.
- `/food-trucks/:citySlug`, `/food-trucks/:citySlug/:cuisineSlug`, `/food-trucks-today/:city`, `/food-truck-catering/:city`, `/book-food-truck/:city`, `/deals-today/:city`, `/events-today/:city`, `/locations-with-trucks/:city` - SEO/city discovery routes.
- `/category/:category`, `/cuisine/:type`, `/cuisine/:cuisine/:city`, `/city/:city`, `/city/:city/:mode`, `/city/:city/food` - category, cuisine, and city landing routes.
- `/events`, `/events/public`, `/event/:slug` - public event discovery/detail.
- `/menu/:restaurantId`, `/checkout/:restaurantId`, `/order-confirmation/:orderId` - public menu and pickup checkout surfaces.
- `/suppliers`, `/supplier/:slug`, `/suppliers/:supplierId` - supplier marketplace public/detail routes.
- `/video`, `/video/:id`, `/scoutcoin`, `/status`, `/install`, `/sitemap`, `/about`, `/contact`, `/faq`, legal/comparison pages - public content routes.

Public route source inventory:

| Route family | Current frontend source | Notes |
| --- | --- | --- |
| `/scout`, `/scout/:refTag`, `/directory`, `/directory/:refTag`, `/scout-v2`, `/food-trucks` | `client/src/pages/explore-preview-v2.tsx` (`ScoutPageV2`) | Canonical public Scout discovery surface; `/food-trucks` is the food-truck-first alias. |
| `/map` | `RedirectToScout` in `client/src/App.tsx`, then `client/src/pages/explore-preview-v2.tsx` | The obsolete standalone map page has been retired. |
| `/trending` | `RedirectToScout` in `client/src/App.tsx`, then `client/src/pages/explore-preview-v2.tsx` | Legacy entry preserved as redirect. |
| `/sitemap` | `client/src/pages/sitemap.tsx` | Public content/discovery index. |
| `/restaurant/:id`, `/restaurant/:id/:profileSlug`, `/truck/:slug`, `/bar/:slug`, `/location/:slug`, `/p/:profileType/:profileId`, `/p/:profileType/:profileId/:profileSlug` | `client/src/pages/public-profile.tsx` | Public profile route families. |
| clean business slug routes | `CleanPublicProfileRoute` in `client/src/App.tsx`, then `client/src/pages/public-profile.tsx` | Only renders when `parseCleanAffiliateBusinessRoute` accepts the path. |
| `/city/:city/food`, `/food-trucks-today/:city`, `/deals-today/:city`, `/events-today/:city`, `/locations-with-trucks/:city`, `/cuisine/:cuisine/:city` | `client/src/pages/public-seo-landing.tsx` | SEO/discovery landing surfaces. |
| `/city/:city`, `/food-trucks/:citySlug`, `/food-trucks/:citySlug/:cuisineSlug` | `client/src/pages/city-landing.tsx` | City and food-truck city landing routes. |
| `/city/:city/:mode` | `client/src/pages/city-discovery.tsx` | Generic city discovery mode route; keep route ordering in mind when auditing `/city/:city/food`. |
| `/profile-setup` | `client/src/pages/profile-setup.tsx` | Public profile setup offer page. |

Legacy/dead-looking public surfaces to verify before editing:

- `client/src/pages/explore-preview.tsx` is legacy/quarantined; `ScoutPageV2` is the canonical Scout route.
- `client/src/pages/trending.tsx` exists, but `/trending` redirects to `/scout` and is not mounted as a standalone public page.

Main backend groups:

- `registerPublicDiscoveryRoutes`
- `registerPublicMapRoutes`
- `registerDealDiscoveryRoutes`
- `registerPublicSearchRoutes`
- `registerPublicSeoLandingRoutes`
- `registerSeoRoutes`
- `registerRestaurantCoreRoutes`
- `registerLocationUtilityRoutes`
- `registerMenuRoutes`
- `registerPickupOrderRoutes`
- `registerMerchantDeliveryRoutes`
- `registerSupplierMarketplaceRoutes`
- `registerScoutSurfaceRoutes`

## Owner / Truck Routes

Frontend routes:

- `/restaurant-signup` - owner/truck signup.
- `/claim-truck` - claim imported truck/profile.
- `/account-setup`, `/owner/verify`, `/post-verification` - account and verification continuation surfaces.
- `/restaurant-owner-dashboard`, `/restaurant/dashboard` - owner dashboard aliases.
- `/owner-ai` - owner-scoped model-neutral AI workspace for connection readiness, inert complete-business drafts, exact-revision consent, canonical MealScout apply, and connected-social publishing.
- `/owner-ai/authorize` - protected OAuth consent surface that binds a compatible remote AI to one exact owner/business pair; requires at least one usable MealScout social publishing connection before authorization.
- `/deal-creation`, `/deal-edit/:dealId` - deal creation/edit.
- `/menu-builder`, `/kitchen` - menu setup and kitchen display.
- `/merchant-delivery` - authenticated merchant-operated delivery controls; guests are redirected to login.
- `/truck-discovery` - truck-facing discovery.
- `/business-team`, `/business-team/accept` - team management and invite acceptance.
- `/subscribe` - subscription/plan surface.

Main backend groups:

- `setupUnifiedAuth`
- `registerAuthAccountRoutes`
- `registerRestaurantSignupRoutes`
- `registerRestaurantCoreRoutes`
- `registerRestaurantOperationsRoutes`
- `registerClaimRoutes`
- `registerTruckClaimRoutes`
- `registerDealManagementRoutes`
- `registerBusinessTeamRoutes`
- `registerMenuRoutes`
- `registerOwnerAiActionRoutes`
- `registerPickupOrderRoutes`
- `registerSubscriptionRoutes`

Owner AI remote-tool routes registered by `registerOwnerAiActionRoutes` include OAuth authorization-code/PKCE discovery and token lifecycle endpoints plus Streamable HTTP `POST /api/owner-ai/mcp`. The MCP approval tool may apply and publish only the immutable revision the owner explicitly approved in chat. Legacy `/api/owner-ai/connector/*` bearer-key routes remain draft-only.

## Host / Event Routes

Frontend routes:

- `/host-signup` - host onboarding.
- `/host/dashboard` - host dashboard.
- `/event-coordinator/dashboard` - event coordinator dashboard.
- `/events`, `/events/public`, `/event/:slug` - event browse/detail surfaces.

Main backend groups:

- `registerHostRoutes`
- `registerOpenCallSeriesRoutes`
- `registerEventRoutes`
- `registerEventCoordinatorRoutes`
- `registerHostInterestRoutes`
- `registerBookingRoutes`

## Parking Pass Routes

Frontend routes:

- `/parking-pass` - public/authenticated Parking Pass browse, booking, host setup, and map surface.
- `/parking-pass-manage` - authenticated management redirect/helper route.
- `/parking-pass/manage` - not present in `client/src/App.tsx` in this checkout.

Main backend routes/groups:

- `GET /api/parking-pass`
- `GET /api/parking-pass/host-ids`
- `GET /api/parking-pass/host-status`
- `GET /api/parking-pass/weather`
- `GET /api/parking-pass/intelligence-status`
- `GET/POST /api/hosts/parking-pass`
- `POST /api/parking-pass/:passId/book`
- `registerEventRoutes`
- `registerHostRoutes`
- `registerBookingRoutes`
- `registerStripeWebhookRoutes`

Important invariant: Parking Pass booking requires non-expired stored insurance verification.

## Admin / Staff Routes

Frontend routes:

- `/admin`, `/admin/login` - admin login entries.
- `/admin/dashboard` - large admin dashboard and Launch Board tab surface.
- `/admin/control-center` - admin control center.
- `/admin/incidents`, `/admin/tickets` - incident/support admin.
- `/admin/moderation`, `/admin/moderation/queue`, `/admin/moderation/videos`, `/admin/moderation/metrics`, `/admin/moderation/appeals` - moderation.
- `/admin/audit-logs`, `/admin/vac-logs`, `/admin/telemetry`, `/admin/geo-ads`, `/admin/geo/heatmap`, `/admin/affiliates`, `/admin/giveaway-wheel`, `/admin/switcher`, `/admin/oauth-setup` - admin tools.
- `/staff` - staff dashboard.

Main backend groups:

- `registerAdminManagementRoutes`
- `registerAdminCoreOpsRoutes` through runtime bootstrap/admin modules
- `registerAdminMarketHeatmapRoutes`
- `registerGeoAdRoutes`
- `registerHostPayoutAdminRoutes`
- `registerGrowthRoutes`
- `registerModerationRoutes`
- `registerSupportRoutes`
- `registerStaffRoutes`

## Server Route Registration Map

Auth/account:

- `setupUnifiedAuth`
- `registerAuthAccountRoutes`
- `registerNotificationRoutes`
- `registerBusinessTeamRoutes`
- `registerRuntimeBootstrapRoutes`

Public discovery/profile/SEO/search:

- `registerPublicDiscoveryRoutes`
- `registerPublicMapRoutes`
- `registerDiscoveryRoutes`
- `registerDealDiscoveryRoutes`
- `registerPublicSearchRoutes`
- `registerPublicSeoLandingRoutes`
- `registerSeoRoutes`
- `registerRestaurantCoreRoutes`
- `registerLocationDemandRoutes`
- `registerLocationUtilityRoutes`
- `registerRecommendationRoutes`
- `registerScoutSurfaceRoutes`
- `app.get("/api/signals")`

Restaurant operations:

- `registerRestaurantCoreRoutes`
- `registerRestaurantOperationsRoutes`
- `registerRestaurantSignupRoutes`
- `registerClaimRoutes`
- `registerTruckClaimRoutes`
- `registerDealManagementRoutes`
- `registerHiringRoutes`

Menu/order:

- `registerMenuRoutes`
- `registerPickupOrderRoutes`

Host/event/booking:

- `registerHostRoutes`
- `registerOpenCallSeriesRoutes`
- `registerEventRoutes`
- `registerEventCoordinatorRoutes`
- `registerHostInterestRoutes`
- `registerBookingRoutes`

Parking Pass/payment/webhook:

- `registerEventRoutes`
- `registerHostRoutes`
- `registerBookingRoutes`
- `registerStripeWebhookRoutes`
- `registerSubscriptionRoutes`
- `registerHostPayoutAdminRoutes`
- `registerPickupOrderRoutes`
- `registerSupplierMarketplaceRoutes`

Admin/staff:

- `registerAdminManagementRoutes`
- `registerAdminMarketHeatmapRoutes`
- `registerGeoAdRoutes`
- `registerHostPayoutAdminRoutes`
- `registerGrowthRoutes`
- `registerModerationRoutes`
- `registerStaffRoutes`
- `registerSupportRoutes`

Analytics/Launch Board:

- `registerAnalyticsRoutes`
- `registerGrowthRoutes`
- `registerAdminManagementRoutes`
- `registerAdminMarketHeatmapRoutes`
- `registerGeoAdRoutes`
- `registerPublicDiscoveryRoutes`
- `registerRestaurantOperationsRoutes`

Media/uploads:

- `registerMediaRoutes`
- image upload helpers and menu/profile media routes.

Support/moderation:

- `registerSupportRoutes`
- `registerModerationRoutes`

Supplier:

- `registerSupplierMarketplaceRoutes`
- `registerSupplyScoutRoutes` when `ENABLE_SUPPLY_SCOUT=true`

Growth/referral:

- `registerGrowthRoutes`
- affiliate admin/share/referral routes in admin/growth modules.

## Danger Routes

Treat these as high-risk until C4-C10 add narrower maps/contracts:

- `/admin/dashboard` - large admin frontend surface.
- `/api/admin/launch-board` - Launch Board aggregation and schema drift risk.
- `/api/admin/users/:id/verify-insurance` - changes booking eligibility.
- `/api/admin/claim-pitches` and `/api/admin/claim-pitches/:listingId/status` - imported listing pitch/status workflow.
- `/api/hosts/parking-pass` - host Parking Pass listing writes.
- `/api/parking-pass/:passId/book` - Parking Pass booking and Stripe intent path.
- `/api/bookings/*` - booking state, host/truck schedule reads, and ownership boundaries.
- `/api/stripe/webhook` - payment reconciliation and raw body handling.
- `/api/restaurants/:restaurantId/mobile-settings` - truck mobile/location settings.
- `/api/restaurants/:restaurantId/location` path family inside restaurant operations - live location/profile location updates.
- `/api/admin/geo-ads/*` - admin geo ad mutation and metrics.

## Validation Routes

`npm run gate:production` currently performs read-only probes for:

- `GET https://mealscout.onrender.com/api/health`
- `GET https://mealscout.onrender.com/health/ready`
- `GET https://www.mealscout.us/p/truck/t1/taco-bandito`
- `GET https://www.mealscout.us/scout`
- `GET https://www.mealscout.us/parking-pass`
- `GET https://mealscout.onrender.com/api/admin/launch-board` expecting admin launch-board guest auth rejection.
- `GET https://www.mealscout.us/<indexnow-key>.txt`

Still requires fixtures, staging, or explicit production-test-record approval:

- Admin insurance verification mutation smoke.
- Parking Pass allowed/blocked booking state smoke.
- Stripe webhook replay or payment mutation smoke.
- Host Parking Pass listing mutation smoke.
- Owner dashboard profile/location/mobile-settings mutation smoke.

## Trace Examples

- Public user enters `/scout`: `client/src/App.tsx` routes to `ScoutPageV2` (`client/src/pages/explore-preview-v2.tsx`), then calls discovery APIs backed by public discovery, live trucks, public events, restaurants/subscribed, and deals/nearby route groups.
- Customer opens `/p/...`: `client/src/App.tsx` routes to `PublicProfilePage`; backend profile resolution lives in public discovery/profile routes and public profile prerender routes.
- Truck owner reaches dashboard: `/restaurant-owner-dashboard` or `/restaurant/dashboard` routes to `RestaurantOwnerDashboard`; backend ownership/profile/deal/menu/schedule surfaces are restaurant operations, restaurant core, deal management, menu, and business team routes.
- Host creates/open spots: `/host/dashboard` and `/parking-pass` host setup flows call host/event/Parking Pass APIs, especially `/api/hosts/parking-pass` and event route groups.
- Admin reads Launch Board: `/admin/dashboard` Launch Board tab calls `/api/admin/launch-board`, implemented in admin core ops routes.
- Parking Pass booking path starts: `/parking-pass` selects a listing and calls `/api/parking-pass/:passId/book`, then payment/webhook reconciliation completes state transitions.
