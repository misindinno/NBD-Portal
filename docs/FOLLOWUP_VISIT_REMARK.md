# Follow-up dialog visit remarks

The Follow Up Done dialog has **Follow Up Remark** and **Visit Remark** tabs.
The original completion form and completion API are unchanged. Switching tabs
preserves drafts and never saves. Visit Remark has three required fields: date,
remark (up to 1,000 characters), and visit type (Office or Factory).

Visit Remark creates a **New**, date-only inbound request in
`CLIENT_FACTORY_VISITS`, with an audit entry in `CLIENT_FACTORY_VISIT_EVENTS`.
It reuses the atomic visit writer, request-ID replay protection, portal-qualified
lead link and existing permissions. The audit event identifies the originating
follow-up. The lead and follow-up are not modified or completed.

The date is stored literally as `YYYY-MM-DD` in Planned Start; no appointment
time, host, site, visitor count or contact details are invented. The register
already filters and totals by the date part. Opening this request shows a notice
to fill the normal booking details and choose a real appointment time before
scheduling. The existing full-booking validation and status transitions remain.

The options and save endpoints require Followups, ClientFactoryVisits and
ClientFactoryVisitsCreate (or the established administrator bypass). VIEWER is
denied. The linked lead must also be available under the existing visit lead
lookup, including Leads permission and assignment/department/archive scope.
Standalone follow-ups cannot save a visit. No permissions are automatically
granted. Existing visit tables must already be initialized; these endpoints do
not initialize tables or change headers.

This action uses an online RPC, not the offline follow-up outbox. Repeated clicks
are blocked while saving. If a save response is uncertain, the payload and
request ID remain frozen; Retry same request safely recovers its outcome. Cancel
closes the dialog but cannot undo an already submitted request. After closing an
uncertain save, check the visit register before starting a new request.

## Local validation

- `node scripts/check-syntax.js`
- `node --test tests/*.test.js`
- `node scripts/followup-visit-browser-fixture.js` serves a synthetic loopback-only
  fixture at `http://127.0.0.1:8772` (`/mobile` embeds a 390px viewport).

Automated coverage includes permissions/revocation, invalid dates/type/remarks,
standalone/archive/duplicate lead IDs, atomic and replay-safe saves, upgrading
to a full booking, tab switching, repeated clicks, cancel/logout races and
validation failures. Browser checks use actual dialog/validator code and the
in-memory visit service fixture; follow-up completion transport is a synthetic
counter. No production record is submitted by these tests.
