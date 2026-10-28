# Google Sheets ↔ IndexedDB sync

Google Sheets remains the shared source of truth. IndexedDB stores verified reads
and durable pending commands in each browser. No PostgreSQL, extra shared database,
credentials in IndexedDB are introduced.

## Central Disqualified records (2026-10-28)

All six client configurations point to the shared Disqualified workbook. `Master`,
`FOLLOWUPS`, and `FOLLOWUP_HISTORY` store literal values with origin workbook,
origin portal, a namespaced Central Key, and transfer state. `PORTAL_CONFIG`
retains stage/field definitions. Existing manual/legacy records are preserved.

The configured worker is installed once when a deployment is opened. Each minute
it selects leads whose current stage is Disqualified, copies complete parent and
child bundles, reads back every copied value, and then uses the source sync
transaction and revision fence to remove the three source record types and
update indexes. A failed or ambiguous copy never permits source deletion. An
ambiguous source commit is reconciled against committed source receipts on retry.
If a staged lead changes to another stage before removal, its copy is marked
Cancelled and excluded from portal views. Changing data during preparation
aborts removal. Other modules remain in their original workbooks; custom values
are additionally carried in the parent's Custom Fields JSON cell.

Verification uses fresh Sheets API reads after API writes; it must not use a
SpreadsheetApp read cached before the write. A ten-minute worker lease prevents
overlapping scheduled/manual runs, with cleanup on ordinary success/failure and
expiry after a terminated execution. Batches retain complete lead bundles, up to
150 leads / normally 600 parent and child rows. Source index rows that only move
position update their row number without rewriting unchanged business fields.

The Disqualified page is read-only and uses the existing Leads permission and
assignment/department rules, additionally restricted to its origin workbook.
Archived records also require Archive access. Configuration is copied even for a
portal with no Disqualified leads; subsequent definition changes refresh it.
Its list/detail APIs commit into the scoped IndexedDB page cache before rendering.
The whole-sheet mirror adds DQ_MASTER, DQ_FOLLOWUPS, DQ_FOLLOWUP_HISTORY and
DQ_CONFIG stores; database version 2 preserves existing stores during upgrade.
Scope hashes include the configured central workbook. Live background reads
detect manual central sheet edits; this is polling, not WebSockets.

Operational checks: inspect Transfer State and the admin page's last transfer
status. Unknown schema columns, duplicate IDs and oversized bundles fail closed
with the source retained. Fix the schema/data and retry using Transfer pending
leads or the next worker run. Source receipts and revision fences must not be
deleted. Keep the pre-conversion hidden workbook snapshots for recovery.

The complete, schema-preserving business-table mirror added on 2026-10-26 is
documented in [WHOLE_SHEET_INDEXEDDB.md](WHOLE_SHEET_INDEXEDDB.md). It adds named
sheet stores and a local Sheet Data viewer alongside the existing worklist caches.

## Supported flows

| Flow | Behavior |
| --- | --- |
| Lead create/edit, follow-up create/completion, stage moves | Queued locally, authorized and validated on the server, then committed atomically |
| Archive, bulk archive, restore, bulk lead save | Same queue and transaction path; per-row bulk failures retain existing result semantics |
| Manual call-to-client mapping | Contact number, call mapping and audit commit together with existing phone conflict guards |
| Client & Factory Visit create/edit | Durable browser queue; existing request ID/version contract, atomic record/event batch and added revision fence |
| Reads | Verified snapshots plus per-record manifest deltas for supported worklists |
| Direct Sheet edits/deletes, API imports, integration changes | Detected on the next successful authorized source reconciliation |

Permanent deletion, cross-workbook transfers, public anonymous forms, file uploads,
user/config administration and unsupported APIs retain their online paths. Uploaded
file objects are rejected from the sync queue; forms using an inline file field
need the online workflow while this feature is disabled. This release does not
claim to replay every possible portal mutation offline.

## Write protocol

1. Capture the authorized record originally displayed, including update time,
   ownership, stage and relevant custom fields. A new lead needs no existing base.
2. Persist an immutable command in `nbd-sync-outbox.commands` before sending it.
   It contains portal/user/scope, UUID, action, arguments, original bases and a
   fingerprint. It never contains the session token. Repeated identical submissions
   reuse the existing command; dismissed commands can be intentionally resubmitted.
3. While online, drain commands sequentially. The foreground browser checks every
   five seconds and on online/focus. IndexedDB claims with two-minute leases keep
   two tabs from normally sending the same command concurrently. Attempt numbers
   prevent an old response from replacing a newer attempt's state.
   A missing RPC callback releases the local wait after two minutes and schedules
   a same-ID retry; it does not cancel the server save or declare that save failed.
4. The server rechecks session, portal, user, scope, action permissions, row access,
   original bases and existing business validators. An action allowlist prevents
   arbitrary function dispatch. A ScriptLock serializes normal sync writes.
5. Domain changes are staged in memory. A single Sheets `batchUpdate` writes changed
   cells, appended/deleted rows, derived indexes, FSR delivery queue entries and
   `_SYNC_OPERATIONS` (operation ID, actor, request hash, result, commit time).
   Failed per-row bulk work restores its staging savepoint.
6. The batch adds a caller-supplied unique named-range ID for the next receipt
   revision. Batches prepared against that same revision cannot both commit, even
   when one remains in flight after a timeout. Visit saves use an equivalent event
   revision fence. Receipts/events let retries recover the original result.
7. Only a confirmed commit is shown as Synced. Unknown outcomes retain the command
   and retry with its original ID. After confirmation, invalidate local snapshots
   and signal other tabs to verify. Outbound FSR delivery uses its existing worker.

The Sheets API documents atomic application of subrequests and rejection of an
existing caller-supplied named-range ID:
[batch requests](https://developers.google.com/workspace/sheets/api/guides/batch),
[AddNamedRangeRequest](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#AddNamedRangeRequest).

The UI keeps existing save return contracts: an online submission awaits its first
sync attempt. Offline/unconfirmed saves show a pending message and keep the input.
They are not inserted into the server-confirmed list as if already saved. A failed
IndexedDB write sends nothing. There is no unsafe network-only fallback for a
sync-enabled save and no automatic replay through a legacy endpoint.

## Pending changes and access

The Pending changes panel shows state, reference and error. Validation/conflict
entries retain the submitted input for review and can be dismissed; retryable,
blocked and paused entries offer Retry. Uncertain outcomes cannot be discarded as
though they were known failures. An unresolved command stops later commands from
overtaking it. Correct a rejected input only after reviewing/dismissing that entry.

Queues are isolated by portal and user. Logout clears private read snapshots and
UI state, but preserves unconfirmed commands for the original account so they are
not silently lost. A different account cannot list/replay them through the app.
This is application isolation, not encryption against browser-profile owners or
XSS. Do not share a browser profile for confidential pending work.

Role/department/assignment changes are rechecked on every server request. Changed
scope blocks old commands instead of silently replaying them with expanded rights.
Such entries need an administrator to reconcile their original operation reference
and permissions; there is no automatic rebase of an ambiguous write. If access is
revoked, data can remain visible until the next successful verification; this is
not instantaneous revocation.

## Pull protocol and timing

Cold reads use complete, revision-bound pages. Current clients opt in to batches
of up to 2,000 records, targeting at most one million serialized characters per
batch (one oversized row is sent alone). This avoids a separate Sheet scan/RPC
for every 100 history records. Older clients retain 100-record pages. Every batch
still rechecks authorization/revision, and only a complete, verified snapshot is
committed locally. Warm clients submit record IDs and
SHA-256 hashes, and the server computes authorized changed records plus removal
tombstones. A client applies every delta page to a temporary snapshot, checks the
final hash/revision and replaces IndexedDB in one transaction. Reassignment/removal
is a tombstone in that user's view; a foreign manifest cannot grant record access.
Module array positions preserve legitimate duplicate business/history rows.

New clients negotiate `canonical-v1` content hashes. Object keys are recursively
sorted before hashing on both sides, because the Apps Script RPC bridge may change
property order. Array order and values remain significant. This changes only read
snapshot/delta hashes, not authorization scope or write receipts. Legacy hash
responses remain readable during rollout; old clients keep the legacy protocol.

Already verified in-memory reads can be reused for 15 seconds. Visible worklists
revalidate at the existing 15-second polling tick; focus/explicit refresh forces
verification. Refresh waits while a form/input is being edited. Hidden/offline
sync-enabled tabs skip stamp polling. Polling detects missed external writes by
reading current source state, including changes that never fire an Apps Script
trigger. No unreliable `onChange` guarantee, WebSocket service, durable ordered
change journal or cross-tab read leader is claimed.

## Activation and rollback

1. Push matching frontend/server code, then update the intended versioned Apps
   Script web-app deployment. The repository's push workflow syncs project source;
   it does not itself replace an existing versioned `/exec` deployment.
2. On a test deployment of the intended portal, sign in as ADMIN and choose
   **Set up Sheets sync → Enable sync**. `apiSyncInitialize` prepares the operation,
   follow-up/custom-value/bulk/FSR queue schemas, ensures the FSR worker and enables
   `LEAD_READ_CACHE_ENABLED`, `PORTAL_READ_CACHE_ENABLED` and
   `PORTAL_TWO_WAY_SYNC_ENABLED`. Each must be the exact string `true`.
3. Verify actual Apps Script iframe IndexedDB support, staff scopes, a synthetic
   lead/follow-up, manual Sheet edit, reconnect and reload on the deployed version.
   Measure response times and quotas for that workbook's actual size before wider use.
4. For rollback, set `PORTAL_TWO_WAY_SYNC_ENABLED=false` and reload clients. Existing
   queued requests pause on the server; keep their local data. Leave read flags on
   for the read-only pilot, or turn them off too. Re-enable to resume matching-scope
   commands. Do not resubmit an uncertain command through a legacy form.

Deployment alone does not enable sync, replace a workbook or write production rows.
No production workbook, flag or deployment version was changed during local testing.

## Limits and operational requirements

- Source scans still happen for every revision/page check and when planning a write.
  This reduces transfers and makes saves recoverable; it does not remove Google
  service execution limits or guarantee lower latency for every cold operation.
- Manifest cap: 10,000 records/1.2M characters; larger snapshots use replacement.
  Delta pages: 100 changes. Browser command payload cap: 200K characters; server
  envelope: 250K. Bulk queue: at most 20 rows, bases: 50. Batch: at most 2,000
  subrequests/1.5M characters. Stored result: at most 40K characters.
- The transaction rechecks touched tables immediately before commit. Direct Sheet
  writers and legacy/other scripts do not necessarily acquire this portal's lock
  or advance its fence. Google Sheets offers no conditional update on those arbitrary
  writes: a manual edit between final verification and commit can still race. This
  is not serializable transactions across independent integrations/workbooks.
- Only changed cells are written; untouched formulas/formatting are preserved.
  User text starting with `=` is stored as literal text. Staged dates use serial
  values when a true Date is supplied; domain-normalized date strings are retained.
- **Do not delete/truncate `_SYNC_OPERATIONS`, Visit events or sync named ranges.**
  Receipts and revision fences protect retries. Removing them can break deduplication
  or make revision allocation fail closed. They currently have no automatic retention
  cleanup; monitor growth, Sheet limits and response time. Maintenance needs a separate
  epoch/retention design before any history is pruned.
- Pending data can be lost if the browser evicts/clears storage. Sync runs while the
  portal is open, not in a service worker after the browser closes. Dismissed commands
  clear payloads; committed local entries remain until dismissed. Monitor storage.

## Verification

Run:

```text
node scripts/check-syntax.js
node --test tests/*.test.js
node scripts/two-way-sync-browser-fixture.js
```

The CI source-push workflow runs syntax and regression checks before clasp pushes.
Local result: **205 tests passed**, including transaction rollback/response loss,
delayed same/different commands, duplicate protection, current authorization,
conflicts, archive/restore, bulk partial validation, call mapping, FSR queueing,
multi-page deltas, mid-read Sheet changes, tombstones, user isolation and quota errors.

The fixture binds only `127.0.0.1:8769` and uses synthetic records, real production
client/transaction code, actual browser IndexedDB and a simulated Sheets API.
Chrome passed ten browser checks plus an actual page-reload recovery check.
This is not a production latency benchmark, full portal visual test, actual Google
Sheets API integration test or live Apps Script iframe test. Those deployment
checks remain necessary before activation; local passes do not certify them.
