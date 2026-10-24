# Client & Factory Visits rollout — 2026-10-24

Runtime source: `43d1ae72e7bc9fc903f53581d56c64ed9803c67c`.
All six existing web-app deployment IDs were updated; workbook IDs were retained.

| Portal | Version | HTTP/application smoke | Visit initialization and live check |
| --- | --- | --- | --- |
| NBD | 160 | Passed | Initialized; create, validation, cancel, history and reload passed |
| NBD Lamination | 31 | Passed | Awaiting Administrator login |
| LQ | 94 | Passed | Initialized; create, cancel, history and reload passed |
| LQ Lamination | 34 | Passed | Awaiting Administrator login |
| CS | 7 | Passed | Awaiting Administrator login |
| Dead | 8 | Passed | Awaiting Administrator login |

The four pending portals display one usable sign-in form on the latest version.
No claim is made that their visit tables or save operations have been verified.
They are open in Chrome's **🧪 Visit rollout** group for login and continuation.

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

After Administrator login in each pending portal, initialize the module through
its page, run the same clearly labelled synthetic create/cancel/history/reload
check, and update this record with the actual outcomes. Preserve existing data.

Sheets/IndexedDB sync activation was not part of this initialization. Its feature
flags were left unchanged. The separate Scot architecture review is in
`SCOT_INDEXEDDB_REVIEW.md`; a full collection mirror is not implemented by this rollout.
