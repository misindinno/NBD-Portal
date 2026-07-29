// ─── ConfigService.js ────────────────────────────────────────────────────────

function getConfigByType(type) {
  return queryRows(
    SHEET_NAMES.CONFIG,
    (r) => r["Config Type"] === type && r["Status"] === "Active",
  ).map((r) => r["Value"]);
}

function getAllConfigs() {
  return getAllRows(SHEET_NAMES.CONFIG);
}

function addConfig(type, value, email) {
  requireConfigEditor();
  const existing = queryRows(
    SHEET_NAMES.CONFIG,
    (r) => r["Config Type"] === type && r["Value"] === value,
  );
  if (existing.length) return respond(null, "Value already exists.");
  insertRow(SHEET_NAMES.CONFIG, {
    "Config ID": generateUUID(),
    "Config Type": type,
    Value: value,
    Status: "Active",
  });
  invalidateAppConfigCache();
  _bumpStamp('config');
  return respond(true);
}

function updateConfigStatus(configId, status, email) {
  requireConfigEditor();
  updateRow(SHEET_NAMES.CONFIG, "Config ID", configId, { Status: status });
  invalidateAppConfigCache();
  _bumpStamp('config');
  return respond(true);
}

function savePortalSettings(settings, email) {
  requireConfigEditor();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('PORTAL_VISIBLE_DEPARTMENTS', _normalizeDepartmentList_(settings && settings.visibleDepartments));
  props.setProperty('PORTAL_ESCALATE_FORM_URL', String(settings && settings.escalateFormUrl || '').trim());
  invalidateAppConfigCache();
  _bumpStamp('config');
  return respond(true);
}

// ── Pipeline Stages ───────────────────────────────────────────────────────────

function getActiveStages() {
  return queryRows(
    SHEET_NAMES.STAGES,
    (r) => r["Is Active"] === true || r["Is Active"] === "TRUE",
  ).sort((a, b) => Number(a["Stage Order"]) - Number(b["Stage Order"]));
}

function getAllStages() {
  return getAllRows(SHEET_NAMES.STAGES).sort(
    (a, b) => Number(a["Stage Order"]) - Number(b["Stage Order"]),
  );
}

function saveStage(stage, email) {
  requireConfigEditor();
  let stageId = stage["Stage ID"];
  if (stageId) {
    updateRow(SHEET_NAMES.STAGES, "Stage ID", stageId, stage);
  } else {
    stageId = generateUUID();
    insertRow(SHEET_NAMES.STAGES, {
      ...stage,
      "Stage ID": stageId,
      "Created At": now(),
    });
  }
  // "Update Stage Form" is stored as an enabled-stage allow-list (Script Property), not a
  // sheet column — the STAGES sheet has no header for it so a column write would be dropped.
  if (Object.prototype.hasOwnProperty.call(stage, "Show On Stage Field Form")) {
    const show = stage["Show On Stage Field Form"] !== false && stage["Show On Stage Field Form"] !== "FALSE";
    _setStageFieldFormVisibility_(stageId, show);
  }
  invalidateAppConfigCache();
  _bumpStamp('stages');
  return respond(true);
}

// Toggles whether a stage appears on the Stage Fields form by maintaining an allow-list of
// enabled stage IDs in Script Properties (default: not shown until opted in).
function _setStageFieldFormVisibility_(stageId, show) {
  const props = PropertiesService.getScriptProperties();
  let allowed = _parseIdList_(props.getProperty('STAGE_FIELD_FORM_STAGES'));
  const has = allowed.indexOf(stageId) !== -1;
  if (show && !has) allowed.push(stageId);
  else if (!show && has) allowed = allowed.filter((id) => id !== stageId);
  else return;
  props.setProperty('STAGE_FIELD_FORM_STAGES', allowed.join(','));
}

function reorderStages(orderedIds, email) {
  requireConfigEditor();
  orderedIds.forEach((id, i) =>
    updateRow(SHEET_NAMES.STAGES, "Stage ID", id, { "Stage Order": i + 1 }),
  );
  invalidateAppConfigCache();
  _bumpStamp('stages');
  return respond(true);
}

// ── Field Config ──────────────────────────────────────────────────────────────

function getFieldConfig(sheetName) {
  return _fieldConfigRows(sheetName, false);
}

function getAllFieldConfigs(sheetName) {
  return _fieldConfigRows(sheetName, true);
}

function _fieldConfigRows(sheetName, includeHidden) {
  return queryRows(
    SHEET_NAMES.FIELD_CONFIG,
    (r) =>
      (!sheetName || (r["Sheet Name"] || "Leads") === sheetName) &&
      (includeHidden ||
        (r["Is Visible"] !== false && r["Is Visible"] !== "FALSE")),
  ).sort((a, b) => Number(a["Display Order"]) - Number(b["Display Order"]));
}

function saveFieldConfig(field, email) {
  requireConfigEditor();
  const existingFields = getAllRows(SHEET_NAMES.FIELD_CONFIG);
  const check = FieldValidation.validateField(field, existingFields);
  if (!check.ok) return respond(null, check.message);
  const normalized = _normalizeFieldConfig({ ...field, 'Column Key': check.derivedKey });
  ensureCustomFieldValueSheets_();

  if (normalized["Field ID"]) {
    updateRow(
      SHEET_NAMES.FIELD_CONFIG,
      "Field ID",
      normalized["Field ID"],
      normalized,
    );
  } else {
    insertRow(SHEET_NAMES.FIELD_CONFIG, {
      ...normalized,
      "Field ID": generateUUID(),
    });
  }
  invalidateAppConfigCache();
  _bumpStamp('fields');
  return respond(true);
}

function _normalizeFieldConfig(field) {
  // Validation already done by FieldValidation.validateField() before this is called
  const type      = String(field["Field Type"] || "Text").trim();
  const fieldName = String(field["Field Name"] || "").trim();
  const columnKey = String(field["Column Key"]  || FieldValidation.columnKeyFromName(fieldName)).trim();
  const sheetName = String(field["Sheet Name"]  || "Leads").trim();
  return {
    ...field,
    "Sheet Name": sheetName,
    "Field Name": fieldName,
    "Column Key": columnKey,
    "Field Type": type,
    "Stage ID": sheetName === "Leads" ? field["Stage ID"] || "" : "",
    "Dropdown Source": field["Dropdown Source"] || "",
    "Formula Logic": field["Formula Logic"] || "",
    "Validation Min": _fieldConfigValue(field, "Validation Min"),
    "Validation Max": _fieldConfigValue(field, "Validation Max"),
    "Validation Regex": field["Validation Regex"] || "",
    "Validation Message": field["Validation Message"] || "",
    "Help Text": field["Help Text"] || "",
    "File Types": field["File Types"] || "",
    "Max File MB": _fieldConfigValue(field, "Max File MB"),
    "Is Required":
      field["Is Required"] === true || field["Is Required"] === "TRUE",
    "Is Visible":
      field["Is Visible"] !== false && field["Is Visible"] !== "FALSE",
    "Display Order": Number(field["Display Order"]) || 100,
    "Skip Visibility": field["Skip Visibility"] === "skip_only" ? "skip_only" : "normal",
    "Per Stage": field["Per Stage"] === true || field["Per Stage"] === "TRUE",
  };
}

function _fieldConfigValue(field, key) {
  const value = field[key];
  return value === undefined || value === null ? "" : value;
}


// ── App Bootstrap ─────────────────────────────────────────────────────────────

function getAppConfig() {
  assertServerContext_();
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get("APP_CONFIG_V9");
    if (cached) {
      try {
        return respond(JSON.parse(cached));
      } catch (e) {}
    }
    const outcomes = getConfigByType("Outcome");
    const settings = getPortalSettings_();
    const config = {
      stages: getActiveStages(),
      sources: getConfigByType("Lead Source"),
      priorities: getConfigByType("Priority"),
      followupTypes: getConfigByType("Follow-up Type"),
      outcomes: outcomes.length
        ? outcomes
        : [
            "Interested",
            "Not Interested",
            "Call Again",
            "Order Received",
            "Payment Received",
            "No Response",
          ],
      productInterests: getConfigByType("Product Interest"),
      categories: getConfigByType("Category"),
      statuses: getConfigByType("Lead Status"),
      states: getConfigByType("State"),
      settings,
      leadFields: getFieldConfig("Leads"),
      followupFields: getFieldConfig("Followups"),
      _allConfigs: getAllRows(SHEET_NAMES.CONFIG),
      users: getUsersWithPortalAccess_()
        .filter((u) => isActiveUserValue(u["Is Active"]) && _userMatchesDepartmentSettings_(u, settings))
        .map((u) => {
        const email = String(u["Email Address"] || "")
          .trim()
          .toLowerCase();
        const role = normalizeStaffPermission(u["Permission"] || u["Role"]);
        return {
          id: getStaffUserId(u, email),
          name: u["Name"],
          title: u["Title"] || u["Name"],
          role,
          department: u["Department"] || "",
        };
      }),
      departments: _activeUserDepartments_(),
      allStages: getAllStages(),
      userNameMap: getAllRows(SHEET_NAMES.USERS).reduce((m, u) => {
        const email = String(u["Email Address"] || "").trim().toLowerCase();
        const id = getStaffUserId(u, email);
        if (id) m[id] = u["Name"] || email;
        if (email && id !== email) m[email] = u["Name"] || email;
        return m;
      }, {}),
    };
    try {
      cache.put("APP_CONFIG_V9", JSON.stringify(config), 300);
    } catch (e) {}
    return respond(config);
  } catch (e) {
    return respond(null, "getAppConfig failed: " + e.message);
  }
}

function _userMatchesDepartmentSettings_(user, settings) {
  const selected = settings.visibleDepartments || [];
  if (!selected.length) return true;
  const department = String(user["Department"] || "").trim().toLowerCase();
  return selected.some((d) => String(d || "").trim().toLowerCase() === department);
}

function getPortalSettings_() {
  try {
    const props = PropertiesService.getScriptProperties();
    return {
      visibleDepartments: _parseDepartmentList_(props.getProperty('PORTAL_VISIBLE_DEPARTMENTS')),
      escalateFormUrl: String(props.getProperty('PORTAL_ESCALATE_FORM_URL') || '').trim(),
      // Stages enabled for the Stage Fields ("Update Stage") form (opt-in). Empty = none.
      stageFieldFormStages: _parseIdList_(props.getProperty('STAGE_FIELD_FORM_STAGES')),
    };
  } catch (e) {
    return { visibleDepartments: [], escalateFormUrl: '', stageFieldFormStages: [] };
  }
}

// Parses a comma-separated ID list (used for the Stage Fields form's hidden-stage list).
function _parseIdList_(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

function _activeUserDepartments_() {
  return queryRows(
    SHEET_NAMES.USERS,
    (u) => isActiveUserValue(u["Is Active"]),
  )
    .map((u) => String(u["Department"] || "").trim())
    .filter(Boolean)
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .sort();
}

function _parseDepartmentList_(value) {
  if (Array.isArray(value)) return value.map(_departmentName_).filter(Boolean);
  return String(value || "")
    .split(",")
    .map(_departmentName_)
    .filter(Boolean)
    .filter((d, i, arr) => arr.indexOf(d) === i);
}

function _normalizeDepartmentList_(value) {
  return _parseDepartmentList_(value).join(",");
}

function _departmentName_(value) {
  return String(value || "").trim();
}

function invalidateAppConfigCache() {
  assertServerContext_();
  try {
    CacheService.getScriptCache().remove("APP_CONFIG_V9");
  } catch (e) {}
}
