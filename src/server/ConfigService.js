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
  const user = requireConfigEditor();
  let stageId = stage["Stage ID"];
  let movedLeadCount = 0;
  let targetStage = null;
  if (stageId) {
    const stages = getAllStages();
    const currentIndex = stages.findIndex(s => String(s['Stage ID']) === String(stageId));
    if (currentIndex === -1) return respond(null, 'Stage not found.');
    if (stage['Is Active'] === false || stage['Is Active'] === 'FALSE') {
      const leads = queryRows(SHEET_NAMES.LEADS, r => String(r['Stage ID']) === String(stageId));
      targetStage = stages.slice(0, currentIndex).reverse()
        .find(s => s['Is Active'] === true || s['Is Active'] === 'TRUE');
      if (leads.length && !targetStage) {
        return respond(null, 'Cannot deactivate this stage because it has leads and no previous active stage. Activate an earlier stage or move its leads first.');
      }
      // Move before hiding the stage. A failed migration leaves the source stage
      // available, and retrying only moves the leads still assigned to it.
      if (leads.length) movedLeadCount = _moveLeadsFromInactiveStage_(leads, stages[currentIndex], targetStage, user.id);
    }
    if (!updateRow(SHEET_NAMES.STAGES, "Stage ID", stageId, stage)) {
      return respond(null, 'Stage update failed. Stage was not found.');
    }
  } else {
    stageId = generateUUID();
    insertRow(SHEET_NAMES.STAGES, {
      ...stage,
      "Stage ID": stageId,
      "Created At": now(),
    });
  }
  invalidateAppConfigCache();
  _bumpStamp('stages');
  return respond({ stageId, movedLeadCount, targetStageName: targetStage ? targetStage['Stage Name'] : '' });
}

// Configuration reassignment preserves lead status, follow-ups, custom fields,
// archive metadata, and ownership; it does not complete a sales pipeline step.
function _moveLeadsFromInactiveStage_(leads, sourceStage, targetStage, userId) {
  const movedIds = [];
  const timestamp = now();
  try {
    leads.forEach(lead => {
      const leadId = lead['Lead ID'];
      const updated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, {
        'Stage ID': targetStage['Stage ID'],
        'Stage Updated At': timestamp,
        'Updated At': timestamp
      });
      if (!updated) throw new Error('Lead reassignment failed. Please retry saving the stage.');
      movedIds.push(leadId);
      insertLeadActivityLog_(leadId, 'Stage Change', sourceStage['Stage ID'], targetStage['Stage ID'],
        'Automatically reassigned to ' + targetStage['Stage Name'] + ' while deactivating stage ' + sourceStage['Stage Name'] + '.', userId);
    });
  } finally {
    if (movedIds.length) {
      _bumpStamp('leads');
      pushFsrLeadIds_(movedIds, 'client.updated');
    }
  }
  return movedIds.length;
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
    };
  } catch (e) {
    return { visibleDepartments: [], escalateFormUrl: '' };
  }
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
