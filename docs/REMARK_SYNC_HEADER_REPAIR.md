# Remark sync header repair — 2026-10-26

NBD's `LEAD_FIELD_VALUES` had `Value ID` in both A1 and I1. The production
schema validator rejected it before `apiSyncPush` could commit a follow-up.
The former test fixture replaced that validator with an identity function.

Live repair: copied the 23 IDs in I4093:I4115 into the corresponding empty
A cells, then renamed I1 to `Legacy Value ID`. The original I-column values
and all other record cells were retained and verified by readback. The same
business-sheet header audit found no duplicate normalized headers in the
other five portals. No lead, remark or history record was deleted.

Header initialization now trims names and de-duplicates requested columns.
A blank first header no longer causes existing headers to be overwritten.
Sync transactions use validated, normalized headers for lookup while keeping
the original header row for conflict checks and preserving untouched cells.
Actual ambiguous duplicate headers still fail closed and require repair.

Schema failures now pause the durable browser command and offer Retry after
repair. Older commands marked invalid with the configuration-error message
are also retryable. The operation ID, payload, account/scope and conflict
checks are preserved; retry never falls back to a separate legacy write.

Regression coverage includes production header validation, the duplicate-ID
failure and repair, padded headers, initialization with a blank first header,
legacy outbox recovery, and idempotent retry after commit. All 250 tests and
the JavaScript/HTML syntax check passed before the initial deployment.

Live retry then exposed a second pre-commit blocker: `Invalid sync batch size`.
The old planner regenerated every lead/follow-up index by source row order.
On an existing workbook with a different index order or date representations,
one remark could produce thousands of unrelated cell writes.

The planner now updates affected index IDs, adds new IDs, and adjusts row
pointers only when source rows move or are removed. Unrelated index rows and
their extra columns are preserved. The atomic receipt and batch limits remain.
Legacy batch-limit errors are retryable with their original operation IDs.
Regression tests cover 3,001 leads plus 3,001 follow-ups with reversed indexes,
deletion/append row pointers, and recovery of a retained batch-limit request.
