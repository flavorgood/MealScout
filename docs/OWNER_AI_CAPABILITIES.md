# Owner AI read and preview contract

`shared/ownerAiCapabilities.ts` is a pure synchronous server-side facade. It performs no database, authentication, network, draft persistence, approval, apply, or publication operation. It is not wired to an endpoint. Product scope covers all canonical public profile types; this bounded implementation does not make all types writable.

The caller must supply trusted, freshly loaded current-owner/profile metadata and verified credential state. `principal` is an explicit projection of the existing connector principal plus authoritative active/expiry/revocation state and resolved profile target. The existing authenticator returns restaurantId, not canonical profileType: an integration must resolve that type from authoritative metadata, never accept a client-supplied type or infer an unrelated entity from a restaurant ID. This facade does not prove that these trusted inputs came from real authentication. No new grants or paid membership requirement are introduced.

Every call checks exact profileId/profileType binding across request, principal and metadata, current ownership, active credential, revocation and expiry, and context scope. Preview additionally requires draft-create scope, current expectedVersions, and a matching verified native adapter. Approval scope is intentionally unnecessary for read/preview. Results are detached and recursively frozen before return; there is no asynchronous target lookup that could retarget an in-flight preview.

| Profile type | Adapter permitted by this contract | Preview scope |
| --- | --- | --- |
| restaurant, truck, bar, caterer, private_chef | Explicitly verified restaurant_native, same backing restaurant ID and authoritative canonical type | Details, menu/prices, hours, locations, schedules, photos |
| location, host, supplier | Unsupported | No packet preview |
| All types | Settings unsupported | No settings changes |

Capabilities describe the currently bound target and granted scopes. Other types remain listed with unsupported adapters; a type name alone never enables a native adapter. This is contract coverage for existing restaurant-backed packet semantics, not proof of integrated type-specific persistence. Social and deals are excluded from this slice, and strict native schemas reject unknown settings/apply/target fields. Existing apply code is not reimplemented.

The eight-type canonical `PublicProfileType` union is not the entire public product surface: separate `/event` and `/events` details exist outside that union. Event targets are explicitly unsupported and rejected by this facade until a canonical target/adapter contract is supplied. Personal/account security and permissions settings are also unsupported. Native schedules represent dated stops; dated closure operations are unsupported and must never be encoded as available stops or replacement weekly hours.

Source and context carry source attribution, observedAt, access and expiresAt. Expired/future/unknown evidence fails closed. Public-facing detail/menu/hour changes require public evidence and context. Schedule access must be explicit because the existing native schema defaults omitted isPublic to true. Private/restricted evidence can only preview explicitly private schedules; it cannot preview public stops. Source/stop expiry is preserved and checked. No timezone is guessed. Preview always returns approvalRequired=true and canApply=false; it conveys neither consent nor authority to publish. Integration must reauthenticate, re-resolve ownership/type, recheck versions and source accessibility before approval/apply.

Targeted evidence: `node --import tsx --test scripts/owner-ai-capabilities.behavior.test.ts`.

Dated stop previews require an explicit valid IANA timezone and absolute expiresAt. Expired stops and dates before today in that timezone are rejected even when packet provenance is fresh. Unknown timezone remains a blocker. Missing current versions disable advertised preview capabilities. Future review/apply must repeat these time checks.
