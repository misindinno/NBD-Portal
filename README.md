# SCOT Leads Portal

A Google Sheets + Apps Script web app for lead management, pipeline tracking, and follow-ups.

---

## Quick Setup (Step by Step)

### Step 1 — Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
2. Name it **SCOT Leads Portal**
3. Copy the Spreadsheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`

### Step 2 — Create the Apps Script Project

1. In the sheet, go to **Extensions → Apps Script**
2. Copy the Script ID from the URL:
   `https://script.google.com/home/projects/**SCRIPT_ID**/edit`

### Step 3 — Install clasp

```bash
npm install -g @google/clasp
clasp login
```

### Step 4 — Configure this project

Edit `.clasp.json` and replace the placeholders:

```json
{
  "scriptId": "YOUR_SCRIPT_ID_HERE",
  "rootDir": "./src"
}
```

### Step 5 — Push code to Apps Script

```bash
clasp push
```

> clasp flattens `src/server/` and `src/client/` — all `.gs` and `.html` files land in the same Apps Script project.

### Step 6 — Run one-time setup

1. Open Apps Script editor
2. Select function `setupSheets` from the dropdown
3. Click **Run** — this creates all sheet tabs with headers and seeds default data

### Step 7 — Migrate existing USERS data

Your existing USERS sheet columns map as follows:

| Your Column | Portal Column |
|---|---|
| ID | User ID |
| Name | Name |
| Title | Title |
| Email Address | Email Address |
| Company Phone | Company Phone |
| Job Title | Job Title |
| Department | Department |
| Permission | Role (change "USER" → correct role) |

Recommended role assignments:
- Shallu (Sales Head) → **Manager**
- Sanya, Apurva, Sakshi → **Sales**
- Kavita Arora (EA) → **Admin**
- Pooja, Shalini (Production) → **User**

Add two more columns manually: `Is Active` = TRUE for all, `Can Edit Config` = TRUE for Admin only.

### Step 8 — Deploy as Web App (TWO deployments needed)

**Deployment 1 — READ (User Accessing)**

1. In Apps Script: **Deploy → New Deployment**
2. Type: **Web App**
3. **Execute as: User accessing the web app** ← Reads run as each user
4. **Who has access: Anyone** ← Open access for auth check
5. Click **Deploy** → copy the Web App URL (this is your main app URL)

**Deployment 2 — WRITE (Execute as Me)**

1. In Apps Script: **Deploy → New Deployment** (create a second one)
2. Type: **Web App**
3. **Execute as: Me (your-email@domain.com)** ← CRITICAL: Writes run as owner
4. **Who has access: Anyone** ← Allows frontend to POST writes
5. Click **Deploy** → copy this second Web App URL
6. Go to **Project Settings → Script Properties**
7. Add property:
   - Key: `WRITE_WEBHOOK_URL`
   - Value: `<paste Deployment 2 URL here>`
8. Click **Save**

**Why two deployments?**
- Deployment 1 (USER_ACCESSING) — serves the app shell + handles reads via `google.script.run` — no sheet sharing needed for reads
- Deployment 2 (USER_DEPLOYING) — handles all writes via `fetch()` POST webhook — runs as you (owner) so users don't need sheet Editor access
- Every write validates the user's email + role server-side before executing

### Step 9 — Access Control

Share Deployment 1 URL with your team. The app will:
- ✅ Allow access if user's email is in USERS sheet with `Is Active = TRUE`
- ❌ Show "Access Revoked" page if email not found or `Is Active = FALSE`
- All writes go through Deployment 2 webhook with role validation

---

## Project Structure

```
src/
├── server/
│   ├── Code.gs          — doGet entry, sheet setup, seed data
│   ├── Api.gs           — All google.script.run endpoints
│   ├── SheetDB.gs       — Generic sheet CRUD (read/write/update/delete)
│   ├── AuthService.gs   — Login via Google session, role check
│   ├── LeadService.gs   — Lead CRUD, stage update, pipeline data
│   ├── ClientService.gs — Client CRUD
│   ├── FollowupService.gs — Follow-up CRUD, today/overdue queries
│   ├── ConfigService.gs — Stages, dropdowns, field config, app bootstrap
│   ├── FormulaService.gs — Safe calculated fields engine (no eval)
│   └── Utils.gs         — UUID, date helpers, respond() wrapper
└── client/
    ├── Index.html       — App shell, all CDN libraries loaded here
    ├── CSS.html         — Global Material Design styles
    ├── JS.html          — App state, API wrapper, router, utilities
    ├── Dashboard.html   — Stat cards + Chart.js bar charts
    ├── Clients.html     — Tabulator grid + add/edit modal
    ├── Leads.html       — Tabulator grid + lead detail + follow-up history
    ├── Pipeline.html    — SortableJS Kanban board with drag-drop
    ├── Followups.html   — Today / Overdue / All follow-ups tabs
    └── Config.html      — Admin: stages, dropdowns, users management
```

---

## Libraries Used (all CDN, no build step)

| Library | Purpose |
|---|---|
| Material Icons + Roboto | Google Material UI icons and font |
| Tabulator.js 6.x | Data grids with sort, filter, pagination |
| SortableJS 1.x | Kanban drag-drop + stage reorder |
| Chart.js 4.x | Dashboard bar charts |
| Flatpickr | Date pickers (available, attach with `flatpickr()`) |
| Choices.js | Searchable dropdowns (available, attach with `new Choices()`) |
| SweetAlert2 | Confirm dialogs |
| Toastify.js | Toast notifications |

---

## Role Permissions

| Module | Admin | Manager | Sales | User | Viewer |
|---|---|---|---|---|---|
| Dashboard | ✅ All | ✅ All | ✅ Own | ✅ Own | ✅ Read |
| Clients | ✅ Full | ✅ Full | ✅ Own | ❌ | ✅ Read |
| Leads | ✅ Full | ✅ Full | ✅ Own | ❌ | ✅ Read |
| Pipeline | ✅ Full | ✅ Full | ✅ Own | ❌ | ✅ Read |
| Follow-ups | ✅ Full | ✅ Full | ✅ Own | ✅ Own | ✅ Read |
| Config | ✅ Full | ❌ | ❌ | ❌ | ❌ |

---

## Development Workflow

```bash
# Make changes locally in VS Code
# Push to Apps Script
clasp push

# Open in browser
clasp open

# Pull latest from Apps Script (if edited online)
clasp pull
```

---

## Calculated Fields (FormulaService)

Create calculated fields in the Config → Field Config tab.

Supported formula syntax:

```
DATEDIFF(TODAY(), {{Next Follow-up Date}})   → days overdue
{{Lead Value}} * 0.1                          → 10% of lead value
IF({{Priority}} == "Hot", 10, 5)             → conditional score
CONCAT({{Lead Name}}, " - ", {{Source}})     → string concat
```

Placeholders use `{{Field Name}}` matching exact column names in the sheet.
