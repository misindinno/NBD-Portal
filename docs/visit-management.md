# Public visit intake

Open the deployed Apps Script `/exec?page=visit-form` URL. It serves a separate
public page without portal login or bootstrap. The deployment must execute as
the owner and allow anonymous access (the existing NBD manifest does).

The starter form contains Client, Visit Date and Remarks. Client options come
from non-archived `LEAD_MASTER` records and expose only IDs and company names.
Phone numbers, addresses, staff details and existing visit records are not
returned by the public APIs. Future field requirements can be added to the
form and its server validator together.

The portal's **Visits** tab is available to administrators and users granted
**Visit Management** under Users → Allowed Modules. It supports search,
status filters, pagination, team notes and New / Scheduled / Completed /
Cancelled statuses. The tab provides the public URL and an enable/pause control.
The public form starts enabled; `PUBLIC_VISIT_PAUSED=true` pauses new intake.

Records live in a new `VISIT_SUBMISSIONS` sheet, initialized on first management
load or submission. Historical `VISITS` and FSR visit history remain separate.
Public callers cannot list or update visit records. A selected client is
revalidated at submission; the server chooses the initial status and timestamps.
The request reference prevents duplicate writes when retrying the same form.
Basic abuse controls include bounded fields, a honeypot and a deployment-wide
limit of 30 accepted new requests per minute. This is basic throttling, not a
replacement for CAPTCHA if the form later experiences sustained abuse.

Management saves reject stale `Updated At` values. The new permission is named
`VisitManagement`; historical retired `Visits` grants do not automatically grant
access to these new submissions.

Validation: `node --test tests/public-visits.test.js` and the deployment preflight.
The public HTTP smoke check verifies the form page is served, but does not prove
that a real browser submission has completed.
