# Callyzer calls and webhook

## Setup

1. Open **System → Webhooks** as a configuration editor.
2. Enable **Receive Callyzer calls**, save, and copy the URL into Callyzer. Leave Secret blank.
3. Add each employee's portal user ID to their Callyzer employee tags. Plain IDs and `id=USER_ID` are supported, case-insensitively.
4. Send a test delivery. Inspect its progress under **Recent deliveries**, then open **Calls**.

The endpoint is the existing Apps Script deployment URL, optionally followed by `?webhook=callyzer`. The bare `/exec` URL also works. No webhook secret, signature, API key or portal login token is required for delivery. Management APIs require a portal session and the appropriate permissions.

## Calls section

**Calls** provides All calls, Matched, Unmatched and Needs Review views. Search by client, number or caller; filter by date range, caller and direction. Results are sorted by call time and paged in groups of 25.

Each row shows the caller, source employee details, customer number, linked client, call date/time, direction, duration, method/mode, remark, CRM result and recording link. Each client's detail dialog also has a **Call Logs** tab scoped to that client.

Times are displayed as supplied by Callyzer, without timezone conversion. Zero-duration calls are retained and keep Callyzer's direction/type. A missing recording shows “Not available”; only HTTPS recording URLs become links.

## Caller identification

Employee `emp_tags` identify the caller; `call_logs[].id` identifies the call. Exactly one matching active portal user yields that user's name. Missing, null, unknown, inactive or conflicting user tags produce **Anonymous user**, without discarding the call. The original employee name and number remain available as source details.

A later valid tag enriches an anonymous record even when the call revision is unchanged. Missing tags on later retries do not erase an already identified caller. Conflicting identified users flag the call for review.

## Client matching and manual mapping

Normalize `client_country_code` and `client_number`, then compare against client Phone and Alternate No. Bare ten-digit portal numbers default to country code 91; save international numbers with their full country code. One active client match links the call. No match retains it as Unmatched. Multiple matches produce Needs Review. Existing links are retained across repeat deliveries.

Administrators and managers with configuration permission can see unmatched calls. Mapping also requires Leads access, a lead-write role, and permission to edit the selected client. Archived or LQ clients already pushed to NBD cannot be changed by mapping.

For an unlinked call, choose **Map to client**, search for a client, select it, and review the current numbers:

- If the incoming number is already saved, keep contact fields unchanged.
- If Phone is empty, fill Phone.
- Otherwise, fill an empty Alternate No.
- If both fields contain different numbers, explicitly choose which one to replace.
- If another client already has the number, explicitly confirm it is shared. Future automatic matches remain ambiguous while the number is shared.

The default option also maps other currently unlinked calls with the same normalized number; uncheck it to map only the selected call. Saving records the mapping actor, time, and contact change in the client's activity log. A stale form is rejected if contact numbers changed after the dialog loaded. Ordinary write failures restore both the contact fields and affected call records. Google Sheets is not a transactional database; an execution terminated outside normal error handling may need review/retry.

## Upserts and storage

`CALL_LOGS` is the authoritative call store. The unique key is Callyzer call ID within the receiving portal, never the phone number. Different calls to the same number remain separate.

- New ID: insert.
- Identical replay: leave unchanged.
- Newer revision: update the same record.
- Equal revision: fill missing optional details such as a recording.
- Older revision: retain newer call details.
- Null optional fields do not erase existing notes or recordings.
- Revision order uses `modified_at`, then `synced_at`, then the call timestamp.
- A changed customer number on an existing call is flagged instead of silently moving the call to another client.
- Manual client mappings survive later webhook updates.

Existing call entries in FOLLOWUP_HISTORY are copied into CALL_LOGS in resumable groups of 200. The source entries remain intact. The follow-up history view merges canonical calls with manual history, hiding only legacy call entries whose IDs were successfully migrated. Legacy records without the original customer number show “Number unavailable” until a later delivery enriches them. No other client, lead stage or manual follow-up is modified by call ingestion.

## Durable processing and retries

Webhook delivery first validates and stores each call in `CALL_WEBHOOK_INBOX`, then acknowledges the accepted delivery. An installable one-minute trigger (`processCallWebhookInbox_`) processes up to 25 calls or about 45 seconds per run. The trigger is installed when enabling the webhook or accepting the first delivery. The Apps Script deploying account must retain its existing script/Sheets permissions.

A queued call is marked Done only after its canonical upsert succeeds. Repeated payloads or a crash between upsert and completion marking are safe to retry by call ID. Processing retries three times before Failed. Configuration editors can use **Retry processing** on the Webhooks page. Pending and failed inbox rows are never removed by retention; older fully completed deliveries are pruned as whole batches once completed inbox rows exceed 500, preserving delivery totals.

Limits: 1,000,000 request characters, 100 employees, 200 calls per request, and 2,000 pending/failed inbox items. Invalid individual calls are reported while valid calls are queued. A full/busy inbox returns a failure receipt with `retry: true`; unaccepted calls must be resent.

The default acknowledgement is HTML to avoid the Google ContentService redirect that previously caused delivery timeouts. Machine clients can opt into JSON with `format=json`, but must follow the redirect. HTTP 200 indicates transport completion; inspect the receipt and delivery processing status for acceptance and completion. “Received” does not mean all calls have already been linked.

## Request / response debugging

**Webhooks → Recent deliveries → Request / response** shows the received Callyzer data (including tags), original acknowledgement and request processing time. The summary separately shows background processing progress: Received, Processing, Completed or Failed, and inserted/updated/duplicate/anonymous/unmatched counts.

Details load only on expansion and require configuration permission. Public acknowledgements exclude lead identities, call contents and raw request data. The last 100 delivery logs are retained; the page lists the latest 30. Payload previews are limited to the first 30,000 characters and clearly marked when truncated. This preview limit does not truncate queued valid calls.

Logging is best-effort and cannot make an accepted delivery fail. Missing older debug payloads and expired delivery logs do not remove canonical calls or pending queue entries.

## Verification

```powershell
node scripts/check-syntax.js
node --test tests/call-webhook.test.js
node --test tests/*.test.js
```

Tests cover caller tags/anonymous fallback, retries and enrichment, 58-call batches, queue failures, client matching, contact mapping and rollback, access scope, migration, pagination, and payload escaping. Browser checks cover the Calls page, contact-mapping dialog and client-scoped tab.
