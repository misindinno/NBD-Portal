# Dashboard Portal — Setup

Read-only analytics portal. Hides every Leads / Followups / Pipeline page; shows only the Dashboard and Today's Activity.

Data sheet: `1twfrZgWZ7AiIWWJR95t5Onhqh5xZZOYZ6YrDrvIgq4w`

## One-time GAS project creation

1. Open the data spreadsheet and choose **Extensions → Apps Script** to create a bound script.
2. Copy the script ID from the URL (`/d/<scriptId>/edit`).
3. Paste it into `clients/dashboard-portal/.clasp.json` → `scriptId`.
4. Optionally fill in `client.json` → `deploymentId` after your first `clasp deploy`.
5. From the project root run `./push.ps1` (or `clasp push` directly inside `src/` using the dashboard `.clasp.json`).

Once `scriptId` is set, the existing `push.ps1` picks this client up automatically along with the others.
