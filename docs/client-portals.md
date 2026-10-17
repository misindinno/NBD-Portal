# Client portals

All six portals use the shared source under `src/`. Each folder under `clients/`
contains its own workbook ID, Apps Script project ID, portal key and deployment
metadata. The GitHub deployment workflow discovers these folders automatically.

| Folder | Portal | Permission key |
| --- | --- | --- |
| nbd-client1 | NBD | NBD |
| nbd-lamination | NBD Lamination | NBD |
| lq-portal | LQ | LQ |
| lq-lamination | LQ Lamination | LQ |
| cs-portal | CS | CS |
| dead-portal | Dead | DEAD |

CS and Dead use the existing shared Staff List workbook for identity and the
existing portal-key-based access overrides. Configure each portal's users in its
Users screen. As with the other portals, a user without an override inherits the
shared staff permissions; adding a portal does not create new staff accounts.

Deploy just one new portal:

```powershell
.\deploy.ps1 -Client cs-portal
.\deploy.ps1 -Client dead-portal
```

The live URL is `https://script.google.com/macros/s/<deploymentId>/exec`, using
the ID saved in that client's `client.json`. Public visit intake is at
`?page=visit-form`. Only deploy with the intended client's configuration.

Initial setup on 2026-10-17 added the core master/history/index/config tables,
seven default pipeline stages and standard dropdowns to the supplied workbooks.
Existing Sheet1 tabs were preserved. No customer records were copied from any
other portal. Auxiliary call, visit-intake and bulk sheets initialize on demand.
Integration credentials and Script Properties are project-specific and are not
copied from NBD.

Both new projects have version 1 web-app deployments saved in their client.json.
Deployment preflight passed for both clients. HTTP smoke checks on 2026-10-17
returned 403 Access denied for both URLs, so live operation is not yet verified.
The CS deployment API confirms ANYONE_ANONYMOUS access and USER_DEPLOYING
execution. The project owner needs to check authorization and account/domain
access in Apps Script; the cause of Google's access denial is not confirmed.
