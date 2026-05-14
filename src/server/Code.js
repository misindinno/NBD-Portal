// ─── Code.gs ─────────────────────────────────────────────────────────────────
// DEPLOYMENT SETUP:
//   Deployment 1 (READ)  — Execute as: User accessing | Access: Anyone
//                          Used for doGet + google.script.run reads/write proxy
//   Deployment 2 (WRITE) — Execute as: Me (owner)     | Access: Anyone
//                          Used for doPost write webhook — apiWrite POSTs here server-side
//
// Store Deployment 2 URL in Script Properties:
//   Apps Script → Project Settings → Script Properties
//   Key: WRITE_WEBHOOK_URL  Value: <Deployment 2 web app URL>

function doGet(e) {
  return withServerContext_(() => {
    try {
      const googleToken = e && e.parameter && e.parameter.google_token ? e.parameter.google_token : null;
      if (googleToken) return _handleGoogleAuthRedirect_(googleToken);
      return HtmlService.createTemplateFromFile('Index')
        .evaluate()
        .setTitle(CLIENT_CONFIG.APP_TITLE)
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch (err) {
      return HtmlService.createHtmlOutput(
        '<pre style="font-family:monospace;padding:20px;color:#c00">' +
        'doGet ERROR:\n' + err.message + '\n\n' + (err.stack || '') +
        '</pre>'
      ).setTitle(CLIENT_CONFIG.APP_TITLE + ' - Error');
    }
  });
}

function getGoogleClientId() {
  try {
    return PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') || '';
  } catch(e) { return ''; }
}

function _handleGoogleAuthRedirect_(idToken) {
  try {
    const verified = _verifyGoogleIdToken_(idToken);
    if (!verified) return _serveAuthError_('Google sign-in failed. Please try again.');
    const norm = String(verified.email).trim().toLowerCase();
    const userResult = getCurrentUserByEmail_(norm, false);
    if (!userResult.success) return _serveAuthError_('Your Google account (' + norm + ') is not authorized for this portal.');
    const token = createAuthSession_(norm, userResult.data.id);
    const appUrl = ScriptApp.getService().getUrl().split('?')[0];
    const safeToken = String(token).replace(/[^a-f0-9]/gi, '');
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head><body>' +
      '<script>' +
      'try{localStorage.setItem("nbd_token","' + safeToken + '");}catch(e){}' +
      'window.location.replace("' + appUrl + '");' +
      '<\/script>' +
      '<p style="font-family:sans-serif;padding:24px;color:#444">Signing in, please wait…</p>' +
      '</body></html>';
    return HtmlService.createHtmlOutput(html).setTitle(CLIENT_CONFIG.APP_TITLE + ' – Signing in');
  } catch (err) {
    return _serveAuthError_('Sign-in error: ' + err.message);
  }
}

function _serveAuthError_(msg) {
  const appUrl = ScriptApp.getService().getUrl().split('?')[0];
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;padding:40px;max-width:420px;margin:60px auto;text-align:center">' +
    '<h2 style="color:#c00;margin-bottom:12px">Sign-in Error</h2>' +
    '<p style="color:#555;margin-bottom:24px">' + msg + '</p>' +
    '<a href="' + appUrl + '" style="color:#4F46E5;font-weight:500">Try again</a>' +
    '</div>'
  ).setTitle(CLIENT_CONFIG.APP_TITLE + ' – Sign-in Error');
}

// ── Custom Menu ───────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(CLIENT_CONFIG.APP_TITLE)
    .addItem('⚙️ Run Setup', 'setupSheets')
    .addSeparator()
    .addItem('🔗 Open Portal', 'openPortal')
    .addToUi();
}

function openPortal() {
  const url = ScriptApp.getService().getUrl(); // requires script.scriptapp scope — only runs from sheet menu, not web app
  const html = '<script>window.open("' + url + '", "_blank"); google.script.host.close();<\/script>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(1).setHeight(1),
    'Opening Portal...'
  );
}

// ── Write dispatcher ──────────────────────────────────────────────────────────
function _dispatchWrite(fn, email, payload) {
  switch (fn) {
    // ── Leads
    case 'saveLead':          return saveLead(payload, email);
    case 'deleteLead':        return deleteLead(payload.id, email);
    case 'updateLeadStage':   return updateLeadStage(payload.leadId, payload.stageId, payload.note, email);
    case 'moveLeadStageWithFields':
      return moveLeadStageWithFields(payload.leadId, payload.stageId, payload.fields || {}, payload.note, email);
    // ── Follow-ups
    case 'saveFollowup':      return saveFollowup(payload, email);
    case 'markFollowupDone':  return markFollowupDone(payload.id, payload.data || {}, email);
    // ── Config (admin only — role checked inside each fn)
    case 'addConfig':         return addConfig(payload.type, payload.value, email);
    case 'updateConfigStatus':return updateConfigStatus(payload.id, payload.status, email);
    case 'saveStage':         return saveStage(payload, email);
    case 'reorderStages':     return reorderStages(payload.ids, email);
    case 'saveFieldConfig':   return saveFieldConfig(payload, email);
    case 'savePortalSettings':return savePortalSettings(payload, email);
    case 'saveUser':          return _saveUser(payload, email);
    default: throw new Error(`Unknown write function: ${fn}`);
  }
}

function _saveUser(data, email) {
  requireUserManager();
  const payload = _normalizeUserPayload(data);
  const lookupId = data['ID'] || data['User ID'];
  const lookupEmail = data['_Original Email Address'] || data['Email Address'];
  if (lookupId) {
    updateRow(SHEET_NAMES.USERS, 'ID', lookupId, payload);
  } else if (lookupEmail && queryRows(SHEET_NAMES.USERS, u => String(u['Email Address']).trim().toLowerCase() === String(lookupEmail).trim().toLowerCase()).length) {
    updateRow(SHEET_NAMES.USERS, 'Email Address', lookupEmail, payload);
  } else {
    insertRow(SHEET_NAMES.USERS, { ...payload, 'ID': payload['ID'] || generateUUID() });
  }
  invalidateAppConfigCache();
  return respond(true);
}

function _normalizeUserPayload(data) {
  const permission = normalizeStaffPermission(data['Permission'] || data['Role']);
  if (!ROLE_PERMISSIONS[permission]) throw new Error('Unsupported permission: ' + permission);
  const modules = parseUserModules(data['Allowed Modules']);
  const hasModulesField = Object.prototype.hasOwnProperty.call(data, 'Allowed Modules');
  const allowedModules = hasModulesField ? (modules.length ? modules.join(',') : 'NONE') : getRoleModules(permission).join(',');
  const payload = {
    'Job Title': data['Job Title'] || '',
    'Department': data['Department'] || '',
    'Email Address': String(data['Email Address'] || '').trim(),
    'Company Phone': data['Company Phone'] || '',
    'Name': data['Name'] || '',
    'Title': data['Title'] || data['Name'] || '',
    'ID': data['ID'] || data['User ID'] || '',
    'Permission': permission,
    'Allowed Modules': allowedModules,
    'Can Edit Config': isTruthyPermission(data['Can Edit Config']) || modules.some(m => _moduleKey(m) === 'config'),
    'Is Active': data['Is Active'] === true || data['Is Active'] === 'TRUE'
  };
  if (Object.prototype.hasOwnProperty.call(data, 'Password')) payload['Password'] = data['Password'] || '';
  return payload;
}

function include(filename) {
  assertServerContext_();
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ── One-time Setup ────────────────────────────────────────────────────────────
function setupSheets() {
  return withServerContext_(() => {
    safeInitHeaders(SHEET_NAMES.USERS, [
      'Job Title','Department','Email Address','Company Phone','Name','Title',
      'ID','Permission','Password','Allowed Modules','Can Edit Config','Is Active'
    ]);
    safeInitHeaders(SHEET_NAMES.LEADS, [
      'Lead ID','Company Name','Contact Person','Phone','Alternate No','Email',
      'City','State','Address','GST No','Category',
      'Remark','Source','Product Interest',
      'Stage ID','Priority','Assigned To','Lead Status',
      'Stage Updated At','Last Follow-up Date','Next Follow-up Date','Created At','Updated At'
    ]);
    ensureFollowupSheets_();
    ensureCustomFieldValueSheets_();
    safeInitHeaders(SHEET_NAMES.STAGES, [
      'Stage ID','Stage Name','Stage Order','Color','Is Active','Is Final Stage','Is Initial Stage','TAT Days','Created At'
    ]);
    safeInitHeaders(SHEET_NAMES.FIELD_CONFIG, [
      'Field ID','Sheet Name','Field Name','Column Key','Field Type',
      'Stage ID','Dropdown Source','Formula Logic',
      'Validation Min','Validation Max','Validation Regex','Validation Message',
      'Help Text','File Types','Max File MB',
      'Is Required','Is Visible','Display Order'
    ]);
    safeInitHeaders(SHEET_NAMES.CONFIG, [
      'Config ID','Config Type','Value','Status'
    ]);
    _migrateLegacyFollowupData_();
    migrateLegacyCustomFieldValues_();
    _seedDefaultData();
    return 'Setup complete! All existing data preserved.';
  });
}

function _seedDefaultData() {
  const stages = getSheet(SHEET_NAMES.STAGES);
  if (stages.getLastRow() < 2) {
    const defaults = [
      ['New Lead', 1, '#2196F3', true, false],
      ['First Call Done', 2, '#FF9800', true, false],
      ['Requirement Collected', 3, '#9C27B0', true, false],
      ['Quotation Sent', 4, '#00BCD4', true, false],
      ['Negotiation', 5, '#FF5722', true, false],
      ['Won', 6, '#4CAF50', true, true],
      ['Lost', 7, '#F44336', true, true]
    ];
    defaults.forEach(([name, order, color, active, final]) =>
      insertRow(SHEET_NAMES.STAGES, {
        'Stage ID': generateUUID(), 'Stage Name': name, 'Stage Order': order,
        'Color': color, 'Is Active': active, 'Is Final Stage': final, 'Created At': now()
      })
    );
  }
  const config = getSheet(SHEET_NAMES.CONFIG);
  if (config.getLastRow() < 2) {
    const defaults = [
      ['Lead Source','WhatsApp'],['Lead Source','Referral'],['Lead Source','Website'],
      ['Lead Source','Exhibition'],['Lead Source','Cold Call'],['Lead Source','Existing Dealer'],
      ['Priority','Hot'],['Priority','Warm'],['Priority','Cold'],
      ['Follow-up Type','Call'],['Follow-up Type','WhatsApp'],['Follow-up Type','Visit'],
      ['Follow-up Type','Email'],['Follow-up Type','Payment'],
      ['Outcome','Interested'],['Outcome','Not Interested'],['Outcome','Call Again'],
      ['Outcome','Order Received'],['Outcome','Payment Received'],['Outcome','No Response'],
      ['Category','Dealer'],['Category','Distributor'],['Category','Direct'],['Category','OEM'],
      ['Lead Status','Open'],['Lead Status','Won'],['Lead Status','Lost'],['Lead Status','Hold'],
      ['State','Delhi'],['State','Haryana'],['State','Punjab'],['State','Rajasthan'],
      ['State','UP'],['State','Maharashtra'],['State','Gujarat']
    ];
    defaults.forEach(([type, value]) =>
      insertRow(SHEET_NAMES.CONFIG, {
        'Config ID': generateUUID(), 'Config Type': type, 'Value': value, 'Status': 'Active'
      })
    );
  }
}
