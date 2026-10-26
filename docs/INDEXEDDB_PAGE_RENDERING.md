# IndexedDB page rendering

Updated 2026-10-26 following the live NBD startup investigation. The old Today
screen waited for seven serial snapshot calls (roughly 50 seconds in the captured
session). The screen cache now uses one authorized response for its first download.

## Read path

1. Authenticate the current session and obtain its current permission scope.
2. Persist sanitized application configuration and prepare **only the initial
   page's data**. Show the initial opening screen during this step.
3. Render the initial page from IndexedDB. Prepare other permitted pages with a
   single background worker; foreground requests take priority between jobs.
4. On navigation, render the matching saved response immediately. Fetch updated
   data in the background, commit it to IndexedDB, read it back, and update the
   view. The response passed to a renderer is never the raw network object.

The sidebar **Data sync** card shows progress. Clicking it opens a page-by-page
status dialog with last-sync times and retries for incomplete pages. Background
work does not replace the main screen with a loading page. A page/filter with no
saved data still needs its first successful server response; no fabricated empty
result is shown as if it were current data.

## Storage

`nbd-sheet-mirror` continues to hold the complete authorized business tables,
preserving original tab/column/row structure. `nbd-authorized-reads.snapshots`
also holds sanitized page projections under `page-preview` keys. These projections
retain existing domain calculations, labels, filtering, and totals instead of
attempting to reinterpret the raw sheets independently in each screen.

Only explicit business-read endpoints are captured. User directory projections
contain an explicit set of display/access fields; passwords, hashes, credentials,
raw webhook delivery bodies and sensitive configuration entries are excluded.
Authentication, diagnostics, validation commands, and exports remain live operations.

Each preview is tied to portal, workbook-derived scope, user, role, modules,
department scope, and configuration/user-management permissions. Exact request
arguments prevent one filter's snapshot being displayed as another filter's data.
Only complete, integrity-checked snapshots less than seven days old can preview.
Session bootstrap is still required before private cached data is displayed.

## Failure and interaction handling

- IndexedDB commit/readback failures never fall back to displaying fresh network
  data. A previous complete preview remains available and the sync error is shown.
- Background failures retain the explicitly labelled older preview. Access denial,
  logout or scope changes lock and purge private read caches; the pending write
  outbox remains separate.
- Late responses cannot replace another route or a newer query. Typing, active
  forms and modals defer a background repaint; the sidebar offers an explicit
  updated-view action. Bulk editor drafts are not recreated by background sync.
- Successful writes invalidate in-memory leases while retaining the last complete
  disk generation as a labelled preview until reconciliation completes.
- Loading skeletons and table-loading overlays are disabled after initial setup.
  All source writes still use the existing server validation and durable outbox.

## Verification

Regression coverage includes delayed database commits, readback, quota failure,
corruption, expiration, cross-user/scope isolation, concurrent filters, missing
crypto, stale navigation responses, typing preservation, background read failure,
access denial, current-page-only startup, and foreground priority over prefetch.
See `tests/page-preview.test.js` plus the existing full regression suite.

### Rollout result

Runtime commit `88e5783`: 243 tests passed; syntax checks and GitHub Actions run
`40297352780` passed. Deployment and cache-busted published-source checks passed
for all six portals: NBD 169, LQ 101, NBD Lamination 38, LQ Lamination 41, CS 14,
and Dead 15. Every published response contained the background worker, sidebar
sync card and IndexedDB readback path.

Signed-in NBD successfully displayed Today and Webhooks during the earlier preview
iteration. Final interactive validation of the revised sidebar/background worker
could not finish: the original Webhooks form had an unsaved edit, and Computer Use
stopped while attempting to select Chrome for a non-disruptive duplicate tab because
it could not confidently identify the active URL. No reload/discard of that form
was performed. The final sidebar scroll change is implemented and deployed but
has not been visually rechecked in the signed-in final build.
