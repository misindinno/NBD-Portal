# IndexedDB read-cache pilot

Implemented locally: secure Leads snapshots plus Follow-ups, Today, Archive and
bounded Visit/Call Report response snapshots using the revision/pagination foundation.
Sheets remains authoritative. No offline write queue, live migration or credential
grant is involved. The independent inbound visit module and Client Call Report
retain their existing storage, permissions, source reads and counting rules.

## Activation and rollback

The pilot is opt-in per Apps Script project: an administrator can later set Script
Property `LEAD_READ_CACHE_ENABLED` to the exact string `true` for Leads and, separately,
`PORTAL_READ_CACHE_ENABLED=true` for the additional screens in a test deployment.
Enabling Leads alone does not enable the other screens. Each switch is independent.
This task does not set that property or deploy anything. Absent/false uses the
existing network-only loaders. Removing a flag makes its active pilot lock
and reauthenticate on its next read. Deploy frontend and server files together.
Older bootstrap responses without cache identity never unlock persistent reads.

Start with one test portal and representative synthetic data. Before production
activation, verify browser storage in the actual Apps Script iframe, RPC payloads,
server scan timings, and role/department/assignment changes with test accounts.
Rollback is the property switch plus a reload, not a Sheets migration.

## Implemented contract

- Bootstrap validates the existing session and supplies schema, Script project ID,
  user ID and a scope fingerprint. No token/password or user directory is persisted.
- `apiGetLeadCachePage` repeats current auth, Leads grant and existing row scopes on
  every request. It scopes master rows before merging custom values through a new
  read-only helper that never initializes custom-value Sheets.
- The revision is SHA-256 of the current sanitized, sorted, authorized collection
  plus its scope. It is a content revision, not a timestamp or a monotonic change
  sequence. Direct Sheet edits are included even if stamps were never bumped.
- RPC pages contain at most 100 records. Continuation cursors are offsets bound to
  that exact revision; stale or malformed cursors fail. The client retries a changed
  snapshot at most three times, with a final revision check after the last page.
- Existing Leads filters, KPIs and exports require a complete collection. The pilot
  therefore stages all pages before publishing anything to the UI or IndexedDB.
  It does **not** implement first-page rendering or claim partial totals are complete.
- IndexedDB database `nbd-authorized-reads` (version 1) has one `snapshots` store.
  Each key includes schema, portal and user; each value includes scope, records,
  revision, completeness, terminal cursor and verification time. A single transaction
  replaces the complete snapshot and metadata together. It never stores AppCache,
  Store, optimistic edits, config objects or session state wholesale.
- Only scalar lead fields are eligible; credential-like keys and nested objects
  are excluded. Existing core edit forms fetch fresh authorized lead details before
  opening. Sensitive credentials must never be entered into arbitrary lead text.
- Warm data is integrity-checked locally and then verified against the current
  authorized server revision **before rendering**. No private offline startup or
  network-error fallback to unverified persistent data is allowed.
- Replacement snapshots handle deleted, archived and reassigned records by removing
  them. Changed scope or revoked access locks/purges the cache. This is not a durable
  tombstone feed; access changes are observed on the next successful server check.
- Leads verifies on navigation/refresh/return to the tab and at most once per minute
  on the visible screen, in addition to existing stamp-driven refreshes. The browser
  offline event hides the Leads view; online resumes verification. Failed load UI
  never displays a partial snapshot. Verification time is shown to the user.
- Server-confirmed mutation responses invalidate snapshots. Failed saves never
  commit optimistic rows to disk. Generations cancel stale reads/storage operations
  after mutation, identity change, offline suspension or logout.
- Logout broadcasts a non-sensitive invalidation signal to other same-origin tabs,
  clears the snapshot store and central memory, then reloads to discard private
  closure-local state in older modules. Duplicate signals share one cleanup.
  Restored browser back/forward-cache pages also lock. Browser-denied storage is a
  network-only fallback; physical erasure cannot be guaranteed when the browser
  refuses storage access, but old data never bypasses online authorization.
- Blocked database opens and stalled transactions have bounded timeouts; corruption,
  missing stores and quota failures fall back to authenticated network reads.

## Files

`src/IndexedDbCache.html` contains storage, lifecycle and sync logic.
`src/server/LeadCacheService.js` implements identity and bounded revision reads.
`src/server/CustomFieldValueService.js` adds the read-only merge path.
`src/server/Api.js`, `AppCore.html`, `AppAuth.html`, `AppData.html`, `Cache.html`,
`Store.html`, `Leads.html` and `Index.html` integrate bootstrap, invalidation and UI.
`src/PortalReadCache.html` and `src/server/PortalReadCacheService.js` add the scoped
response adapter; `Followups.html`, `Today.html`, `Archive.html`, and
`server/ArchiveService.js` integrate complete snapshots and read-only Archive reads.
The Visit and Call Report feature files are unchanged: their existing RPC calls
are routed through the opt-in adapter, with original domain services still used.

## Additional screen coverage

| Screen | Cached unit | Completeness and totals | Sync mechanism |
| --- | --- | --- | --- |
| Follow-ups | Leads, follow-ups, optional history together | Entire response before rendering; original assigned-or-actor scope and duplicate history semantics retained | Validated replacement |
| Today | Leads, follow-ups, history, activity together | Entire response; original Today scope, no independent collection refresh mixing while enabled | Validated replacement |
| Archive / Suggestions / Lost | Each tab's original computed response | Entire tab before local filtering/KPIs; cache reads skip schema initialization | Validated replacement |
| Client & Factory Visits | Current filtered 50-row register page | Original server totals/summary and `canEdit`; options/hosts and history remain network reads | Validated page replacement |
| Client Call Report | Current filtered 50-row report page | Original all-filtered totals, zero-client rows, exact modes, History ID deduplication and IST filters | Validated page replacement |

All additional reads use `apiGetPortalReadCachePage`, an explicit module allowlist,
and the existing domain permission checks. Query/option values are included in the
hashed response, including history inclusion and report page/filter choices. A
packet contains metadata plus array entries indexed by position; the adapter never
merges customer names or deduplicates business/history rows. JSON objects are
canonicalized for stable revisions; array order and IDs retain source semantics.

One complete durable response per module/user is retained, rather than unbounded
filter history. Fetch timing and directory/selector values travel only in fresh
response metadata and never enter IndexedDB. This lets directory labels change on
warm reads without storing a user directory. Generic transactions and generation
guards use the same tested storage engine as Leads.

Follow-ups and Archive no longer reuse a previous in-memory snapshot on a tab open
when the pilot is enabled. Today fails closed rather than falling back to potentially
mixed legacy cache collections. Background verification is coalesced and uses a
per-screen stamp baseline; forms and focused inputs are not replaced while editing.
Offline hides the current cached screen. Export endpoints remain live and authorized;
no export is assembled from a partial persistent response.

## Validation

Run from the repository root:

```text
node scripts/check-syntax.js
node --test tests/*.test.js
node scripts/lead-cache-browser-fixture.js
node scripts/portal-cache-browser-fixture.js
```

The browser fixture binds only `127.0.0.1:8767`, uses synthetic records and the real
IndexedDB implementation, RPC adapter and Leads loader. Its native list renderer
replaces Tabulator to avoid third-party assets; it is not a full portal/deployment
test. Its controls exercise direct edits/deletion, server-save reconciliation,
revocation, network/storage failure and cross-tab logout. Storage checks exercise
actual IndexedDB atomic writes, cancellation and clear/recovery.

Unit coverage includes exact IDs/scopes, empty results, credentials exclusion,
corruption, duplicate/replayed pages, revision changes and retry limits, interrupted
loads, user/portal switching, denied storage, offline reads, logout/identity races,
stale cache writes and confirmed-save invalidation. Existing call-report and inbound
visit tests remain in the full suite.

Synthetic Chrome measurement (205 leads, localhost, native list): cold 4 RPCs,
36,514 response characters, 39 ms; warm 1 RPC, 323 characters, 19 ms. ASCII fixture
payloads make character/byte counts equal. These measurements demonstrate reduced
transfer only; they are not a production latency or server-scan benchmark.

The additional fixture binds `127.0.0.1:8768`, using real domain read services,
the actual Visit and Call Report views, and compact data previews for the legacy
worklists. This distinguishes cache/RPC integration checks from full portal visual
testing. Expansion tests compare domain outputs, actor/department/owner scopes,
history inclusion, all-filtered totals across pages, same-name customer IDs, direct
edits/deletion, volatile user labels and separate feature flags.

Final expansion validation: 174 tests passed (37 cache-specific tests), syntax
checks passed, and the repository-normalized `git diff --check` passed. Chrome
verified warm Today/Follow-ups reads, Archive tabs/empty states, the actual Call
Report and Visit register/filter views, zero totals, network failure/recovery and
revocation cleanup. Console warnings/errors were empty in the checked fixture.
No live portal/Sheets browser session was used. The fixtures were stopped after
testing. Tests of the actual Apps Script embedding remain a pre-activation step.

## Remaining phases and limitations

1. Server scans still occur on every revision/page request. Cold loads can cost more
   server work than the previous single full response. First-page rendering requires
   coordinated server search/facets/counts/exports and UI changes; do not enable for
   large datasets before measuring these costs.
2. No persistent change log, monotonic delta cursor, tombstone feed, materialized
   read index, external-edit reconciliation job, or cross-tab sync leader exists.
   Current full-content validation is deliberately the conservative alternative.
3. The above screens now use validated replacements. Custom Follow-up query APIs,
   individual detail/history reads, external FSR history and Calls remain network
   reads. Leads/Follow-ups/Today/Archive still require complete responses before
   first rendering. Visit/Report retain their existing server-paginated first pages
   and server-wide totals; no new partial-data totals are introduced.
4. Server-side saves and their established concurrency/idempotency rules are unchanged.
   The cache rejects stale **cache writes**; it does not add optimistic-concurrency
   protection to legacy lead business writes. No offline mutation replay is added.
5. Cache isolation is an application boundary, not encryption against an owner of
   the browser profile or an XSS attacker. Browser persistence/eviction varies; the
   authenticated network path must remain usable.

## Durable delta/tombstone prerequisites (not enabled or claimed implemented)

A correct delta implementation needs a durable ordered journal and retention/epoch
contract, covering every ordinary save, bulk import, stage/archive/restore action,
integration update, scheduled job and administrator mutation. Existing mixed
SpreadsheetApp/Sheets API and multi-workbook writes do not atomically commit such
a journal. An approved transaction/reconciliation design is required first.

Direct Sheet edits, row deletions, API imports and formula changes cannot all be
captured by a simple onEdit trigger. A deployed reconciler must compare current
source state with durable per-record revisions, emit deletion tombstones and repair
missed journal entries. Ownership, department, role and module changes additionally
need visibility invalidation, including records a user can no longer fetch. Expired
cursors, schema changes and missed reconciliation windows must force full resync.

No journal schema, initializer or trigger is added or executed in this work. The
only available protocol is the explicitly labeled validated replacement protocol.
Introducing durable delta remains gated on those contracts and separately approved
schema/deployment work; existing snapshot validation already detects direct edits
on the next successful verification without pretending to provide a change feed.
