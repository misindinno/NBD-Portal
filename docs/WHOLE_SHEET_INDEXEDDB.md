# Whole business-sheet mirror

Implemented 2026-10-26. The requested format is **tab names, column names/order
and row values**, not colours, formatting, formulas or spreadsheet permissions.

The subsequent [page-rendering update](INDEXEDDB_PAGE_RENDERING.md) adds
IndexedDB-first page previews, current-page-only initial loading, and sidebar
background sync status. Domain screens use authorized page projections alongside
these raw schema-preserving stores.

## Storage and scope

Database: `nbd-sheet-mirror`, version 1. Each supported tab has an object store
with the **exact tab name**. `_meta` holds the original header array, sheet ID,
revision, complete flag, row count, verified time and portal/workbook/user scope.

Each stored row has `snapshotKey`, its physical `rowNumber`, a `cells` array in
original column order and `dates` (zero-based date-column indexes). This preserves
empty cells, duplicate/empty headers, legitimate duplicate rows and leading-zero
text IDs without inventing unique business IDs. Dates use ISO timestamps plus
their type metadata; numbers, booleans and strings keep their types. Formula cells
contain their calculated values. Custom values remain in their separate source
tables rather than being merged into LEAD_MASTER and changing its schema.

Supported stores:

| Sheet | Access |
| --- | --- |
| LEAD_MASTER | Lead/follow-up/pipeline/archive readers, existing assignment/department scope |
| FOLLOWUPS | Follow-ups permission and linked-lead/actor scope |
| FOLLOWUP_HISTORY | Follow-ups/archive permission and linked-lead/actor scope |
| LEAD_ACTIVITY_LOGS | Lead/follow-up readers and linked-lead/actor scope |
| LEAD_FIELD_VALUES | Lead/pipeline/archive readers; authorized lead IDs |
| FOLLOWUP_FIELD_VALUES | Follow-ups readers; authorized follow-up IDs |
| PIPELINE_STAGES | Signed-in portal members |
| FIELD_CONFIG | Signed-in portal members |
| CONFIG | Signed-in portal members; sensitive config types excluded |
| Bulk_Config | Bulk Entry permission |
| CALL_LOGS | Lead/follow-up readers; linked-lead and unmatched-call permissions |
| VISIT_SUBMISSIONS | VisitManagement permission, matching the existing management API |
| CLIENT_FACTORY_VISITS | ClientFactoryVisits permission; portal, host/creator and manager scope |
| CLIENT_FACTORY_VISIT_EVENTS | Events for authorized client/factory visits |

ADMIN can read the business data allowed by these services; other accounts receive
only authorized rows. Reports-only access does not grant raw follow-up remarks.
Duplicate parent IDs that make ownership ambiguous block linked-record sync for
non-admins; raw authorized master rows and legitimate duplicate history remain
distinct physical records.

This is **not an unrestricted export of every workbook tab**. Staff credentials,
access tables, internal indexes, queues, execution logs, operation receipts and
unreviewed tabs are excluded. The UI lists excluded names for administrators.
Sensitive columns retain their position/name but have null values and explicit
redaction metadata. Sensitive key/value config/custom-field records are excluded.
New business tabs must be added with a reviewed row-access rule and store migration.

## Sync and use

After authenticated bootstrap, existing sync-enabled portals start a single
background worker after the first screen renders. `PORTAL_READ_CACHE_ENABLED`
must be `true`; `PORTAL_SHEET_MIRROR_ENABLED=false` disables the mirror. No workbook
replacement or initialization occurs during reads. Missing optional tabs are
reported as not initialized, with no rows or invented schema.

**Sheet Data** in the sidebar provides per-sheet row counts, status, verification
time, **Sync now**, and **View rows**. Opening a table verifies current access and
then reads the complete saved table from IndexedDB. Search and 50-row pagination
operate locally on that complete result without page-sized server fetches.
`SheetMirror.readSheet(name)` exposes the same verified structured data for other
client consumers. The existing domain screens retain their tested lead/query
cache paths; this change does not claim that all portal reports/forms were rewritten
to run entirely against the new raw tables.

The worker negotiates canonical hashes, bounded complete pages and record deltas
with tombstones through the existing cache protocol. Source rows, headers and
current authorization are checked on each page, then the completed revision is
confirmed. Rows plus metadata commit in **one transaction per sheet**. Partial or
failed downloads cannot replace the last complete generation or be shown as synced.
Each sheet is independently consistent; there is no cross-sheet transaction over
independent direct Google Sheets edits.

Acknowledged portal saves and other-tab save notifications invalidate the mirror.
Reconnect requests a refresh. While visible/online, a one-minute timer checks
whether five minutes have elapsed since the last cycle; focus also checks this.
Manual Sheet changes/imports/deletions are found by source reconciliation even
without triggers. This is bounded background polling, not WebSockets or immediate
cross-device updates. Initial copying and large changed tables still require
Google service reads and are subject to its execution/quota limits.

Identity includes the workbook, portal, user and permission scope. Startup checks
the persisted identity and atomically clears previous-scope data before reuse.
Logout/revocation clears the read mirror, **not the durable command outbox**.
Account isolation is application isolation, not encryption against someone with
access to the browser profile. Storage eviction/quota errors are reported; an
unsaved table is never labelled synced. Fresh access verification is required to
open a table, including after a browser restart.

The existing two-way command queue remains the write path. Editing arbitrary
IndexedDB cells does not directly bypass validation and write them to Sheets.
There is no PostgreSQL dependency.

## Verification

```text
node scripts/check-syntax.js
node --test tests/*.test.js
node scripts/sheet-mirror-browser-fixture.js
```

The synthetic fixture listens only on `127.0.0.1:8771`. Chrome's actual IndexedDB
passed full 14-table persistence, 2,105 history records, duplicates/column order,
new client recovery, Sheet edit/new column/delete propagation, account switching,
private-data clearing and actual browser reload/reverification. No production
customer records were created/edited by these checks.

Regression tests additionally cover interrupted replacement retaining its previous
complete generation, quota failure, workbook isolation, permission revocation,
reassignment, malformed schemas and client/factory visit/event scopes.

Final verification: **229 tests passed**, syntax checks passed, GitHub Actions
run `40282805935` passed for runtime commit `64abfb16ad9703042d63b5ce4e9021ea70a9ac2a`.
The actual Sheet Data viewer was also exercised in Chrome: 2,105 saved rows,
43 local pages, page navigation, and a search for the final row all worked.
The published NBD page rendered its sign-in screen; no NBD session was available
in that browser. Authenticated production row-count/parity checks were therefore
not performed, and synthetic tests must not be presented as live workbook checks.

Published versions on 2026-10-26: NBD **167**, LQ **100**, NBD Lamination **37**,
LQ Lamination **40**, CS **13**, Dead **14**. All deployment HTTP smoke checks
passed. Workbook IDs and existing sync activation flags were retained.
