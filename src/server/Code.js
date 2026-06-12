// ─── Code.gs ─────────────────────────────────────────────────────────────────
// Runtime setup:
//   - doGet serves the portal UI.
//   - google.script.run API calls read data and execute authenticated mutations
//     through trusted user context.

function doGet(e) {
  return withServerContext_(() => {
    try {
      const googleToken = e && e.parameter && e.parameter.google_token ? e.parameter.google_token : null;
      if (googleToken) return _handleGoogleAuthRedirect_(googleToken);
      const template = HtmlService.createTemplateFromFile('Index');
      template.initialPage = e && e.parameter && e.parameter.page ? String(e.parameter.page).replace(/[^a-z0-9_-]/gi, '') : '';
      return template
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
  const menu = SpreadsheetApp.getUi()
    .createMenu(CLIENT_CONFIG.APP_TITLE)
    .addItem('⚙️ Run Setup', 'setupSheets')
    .addItem('🔐 Migrate Portal Permissions', 'migrateUserPortalAccess')
    .addItem('🔐 Update Permissions', 'updatePermissions')
    .addSeparator()
    .addItem('🔄 Push Update to All Clients', 'pushUpdate')
    .addItem('🧭 Rebuild Indexes', 'rebuildAllIndexes')
    .addItem('📅 Reopen Closed Non-final Follow-ups', 'reopenClosedNonFinalFollowupsFromMenu')
    .addSeparator()
    .addItem('🔗 Open Portal', 'openPortal');
  if (String(CLIENT_CONFIG.APP_TITLE || '').toLowerCase().includes('lq')) {
    menu.addItem('Bulk Entry', 'openBulkEntry');
  }
  menu.addToUi();
}

// Forces GAS to exercise every OAuth scope declared in appsscript.json.
// Run this from the menu after adding or changing oauthScopes so Google
// presents the authorization dialog for any newly-added permissions.
function updatePermissions() {
  const ui = SpreadsheetApp.getUi();
  const results = [];
  const errors  = [];

  function probe(label, fn) {
    try { fn(); results.push('✅ ' + label); }
    catch (e) { errors.push('❌ ' + label + ': ' + e.message); }
  }

  // Spreadsheets scope
  probe('Spreadsheets', () => SpreadsheetApp.getActiveSpreadsheet().getId());

  // Drive scope — indirect reference so GAS static scope detection doesn't
  // require it when the scope isn't yet authorized
  probe('Drive', () => {
    const Drive = this['DriveApp'];
    if (!Drive) throw new Error('DriveApp not available');
    Drive.getRootFolder().getId();
  });

  // External requests scope
  probe('External Requests', () => {
    const resp = UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
    if (resp.getResponseCode() < 200) throw new Error('HTTP ' + resp.getResponseCode());
  });

  // User info scope
  probe('User Info', () => {
    const email = Session.getEffectiveUser().getEmail();
    if (!email) throw new Error('No email returned');
  });

  // Script app scope
  probe('Script App', () => ScriptApp.getService().getUrl());

  // Container UI scope (this function itself runs in container, so if we got here it's authorized)
  probe('Container UI', () => SpreadsheetApp.getUi());

  const allOk = errors.length === 0;
  const body  = [...results, ...(errors.length ? ['', ...errors] : [])].join('\n');
  const title = allOk ? '✅ All Permissions Granted' : '⚠️ Permission Issues Found';
  const note  = allOk
    ? '\n\nAll scopes are authorized. You can now redeploy the web app.'
    : '\n\nFailed scopes need attention. Check oauthScopes in appsscript.json.';

  ui.alert(title, body + note, ui.ButtonSet.OK);
}

// Bumps APP_VERSION so every open browser tab detects the change and reloads.
function pushUpdate() {
  const ui = SpreadsheetApp.getUi();
  PropertiesService.getScriptProperties().setProperty('APP_VERSION', String(Date.now()));
  ui.alert('✅ Update Pushed', 'All open portal tabs will reload within 15 seconds.', ui.ButtonSet.OK);
}

function openPortal() {
  const url = ScriptApp.getService().getUrl(); // requires script.scriptapp scope — only runs from sheet menu, not web app
  const html = '<script>window.open("' + url + '", "_blank"); google.script.host.close();<\/script>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(1).setHeight(1),
    'Opening Portal...'
  );
}

function openBulkEntry() {
  const url = ScriptApp.getService().getUrl() + '?page=bulkview';
  const html = '<script>window.open("' + url + '", "_blank"); google.script.host.close();<\/script>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(1).setHeight(1),
    'Opening Bulk Entry...'
  );
}

// ── Write dispatcher ──────────────────────────────────────────────────────────
function _dispatchWrite(fn, email, payload) {
  switch (fn) {
    // ── Leads
    case 'saveLead':          return saveLead(payload, email);
    case 'deleteLead':        return deleteLead(payload.id, email);
    case 'updateLeadStage':   return updateLeadStage(payload.leadId, payload.stageId, payload.note, email, payload.fromStageId || '');
    case 'moveLeadStageWithFields':
      return moveLeadStageWithFields(payload.leadId, payload.stageId, payload.fields || {}, payload.note, email, payload.fromStageId || '');
    case 'pushLeadToNbd':
      return pushLeadToNbd(payload.leadId, email, payload.nbdAssignedTo, payload.mapToNbdLeadId || '', payload.qualifiedRemark || '');
    case 'saveBulkRows':
      return respond(saveBulkRows(payload.rows || [], email, payload.batchId || '', payload.mode || 'create'));
    // ── Follow-ups
    case 'saveFollowup':      return saveFollowup(payload, email);
    case 'markFollowupDone':  return markFollowupDone(payload.id, payload.data || {}, email);
    case 'deleteFollowup':    return deleteFollowup(payload.id, email);
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
  const payload = _normalizeUserIdentityPayload(data);
  const lookupId = data['ID'] || data['User ID'];
  const lookupEmail = data['_Original Email Address'] || data['Email Address'];
  let finalUserId = payload['ID'] || lookupId || '';
  if (lookupId) {
    updateRow(SHEET_NAMES.USERS, 'ID', lookupId, payload);
  } else if (lookupEmail && queryRows(SHEET_NAMES.USERS, u => String(u['Email Address']).trim().toLowerCase() === String(lookupEmail).trim().toLowerCase()).length) {
    updateRow(SHEET_NAMES.USERS, 'Email Address', lookupEmail, payload);
    const updated = queryRows(SHEET_NAMES.USERS, u => String(u['Email Address']).trim().toLowerCase() === String(payload['Email Address']).trim().toLowerCase())[0] || {};
    finalUserId = updated['ID'] || updated['User ID'] || finalUserId || payload['Email Address'];
  } else {
    finalUserId = payload['ID'] || generateUUID();
    insertRow(SHEET_NAMES.USERS, { ...payload, 'ID': finalUserId });
  }
  upsertUserPortalAccess_({ ...payload, 'ID': finalUserId }, data);
  invalidateAppConfigCache();
  return respond(true);
}

function _normalizeUserIdentityPayload(data) {
  const permission = normalizeStaffPermission(data['Permission'] || data['Role']);
  if (!ROLE_PERMISSIONS[permission]) throw new Error('Unsupported permission: ' + permission);
  const payload = {
    'Job Title': data['Job Title'] || '',
    'Department': data['Department'] || '',
    'Email Address': String(data['Email Address'] || '').trim(),
    'Company Phone': data['Company Phone'] || '',
    'Name': data['Name'] || '',
    'Title': data['Title'] || data['Name'] || '',
    'ID': data['ID'] || data['User ID'] || '',
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
    ensureUserPortalAccessSheet_();
    migrateUserPortalAccess_();
    safeInitHeaders(SHEET_NAMES.LEADS, [
      'Lead ID','Company Name','Contact Person','Phone','Alternate No','Email',
      'City','State','Address','GST No','Category',
      'Client Description','Source','Product Interest',
      'Stage ID','Priority','Assigned To','Lead Status',
      'Stage Updated At','Last Follow-up Date','Next Follow-up Date',
      'Source Portal','Source Lead ID','NBD Lead ID','Pushed To NBD At',
      'Created At','Updated At'
    ]);
    ensureFollowupSheets_();
    ensureCustomFieldValueSheets_();
    ensureIndexSheets_();
    safeInitHeaders(SHEET_NAMES.STAGES, [
      'Stage ID','Stage Name','Stage Order','Color','Is Active','Is Final Stage','Is Initial Stage','TAT Days','Is Skippable','Stage Outcome','Created At'
    ]);
    safeInitHeaders(SHEET_NAMES.FIELD_CONFIG, [
      'Field ID','Sheet Name','Field Name','Column Key','Field Type',
      'Stage ID','Dropdown Source','Formula Logic',
      'Validation Min','Validation Max','Validation Regex','Validation Message',
      'Help Text','File Types','Max File MB','Allow Multiple',
      'Is Required','Is Visible','Display Order','Skip Visibility','Per Stage'
    ]);
    safeInitHeaders(SHEET_NAMES.CONFIG, [
      'Config ID','Config Type','Value','Status'
    ]);
    safeInitHeaders(SHEET_NAMES.CHANGE_LOG, [
      'Sequence','Timestamp','Module','Record ID','Action Type','Changed By'
    ]);
    if (String(CLIENT_CONFIG.APP_TITLE || '').toLowerCase().includes('lq') && typeof _ensureBulkSheets_ === 'function') {
      _ensureBulkSheets_();
    }
    _ensureQualifiedRemarksField_();
    _migrateLegacyFollowupData_();
    migrateLegacyCustomFieldValues_();
    rebuildAllIndexes();
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
      ['Lead Status','Open'],['Lead Status','Won'],['Lead Status','Lost'],['Lead Status','Hold'],['Lead Status','Disqualified'],
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

function _ensureQualifiedRemarksField_() {
  const existing = queryRows(SHEET_NAMES.FIELD_CONFIG, r =>
    String(r['Sheet Name'] || 'Leads') === 'Leads' &&
    String(r['Column Key'] || '') === 'CF_Qualified_Remarks'
  );
  if (existing.length) return;
  insertRow(SHEET_NAMES.FIELD_CONFIG, {
    'Field ID': generateUUID(),
    'Sheet Name': 'Leads',
    'Field Name': 'Qualified Remarks',
    'Column Key': 'CF_Qualified_Remarks',
    'Field Type': 'Textarea',
    'Stage ID': '',
    'Dropdown Source': '',
    'Formula Logic': '',
    'Validation Min': '',
    'Validation Max': '',
    'Validation Regex': '',
    'Validation Message': '',
    'Help Text': 'Won stage remark sent to NBD Client Description.',
    'File Types': '',
    'Max File MB': '',
    'Allow Multiple': '',
    'Is Required': false,
    'Is Visible': true,
    'Display Order': 100,
    'Skip Visibility': 'normal',
    'Per Stage': true
  });
}
