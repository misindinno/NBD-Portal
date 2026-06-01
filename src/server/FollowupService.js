// ─── FollowupService.js ──────────────────────────────────────────────────────

function ensureFollowupSheets_() {
  safeInitHeaders(SHEET_NAMES.FOLLOWUPS, [
    'Follow-up ID','Lead ID','Planned Date','Follow-up Date','Follow-up Type',
    'Discussion','Outcome','Next Follow-up Date','Next Action','Status',
    'Done Date','Done By','Stage ID','Updated Stage ID','Created By','Created At','Updated At'
  ]);
  safeInitHeaders(SHEET_NAMES.FOLLOWUP_HISTORY, [
    'History ID','Follow-up ID','Lead ID','Planned Date','Done Date','Done By',
    'Follow-up Type','Contact Mode','Remark','Outcome','Next Planned Date','Status After','Stage ID','Updated Stage ID','Created At'
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
  if (filters && (filters.dateFrom || filters.dateTo)) {
    const from = String(filters.dateFrom || '');
    const to = String(filters.dateTo || '');
    rows = rows.filter(r => {
      const d = _fmtFollowupDate_(r['Created At'] || r['Done Date'] || '');
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  return rows.sort((a, b) => _timeValue(b['Created At'] || b['Done Date']) - _timeValue(a['Created At'] || a['Done Date']));
}

function getLeadActivityLogs(filters) {
  let rows = _leadActivityRows();
  if (filters && filters.leadId) rows = rows.filter(r => r['Lead ID'] === filters.leadId);
  if (filters && (filters.dateFrom || filters.dateTo)) {
    const from = String(filters.dateFrom || '');
    const to = String(filters.dateTo || '');
    rows = rows.filter(r => {
      const d = _fmtFollowupDate_(r['Created At'] || '');
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  return rows.sort((a, b) => _timeValue(b['Created At']) - _timeValue(a['Created At']));
}

function getFollowupWorklist(filters, user) {
  filters = filters || {};
  const tab = String(filters.tab || 'all').toLowerCase();
  const pageSize = Math.max(10, Math.min(100, Number(filters.pageSize) || 25));
  const page = Math.max(1, Number(filters.page) || 1);
  const allFollowups = _scopeFollowupRows(getFollowups({ includeClosed: true }), user)
    .filter(r => String(r['Follow-up Type'] || '').toLowerCase() !== 'stage change');
  const scopedLeads = _scopeAssignedRows(_leadRows(), user);
  const leadMap = scopedLeads.reduce((m, l) => { if (l['Lead ID']) m[l['Lead ID']] = l; return m; }, {});
  const userMap = _buildUserMapById_();
  const stageMap = getAllRows(SHEET_NAMES.STAGES).reduce((m, s) => { if (s['Stage ID']) m[s['Stage ID']] = s; return m; }, {});
  const todayStr = today();
  const openScheduled = allFollowups
    .filter(_isOpenFollowup)
    .filter(r => !!_fmtFollowupDate_(r['Next Follow-up Date'] || r['Next Planned Date']));
  const noNextClosed = allFollowups
    .filter(r => !_fmtFollowupDate_(r['Next Follow-up Date'] || r['Next Planned Date']));
  const counts = openScheduled.reduce((m, r) => {
    const d = _fmtFollowupDate_(r['Next Follow-up Date'] || r['Next Planned Date']);
    if (d < todayStr) m.overdue++;
    else if (d === todayStr) m.today++;
    else if (d > todayStr) m.future++;
    return m;
  }, { all: openScheduled.length, today: 0, overdue: 0, future: 0, closed: noNextClosed.length });

  let rows;
  if (tab === 'closed') {
    const historyRows = _scopeFollowupHistoryRows(getFollowupHistory({}), user)
      .filter(r => String(r['Follow-up Type'] || '').toLowerCase() !== 'stage change');
    const historyIds = historyRows.reduce((m, r) => { if (r['Follow-up ID']) m[String(r['Follow-up ID'])] = true; return m; }, {});
    rows = historyRows.concat(noNextClosed.filter(r => !historyIds[String(r['Follow-up ID'] || '')]));
    counts.closed = rows.length;
  } else {
    rows = openScheduled;
    if (tab === 'today') rows = rows.filter(r => _fmtFollowupDate_(r['Next Follow-up Date'] || r['Next Planned Date']) === todayStr);
    else if (tab === 'overdue') rows = rows.filter(r => _fmtFollowupDate_(r['Next Follow-up Date'] || r['Next Planned Date']) < todayStr);
    else if (tab === 'future') rows = rows.filter(r => _fmtFollowupDate_(r['Next Follow-up Date'] || r['Next Planned Date']) > todayStr);
  }

  rows = _filterFollowupWorklistRows_(rows, filters, leadMap);
  rows = rows.sort(_sortFollowupWorklistRows_);
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize).map(r => _decorateWorklistRow_(r, leadMap, userMap, stageMap));
  return { rows: pageRows, total, page, pageSize, counts };
}

function saveFollowup(data, email) {
  ensureFollowupSheets_();
  const user = requireRole(['ADMIN']);
  let lead = null;
  let stage = null;
  let preparedLeadForStage = null;
  if (data['Lead ID']) {
    lead = queryRows(SHEET_NAMES.LEADS, r => r['Lead ID'] === data['Lead ID'])[0];
    if (!lead) return respond(null, 'Lead not found.');
    if (!_canWriteFollowupForLead(lead, user)) return respond(null, 'Permission denied.');
    if (_isLeadPushedToNbd_(lead)) return respond(null, 'Lead is already pushed to NBD and follow-ups are locked in LQ.');
  }
  const id = generateUUID();
  const payload = _prepareFollowupPayload(data);
  const skipped = payload['__stage_skipped'] === 'true' || payload['__stage_skipped'] === true;
  if (lead && payload['Updated Stage ID'] && payload['Updated Stage ID'] !== lead['Stage ID']) {
    stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === payload['Updated Stage ID'])[0];
    if (!stage) return respond(null, 'Selected stage not found.');
    const moveCheck = _validateLeadStageMove_(lead['Stage ID'], payload['Updated Stage ID']);
    if (!moveCheck.ok) return respond(null, moveCheck.message);
    preparedLeadForStage = _prepareLeadPayload(payload, payload['Updated Stage ID'], lead, skipped);
  }
  const plannedDate = _plannedDate(payload) || today();
  const row = {
    ...payload,
    'Follow-up ID': id,
    'Planned Date': plannedDate,
    'Follow-up Date': payload['Follow-up Date'] || plannedDate,
    'Next Follow-up Date': plannedDate,
    'Status': 'Open',
    'Outcome': payload['Outcome'] || '',
    'Stage ID': lead && lead['Stage ID'] || payload['Stage ID'] || '',
    'Created By': user.id,
    'Created At': now(),
    'Updated At': now()
  };
  try {
    insertRow(SHEET_NAMES.FOLLOWUPS, pickFollowupMasterFields_(row));
    upsertCustomFieldValues_('Followups', id, payload, user.id);
  } catch (e) {
    deleteRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', id);
    deleteCustomFieldValuesForEntity_('Followups', id);
    throw e;
  }
  if (lead) {
    const updates = { 'Next Follow-up Date': plannedDate, 'Updated At': now() };
    let activityLog = null;
    if (stage) {
      upsertCustomFieldValues_('Leads', lead['Lead ID'], preparedLeadForStage, user.id, payload['Updated Stage ID']);
      updates['Stage ID'] = payload['Updated Stage ID'];
      updates['Stage Updated At'] = now();
      const nextStatus = _leadStatusForStage(stage);
      if (nextStatus) {
        updates['Lead Status'] = nextStatus;
        updates['Next Follow-up Date'] = '';
      }
      activityLog = {
        leadId: lead['Lead ID'],
        oldStageId: lead['Stage ID'] || '',
        newStageId: payload['Updated Stage ID'],
        remark: payload['Discussion'] || payload['Remark'] || ''
      };
    }
    const leadUpdated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', payload['Lead ID'], updates);
    if (!leadUpdated) {
      // Follow-up was saved; log that the linked lead could not be updated (may have been deleted concurrently)
      Logger.log('saveFollowup: follow-up saved but lead row not found for Lead ID ' + payload['Lead ID']);
    } else if (activityLog) {
      insertLeadActivityLog_(
        activityLog.leadId,
        'Stage Change',
        activityLog.oldStageId,
        activityLog.newStageId,
        activityLog.remark,
        user.id
      );
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
  if (_isLeadPushedToNbd_(lead)) return respond(null, 'Lead is already pushed to NBD and follow-ups are locked in LQ.');

  const doneDate = formatDate(data['Done Date'] || today());
  const nextDate = formatDate(data['Next Follow-up Date'] || data['Next Planned Date'] || '');
  const remark = String(data['Remark'] || '').trim();
  if (!remark) return respond(null, 'Done remark is required.');

  // Pre-validate stage before any writes to avoid partial-write inconsistency
  const skipped = data['__stage_skipped'] === 'true' || data['__stage_skipped'] === true;
  let stage = null;
  let preparedLeadForStage = null;
  if (lead && data['Updated Stage ID'] && data['Updated Stage ID'] !== lead['Stage ID']) {
    stage = queryRows(SHEET_NAMES.STAGES, r => r['Stage ID'] === data['Updated Stage ID'])[0];
    if (!stage) return respond(null, 'Selected stage not found.');
    const moveCheck = _validateLeadStageMove_(lead['Stage ID'], data['Updated Stage ID']);
    if (!moveCheck.ok) return respond(null, moveCheck.message);
    preparedLeadForStage = _prepareLeadPayload(data, data['Updated Stage ID'], lead, skipped);
  }

  const statusAfter = nextDate ? 'Open' : 'Closed';
  const history = {
    'History ID': generateUUID(),
    'Follow-up ID': followupId,
    'Lead ID': row['Lead ID'] || '',
    'Planned Date': _plannedDate(row),
    'Done Date': doneDate,
    'Done By': user.id,
    'Follow-up Type': row['Follow-up Type'] || '',
    'Contact Mode': String(data['Contact Mode'] || ''),
    'Remark': remark,
    'Outcome': data['Outcome'] || row['Outcome'] || '',
    'Next Planned Date': nextDate,
    'Status After': statusAfter,
    'Stage ID': row['Stage ID'] || lead && lead['Stage ID'] || '',
    'Updated Stage ID': data['Updated Stage ID'] || row['Updated Stage ID'] || '',
    'Created At': now()
  };

  const followupPatch = {
    'Status': statusAfter,
    'Outcome': nextDate ? '' : (data['Outcome'] || row['Outcome'] || ''),
    'Updated At': now()
  };
  if (nextDate) {
    followupPatch['Planned Date'] = nextDate;
    followupPatch['Next Follow-up Date'] = nextDate;
    followupPatch['Next Action'] = data['Next Action'] || row['Next Action'] || '';
    followupPatch['Stage ID'] = data['Updated Stage ID'] || lead && lead['Stage ID'] || row['Stage ID'] || '';
    followupPatch['Done Date'] = '';
    followupPatch['Done By'] = '';
  } else {
    followupPatch['Planned Date'] = '';
    followupPatch['Next Follow-up Date'] = '';
    followupPatch['Done Date'] = doneDate;
    followupPatch['Done By'] = user.id;
  }
  if (data['Updated Stage ID']) followupPatch['Updated Stage ID'] = data['Updated Stage ID'];
  const updated = updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followupId, followupPatch);
  if (!updated) return respond(null, 'Follow-up record not found — it may have been deleted. Please refresh and try again.');

  // Write history only after the followup row update succeeds. If this fails,
  // restore the follow-up row so "done" and history do not drift apart.
  try {
    insertRow(SHEET_NAMES.FOLLOWUP_HISTORY, history);
  } catch (e) {
    updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followupId, pickFollowupMasterFields_(row));
    throw e;
  }

  let leadPatch = null;
  let activityLog = null;
  if (lead) {
    leadPatch = {
      'Last Follow-up Date': doneDate,
      'Next Follow-up Date': nextDate,
      'Updated At': now()
    };
    if (stage) {
      upsertCustomFieldValues_('Leads', lead['Lead ID'], preparedLeadForStage, user.id, data['Updated Stage ID']);
      leadPatch['Stage ID'] = data['Updated Stage ID'];
      leadPatch['Stage Updated At'] = now();
      const nextStatus = _leadStatusForStage(stage);
      if (nextStatus) {
        leadPatch['Lead Status'] = nextStatus;
        leadPatch['Next Follow-up Date'] = '';
      }
      activityLog = {
        leadId: lead['Lead ID'],
        oldStageId: lead['Stage ID'] || '',
        newStageId: data['Updated Stage ID'],
        remark
      };
    }
    const leadUpdated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', lead['Lead ID'], leadPatch);
    if (!leadUpdated) {
      Logger.log('markFollowupDone: follow-up saved but lead row not found for Lead ID ' + lead['Lead ID']);
      activityLog = null;
    } else if (activityLog) {
      activityLog = insertLeadActivityLog_(
        activityLog.leadId,
        'Stage Change',
        activityLog.oldStageId,
        activityLog.newStageId,
        activityLog.remark,
        user.id
      );
    }
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
  const isMIS = String(user.department || '').trim().toUpperCase() === 'MIS';
  if (!isMIS && user.role !== 'ADMIN') throw new Error('Permission denied. Only MIS or Admin users can delete follow-ups.');
  const row = _followupRows().filter(r => r['Follow-up ID'] === followupId)[0];
  const lead = row && row['Lead ID']
    ? queryRows(SHEET_NAMES.LEADS, r => r['Lead ID'] === row['Lead ID'])[0]
    : null;
  if (_isLeadPushedToNbd_(lead)) throw new Error('Lead is already pushed to NBD and follow-ups are locked in LQ.');
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
  const status = row['Status'] || (row['Outcome'] || row['Done Date'] ? 'Closed' : 'Open');
  const isClosed = String(status || '').toLowerCase() === 'closed';
  const nextPlanned = row['Next Follow-up Date'] || row['Next Planned Date'] || '';
  const planned = nextPlanned || (isClosed ? _plannedDate(row) : '');
  return {
    ...row,
    'Planned Date': planned,
    'Follow-up Date': row['Follow-up Date'] || planned,
    'Next Follow-up Date': nextPlanned,
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

function _fmtFollowupDate_(value) {
  if (!value) return '';
  return formatDate(value);
}

function _filterFollowupWorklistRows_(rows, filters, leadMap) {
  const search = String(filters.search || '').trim().toLowerCase();
  const type = String(filters.type || '');
  const assignedTo = String(filters.assignedTo || '');
  const contactMode = String(filters.contactMode || '');
  const stage = String(filters.stage || '');
  const dateFrom = String(filters.dateFrom || '');
  const dateTo = String(filters.dateTo || '');
  return rows.filter(row => {
    const lead = leadMap[row['Lead ID']] || {};
    if (search) {
      const haystack = [
        lead['Company Name'], lead['Contact Person'], lead.Phone,
        row.Discussion, row.Remark, row.Outcome, row['Next Action']
      ].map(v => String(v || '').toLowerCase()).join(' ');
      if (!haystack.includes(search)) return false;
    }
    if (type && String(row['Follow-up Type'] || '') !== type) return false;
    if (assignedTo && lead['Assigned To'] !== assignedTo) return false;
    if (contactMode && String(row['Contact Mode'] || '') !== contactMode) return false;
    if (stage && lead['Stage ID'] !== stage && row['Stage ID'] !== stage && row['Updated Stage ID'] !== stage) return false;
    const rowDate = _fmtFollowupDate_(row['Done Date'] || row['Next Follow-up Date'] || row['Next Planned Date'] || row['Created At']);
    if (dateFrom && rowDate && rowDate < dateFrom) return false;
    if (dateTo && rowDate && rowDate > dateTo) return false;
    return true;
  });
}

function _sortFollowupWorklistRows_(a, b) {
  const ad = _fmtFollowupDate_(a['Next Follow-up Date'] || a['Next Planned Date']) || '9999-12-31';
  const bd = _fmtFollowupDate_(b['Next Follow-up Date'] || b['Next Planned Date']) || '9999-12-31';
  if (ad !== bd) return ad.localeCompare(bd);
  return _timeValue(b['Created At'] || b['Done Date']) - _timeValue(a['Created At'] || a['Done Date']);
}

function _decorateWorklistRow_(row, leadMap, userMap, stageMap) {
  const lead = leadMap[row['Lead ID']] || {};
  const stage = stageMap[row['Updated Stage ID'] || row['Stage ID'] || lead['Stage ID']] || {};
  const assignedUser = userMap[lead['Assigned To']] || {};
  const createdUser = userMap[row['Created By']] || {};
  return {
    ...row,
    _companyName: lead['Company Name'] || lead['Client Description'] || '',
    _contactPerson: lead['Contact Person'] || '',
    _city: lead.City || '',
    _leadPhone: lead.Phone || '',
    _leadLabel: lead['Lead ID'] ? ((lead['Company Name'] || lead['Client Description'] || lead['Lead ID']) + (lead.Phone ? ' - ' + lead.Phone : '')) : '',
    _assignedToLabel: assignedUser.Name || lead['Assigned To'] || '',
    _createdByLabel: createdUser.Name || row['Created By'] || '',
    _leadStageLabel: stage['Stage Name'] || '',
    _remarkLabel: row.Remark || row.Discussion || ''
  };
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
    'Remark': _leadActivityRemark_(actionType, newValue, remark),
    'Created By': userId || '',
    'Created At': now()
  };
  insertRow(SHEET_NAMES.LEAD_ACTIVITY_LOGS, row);
  _bumpStamp('activity_logs');
  return row;
}

function _leadActivityRemark_(actionType, newValue, remark) {
  const text = String(remark || '').trim();
  if (text) return text;
  if (String(actionType || '').toLowerCase().includes('stage')) {
    const stage = queryRows(SHEET_NAMES.STAGES, r => String(r['Stage ID']) === String(newValue))[0];
    return 'Stage updated to ' + (stage && stage['Stage Name'] || newValue || 'next stage');
  }
  return '';
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
      'Follow-up Type': row['Follow-up Type'] || '',
      'Remark': row['Discussion'] || '',
      'Outcome': row['Outcome'] || '',
      'Next Planned Date': row['Next Follow-up Date'] || '',
      'Status After': 'Closed',
      'Stage ID': row['Stage ID'] || '',
      'Updated Stage ID': row['Updated Stage ID'] || '',
      'Created At': row['Updated At'] || row['Created At'] || now()
    });
    historyInserted++;
  });

  if (logsInserted) _bumpStamp('activity_logs');
  if (historyInserted) _bumpStamp('followup_history');
}
