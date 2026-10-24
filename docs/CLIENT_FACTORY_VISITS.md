# Client & Factory Visits

An independent, authenticated module for **customers visiting our office or
factory**. Route: `clientfactoryvisits`. It has no public form, field-sales visit
workflow, messages, automatic follow-ups, lead-stage changes or FSR integration.
Existing Visits/public intake, FSR and follow-up tables are untouched.

## Access

No role receives new grants by default. Existing ADMIN checks bypass grants.
An administrator can explicitly select these modules in the existing user editor:

- `ClientFactoryVisits`: open the module and read permitted visits.
- `ClientFactoryVisitsCreate`: with the read grant, create bookings and edit own
  non-terminal bookings.
- `ClientFactoryVisitsManage`: with the read grant, edit permitted visits and
  correct terminal outcomes. Does not independently grant creation.

VIEWER remains read-only even with write grants. Non-admins see visits they
created or host. A MANAGER with the manage grant can also see visits hosted by
active users in the portal's department scope. ADMIN sees this portal's visits.
No request grants access to foreign portal records. Hosts are validated against
existing active staff plus portal overrides and department settings. No staff
accounts or sites are seeded. Site is required bounded free text.

Lead selection additionally requires the existing Leads permission (or ADMIN)
and current record scope. It reads active LEAD_MASTER only, using the actual
Apps Script project ID plus the exact Lead ID as the stable link. Names are not
identity keys. Company is saved as a snapshot; links cannot be changed on an
existing visit. Unlinked visitors are allowed, without creating a lead.

## Storage and setup

Dedicated tables: `CLIENT_FACTORY_VISITS` and `CLIENT_FACTORY_VISIT_EVENTS`.
The exact headers live in ClientFactoryVisitService.js. The register holds
visitor/contact/count, office/factory site, host, planned/actual times, purpose,
requirements, outcome/next action/reason, immutable identity and version fields.
Events store actor, request hash, version, time and status transition.

Initialization is explicit through the module's ADMIN-only **Initialize module
tables** action. It creates only these tables and appends missing headers without
rewriting records. Read/booking calls do not initialize existing workflow tables.
Do not run it on production until the module deployment is authorized. No live
initialization or live permission changes were performed during implementation.

Writes require the enabled Google Sheets advanced service. One atomic
`Spreadsheets.batchUpdate` saves both the visit and its audit/idempotency event
under a script lock. User text uses literal `stringValue`, not formula parsing.
A repeated request returns acknowledgement; changed payload/actor reuse fails.
A version mismatch rejects stale edits. A lost response can be retried safely
with the same request; the UI freezes pending fields until confirmed.

## Dates and workflow

Appointments and actual times are local **Asia/Kolkata** datetime values.
Audit timestamps are UTC ISO timestamps. Start/end ordering and real calendar
dates are validated. Actual times cannot be in the future.

- New → Scheduled or Cancelled.
- Scheduled → Completed, Cancelled or No-show.
- Completed requires actual start/end and outcome.
- Cancelled / No-show require a reason; No-show cannot precede the appointment.
- Terminal records cannot reopen. Manage permission allows same-status corrections.

The dashboard/register has planned-date, host, status and search filters; counts
apply to the full permitted filtered result, with 50 rows per page. A history
button shows the last 100 audit events. No export is included in this version.

## Validation

Run `node --test tests/client-factory-visits.test.js` and
`node scripts/check-syntax.js`. The suite is also in deployment preflight.

For browser QA, run `node scripts/cfv-browser-fixture.js`, then open
`http://127.0.0.1:8766`. The server binds to loopback, reads the real UI/service,
and uses in-memory synthetic Sheets/auth fixtures only. No dependencies, secrets
or production connections are required. Stop it when finished.

Browser QA covered linked factory booking, unlinked office booking at 390px,
required outcome errors, successful completion, lost-response retry without
duplication, status filtering/zero results, read-only detail and audit history.
The mobile register scrolls within its table; the page has no horizontal overflow.
Production Apps Script transport and actual Sheets batch execution still require
a separately authorized deployment smoke test.

`Dev checks` runs syntax and tests on pushes to dev. The existing deploy workflow
still triggers only on main/master or manual dispatch; pushing dev does not deploy.
