# FSR client visit history API

Open **API → API access** in FSR to generate a read-only API key for the corresponding NBD or LQ portal. Copy the key when it is created; FSR stores only its hash. You can revoke it on the same page.

## Request

GET /api/v1/clients/{clientId}/visits?limit=20&offset=0
Authorization: Bearer YOUR_API_KEY

Use the original source portal **Lead ID**, exactly as stored, including leading zeros. FSR matches this to sourceRecordId. The API key fixes the source portal (for example, nbd-portal); a caller cannot select another portal. The FSR MongoDB client ID is not the original source portal Lead ID.

Example (replace the domain and key):

~~~sh
curl 'https://your-fsr-domain/api/v1/clients/NBD-00123/visits?limit=20&offset=0' -H 'Authorization: Bearer YOUR_API_KEY'
~~~

## Response

~~~json
{
  "data": {
    "client": { "id": "NBD-00123", "sourceKey": "nbd-portal", "fsrClientId": "database-client-id", "companyName": "Example Company" },
    "visits": [
      {
        "id": "database-visit-id",
        "submissionId": "VISIT-001",
        "planId": "PLAN-001",
        "sourceKey": "nbd-portal",
        "sourceRecordId": "NBD-00123",
        "companyName": "Example Company",
        "visitDate": "2026-09-08T00:00:00.000Z",
        "salespersonName": "Example salesperson",
        "remarks": "Discussed requirements",
        "visitOutcome": "Follow-up required",
        "nextAction": "Send quotation"
      }
    ],
    "pagination": { "offset": 0, "limit": 20, "total": 1, "nextOffset": null }
  }
}
~~~

The example shortens each visit. The endpoint also returns submission and update timestamps, contact details, form company name, location, requirement, lead type, follow-up date, order details, review status, and evidence URLs. This includes the GOLD, SILVER, or BRONCH Category, order received, company on form, city, and state. Optional fields can be null. Evidence URLs are relative to FSR and still require an authorized FSR login; the history API key does not grant file access.

Visits are ordered by visit date, then submission time, newest first. The default limit is 20; maximum is 50. Use nextOffset for the next page; null means there are no more pages. Offset must be an integer from 0 to 100000. Pages read live data: after changes, refresh from offset 0.

A client with no matching visits returns 200 with an empty visits array. Missing client master data returns null fsrClientId/companyName; any matching saved visits still appear. Invalid pagination/client IDs return 400; missing, invalid, or revoked keys return 401. Errors use {"error":{"code":"...","message":"..."}}. Unexpected server failures return 500. Responses are not cached.

## Setup for all NBD and LQ portals

1. Deploy the updated FSR project to its normal HTTPS domain (Vercel Hobby is supported).
2. Generate one key per deployment in **API → API access**, choosing the matching source portal from the mapping below.
3. Deploy the shared Apps Script code using the corresponding client configuration. In **Project Settings → Script properties**, add:

| Property | Value |
| --- | --- |
| FSR_API_BASE_URL | FSR HTTPS origin, such as https://your-fsr-domain (no /api suffix) |
| FSR_API_KEY | The generated API key |

4. Open a lead in NBD, NBD Lamination, LQ, or LQ Lamination; its FSR history loads in the background and the tab shows the total count. Select **FSR Visit History** to view it. Use **Refresh history** for the latest saved changes and **Load more visits** for older visits.

Each portal checks the signed-in user's access to the lead before its server calls FSR. Keys stay in Script Properties and are not sent to the browser. Existing and new saved visits are read directly; no cron, webhook relay, database copy, or historical import is required. No database migration is needed for this feature.

If history is empty, verify that the selected key's portal and the exact source Lead ID match the sourceKey/sourceRecordId saved on FSR visits. If requests fail, check the deployed domain, key, and Vercel access protection. The portal expects the configured URL to respond directly, without redirects or an interactive deployment login.

A refresh replaces the displayed page only after a successful response. On failure, previously loaded history remains visible with a retry message. Closing a lead prevents late responses from updating its removed dialog.

Configure the properties separately in each Apps Script deployment (nbd-client1, nbd-lamination, lq-portal, and lq-lamination), using an API key for that deployment’s matching FSR source portal. The checked-in src/server/ClientConfig.js can belong to an LQ target; use the project’s client-specific deployment workflow instead of pushing that configuration directly to another client.

### Deployment mapping
| Client folder | FSR API key scope |
| --- | --- |
| nbd-client1 | NBD Portal |
| nbd-lamination | NBD Lamination Portal |
| lq-portal | LQ Portal |
| lq-lamination | LQ Lamination Portal |

Generate a separate key for each matching source under FSR → API → API access. Use the same deployed FSR HTTPS origin in FSR_API_BASE_URL, and each portal’s own key in FSR_API_KEY. Lead IDs are looked up within that key’s source, even if another portal uses the same ID. To publish the shared code to all configured clients, run the existing deploy.ps1 -All workflow after configuring the properties.
