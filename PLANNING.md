# SCOT Leads Portal — Project Planning Document

## 1. Project Overview

**Name:** SCOT Leads Portal
**Stack:** Google Sheets (DB) + Apps Script (Backend) + HTML Service (Frontend)
**UI Framework:** Material Design (MUI via CDN) + supporting libraries
**Dev Tools:** clasp + VS Code + GitHub

---

## 2. Existing User Data Mapping

Your current USERS sheet has these columns:

| Existing Column | Maps To (Portal Field) | Notes |
|---|---|---|
| Job Title | Role / Department Title | e.g. "Sales Head", "CRR", "EA" |
| Department | Department | Sales / Admin / Production |
| Email Address | User Email (login key) | Primary identifier |
| Company Phone | Phone | Contact number |
| Name | User Name | Short name |
| Title | Display Title | Full display label e.g. "Sanya - NBD - 1" |
| ID | User ID | UUID already present ✅ |
| Permission | Role | Currently all "USER" — needs Admin/Manager roles added |
| Password | Password | Plain text — consider hashing or removing for Google Auth |

### Recommended Role Mapping

| Job Title | Suggested Portal Role |
|---|---|
| Sales Head | Manager |
| NBD - 1, NBD - 2 | Sales |
| CRR | Sales |
| EA | Admin |
| IC - 1, PP - 2 | User (Production/Viewer) |

### Recommended USERS Sheet Final Structure

| Column | Description |
|---|---|
| User ID | UUID (already exists) |
| Name | Short name |
| Title | Display title |
| Email Address | Login email |
| Company Phone | Phone |
| Job Title | Job title |
| Department | Department |
| Role | Admin / Manager / Sales / User / Viewer |
| Allowed Modules | Comma-separated: Leads,Clients,Followups,Dashboard |
| Can Edit Config | TRUE / FALSE |
| Is Active | TRUE / FALSE |
| Password | (optional — use Google Auth instead) |

---

## 3. Sheet Database Structure

### A. CLIENT_MASTER
| Column | Type | Notes |
|---|---|---|
| Client ID | Text | UUID auto-generated |
| Company Name | Text | Required |
| Contact Person | Text | |
| Phone | Text | |
| Alternate No | Text | |
| Email | Text | |
| City | Text | |
| State | Text | Dropdown from CONFIG |
| Address | Text | |
| GST No | Text | |
| Category | Text | Dropdown from CONFIG |
| Assigned To | Text | User ID from USERS |
| Status | Text | Active/Inactive/Disqualified |
| Created At | DateTime | Auto |
| Updated At | DateTime | Auto |

### B. LEADS
| Column | Type | Notes |
|---|---|---|
| Lead ID | Text | UUID auto-generated |
| Client ID | Text | Linked to CLIENT_MASTER |
| Lead Name | Text | Opportunity title |
| Source | Text | Dropdown from CONFIG |
| Product Interest | Text | Dropdown from CONFIG |
| Lead Value | Number | Expected value |
| Stage ID | Text | Linked to PIPELINE_STAGES |
| Priority | Text | Hot/Warm/Cold |
| Assigned To | Text | User ID from USERS |
| Expected Closing Date | Date | |
| Last Follow-up Date | Date | Auto-updated |
| Next Follow-up Date | Date | |
| Lead Status | Text | Open/Won/Lost/Hold |
| Created At | DateTime | Auto |
| Updated At | DateTime | Auto |

### C. FOLLOWUPS
| Column | Type | Notes |
|---|---|---|
| Follow-up ID | Text | UUID auto-generated |
| Lead ID | Text | Linked to LEADS |
| Client ID | Text | Linked to CLIENT_MASTER |
| Follow-up Date | Date | |
| Follow-up Type | Text | Call/WhatsApp/Visit/Email/Payment |
| Discussion | Text | Remarks |
| Outcome | Text | Interested/Not Interested/Call Again/Order Received |
| Next Follow-up Date | Date | |
| Next Action | Text | |
| Updated Stage ID | Text | New stage after follow-up |
| Created By | Text | User ID |
| Created At | DateTime | Auto |

### D. PIPELINE_STAGES
| Column | Type | Notes |
|---|---|---|
| Stage ID | Text | UUID |
| Stage Name | Text | |
| Stage Order | Number | Sort order |
| Color | Text | Hex color for UI |
| Is Active | Boolean | TRUE/FALSE |
| Is Final Stage | Boolean | TRUE/FALSE |
| Created At | DateTime | Auto |

Default stages:
1. New Lead (#2196F3)
2. First Call Done (#FF9800)
3. Requirement Collected (#9C27B0)
4. Quotation Sent (#00BCD4)
5. Negotiation (#FF5722)
6. Won (#4CAF50) — Final
7. Lost (#F44336) — Final

### E. FIELD_CONFIG
| Column | Type | Notes |
|---|---|---|
| Field ID | Text | UUID |
| Sheet Name | Text | Leads/Client/Followups |
| Field Name | Text | Display label |
| Column Key | Text | Internal key |
| Field Type | Text | Text/Number/Date/Dropdown/Formula |
| Dropdown Source | Text | CONFIG type or range |
| Formula Logic | Text | Template formula string |
| Is Required | Boolean | |
| Is Visible | Boolean | |
| Display Order | Number | |

### F. CONFIG
| Column | Type | Notes |
|---|---|---|
| Config ID | Text | UUID |
| Config Type | Text | Lead Source / Priority / Follow-up Type / Category / State |
| Value | Text | |
| Status | Text | Active/Inactive |

Default values:
- Lead Source: WhatsApp, Referral, Website, Exhibition, Cold Call, Existing Dealer
- Priority: Hot, Warm, Cold
- Follow-up Type: Call, WhatsApp, Visit, Email, Payment
- Category: Dealer, Distributor, Direct, OEM
- Lead Status: Open, Won, Lost, Hold

---

## 4. Apps Script File Structure

```
leads-portal/
├── appsscript.json
└── src/
    ├── server/
    │   ├── Code.gs          — doGet, routing, app entry
    │   ├── Api.gs           — All google.script.run endpoints
    │   ├── SheetDB.gs       — Generic sheet CRUD helpers
    │   ├── AuthService.gs   — Login, role check, session
    │   ├── LeadService.gs   — Lead CRUD, stage update
    │   ├── ClientService.gs — Client CRUD
    │   ├── FollowupService.gs — Follow-up CRUD, history
    │   ├── ConfigService.gs — Stages, dropdowns, field config
    │   ├── FormulaService.gs — Calculated fields engine
    │   └── Utils.gs         — UUID, date helpers, validators
    └── client/
        ├── Index.html       — Shell/layout + router
        ├── Dashboard.html   — Dashboard page partial
        ├── Leads.html       — Lead list + pipeline page
        ├── Clients.html     — Client master page
        ├── Followups.html   — Follow-up entry page
        ├── Config.html      — Admin config page
        ├── CSS.html         — Global styles
        └── JS.html          — Global JS + router logic
```

---

## 5. Frontend Libraries (CDN)

| Library | Version | Purpose |
|---|---|---|
| Material Web Components (MWC) | Latest | Primary UI — buttons, dialogs, cards, inputs |
| Material Icons | Latest | Icon set |
| Tabulator.js | 6.x | Data grids — leads list, clients, follow-ups |
| SortableJS | 1.x | Kanban drag-drop pipeline |
| Chart.js | 4.x | Dashboard charts |
| Flatpickr | 4.x | Date/time pickers |
| Choices.js | 10.x | Searchable dropdowns |
| SweetAlert2 | 11.x | Confirm dialogs, alerts |
| Toastify.js | 1.x | Toast notifications |

All loaded via CDN — no build step needed.

---

## 6. Role-Based Access Matrix

| Module | Admin | Manager | Sales | User | Viewer |
|---|---|---|---|---|---|
| Dashboard | ✅ Full | ✅ Full | ✅ Own | ✅ Own | ✅ Read |
| Clients | ✅ Full | ✅ Full | ✅ Own | ❌ | ✅ Read |
| Leads | ✅ Full | ✅ Full | ✅ Own | ❌ | ✅ Read |
| Pipeline | ✅ Full | ✅ Full | ✅ Own | ❌ | ✅ Read |
| Follow-ups | ✅ Full | ✅ Full | ✅ Own | ✅ Own | ✅ Read |
| Reports | ✅ Full | ✅ Full | ✅ Own | ❌ | ✅ Read |
| Config | ✅ Full | ❌ | ❌ | ❌ | ❌ |
| Users | ✅ Full | ❌ | ❌ | ❌ | ❌ |

---

## 7. Calculated Fields Engine

Formula syntax (safe, no eval):

```
{{Lead Value}} * 0.1
DATEDIFF(TODAY(), {{Next Follow-up Date}})
IF({{Priority}} == "Hot", 10, IF({{Priority}} == "Warm", 5, 1))
```

Supported functions in FormulaService.gs:
- `DATEDIFF(date1, date2)` — days between dates
- `TODAY()` — current date
- `IF(condition, trueVal, falseVal)` — conditional
- `SUM(field1, field2)` — sum fields
- `CONCAT(field1, field2)` — string concat

---

## 8. Pipeline Stage Update Flow

```
User drags card to new stage
        ↓
google.script.run → Api.updateLeadStage(leadId, newStageId)
        ↓
LeadService: update LEADS.Stage ID + Updated At
        ↓
FollowupService: auto-log stage change in FOLLOWUPS
        ↓
Return updated lead data
        ↓
Frontend refreshes Kanban column counts
```

---

## 9. Dashboard Cards

| Card | Data Source |
|---|---|
| Total Open Leads | LEADS where Status = Open |
| Today's Follow-ups | FOLLOWUPS where Next Follow-up Date = Today |
| Overdue Follow-ups | FOLLOWUPS where Next Follow-up Date < Today |
| Won This Month | LEADS where Stage = Won, this month |
| Lost This Month | LEADS where Stage = Lost, this month |
| Conversion % | Won / (Won + Lost) * 100 |
| Stage-wise Pipeline | Count by Stage ID (bar chart) |
| Lead Value by Stage | Sum Lead Value by Stage (bar chart) |
| User-wise Pending | Count by Assigned To (table) |

---

## 10. Implementation Phases

| Phase | Work | Priority |
|---|---|---|
| Phase 1 | Sheet setup, seed data, UUID system | 🔴 Critical |
| Phase 2 | SheetDB.gs + Utils.gs + AuthService.gs | 🔴 Critical |
| Phase 3 | App shell (Index.html), login/user check, routing | 🔴 Critical |
| Phase 4 | Client Master — list, add, edit | 🟠 High |
| Phase 5 | Leads — list, add, edit, filters | 🟠 High |
| Phase 6 | Follow-up entry + history view | 🟠 High |
| Phase 7 | Pipeline Kanban with drag-drop | 🟡 Medium |
| Phase 8 | Admin Config — stages, dropdowns, users | 🟡 Medium |
| Phase 9 | Calculated fields engine | 🟡 Medium |
| Phase 10 | Dashboard + Charts | 🟡 Medium |
| Phase 11 | Reports page | 🟢 Low |
| Phase 12 | Testing, permissions audit, deployment | 🟢 Low |

---

## 11. Authentication Strategy

Since all users have Google emails, use `Session.getActiveUser().getEmail()` in Apps Script to identify the logged-in user. No password needed.

- On app load → `AuthService.getCurrentUser()` → match email in USERS sheet
- If not found → show "Access Denied"
- Return user object with role + allowed modules to frontend
- Frontend hides/shows nav items based on role

Password column in USERS sheet can be kept for reference but will NOT be used for auth.

---

## 12. Key Design Decisions

1. **Single Page App** — Index.html is the shell, page content loaded via `google.script.run` returning HTML partials or JSON data
2. **JSON-first API** — All `Api.gs` functions return JSON, frontend renders with JS
3. **No eval()** — Formula engine uses safe parser, not JavaScript eval
4. **Optimistic UI** — Show changes immediately, sync in background
5. **Sheet locking** — Use `LockService` in Apps Script for concurrent write protection
6. **Batch reads** — Load all config data once on app init, cache in `sessionStorage`

---

## 13. Folder Structure to Create

```
c:\code\NBD Portal\
├── PLANNING.md                  ← This file
├── appsscript.json
├── .clasp.json
├── .gitignore
└── src/
    ├── server/
    │   ├── Code.gs
    │   ├── Api.gs
    │   ├── SheetDB.gs
    │   ├── AuthService.gs
    │   ├── LeadService.gs
    │   ├── ClientService.gs
    │   ├── FollowupService.gs
    │   ├── ConfigService.gs
    │   ├── FormulaService.gs
    │   └── Utils.gs
    └── client/
        ├── Index.html
        ├── Dashboard.html
        ├── Leads.html
        ├── Pipeline.html
        ├── Clients.html
        ├── Followups.html
        ├── Config.html
        ├── CSS.html
        └── JS.html
```
