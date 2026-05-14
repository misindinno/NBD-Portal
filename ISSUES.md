# SCOT Leads Portal — Known Issues & Bug Tracker

> Deep code review conducted on full source (`src/`).
> All 23 issues have been fixed. This document serves as a change log.
> Severity levels: 🔴 High · 🟠 Medium · 🟡 Low

---

## Custom Fields System — Implementation Status

The custom fields system **is fully implemented** end-to-end:

| Layer | Status |
|---|---|
| Config UI (Config → Custom Fields tab) | ✅ Done |
| FIELD_CONFIG sheet storage | ✅ Done |
| Stage-specific field binding | ✅ Done |
| Lead form rendering with show/hide by stage | ✅ Done |
| Server-side validation (required, min/max, regex, type) | ✅ Done |
| File upload to Google Drive | ✅ Done |
| Formula engine (FormulaService) | ✅ Done (but has bugs — see below) |
| Pipeline drag-drop field enforcement | ❌ Missing |

However, several critical bugs prevent it from working correctly in production. All issues are documented below.

---

## Issues by File

---

### `src/server/FormulaService.js`

---

#### 🔴 #1 — Formula fields never display anywhere (wrong key used)

**Function:** `applyCalculatedFields`
**Line:** ~14

Formula results are stored on the row object using `Field Name` as the key:
```js
row[f['Field Name']] = evaluateFormula(f['Formula Logic'], row);
```
But everywhere else in the system — the lead form, lead detail view, sheet storage, and payload collection — custom fields are keyed by `Column Key`. The formula result is written to a key that nothing reads.

**Fix:**
```js
row[f['Column Key']] = evaluateFormula(f['Formula Logic'], row);
```

---

#### 🔴 #2 — String field values with quotes break formula evaluation

**Function:** `evaluateFormula`
**Line:** ~6–12

Field values are injected into the formula expression as:
```js
return typeof val === 'string' ? `"${val}"` : (val || 0);
```
If a field value contains a double-quote (e.g. `5" Pipe`), the expression becomes malformed:
```
"5" Pipe"   ← invalid
```
This causes `_safeEval` to throw or return `#ERR` for any lead with quotes in field values.

**Fix:**
```js
return typeof val === 'string' ? `"${val.replace(/"/g, '\\"')}"` : (val || 0);
```

---

#### 🔴 #3 — `IF()` regex is greedy — breaks on commas inside string arguments

**Function:** `_safeEval`
**Line:** ~22–35

The regex `/IF\((.+),(.+),(.+)\)/g` uses greedy `.+` for all three capture groups. A formula like:
```
IF({{Priority}} == "Hot", "Great, confirmed", "Pending")
```
splits incorrectly because the comma inside `"Great, confirmed"` is treated as an argument separator.

**Fix:** Use non-greedy quantifiers:
```js
expr = expr.replace(/IF\((.+?),(.+?),(.+?)\)/g, ...)
```
Or implement a proper comma-splitter that respects quoted strings.

---

#### 🟡 #4 — `CONCAT()` only supports exactly 2 arguments

**Function:** `_safeEval`
**Line:** ~40–50

The regex `/CONCAT\(([^,]+),([^)]+)\)/g` captures exactly two arguments. The README documents a 3-argument example:
```
CONCAT({{Lead Name}}, " - ", {{Source}})
```
This silently produces wrong output with 3+ arguments.

**Fix:** Replace with a variadic implementation:
```js
expr = expr.replace(/CONCAT\(([^)]+)\)/g, (_, args) =>
  args.split(',').map(a => a.trim().replace(/^"|"$/g, '')).join('')
);
```

---

### `src/server/LeadService.js`

---

#### 🔴 #5 — Required custom field validation fires for wrong stage on edit

**Function:** `saveLead` → `_prepareLeadPayload`
**Line:** ~47–60

When editing a lead, `_prepareLeadPayload` calls `getLeadCustomFieldsForStage(stageId)`. If the client sends an empty `Stage ID`, the fallback correctly uses `existing.lead['Stage ID']`. However, `getLeadCustomFieldsForStage` returns both global fields (Stage ID = `''`) AND stage-specific fields for the resolved stage. If a required field belongs to a stage the lead has already moved past, and its value is empty in the payload, validation throws an error blocking the save.

**Impact:** Editing a lead can fail with a validation error for a field that belongs to a different stage.

**Fix:** In `_validateCustomFieldValue`, skip required-field enforcement for fields whose `Stage ID` does not match the current stage being saved.

---

#### 🔴 #6 — Hidden formula fields excluded from computation

**Function:** `getLeadCustomFieldsForStage`
**Line:** ~62–68

Fields with `Is Visible = FALSE` are excluded from `getLeadCustomFieldsForStage`. This means hidden Formula fields are never computed and never written to the sheet. Formula fields should be computed server-side regardless of visibility — visibility only controls whether they appear in the UI.

**Fix:** In `applyCalculatedFields` (FormulaService), remove the `Is Visible` filter so all Formula fields are evaluated.

---

#### 🟠 #7 — File upload: base64 data URL stripping is fragile

**Function:** `_uploadCustomFieldFile`
**Line:** ~108–120

The data URL prefix is stripped with:
```js
const base64 = String(file.data).split(',').pop();
```
If the MIME type or filename contains a comma, `split(',').pop()` returns only the last segment, corrupting the base64 payload and producing a broken file in Google Drive.

**Fix:**
```js
const commaIdx = file.data.indexOf(',');
const base64 = commaIdx !== -1 ? file.data.slice(commaIdx + 1) : file.data;
```

---

### `src/server/ConfigService.js`

---

#### 🔴 #8 — Column Key regex allows spaces — breaks sheet column lookup

**Function:** `_normalizeFieldConfig`
**Line:** ~82–88

The validation regex is:
```js
/^[A-Za-z][A-Za-z0-9_ ]{1,60}$/
```
This allows spaces in Column Key. But `SheetDB.js` looks up columns with `headers.indexOf(key)`. A key like `"My Field"` will never match a sheet header `"My_Field"` or vice versa, causing all reads and writes for that field to silently do nothing.

The auto-generator `_columnKeyFromName` correctly uses underscores, but manual entry can include spaces.

**Fix:** Remove the space from the character class:
```js
/^[A-Za-z][A-Za-z0-9_]{1,60}$/
```

---

### `src/server/SheetDB.js`

---

#### 🟠 #9 — `updateRow` makes one Sheets API call per field (N+1 writes)

**Function:** `updateRow`
**Line:** ~62–78

```js
Object.keys(updates).forEach((key) => {
  const col = headers.indexOf(key);
  if (col !== -1) sheet.getRange(rowIndex, col + 1).setValue(updates[key]);
});
```
Each `setValue` is a separate Google Sheets API call. Saving a lead with 10 custom fields makes 10+ individual API calls inside a single lock. Apps Script has a 6-minute execution limit and each Sheets call adds ~200–500ms latency.

**Fix:** Build a full row array and write it in one call:
```js
const rowData = data[rowIndex - 1].map((cell, i) =>
  updates[headers[i]] !== undefined ? updates[headers[i]] : cell
);
sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowData]);
```

---

#### 🟠 #10 — `updateRow` reads row index before acquiring the lock

**Function:** `updateRow`
**Line:** ~62–78

`findRowIndex` is called before `LockService.getScriptLock()`. Between the index read and the lock acquisition, a concurrent write (e.g. another user saving simultaneously) could insert or delete rows, making the cached `rowIndex` stale. The update then writes to the wrong row.

**Fix:** Move `findRowIndex` inside the lock block, after `lock.waitLock(10000)`.

---

### `src/server/AuthService.js`

---

#### 🟠 #11 — Write token is never invalidated after use

**Function:** `validateWriteToken`
**Line:** ~35–42

The token is read from cache but never deleted. It remains valid for 6 hours and can be reused unlimited times. If intercepted (e.g. via network logs), it can be replayed to execute arbitrary write operations as the original user.

**Fix:** Delete the token from cache immediately after validation:
```js
CacheService.getScriptCache().remove('WRITE_TOKEN:' + token);
```
Then issue a fresh token in the response so the client can continue making writes.

---

### `src/server/Api.js`

---

#### 🟠 #12 — Overdue follow-up count has timezone mismatch

**Function:** `apiGetDashboard`
**Line:** ~95–110

```js
new Date(f['Next Follow-up Date']) < new Date(t)
// where t = today() → e.g. "2024-01-15"
```
`new Date('2024-01-15')` parses as **midnight UTC**. But `new Date('2024-01-14 10:30:00')` (a full datetime from the sheet) parses in the **script's local timezone**. Depending on the server timezone offset, follow-ups can appear overdue a day early or not overdue when they should be.

**Fix:** Use `formatDate()` on both sides for a consistent string comparison:
```js
formatDate(f['Next Follow-up Date']) < t && !f['Outcome']
```

---

### `src/Pipeline.html`

---

#### 🔴 #13 — Drag-drop stage change bypasses custom field validation

**Function:** `onEnd` (SortableJS callback)
**Line:** ~55–75

When a lead card is dragged to a new stage, `api.updateLeadStage` is called directly. This only updates `Stage ID` and logs a follow-up — it does **not** call `_prepareLeadPayload` or `_validateCustomFieldValue`. Required custom fields for the destination stage are never checked or prompted.

**Impact:** A lead can be moved to any stage without filling required fields for that stage, making stage-specific required fields completely ineffective from the Pipeline view.

**Fix:** After a successful drag, check if the destination stage has required custom fields with empty values on the lead. If so, open a mini-form to collect them before confirming, or revert the drag and show a warning.

---

#### 🟠 #14 — Drag revert on error uses wrong DOM index

**Function:** `onEnd` (SortableJS callback)
**Line:** ~55–75

On API error, the card is reverted with:
```js
evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex] || null);
```
After SortableJS moves the item, `evt.from.children` has already shifted. `evt.oldIndex` no longer points to the correct sibling, so the card is inserted at the wrong position.

**Fix:** Use `evt.oldDraggableIndex` (provided by SortableJS) or reload the pipeline on error.

---

### `src/Leads.html`

---

#### 🔴 #15 — Stage change in lead form does not reload custom fields

**Function:** `initLeadCustomFields`
**Line:** ~195–210

When the user changes the Stage dropdown in the lead form, `initLeadCustomFields` only shows/hides already-rendered fields via `display:none`. It does not re-fetch fields from the server. Two problems:

1. The "Stage Fields" section header remains visible even when no fields are active for the selected stage.
2. Fields added to a stage after the form was opened will not appear until the form is closed and reopened.

**Fix:** On stage change, either re-render the custom fields section with the filtered field list, or hide the section header when no fields are active:
```js
const hasActive = [...root.querySelectorAll('.lead-custom-field')]
  .some(el => el.style.display !== 'none');
root.querySelector('.custom-field-section').style.display = hasActive ? '' : 'none';
```

---

#### 🟠 #16 — All stage fields flash visible before `initLeadCustomFields` runs

**Function:** `buildLeadFormHTML` → `buildLeadCustomFieldsHTML`
**Line:** ~155–175

`buildLeadCustomFieldsHTML` renders ALL custom fields for all stages. `initLeadCustomFields` then hides non-matching ones. There is a brief flash where all fields are visible before the hide logic runs. If a JS error occurs before `initLeadCustomFields` runs, all fields remain visible and are submitted.

**Fix:** Pre-filter fields by the initially selected stage ID before rendering:
```js
const initialStageId = d['Stage ID'] || cfg.stages[0]?.['Stage ID'] || '';
const filteredFields = customFields.filter(f => !f['Stage ID'] || f['Stage ID'] === initialStageId);
```

---

#### 🟡 #17 — `openLeadDetail` and `openLeadForm` both fetch field config on every open

**Functions:** `openLeadDetail`, `openLeadForm`
**Line:** ~100–115

Both functions call `api.getFieldConfig('Leads')` and `api.getAllConfigs()` every time a modal opens. This data is already available in `App.config.leadFields` (loaded at bootstrap). Each modal open triggers two extra server round-trips.

**Fix:** Use `App.config.leadFields` and build `configOptions` from `App.config` directly. Only re-fetch if the config has been modified in the current session.

---

### `src/Config.html`

---

#### 🟡 #18 — Close button in `openFieldForm` shows garbled text

**Function:** `openFieldForm`
**Line:** ~155–165

The modal close button contains a corrupted UTF-8 sequence (`âœ•`) instead of the `✕` character. This displays as garbage text in the browser.

**Fix:** Replace with the correct HTML entity:
```html
<button class="modal-close" onclick="...">&#x2715;</button>
```

---

#### 🟠 #19 — Dropdown Source field stays visible for non-Select field types

**Function:** `_toggleFieldTypeOptions`
**Line:** ~200–215

The Dropdown Source input is hidden via the `.field-option-select` CSS class toggle. However, when a user switches from `Select` to `Text` (for example), the Dropdown Source value is still included in the form payload and saved to the sheet. On re-open, the field shows a stale Dropdown Source value for a non-Select type.

**Fix:** Clear the Dropdown Source input value when the type changes away from Select/Multi Select:
```js
if (!['Select', 'Multi Select'].includes(type)) {
  form.querySelector('[name="Dropdown Source"]').value = '';
}
```

---

### `src/JS.html`

---

#### 🟡 #20 — `toast()` called with Error objects — shows `[object Error]`

**Affected files:** `Leads.html`, `Clients.html`, `Config.html`, `Followups.html`, `Pipeline.html`

Throughout the codebase, error handlers call:
```js
toast(err, 'error');
```
where `err` is an `Error` object. Toastify calls `.toString()` on it, producing `[object Error]` instead of the actual message.

**Fix:** Update the `toast` utility in `JS.html`:
```js
function toast(msg, type = 'success') {
  const text = msg instanceof Error ? msg.message : String(msg || '');
  Toastify({ text, duration: 3000, gravity: 'top', position: 'right',
    style: { background: type === 'success' ? '#388E3C' : '#D32F2F' }
  }).showToast();
}
```

---

#### 🟡 #21 — `navigate()` has no error boundary around page load functions

**Function:** `navigate`
**Line:** ~95–105

Page load functions (`loadDashboard`, `loadLeads`, etc.) are called directly with no try/catch. If any HTML include failed to load or a function is undefined, the app throws an uncaught `ReferenceError` and the content area is left in a broken state with no user feedback.

**Fix:**
```js
try {
  if (page === 'dashboard') loadDashboard();
  else if (page === 'leads') loadLeads();
  // ...
} catch (err) {
  el('content').innerHTML = `<p style="color:red">Failed to load page: ${escapeHtml(err.message)}</p>`;
}
```

---

### `src/Clients.html`

---

#### 🟡 #22 — Search and status filters conflict — setting one clears the other

**Function:** `loadClients` event listeners
**Line:** ~85–95

The search filter uses Tabulator's nested array OR syntax:
```js
clientTable.setFilter([[{ field: 'Company Name', ... }, { field: 'Contact Person', ... }]]);
```
The status filter calls:
```js
clientTable.setFilter('Status', '=', value);
```
`setFilter` replaces all existing filters. Setting a status filter clears the search, and vice versa.

**Fix:** Use the same `applyClientFilters()` pattern as `applyLeadFilters()` in `Leads.html` — rebuild all active filters together on every change.

---

### `src/Followups.html`

---

#### 🟡 #23 — Disabled `Updated Stage ID` field may still be submitted

**Function:** `_clearSelectedLead`
**Line:** ~180–200

When a lead is deselected, `Updated Stage ID` is set to `disabled`. In some browsers, `FormData` still includes disabled fields. The server correctly ignores it when `Lead ID` is absent, but the field value is not explicitly cleared before disabling.

**Fix:** Clear the value before disabling:
```js
select.value = '';
select.disabled = true;
```

---

## Summary Table

| # | File | Severity | Title | Status |
|---|---|---|---|---|
| 1 | FormulaService.js | 🔴 High | Formula fields stored under wrong key — never display | ✅ Fixed |
| 2 | FormulaService.js | 🔴 High | String values with quotes break formula evaluation | ✅ Fixed |
| 3 | FormulaService.js | 🔴 High | IF() regex greedy — breaks on commas in string args | ✅ Fixed |
| 4 | FormulaService.js | 🟡 Low | CONCAT() only supports 2 arguments | ✅ Fixed |
| 5 | LeadService.js | 🔴 High | Required field validation fires for wrong stage on edit | ✅ Fixed |
| 6 | LeadService.js | 🟠 Medium | Hidden formula fields excluded from computation | ✅ Fixed |
| 7 | LeadService.js | 🟠 Medium | File upload base64 stripping is fragile | ✅ Fixed |
| 8 | ConfigService.js | 🔴 High | Column Key regex allows spaces — breaks sheet lookup | ✅ Fixed |
| 9 | SheetDB.js | 🟠 Medium | updateRow makes N+1 Sheets API calls | ✅ Fixed |
| 10 | SheetDB.js | 🟠 Medium | updateRow reads row index before acquiring lock | ✅ Fixed |
| 11 | AuthService.js | 🟠 Medium | Write token never invalidated after use | ✅ Fixed |
| 12 | Api.js | 🟠 Medium | Overdue count has timezone mismatch | ✅ Fixed |
| 13 | Pipeline.html | 🔴 High | Drag-drop bypasses custom field validation | ✅ Fixed |
| 14 | Pipeline.html | 🟠 Medium | Drag revert on error uses wrong DOM index | ✅ Fixed |
| 15 | Leads.html | 🔴 High | Stage change in form does not reload custom fields | ✅ Fixed |
| 16 | Leads.html | 🟠 Medium | All stage fields flash visible before hide logic runs | ✅ Fixed |
| 17 | Leads.html | 🟡 Low | Field config fetched on every modal open — no caching | ✅ Fixed |
| 18 | Config.html | 🟡 Low | Close button shows garbled text (broken UTF-8) | ✅ Fixed |
| 19 | Config.html | 🟠 Medium | Dropdown Source field visible for non-Select types | ✅ Fixed |
| 20 | JS.html | 🟡 Low | toast() called with Error objects — shows [object Error] | ✅ Fixed |
| 21 | JS.html | 🟡 Low | navigate() has no error boundary | ✅ Fixed |
| 22 | Clients.html | 🟡 Low | Search and status filters conflict | ✅ Fixed |
| 23 | Followups.html | 🟡 Low | Disabled stage field may still be submitted | ✅ Fixed |

---

## Fix Priority Order

> All issues resolved. No outstanding items.
