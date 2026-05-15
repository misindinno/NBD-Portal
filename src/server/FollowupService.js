// ─── FollowupService.js ──────────────────────────────────────────────────────

function ensureFollowupSheets_() {
  safeInitHeaders(SHEET_NAMES.FOLLOWUPS, [
    'Follow-up ID','Lead ID','Planned Date','Follow-up Date','Follow-up Type',
    'Discussion','Outcome','Next Follow-up Date','Next Action','Status',
    'Done Date','Done By','Updated Stage ID','Created By','Created At','Updated At'
  ]);
  safeInitHeaders(SHEET_NAMES.FOLLOWUP_HISTORY, [
    'History ID','Follow-up ID','Lead ID','Planned Date','Done Date','Done By',
    'Remark','Outcome','Next Planned Date','Status After','Created At'
  ]);
  safeInitHeaders(SHEET_NAMES.LEAD_ACTIVITY_LOGS, [
    'Log ID','Lead ID','Action Type','Old Value','New Value','Remark','Created By','Created At'
  ]);
}

function getFollowups(filters) {
  let rows = _followupRows();
  if (filters && filters.leadId) rows = rows.filter(r => r['Lead ID'] === filters.leadId);
  const status = String(filters && filters.status || '').trim().toLowerCase();
  const includeClosed = !!(filters && (filters.includeClosed || status === 'all'));
  if (status && status !== 'all') {
    rows = rows.filter(r => String(r['Status'] || 'Open').toLowerCase() === status);
  } else if (!includeClosed) {
    rows = rows.filter(_isOpenFollowup);
  }
  return rows.sort(_sortFollowupsByCreated);
}

function getFollowupHistory(filters) {
  let rows = _followupHistoryRows();
  if (filters && filters.leadId) rows = rows.filter(r => r['Lead ID'] === filters.leadId);
  if (filters && filters.followupId) rows = rows.filter(r => r['Follow-up ID'] === filters.followupId);
  return rows.sort((a, b) => _timeValue(b['Created At'] || b['Done Date']) - _timeValue(a['Created At'] || a['Done Date']));
}

function getLeadActivityLogs(filters) {
  let rows = _leadActivityRows();
  if (filters && filters.leadId) rows = rows.filter(r => r['Lead ID'] === filters.leadId);
  return rows.sort((a, b) => _timeValue(b['Created At']) - _timeValue(a['Created At']));
}

function getTodayFollowups() {
  const t = today();
  return _followupRows().filter(r => _isOpenFollowup(r) && formatDate(_plannedDate(r)) === t);
}

function getOverdueFollowups() {
  const t = today();
  return _followupRows().filter(r => {
    const d = formatDate(_plannedDate(r));
    return _isOpenFollowup(r) && d && d < t;
  });
}

function saveFollowup(data, email) {
  ensureFollowupSheets_();
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES', 'USER']);
  let lead = null;
  if (data['Lead ID']) {
    lead = queryRows(SHEET_NAMES.LEADS, r => r['Lead ID'] === data['Lead ID'])[0];
    if (!lead) return respond(null, 'Lead not found.');
    if (!_canWriteFollowupForLead(lead, user)) return respond(null, 'Permission denied.');
  }
  const id = generateUUID();
  const payload = _prepareFollowupPayload(data);
  const plannedDate = _plannedDate(payload) || today();
  const row = {
    ...payload,
    'Follow-up ID': id,
    'Planned Date': plannedDate,
    'Follow-up Date': payload['Follow-up Date'] || plannedDate,
    'Next Follow-up Date': plannedDate,
    'Status': 'Open',
    'Outcome': payload['Outcome'] || '',
    'Created By': user.id,
    'Created At': now(),
    'Updated At': now()
  };
  insertRow(SHEET_NAMES.FOLLOWUPS, pickFollowupMasterFields_(row));
  upsertCustomFieldValues_('Followups', id, payload, user.id);
  if (lead) {
    const updates = { 'Next Follow-up Date': plannedDate, 'Updated At': now() };
    if (payload['Updated Stage ID']) updates['Stage ID'] = payload['Updated Stage ID'];
    const leadUpdated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', payload['Lead ID'], updates);
    if (!leadUpdated) {
      // Follow-up was saved; log that the linked lead could not be updated (may have been deleted concurrently)
      Logger.log('saveFollowup: follow-up saved but lead row not found for Lead ID ' + payload['Lead ID']);
    }
    _bumpStamp('leads');
  }
  _bumpStamp('followups');
  return respond(id);
}

function markFollowupDone(followupId, data, email) {
  ensureFollowupSheets_();
  const user = requireRole(['ADMIN', 'MANAGER', 'SALES', 'USER']);
  const row = _followupRows().filter(r => r['Follow-up ID'] === followupId)[0];
  if (!row) return respond(null, 'Follow-up not found.');

  const lead = row['Lead ID']
    ? queryRows(SHEET_NAMES.LEADS, r => r['Lead ID'] === row['Lead ID'])[0]
    : null;
  if (row['Lead ID'] && !lead) return respond(null, 'Linked lead not found.');
  if (!_canWriteFollowupRow(row, lead, user)) return respond(null, 'Permission denied.');

  const doneDate = formatDate(data['Done Date'] || today());
  const nextDate = formatDate(data['Next Follow-up Date'] || data['Next Planned Date'] || '');
  const remark = String(data['Remark'] || '').trim();
  if (!remark) return respond(null, 'Done remark is required.');

  const statusAfter = nextDate ? 'Open' : 'Closed';
  const history = {
    'History ID': generateUUID(),
    'Follow-up ID': followupId,
    'Lead ID': row['Lead ID'] || '',
    'Planned Date': _plannedDate(row),
    'Done Date': doneDate,
    'Done By': user.id,
    'Remark': remark,
    'Outcome': data['Outcome'] || row['Outcome'] || '',
    'Next Planned Date': nextDate,
    'Status After': statusAfter,
    'Created At': now()
  };
  insertRow(SHEET_NAMES.FOLLOWUP_HISTORY, history);

  const followupPatch = {
    'Status': statusAfter,
    'Outcome': nextDate ? '' : (data['Outcome'] || row['Outcome'] || ''),
    'Updated At': now()
  };
  if (nextDate) {
    followupPatch['Planned Date'] = nextDate;
    followupPatch['Next Follow-up Date'] = nextDate;
    followupPatch['Next Action'] = data['Next Action'] || row['Next Action'] || '';
    followupPatch['Done Date'] = '';
    followupPatch['Done By'] = '';
  } else {
    followupPatch['Next Follow-up Date'] = '';
    followupPatch['Done Date'] = doneDate;
    followupPatch['Done By'] = user.id;
  }
  if (data['Updated Stage ID']) followupPatch['Updated Stage ID'] = data['Updated Stage ID'];
  const updated = updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followupId, followupPatch);
  if (!updated) return respond(null, 'Follow-up record not found — it may have been deleted. Please refresh and try again.');

  let leadPatch = null;
  let activityLog = null;
  if (lead) {
    leadPatch = {
      'Last Follow-up Date': doneDate,
      'Next Follow-up Date': nextDate,
      'Updated At': now()
    };
    if (data['Updated Stage ID'] && data['Updated Stage ID'] !== lead['Stage ID']) {
      const stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === data['Updated Stage ID'])[0];
      if (!stage) return respond(null, 'Selected stage not found.');
      // Validate required custom fields for the new stage and save their values.
      // _prepareLeadPayload merges existing lead values so only stage-specific
      // fields the user submitted are required to be new.
      const prepared = _prepareLeadPayload(data, data['Updated Stage ID'], lead);
      upsertCustomFieldValues_('Leads', lead['Lead ID'], prepared, user.id, data['Updated Stage ID']);
      leadPatch['Stage ID'] = data['Updated Stage ID'];
      const nextStatus = _leadStatusForStage(stage);
      if (nextStatus) leadPatch['Lead Status'] = nextStatus;
      activityLog = insertLeadActivityLog_(
        lead['Lead ID'],
        'Stage Change',
        lead['Stage ID'] || '',
        data['Updated Stage ID'],
        remark,
        user.id
      );
    }
    updateRow(SHEET_NAMES.LEADS, 'Lead ID', lead['Lead ID'], leadPatch);
    _bumpStamp('leads');
  }

  _bumpStamp('followups');
  _bumpStamp('followup_history');
  return respond({
    followup: { ...row, ...followupPatch },
    history,
    leadId: row['Lead ID'] || '',
    leadPatch,
    activityLog
  });
}

function _canWriteFollowupForLead(lead, user) {
  return ['ADMIN', 'MANAGER'].includes(user.role) || lead['Assigned To'] === user.id;
}

function _canWriteFollowupRow(row, lead, user) {
  if (['ADMIN', 'MANAGER'].includes(user.role)) return true;
  if (lead) return _canWriteFollowupForLead(lead, user);
  return row['Created By'] === user.id;
}

function getFollowupCustomFields() {
  return queryRows(SHEET_NAMES.FIELD_CONFIG, r =>
      r['Sheet Name'] === 'Followups' &&
      (r['Is Visible'] !== false && r['Is Visible'] !== 'FALSE')
    )
    .sort((a, b) => Number(a['Display Order']) - Number(b['Display Order']));
}

function _prepareFollowupPayload(data) {
  const payload = { ...data };
  const fields = getFollowupCustomFields();
  fields.forEach(field => {
    const key = field['Column Key'];
    let value = payload[key];
    if (field['Field Type'] === 'Formula') return;
    if (field['Field Type'] === 'Checkbox') value = value === true || value === 'TRUE' || value === 'on' ? 'TRUE' : '';
    if (field['Field Type'] === 'Multi Select' && Array.isArray(value)) value = value.join(', ');
    if (field['Field Type'] === 'File' && value && typeof value === 'object') value = _uploadCustomFieldFile(value, field);
    _validateCustomFieldValue(field, value);
    if (value !== undefined) payload[key] = value;
  });
  return payload;
}

function deleteFollowup(followupId, email) {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  const user = result.data;
  const isMIS = String(user.designation || '').trim().toUpperCase() === 'MIS';
  if (!isMIS) throw new Error('Permission denied. Only MIS designation users can delete follow-ups.');
  deleteRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followupId);
  _bumpStamp('followups');
  return respond(true);
}

function _followupRows() {
  return getRowsWithCustomFieldValues_('Followups', getAllRows(SHEET_NAMES.FOLLOWUPS))
    .filter(_isFollowupTaskRow)
    .map(_normalizeFollowupRow);
}

function _followupHistoryRows() {
  return getAllRows(SHEET_NAMES.FOLLOWUP_HISTORY);
}

function _leadActivityRows() {
  return getAllRows(SHEET_NAMES.LEAD_ACTIVITY_LOGS);
}

function _normalizeFollowupRow(row) {
  const planned = _plannedDate(row);
  const status = row['Status'] || (row['Outcome'] || row['Done Date'] ? 'Closed' : 'Open');
  return {
    ...row,
    'Planned Date': planned,
    'Follow-up Date': row['Follow-up Date'] || planned,
    'Next Follow-up Date': row['Next Follow-up Date'] || planned,
    'Status': status
  };
}

function _isFollowupTaskRow(row) {
  return String(row && row['Follow-up Type'] || '').toLowerCase() !== 'stage change';
}

function _isOpenFollowup(row) {
  return String(row && row['Status'] || 'Open').toLowerCase() !== 'closed';
}

function _plannedDate(row) {
  return row && (row['Planned Date'] || row['Next Follow-up Date'] || row['Follow-up Date'] || '');
}

function _sortFollowupsByCreated(a, b) {
  return _timeValue(b['Created At']) - _timeValue(a['Created At']);
}

function _timeValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const time = new Date(normalized).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function insertLeadActivityLog_(leadId, actionType, oldValue, newValue, remark, userId) {
  ensureFollowupSheets_();
  const row = {
    'Log ID': generateUUID(),
    'Lead ID': leadId || '',
    'Action Type': actionType || 'Activity',
    'Old Value': oldValue || '',
    'New Value': newValue || '',
    'Remark': remark || '',
    'Created By': userId || '',
    'Created At': now()
  };
  insertRow(SHEET_NAMES.LEAD_ACTIVITY_LOGS, row);
  _bumpStamp('activity_logs');
  return row;
}

function _migrateLegacyFollowupData_() {
  ensureFollowupSheets_();
  const followups = getAllRows(SHEET_NAMES.FOLLOWUPS);
  const existingLogs = getAllRows(SHEET_NAMES.LEAD_ACTIVITY_LOGS).reduce((m, r) => {
    m[r['Log ID']] = true;
    return m;
  }, {});
  const existingHistory = getAllRows(SHEET_NAMES.FOLLOWUP_HISTORY).reduce((m, r) => {
    m[r['History ID']] = true;
    return m;
  }, {});
  let logsInserted = 0;
  let historyInserted = 0;

  followups.forEach(row => {
    const id = row['Follow-up ID'];
    if (!id) return;
    if (String(row['Follow-up Type'] || '').toLowerCase() === 'stage change') {
      const logId = 'LEGACY-' + id;
      if (!existingLogs[logId]) {
        insertRow(SHEET_NAMES.LEAD_ACTIVITY_LOGS, {
          'Log ID': logId,
          'Lead ID': row['Lead ID'] || '',
          'Action Type': 'Stage Change',
          'Old Value': '',
          'New Value': row['Updated Stage ID'] || '',
          'Remark': row['Discussion'] || '',
          'Created By': row['Created By'] || '',
          'Created At': row['Created At'] || row['Follow-up Date'] || now()
        });
        logsInserted++;
      }
      return;
    }

    const status = String(row['Status'] || '').toLowerCase();
    const looksClosed = status === 'closed' || row['Outcome'] || row['Done Date'];
    if (!looksClosed) return;
    const historyId = 'LEGACY-' + id;
    if (existingHistory[historyId]) return;
    insertRow(SHEET_NAMES.FOLLOWUP_HISTORY, {
      'History ID': historyId,
      'Follow-up ID': id,
      'Lead ID': row['Lead ID'] || '',
      'Planned Date': _plannedDate(row),
      'Done Date': row['Done Date'] || row['Follow-up Date'] || row['Created At'] || '',
      'Done By': row['Done By'] || row['Created By'] || '',
      'Remark': row['Discussion'] || '',
      'Outcome': row['Outcome'] || '',
      'Next Planned Date': row['Next Follow-up Date'] || '',
      'Status After': 'Closed',
      'Created At': row['Updated At'] || row['Created At'] || now()
    });
    historyInserted++;
  });

  if (logsInserted) _bumpStamp('activity_logs');
  if (historyInserted) _bumpStamp('followup_history');
}
