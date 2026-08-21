# Portal Diagnostics Runbook

**Audience:** portal operators, developers, and Apps Script administrators  
**Use when:** a portal stays on the loading screen, renders blank, repeatedly signs out, or an action fails without enough context  
**Diagnostics contract:** `tests/debug-architecture.contract.test.js`

## First Response For A Stuck Screen

1. Record the local time, portal name, affected user role, browser, and the last action taken. Do not collect or paste a password, session token, Google ID token, cookie, API key, or spreadsheet ID.
2. Leave the page open for 25 seconds. The startup watchdog should replace the loader with the diagnostics panel.
3. Select **Run Checks**. This records browser and Apps Script bridge checks; the public-safe `apiDiagnosticPing` endpoint is available before login, while authenticated checks run only when a session exists.
4. Select **Copy Debug Report** and save the complete block from `PORTAL_DEBUG_REPORT_START` through `PORTAL_DEBUG_REPORT_END` with the incident notes.
5. Note the most recent RPC `requestId`. It is the primary key for matching the browser failure to an Apps Script execution.
6. Select **Reload** once. If reload returns to the same authentication state, select **Sign In Again** to clear the stored session and reload, then authenticate once.
7. If the panel never appears, open browser developer tools, select the portal's `userCodeAppPanel` frame when present, and run:

   ```js
   JSON.stringify(window.PortalDiagnostics && window.PortalDiagnostics.getReport(), null, 2)
   ```

8. If `PortalDiagnostics` is undefined, treat the incident as an HTML render, stale deployment, or sandbox-frame load failure. Capture the Console and Network failures, then inspect the corresponding `doGet` execution before investigating Sheet data.
9. Paste the complete contents of `scripts/browser-portal-debug.js` into that frame's console. Capture the bounded block from `PORTAL_DEBUG_REPORT_START` through `PORTAL_DEBUG_REPORT_END`; the script copies it automatically when clipboard permission is available.

Do not repeatedly reload. A single controlled retry distinguishes a transient network failure from a deterministic startup failure without flooding Apps Script executions.

## Diagnostic Report Format

`PortalDiagnostics.getReport()` returns a structured object; `PortalDiagnostics.formatReport()` creates the bounded shareable text. The copy action wraps its JSON representation in markers so chat, email, and ticket systems do not trim the boundaries:

```text
PORTAL_DEBUG_REPORT_START
{
  "schemaVersion": 1,
  "generatedAt": "ISO-8601 timestamp",
  "uptimeMs": 25000,
  "recoveryReason": "bounded startup failure summary",
  "environment": {
    "url": "origin and path without query or fragment",
    "title": "portal title",
    "readyState": "complete",
    "portalReady": false,
    "online": true,
    "visibility": "visible",
    "language": "browser language",
    "userAgent": "bounded browser description",
    "viewport": { "width": 1280, "height": 720, "devicePixelRatio": 1 },
    "authTokenPresent": true
  },
  "globals": {
    "googleScriptRun": true,
    "api": true,
    "store": true,
    "init": true
  },
  "activeRpcCount": 0,
  "events": [
    {
      "id": 1,
      "at": "ISO-8601 timestamp",
      "elapsedMs": 25,
      "level": "error",
      "type": "window.error",
      "details": {}
    }
  ],
  "rpcs": []
}
PORTAL_DEBUG_REPORT_END
```

Every event uses `id`, `at`, `elapsedMs`, `level`, `type`, and bounded sanitized `details`. Every RPC record should contain the operation, client-observed duration, outcome, and the server `meta.requestId`, `meta.operation`, and `meta.durationMs` when a response envelope was received.

## Redaction And Size Guarantees

The diagnostic report is designed to be shareable with engineering, but it is not a substitute for access control.

- `formatReport()` bounds the JSON body to the declared `reportLength` of 60,000 characters, plus fixed start/end markers.
- Client history retains at most the declared limits of 120 events and 80 RPC records. Oldest records are discarded first.
- Server diagnostic history retains at most 40 spans. It is execution-local or cache-bounded, not a durable audit log.
- Individual strings, stacks, URLs, collections, and object depth are truncated before serialization.
- URL query strings and fragments are removed. Resource failures retain only the bounded, sanitized location needed to identify the failed dependency.
- Keys matching token, password, authorization, cookie, secret, API key, or spreadsheet ID patterns are replaced with `[REDACTED]` recursively.
- Browser diagnostics may read session/local storage only to emit a boolean token-presence signal. Token values, cookies, passwords, and spreadsheet configuration identifiers are never exported.
- SheetDB spans contain the operation name and attributes limited to the normalized sheet label plus `read`/`write` mode. Span status and duration are recorded by the wrapper. They never contain row counts, IDs, cell values, row objects, filters, or mutation payloads.
- Server exceptions are sanitized before structured logging. The browser receives the stable error category and request metadata, not raw credentials or sensitive response bodies.

Before forwarding a report outside the engineering team, inspect it for business data entered into free-text error messages. Redaction protects known secret classes; it cannot infer every confidential phrase.

## Request ID Correlation

The browser starts a local RPC timing record before `google.script.run`. The server creates its own UUID in `withRequestContext_` and returns it in every guarded response:

```text
meta.requestId   server correlation ID
meta.operation   guarded API function name
meta.durationMs  server execution time observed inside the request guard
```

The client records the same server request ID on both successful and application-error responses. Transport failures that never reach Apps Script have no server request ID; correlate those by timestamp, operation, portal, and browser network evidence.

Use this order when tracing an incident:

1. Find the failed or slow operation in `report.rpcs`.
2. Copy its server `requestId`, operation, client duration, server duration, and timestamp.
3. Search Apps Script Executions for the same time and function.
4. Search execution logs or Cloud Logging for the exact request ID.
5. Follow nested diagnostic spans, especially `sheetdb.read_all`, `sheetdb.write_insert`, `sheetdb.write_update`, `sheetdb.write_delete`, and `sheetdb.write_delete_many`.

A large client duration with a small server duration points to browser scheduling, iframe messaging, or network delay. Similar client and server durations point to server work. A missing request ID points to a pre-execution transport or frame problem.

## Apps Script Executions

1. Open the Apps Script project for the affected portal.
2. Open **Executions**.
3. Set the time window around the report timestamp and filter by the reported API operation when possible.
4. Open the matching execution and compare status, duration, deployment, function, and user context.
5. Expand logs and search for the full request ID. Structured entries should include severity, operation, request context, sanitized details, and bounded spans.
6. If there is no matching API execution, inspect `doGet` executions and browser Network failures. The request likely failed before the RPC reached server code.
7. If an execution timed out, inspect the last completed span. A SheetDB span identifies the storage operation without exposing row content.

Apps Script Executions can show successful completion even when the API returned a handled application error. Always inspect the response code/category and structured logs, not only the execution status icon.

## Cloud Logging

Cloud Logging is available when the Apps Script project is linked to a standard Google Cloud project and the operator has log-viewing permission.

1. Open the linked Google Cloud project.
2. Open **Logging**, then **Logs Explorer**.
3. Select the incident time range and search for the request ID with:

   ```text
   SEARCH("<request-id>")
   ```

4. Narrow the result by severity or Apps Script resource labels if the project contains unrelated services.
5. Expand the matching entry. Confirm `context.requestId`, operation, duration, error category, and span outcome.
6. Search the operation name and report timestamp if no request ID exists because of a transport failure.

Do not add tokens, passwords, cookies, spreadsheet IDs, or copied row data to a Logs Explorer query. Queries can be retained in browser and project history.

## Health Check Interpretation

### Public-Safe Ping

`apiDiagnosticPing` is lightweight, guarded by `apiGuard_`, and intentionally unauthenticated so it works before login. It proves that the browser can reach `google.script.run`, the deployed server contains the endpoint, and the request guard executes; it does not prove authentication. It must not read every worklist or write to a Sheet.

| Result | Meaning | Next action |
|---|---|---|
| `ok` | RPC transport, deployed endpoint, and request guard are working; session state is not tested | Correlate the failing feature RPC; use the admin snapshot only when authenticated storage/configuration evidence is needed |
| Endpoint missing/null response | Browser and deployment source are out of sync, or deployment is stale | Run preflight, push the intended source, redeploy the existing deployment, and smoke test |
| Transport failure/no request ID | RPC did not reach the guarded server path | Inspect iframe, browser network, extensions, proxy, and CSP failures |
| Slow ping | Apps Script cold start, quota pressure, or platform latency | Compare client/server duration and inspect Executions before testing Sheets |

### Administrator Snapshot

`apiGetDiagnosticSnapshot(token)` requires a valid session and is ADMIN-only. It reports configuration presence booleans; authenticated/admin context; required Sheet availability, dimensions, and header validity; credential presence booleans; runtime and timezone; recent error fingerprints; and bounded request spans. It does not return identifier values, row values, credentials, tokens, passwords, or user lists.

| Snapshot state | Meaning |
|---|---|
| `ok` | Required runtime/configuration probes passed at capture time |
| `degraded` | At least one actual snapshot check failed or reported unhealthy configuration, auth context, Sheet/header state, credential presence, runtime, or recent-error evidence |
| `failed` | The guarded snapshot request itself failed before a usable check set was returned |

The snapshot is point-in-time evidence. It does not prove that earlier executions were healthy and it must not perform repair writes.

## Common Failure Patterns

| Evidence | Likely layer | Investigation |
|---|---|---|
| `PortalDiagnostics` undefined | HTML/deployment | Verify `Diagnostics` is included before dependencies; inspect `doGet` and deployment source |
| Resource error before startup stage advances | Browser dependency | Identify the sanitized resource host/path; test network policy and extension interference |
| Ping succeeds, bootstrap fails | Configuration/data | Correlate bootstrap request ID; inspect schema and SheetDB spans |
| Server duration near execution limit | Backend/storage | Find the longest bounded span and reduce scan/work per request |
| Client duration much larger than server duration | Browser/iframe/network | Inspect main thread, iframe messaging, network, and browser policy |
| Old deployment lacks diagnostics endpoint | Release mismatch | Run preflight and update the existing deployment; do not create an untracked production URL |

## Deployment And Smoke Checklist

Before deployment:

1. Run the diagnostics contract:

   ```powershell
   node tests\debug-architecture.contract.test.js
   ```

2. Run all JavaScript and inline HTML syntax checks:

   ```powershell
   node scripts\check-syntax.js
   ```

3. Run client-specific preflight:

   ```powershell
   .\scripts\deployment-preflight.ps1 -Root . -ClientNames @('<client-name>')
   ```

4. Confirm no report fixture, log statement, or source file contains a real credential or spreadsheet ID.
5. Confirm the diagnostics contract passes. A red contract means the diagnostics architecture is not deployable.

After updating the intended existing deployment:

1. Run the repository smoke script using deployment metadata already held by the client configuration:

   ```powershell
   .\scripts\post-deployment-smoke.ps1 -DeploymentId '<deployment-id>' -ClientName '<client-name>'
   ```

2. Open the portal in a clean browser session and verify the shell renders.
3. Run the public-safe ping and confirm `ok`, a request ID, operation, and bounded durations; then run the administrator snapshot separately while signed in as ADMIN.
4. As an administrator, run the snapshot and confirm that it contains health metadata but no sensitive IDs or row data.
5. Trigger one controlled client-side test error in a non-production environment and verify global error capture, safe panel rendering, report copy, and request correlation.
6. Verify reload and clear-session recovery actions.
7. Check Apps Script Executions for sanitized structured logs and bounded SheetDB spans.

Rollback the deployment when the shell does not render, diagnostics is absent, ping cannot reach the guarded endpoint, reports leak sensitive values, or the smoke script fails. Preserve the report and request IDs before rollback so the failed release remains diagnosable.
