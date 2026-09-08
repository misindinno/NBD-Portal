# FSR client visit history API

Open **Settings → API access** in FSR to generate a read-only API key for the NBD portal. Copy the key when it is created; FSR stores only its hash. You can revoke it on the same page.

## Request

GET /api/v1/clients/{clientId}/visits?limit=20&offset=0
Authorization: Bearer YOUR_API_KEY

Use the original NBD **Lead ID**, exactly as stored, including leading zeros. FSR matches this to sourceRecordId. The API key fixes the source portal (for example, nbd-portal); a caller cannot select another portal. The FSR MongoDB client ID is not the original NBD Lead ID.

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

The example shortens each visit. The endpoint also returns submission and update timestamps, contact details, form company name, location, requirement, lead type, follow-up date, order details, review status, and evidence URLs. Optional fields can be null. Evidence URLs are relative to FSR and still require an authorized FSR login; the history API key does not grant file access.

Visits are ordered by visit date, then submission time, newest first. The default limit is 20; maximum is 50. Use nextOffset for the next page; null means there are no more pages. Offset must be an integer from 0 to 100000. Pages read live data: after changes, refresh from offset 0.

A client with no matching visits returns 200 with an empty visits array. Missing client master data returns null fsrClientId/companyName; any matching saved visits still appear. Invalid pagination/client IDs return 400; missing, invalid, or revoked keys return 401. Errors use {"error":{"code":"...","message":"..."}}. Unexpected server failures return 500. Responses are not cached.

## NBD setup

1. Deploy the updated FSR project to its normal HTTPS domain (Vercel Hobby is supported).
2. Generate a key in **Settings → API access**, selecting **NBD Portal**. Use a separate key scoped to **NBD Lamination Portal** for that deployment.
3. Deploy the updated NBD Apps Script project. In **Project Settings → Script properties**, add:

| Property | Value |
| --- | --- |
| FSR_API_BASE_URL | FSR HTTPS origin, such as https://your-fsr-domain (no /api suffix) |
| FSR_API_KEY | The generated API key |

4. Open an NBD lead and select **FSR Visit History**. Use **Refresh history** for the latest saved changes and **Load more visits** for older visits.

NBD checks the signed-in user's access to the lead before its server calls FSR. Keys stay in Script Properties and are not sent to the browser. Existing and new saved visits are read directly; no cron, webhook relay, database copy, or historical import is required. No database migration is needed for this feature.

If history is empty, verify that the selected key's portal and the exact NBD Lead ID match the sourceKey/sourceRecordId saved on FSR visits. If requests fail, check the deployed domain, key, and Vercel access protection. NBD expects the configured URL to respond directly, without redirects or an interactive deployment login.
