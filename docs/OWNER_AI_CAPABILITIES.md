# Owner AI read and preview contract

`shared/ownerAiCapabilities.ts` is a pure synchronous server-side facade. The authenticated server resolver now wires it to REST and model-neutral MCP read/preview tools, reloading persisted credentials, current ownership, canonical type, native context and versions. Preview does not persist, approve or publish. Actual editing uses the existing versioned native draft and exact-revision owner-consent flow. Product scope covers all canonical public profile types; this slice does not make unsupported adapters writable.

The server resolves trusted current-owner/profile metadata and credential state. `principal` is an explicit projection of the existing connector principal plus persisted active/expiry/revocation state and canonical profile target. The authenticator returns restaurantId; the resolver obtains canonical type from the native record and rechecks credentials and ownership after context loading. No client-supplied principal, type or visibility can grant access. Source provenance declarations remain unverified; they do not establish business facts or consent. No new grants or paid membership requirement are introduced.

Every call checks exact profileId/profileType binding across request, principal and metadata, current ownership, active credential, revocation and expiry, and context scope. Preview additionally requires draft-create scope, current expectedVersions, and a matching verified native adapter. Approval scope is intentionally unnecessary for read/preview. Results are detached and recursively frozen before return; there is no asynchronous target lookup that could retarget an in-flight preview.

| Profile type | Adapter permitted by this contract | Preview scope |
| --- | --- | --- |
| restaurant, truck, bar, caterer, private_chef | Explicitly verified restaurant_native, same backing restaurant ID and authoritative canonical type | Details, menu/prices, hours, locations, schedules, photos |
| location, host, supplier | Unsupported | No packet preview |
| All types | Settings unsupported | No settings changes |

Capabilities describe the currently bound target and granted scopes. Other types remain listed with unsupported adapters; a type name alone never enables a native adapter. This is contract coverage for existing restaurant-backed packet semantics, not proof of integrated type-specific persistence. Social and deals are excluded from this slice, and strict native schemas reject unknown settings/apply/target fields. Existing apply code is not reimplemented.

The eight-type canonical `PublicProfileType` union is not the entire public product surface: separate `/event` and `/events` details exist outside that union. Event targets remain unsupported until a canonical target/adapter contract exists. Personal/account security and permissions settings are unsupported. Native dated stops now accept explicit `status: "closed"`; a closure requires a valid supplied timezone, exact calendar day and expiry within its local day. Approval rejects remaining overlapping public native availability atomically. Closures never replace weekly hours or automatically cancel bookings.

Source and context carry source attribution, observedAt, access and expiresAt. Expired/future/unknown evidence fails closed in preview. Public-facing detail/menu/hour previews require declared public evidence and context. Schedule access must be explicit because the existing native schema defaults omitted isPublic to true. Private/restricted evidence can only preview explicitly private schedules; it cannot preview public stops. Source/stop expiry is preserved and checked. No timezone is guessed. Preview always returns approvalRequired=true and canApply=false; it conveys neither consent nor authority to publish. Native approval reauthenticates and checks exact owner consent, draft revision and current versions. Preview provenance is not persisted into native drafts or independently verified by native approval. Automated source-driven publishing still needs a verified-source gate at approval/apply; that gate is not implemented by this read/preview slice.

Targeted evidence: `node --import tsx --test scripts/owner-ai-capabilities.behavior.test.ts`.

Dated stop previews require an explicit valid IANA timezone and absolute expiresAt. Expired stops and dates before today in that timezone are rejected even when packet provenance is fresh. Unknown timezone remains a blocker. Missing current versions disable advertised preview capabilities. Future review/apply must repeat these time checks.
