# Client call totals

Open **Client Call Totals** in the sidebar (route `callreport`). Access requires
the existing Reports permission or ADMIN; no default role grants are changed.

The report reads the current portal workbook's `LEAD_MASTER` and
`FOLLOWUP_HISTORY`. It does not write, initialize sheets, rebuild indexes or
merge Callyzer call-log projections. It does not change existing dashboard totals.

## Counting rules

- Match stored Contact Mode exactly: `Call Connected`, `Not Picked`, and
  `WhatsApp Chat`. No inference from follow-up type, outcome or productivity.
- Total calls means connected + not picked. WhatsApp is a separate column.
- Count distinct History IDs, not lead/product rows. Different history IDs are
  separate activities, including multiple calls on the same day.
- Duplicate copies of an ID count once. Conflicting copies of an ID are excluded
  before filters; missing IDs and invalid completion dates are also excluded.
- Use `Done Date`, never Planned Date or Created At. Bounds are inclusive in
  Asia/Kolkata. Date-only and timezone-less Sheet values represent local dates;
  timestamps with an offset are converted to Asia/Kolkata.
- Group by the exact Lead ID as text, preserving leading zeroes. Client fields
  live in LEAD_MASTER. Company names, Client ID and Source Lead ID are not aliases
  for linking historical records. Orphans and ambiguous master IDs are excluded.

## Scope and filters

Filters cover completion date, completed-by user ID, company/ID search, current
category, current lifecycle status and archival state. No date bounds means all
recorded completion dates. Clients with zero matching activity remain visible.
Category/status describe the current lead, not its state at the time of a call.

The report uses current lead assignment and department scope. Being a history
actor does not grant access to another customer's row. Archived records require
Archive permission (ADMIN bypasses it); the default shows active records only.
Archived legacy status uses Pre-Archive Status where available. Unknown links
are never inferred by name. Each portal is reported independently; cross-portal
aggregation and customer consolidation are outside this report.

Pages contain up to 50 clients, with totals for the entire filtered result.
Export rechecks authorization and applies the same server filters, exporting all
filtered clients and a total row, up to 10,000 clients. Narrow filters for larger
exports. CSV text is quoted and formula-leading values are neutralized; import
Lead ID as text in spreadsheet tools to preserve leading zeroes. Exclusion counts
refer to the selected customer scope, including rows whose date cannot be read.

## Local verification

`node --test tests/client-call-report.test.js`

`node scripts/check-syntax.js`

The report suite is included in deployment preflight. Local tests use fixture
data only. No live Sheet or deployment change is needed to run them.
