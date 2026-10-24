# Client & Factory Visits rollout — 2026-10-24

Latest runtime source: `1675f124419741ceaa04d8e9cf71474f477dc63f`.
All six existing web-app deployment IDs were updated; workbook IDs were retained.

| Portal | Version | HTTP/application smoke | Visit initialization and live check |
| --- | --- | --- | --- |
| NBD | 165 | Passed | Initialized; create, validation, cancel, history and reload passed |
| NBD Lamination | 35 | Passed | Login screen only; initialization not verified |
| LQ | 98 | Passed | Initialized; create, cancel, history and reload passed |
| LQ Lamination | 38 | Passed | Login screen only; initialization not verified |
| CS | 11 | Passed | Login screen only; initialization not verified |
| Dead | 12 | Passed | Login screen only; initialization not verified |

The four pending portals display one usable sign-in form on the latest version.
No claim is made that their visit tables or save operations have been verified.
The user limited live testing to the already accessible portals. No further
login or initialization was attempted in these four portals.

## Verification performed

- JavaScript/inline script syntax check passed; all **206** regression tests passed.
- GitHub Actions run `40087105272` passed and pushed project source.
- `deploy.ps1 -All` published each version and completed the HTTP smoke checks.
- Fresh-session testing exposed two simultaneous sign-in overlays. The renderer
  now reuses the mounted form without clearing user input. A regression test
  covers repeated startup/cache-lock requests. Fresh login screens in all four
  pending portals were checked after deployment.
- NBD and LQ display client options from their respective portal data and existing
  hosts. Each saved one explicitly labelled, unlinked synthetic booking, then
  changed it to Cancelled. Creation and cancellation each produced one history
  event; version advanced from 1 to 2 and survived a reload of the latest `/exec`.
- NBD rejected cancellation without a reason and preserved the editable form.
- LQ's first initialization encountered a Google Spreadsheet service timeout.
  The idempotent retry succeeded. This does not establish that the underlying
  workbook timeout problem is permanently resolved.

## Synthetic records retained

| Portal | Visit ID | Label | Final state |
| --- | --- | --- | --- |
| NBD | `7CDBC51C-C3ED-4BC3-B378-5E6DA007E3FA` | DEPLOYMENT TEST — NBD — 2026-10-24 | Cancelled, version 2 |
| LQ | `388E483A-9A4F-401F-97EB-925B1C16F508` | DEPLOYMENT TEST — LQ — 2026-10-24 | Cancelled, version 2 |

These records do not represent customer appointments. No real lead, follow-up,
assignment or customer contact was changed by these tests.

## Remaining work

If testing in the other four portals is resumed with authenticated access,
initialize the module through its page, run the same clearly labelled synthetic
create/cancel/history/reload check, and update this record with actual outcomes.
Preserve existing data.

Sheets/IndexedDB sync activation was not part of this initialization. Its feature
flags were left unchanged. The separate Scot architecture review is in
`SCOT_INDEXEDDB_REVIEW.md`; a full collection mirror is not implemented by this rollout.

## Follow-up loading fixes and Call Totals verification

- Removed the Lead ID column from the Call Totals screen; seven columns remain.
  CSV export still includes the stable Lead ID. Empty-result and footer column
  spans were adjusted.
- Cold cache reads now negotiate batches of up to 2,000 records with a serialized
  size bound. A 9,000-history-record regression fixture completes in six requests,
  including final revision confirmation. Legacy 100-record clients still work.
- Actual Apps Script RPC reordered object keys, causing valid snapshots to fail
  their checksum. The new negotiated canonical content hash ignores key order
  while still detecting changed values and array order. Authorization and
  command-receipt hashing were not changed.
- Background Call Totals refreshes preserve the rendered report while waiting
  and do not supersede a pending foreground load. Failed validation still clears
  the report; filter edits and navigation are protected from late responses.
- Report reads batch Leads, Follow-up History and Stages through the existing
  Sheets API reader and quota-aware fallback. Staff data remains separate.
- Latest suite: **215 tests passed**, plus syntax checks. GitHub Actions run
  `40092559127` passed. All six deployment smoke checks passed.
- Live NBD Follow-ups recovered with **290 open** and **5,000 closed** entries
  visible. The observed cold navigation took 34,694 ms, without the former
  snapshot-integrity error. Large initial loads can still take time.
- Live NBD Call Totals displayed **656 clients**, **4,703 calls** and **169
  WhatsApp chats**. The observed warm report request took **5,117 ms**, compared
  with the prior 35–36-second reads. Background refresh kept the table visible.
  A no-match filter correctly showed zero clients/totals and the seven-column
  empty state.
- Live LQ Call Totals displayed **1,375 clients** and **3,912 calls**, with all
  seven expected columns and no Lead ID column.

These observations establish recovery of the tested pages, not the elimination
of Google service quotas/timeouts or completion of a full-sheet IndexedDB mirror.
