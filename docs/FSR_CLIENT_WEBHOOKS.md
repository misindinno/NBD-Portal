# Sheet changes to FSR

The shared backend covers CS and Dead along with other NBD deployments. Direct edits, multi-row pastes and Google Form submissions enqueue affected lead IDs in FSR_SYNC_QUEUE. Portal saves use the same queue. The one-minute worker sends signed client events, retries transient failures and retains failed jobs for administrator retry. No outbound HTTP occurs inside the edit handler.

## Activation per Apps Script project

Trigger installation can happen before credentials are supplied. Unconfigured sends are skipped; configure the URL and secret to enable delivery. Do not use placeholder secrets. The setup applies to cs-portal, dead-portal, nbd-client1, nbd-lamination, lq-portal and lq-lamination.

1. Set Script Properties FSR_WEBHOOK_URL to the deployed FSR origin followed by /api/webhooks/clients/cs-portal or /api/webhooks/clients/dead-portal.
2. Set FSR_WEBHOOK_SECRET to that source's signing secret from FSR Webhooks. Never put secrets in source code or sheet cells. Set FSR_CLIENT_SHEET to LEAD_MASTER.
3. As a portal administrator, run installFsrClientTriggers from the bound Apps Script editor (or the existing spreadsheet menu). Approve Google's required Apps Script authorization if prompted. This installs edit, form-submit and one-minute delivery triggers. Re-running replaces this user's edit/form triggers without duplicating them.
4. Run getFsrClientWebhookStatus: configured, editTriggerInstalled, createTriggerInstalled and workerInstalled must all be true. Edit an existing test lead and confirm its queue job becomes Done and its FSR record updates.

Triggers run as their installer. Only one administrator should install them per project. Deployment of code alone does not install triggers. The existing clasp remote execution returned NOT_FOUND for CS and Dead during implementation, so activation needs the bound Apps Script editor unless an API-executable deployment is configured.

Google edit triggers do not fire for script/API writes or formula recalculation. Existing portal mutation hooks cover portal saves; external writers must call the queue helper or rely on scheduled sheet reconciliation. Physical row deletion or editing a lead's immutable ID is not a delete webhook. Use the portal status workflow for closure. Keep scheduled imports for reconciliation.

Validation: node tests/fsr-sheet-changes.test.js; node tests/fsr-sync-queue.test.js; node tests/fsr-webhook.contract.test.js.
