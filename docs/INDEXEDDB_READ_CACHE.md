# Authenticated IndexedDB read cache

The read cache now supports opt-in two-way sync. See
[Sheets / IndexedDB sync](SHEETS_INDEXEDDB_SYNC.md) for writes, activation, conflict
handling, validation results and operational limits. This document describes the
underlying read contract; the old read-only pilot remains available independently.

## Flags and identity

`LEAD_READ_CACHE_ENABLED=true` enables Leads snapshots.
`PORTAL_READ_CACHE_ENABLED=true` enables the other supported worklists.
`PORTAL_TWO_WAY_SYNC_ENABLED=true` additionally enables the durable write queue,
manifest deltas and 15-second reuse/revalidation described in the sync guide.
The flags are Script Properties, per Apps Script project, and default off.
Deploy matching frontend/server sources together. Old bootstrap responses never
unlock persistent private reads.

Bootstrap supplies schema, Script project ID, user ID and a scope fingerprint after
validating the session. Every server page repeats authentication, module permission
and row scope checks. No session token, password, staff directory or config object
is persisted in the read cache. Cache contents are not an authorization grant.

## Complete, verified snapshots

- Database `nbd-authorized-reads`, version 1, store `snapshots`.
- Keys include namespace, schema, portal and user. Values include scope, complete
  records, revision, terminal cursor and verification time.
- SHA-256 revisions represent the sanitized, authorized collection, not a timestamp.
  Manual Sheet edits are detected even when application stamps were not bumped.
- Pages contain up to 100 records. Cursors are bound to the collection revision.
  A revision change restarts the read, with at most three attempts.
- A full collection or full module response must pass shape/integrity checks and
  final revision verification before it is rendered or atomically stored. Partial
  totals are never shown as complete totals.
- Warm persistent data is verified online before initial use. Two-way sync permits
  already verified in-memory data to be reused for 15 seconds; explicit refresh,
  mutation, focus and invalidation signals require fresh verification.
- Changed scope, revoked access and logout lock/purge private read snapshots.
  Offline hides the current worklist; with sync enabled, an already-open modal can
  retain its input for a queued save. There is no private offline login/startup.
- Generations reject stale reads and storage writes after logout, identity changes,
  mutations and suspension. Other tabs receive only non-sensitive invalidation.
- Corrupt, unavailable or quota-limited read storage falls back to authenticated
  network reads. Pending-write storage deliberately has a different failure policy:
  if it cannot persist a command, the save is not sent or reported as queued.

## Coverage

| Screen | Cached unit |
| --- | --- |
| Leads / pipeline using `getLeads` | Complete authorized Leads collection |
| Follow-ups | Leads, follow-ups and requested history together |
| Today | Its existing scoped leads, follow-ups, history and activity response |
| Archive / Suggestions / Lost | Each tab's computed response |
| Client & Factory Visits | Current filtered register page and server totals |
| Calls | Current filtered Calls response and original visibility rules |
| Client Call Report | Current filtered 50-row report page and all-filtered totals |

The adapter reuses existing domain services and preserves IDs, source array order,
legitimate duplicate history rows, scopes and totals. Its packed records are a
metadata entry plus indexed array entries. Query choices are part of the revision.
Only one durable response per module/user is retained, not every historic filter.
Directories, selector values and timing metadata remain fresh response metadata.

Custom Follow-up query APIs, individual details/history, external FSR history,
configuration and export endpoints remain authenticated network reads. Existing
edit forms request fresh detail where required; background refresh does not replace
an open form. No whole-workbook download is made to an ordinary user's browser.

## Source and checks

Client: `IndexedDbCache.html`, `PortalReadCache.html`, `AppCore.html`, `AppAuth.html`,
`AppData.html`, `Leads.html` and existing worklist views.
Server: `LeadCacheService.js`, `PortalReadCacheService.js`, `SyncDeltaService.js` and
the read-only custom field merge in `CustomFieldValueService.js`.

Run `node scripts/check-syntax.js` and `node --test tests/*.test.js`.
Local synthetic read fixtures are `scripts/lead-cache-browser-fixture.js` (8767)
and `scripts/portal-cache-browser-fixture.js` (8768). The two-way fixture and current
test evidence are documented in the sync guide.

Server source scans still occur. This cache reduces browser transfers/repeated
navigation work; it is not a materialized server database or a socket service.
Browser profile owners/XSS can inspect local data, and storage may be evicted.
