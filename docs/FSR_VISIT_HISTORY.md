# Shared FSR visit history API

Generate one key in **FSR → API → API access**. New keys read all portals; no portal selection is needed. Reuse the same key in all NBD, NBD Lamination, LQ and LQ Lamination deployments. Keys remain server-side, are shown once, and are stored as hashes. Revocation takes effect on the next request.

## Request

`GET /api/v1/clients/{clientId}/visits?limit=20&offset=0`

Header: `Authorization: Bearer YOUR_API_KEY`.

Use the original portal Lead ID (preserve leading zeros and URL-encode it), not the MongoDB client ID. With no sourceKey, FSR finds the portal from the client master and saved visits. A unique match returns that client's history. If multiple portals use the ID, FSR returns **409 AMBIGUOUS_CLIENT_ID**; include the sourceKey to disambiguate:

`GET /api/v1/clients/000123/visits?sourceKey=nbd-portal&limit=20&offset=0`

This uses the same API key for every source. Histories from unrelated clients sharing an ID are never combined.

## Response and pagination

The JSON envelope is `{ data: { client, visits, pagination } }`.
- client: id, sourceKey, fsrClientId, companyName. Missing master fields are null; saved visits remain available. sourceKey is null if no portal was supplied or found.
- visits: saved submissions, company and form details, dates, salesperson, Category, remarks, outcome, next action, order details, review state and evidence URLs. The full field reference is in **FSR → API → API Docs**. Order received and order value are strings, not booleans or numeric values.
- pagination: offset, limit, total, nextOffset. Default limit 20, maximum 50; offset 0–100000. Keep sourceKey and limit unchanged on subsequent pages. nextOffset null means the end.

Visits are ordered by visit date, submission time, then database ID descending. No matching client/history returns 200 with an empty list. Multiple submissions of one plan remain separate. Responses are uncached; refresh from offset 0 after updates. Evidence links still require an authorized FSR login.

400 indicates invalid client ID, sourceKey or paging; 401 means a missing/invalid/revoked key; 403 means a legacy key cannot access the requested portal; 409 means the ID needs sourceKey; 500 is an unexpected server failure. Errors use `{ error: { code, message } }`.

## Configure every NBD and LQ deployment

1. Deploy the updated FSR code to its HTTPS origin.
2. Generate one all-portals API key.
3. In every Apps Script project's Script Properties, set FSR_API_BASE_URL to the same FSR HTTPS origin (no /api suffix), and FSR_API_KEY to the same generated key.
4. Deploy shared NBD/LQ code using the existing client-specific deployment workflow. The all-client command is `deploy.ps1 -All`; never copy one client's active ClientConfig into another deployment.
5. Open a lead. FSR Visit History loads automatically; Refresh history reads saved updates and Load more visits retrieves older records.

The client configurations supply the following FSR_SOURCE_KEY automatically; users do not select a portal or configure a separate credential:

| Client folder | FSR_SOURCE_KEY |
| --- | --- |
| nbd-client1 | nbd-portal |
| nbd-lamination | nbd-lamination-portal |
| lq-portal | lq-portal |
| lq-lamination | lq-lamination-portal |

NBD/LQ validates signed-in lead access before calling FSR and verifies the returned client and portal. Keep the shared key in Script Properties, never browser code. This requires no cron, webhook relay, history copy, or database migration.

## Existing keys

Existing portal keys retain their original permissions during rollout. Generate one all-portals key and replace FSR_API_KEY in each deployment before revoking old keys. No stored token is silently widened or disclosed. A legacy request without sourceKey continues to use that key's original portal.
