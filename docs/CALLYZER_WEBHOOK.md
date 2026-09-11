# Callyzer call webhook

Open **System → Webhooks** with a user who can edit configuration. Enable **Receive Callyzer calls**, save, and copy the URL into Callyzer. Leave Callyzer's **Secret** field blank. The receiving endpoint does not use a secret, signature, API key, or portal login token.

Each deployment has its own endpoint and enable/pause setting:

```text
https://script.google.com/macros/s/DEPLOYMENT_ID/exec?webhook=callyzer
```

The bare deployment URL ending in `/exec` also accepts Callyzer calls; `?webhook=callyzer` is optional. Unknown named webhook routes are rejected.

The webhook starts paused. Saving its setting initializes its sheets automatically; existing data is preserved. Pausing stops further ingestion and keeps previously received remarks. Changing the URL in Callyzer is unnecessary when the same Apps Script deployment is updated.

## Employee user tags

Put the portal user's ID in the Callyzer employee's **Tags** field. The Webhooks page lists active users and their IDs for copying. Either of these formats works, case-insensitively:

```text
C6F91250-022A-4162-9196-44866796D14C
id=C6F91250-022A-4162-9196-44866796D14C
```

Exactly one distinct active portal user must match the employee's `emp_tags`. Other labels are ignored. Missing, unknown, inactive, or conflicting user tags are reported as `invalidUser`. The saved history uses the portal user ID as **Done By**, rather than the employee name supplied in the request.

## Payload and matching

POST the JSON array from the supplied Callyzer documentation. Example:

```json
[
  {
    "emp_name": "Example User",
    "emp_tags": ["C6F91250-022A-4162-9196-44866796D14C"],
    "call_logs": [
      {
        "id": "example-call-001",
        "client_country_code": "91",
        "client_number": "9876543210",
        "call_date": "2026-09-10",
        "call_time": "14:30:00",
        "duration": "87",
        "call_type": "Outgoing",
        "note": "Customer requested a quotation.",
        "crm_status": "Interested",
        "call_method": "PhoneCall",
        "call_mode": "Voice",
        "call_recording_url": "https://media1.callyzer.co/example.mp3",
        "modified_at": "2026-09-10 14:32:00"
      }
    ]
  }
]
```

- Match `client_number` against **Phone** or **Alternate No** in the receiving portal. Spaces, brackets, dashes, `+`, `00` prefixes and Indian local trunk prefixes are normalized. Bare ten-digit portal numbers default to country code 91; store other countries' numbers with their full country code.
- Attach only to one non-archived matching lead. No match is `unmatched`; multiple matches are `ambiguous`. Calls are not used to create new leads.
- Store the call note, CRM result, type, method and mode in a **Follow-up History → Remark** entry. Display the call date/time, duration and HTTPS recording link alongside it. A recording URL is optional; invalid URLs are omitted.
- Call times are displayed as supplied by Callyzer, without timezone conversion. Configure Callyzer consistently with the portal timezone shown on the Webhooks page.
- Call IDs deduplicate across deliveries. A newer `modified_at` updates the same row; otherwise `synced_at`, then the call timestamp is used for ordering. Equal or older revisions are duplicates. Updates cannot reassign an existing call to another lead or user.
- The webhook records history only. It does not close an open follow-up, change the lead stage, schedule reminders, or overwrite existing manual remarks.

## Delivery results and limits

Delivery receipts contain `success`, counts (`added`, `updated`, `duplicate`, `unmatched`, `ambiguous`, `invalidUser`, `invalid`), and, for request failures, a `code`. Public receipts exclude lead IDs, user IDs, notes, phone numbers and recording links. Valid batches acknowledge independently skipped calls in their counts; correct their source data and resend them.

The Webhooks page shows the latest 30 deliveries and up to 20 problematic call IDs per delivery. The dedicated `CALL_WEBHOOK_DELIVERIES` sheet retains the latest 100 deliveries. Call records remain in `FOLLOWUP_HISTORY` so retry deduplication survives delivery-log retention.

Limits: 1,000,000 payload characters, 100 employees and 200 calls per request. Invalid JSON/structure returns `INVALID_PAYLOAD`; empty or oversized call batches return `BATCH_LIMIT`. Individual invalid calls are skipped while valid ones are processed. `BUSY` and `PROCESSING_FAILED` set `retry: true`; retries safely resume partially written batches.

By default, the endpoint returns a direct HTML acknowledgement containing the receipt, avoiding the Google ContentService redirect that can time out in webhook clients. Check Recent deliveries to confirm that calls were attached; HTTP 200 alone is not proof of a match. Machine clients that explicitly require JSON can append `&format=json` (or `?format=json` on the bare URL), but must follow ContentService redirects and inspect `success` in the JSON. Apps Script does not support custom response status codes here. Source-side Callyzer delivery and recording accessibility must be verified using a real call after setup.

## Validation

```powershell
node scripts/check-syntax.js
node --test tests/call-webhook.test.js
node --test tests/*.test.js
```

The deployment preflight includes the webhook regression tests. Tests cover unsigned routing, configuration permissions, both tag formats, phone matching, repeated/newer events, partial-failure retries, malformed inputs, recording URL validation, formula neutralization and safe HTML rendering.

## Request and response debugging

For new deliveries, open **Webhooks → Recent deliveries → Request / response**. This shows the received Callyzer JSON (including `emp_tags`), NBD response receipt, and processing time. Details are fetched only when expanded and require configuration access. Raw request data is never included in the public webhook acknowledgement.

The latest 100 delivery logs are retained. Each payload is limited to its first 30,000 characters, with the original character count and an explicit truncation notice; this limit does not change call processing. Existing older logs have no saved payload. Paused, malformed, and processing-failed requests are also logged when storage is available. Logging is best-effort: a busy lock or storage failure may prevent a debug entry, but cannot change an otherwise successful call receipt.
