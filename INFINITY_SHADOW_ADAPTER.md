# Infinity shadow adapter

MealScout continues to own its current referral capture, commission behavior,
and profile mutation. The adapter mirrors non-PII attribution touches, signup
evidence, and nothing else into Infinity. It does not read or write commission,
wallet, credit, withdrawal, payment, ordering, profile, menu, schedule, media,
or live-availability state.

Set `INFINITY_API_URL`, `INFINITY_API_KEY`, `INFINITY_TENANT_ID`, and
`INFINITY_PROGRAM_ID` to enable it. Missing configuration disables delivery.
Requests time out after 1.5 seconds, fail open, and run outside the user-facing
success path. Production endpoints must use HTTPS.

The mirrored payload allowlists an internal partner reference, a validated
affiliate tag, its carrier, a query-free canonical route, event type, and
opaque restaurant/route hashes. Raw query strings are never forwarded. Unknown
parameters and query values such as tokens, emails, phone numbers, authorization
codes, and login codes are discarded before the payload is built. Email- or
phone-like path segments are redacted as a second boundary. The adapter also
excludes IP address, user agent, payment value, and commission percentage.

This adapter does not send or apply product-field inheritance. Selective
Intelligence governs future convergence and drift review rather than acting as
a central product-data mutation runtime. MealScout has no active consumer of
that removed Infinity endpoint.
