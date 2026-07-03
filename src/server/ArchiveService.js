function getArchiveData(user) {
  ensureArchiveSchema_();
  const scopedLeads = _scopeAssignedRows(
    getRowsWithCustomFieldValues_('Leads', getAllRows(SHEET_NAMES.LEADS)),
    user
  );
  const followupRows = getAllRows(SHEET_NAMES.FOLLOWUPS);
  const historyRows = getAllRows(SHEET_NAMES.FOLLOWUP_HISTORY);
  const notPickedByLead = historyRows.reduce((map, row) => {
    if (String(row['Contact Mode'] || '').trim() !== 'Not Picked') return map;
    const leadId = String(row['Lead ID'] || '').trim();
    if (!leadId) return map;
    map[leadId] = (map[leadId] || 0) + 1;
    return map;
  }, {});
  const followupByLead = followupRows.reduce((map, row) => {
    const leadId = String(row['Lead ID'] || '').trim();
    if (!leadId) return map;
    if (!map[leadId]) map[leadId] = [];
    map[leadId].push(row);
    return map;
  }, {});

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 28);

  const archived = [];
  const alerts = [];
  scopedLeads.forEach(lead => {
    const leadId = String(lead['Lead ID'] || '').trim();
    if (!leadId) return;
    const enriched = _archiveEnrichLead_(lead, followupByLead[leadId] || [], notPickedByLead[leadId] || 0);
    if (_isArchivedLead_(lead)) {
      archived.push(enriched);
      return;
    }
    if (_archiveLeadNeedsAlert_(lead, notPickedByLead[leadId] || 0, cutoff)) alerts.push(enriched);
  });
  return {
    alerts: alerts.sort((a, b) => Number(b._notPickedCount || 0) - Number(a._notPickedCount || 0)),
    archived: archived.sort((a, b) => new Date(b['Archived At'] || 0) - new Date(a['Archived At'] || 0))
  };
}

// ── Archive suggestions ─────────────────────────────────────────────────────────
// Leads that have been "connected" on a call this many times in a row (no break) are
// likely being chased with no result → suggested for archiving.
const ARCHIVE_SUGGESTION_CONNECTED_ = { 'Call Connected': true };
const ARCHIVE_SUGGESTION_MIN_STREAK_ = 7;

function _archiveHistTime_(h) {
  const v = (h && (h['Done Date'] || h['Created At'])) || '';
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;                 // Sheets serial — monotonic, fine for sorting
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

// Reads leads + follow-up history via the Advanced Sheets service (batchGet) and returns
// the leads whose follow-up history contains a run of >= MIN_STREAK consecutive
// "Call Connected" contacts. SpreadsheetApp fallback is handled inside sheetApiBatchGetRows_.
function getArchiveSuggestionsFast_(user) {
  ensureArchiveSchema_();
  _bootstrapReadMode_ = true;
  let rows;
  try {
    rows = sheetApiBatchGetRows_([
      { sheetName: SHEET_NAMES.LEADS, range: 'A:AC' },
      { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:Z' }
    ]);
  } finally { _bootstrapReadMode_ = false; }

  const leads = _scopeAssignedRows(
    (rows[SHEET_NAMES.LEADS] || []).filter(l => !_isArchivedLead_(l) && !_isLeadPushedToNbd_(l)),
    user
  );
  const history = rows[SHEET_NAMES.FOLLOWUP_HISTORY] || [];

  const byLead = {};
  history.forEach(h => {
    const id = String(h['Lead ID'] || '').trim();
    if (!id) return;
    (byLead[id] || (byLead[id] = [])).push(h);
  });

  const suggestions = [];
  leads.forEach(lead => {
    const id = String(lead['Lead ID'] || '').trim();
    if (!id) return;
    const hist = (byLead[id] || []).slice().sort((a, b) => _archiveHistTime_(a) - _archiveHistTime_(b));
    let streak = 0, maxStreak = 0, total = 0, lastConnected = '';
    hist.forEach(h => {
      const mode = String(h['Contact Mode'] || '').trim();
      if (!mode) return;                                 // system / stage-change rows: not a contact attempt
      if (ARCHIVE_SUGGESTION_CONNECTED_[mode]) {
        streak++; total++;
        if (streak > maxStreak) maxStreak = streak;
        lastConnected = h['Done Date'] || h['Created At'] || lastConnected;
      } else {
        streak = 0;                                      // Not Picked / other contact breaks the run
      }
    });
    if (maxStreak >= ARCHIVE_SUGGESTION_MIN_STREAK_) {
      suggestions.push(Object.assign({}, lead, {
        _connectedStreak: maxStreak,
        _connectedTotal: total,
        _lastConnectedDate: lastConnected
      }));
    }
  });
  return suggestions.sort((a, b) =>
    (b._connectedStreak - a._connectedStreak) || (b._connectedTotal - a._connectedTotal)
  );
}

function archiveLead(leadId, reason, email) {
  ensureArchiveSchema_();
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  const user = result.data;
  if (!(user.role === 'ADMIN' || userHasModule(user, 'Archive'))) throw new Error('Permission denied.');

  const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canReadAssignedRow(lead, user)) return respond(null, 'Permission denied.');
  if (_isArchivedLead_(lead)) return respond(leadId);

  const ts = now();
  const patch = {
    'Lead Status': 'Archived',
    'Is Archived': true,
    'Archived At': ts,
    'Archived By': user.id,
    'Archive Reason': String(reason || '').trim() || 'Archived from portal',
    'Next Follow-up Date': '',
    'Updated At': ts
  };
  const updated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_(patch));
  if (!updated) return respond(null, 'Lead not found.');

  getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId).forEach(followup => {
    if (!followup['Follow-up ID']) return;
    updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID'], {
      'Status': 'Archived',
      'Next Follow-up Date': '',
      'Planned Date': '',
      'Updated At': ts
    });
  });
  insertLeadActivityLog_(leadId, 'Archive Lead', '', 'Archived', patch['Archive Reason'], user.id);
  _bumpArchiveStamps_();
  return respond({ leadId, patch });
}

function restoreArchivedLead(leadId, email) {
  ensureArchiveSchema_();
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  const user = result.data;
  if (!(user.role === 'ADMIN' || userHasModule(user, 'Archive'))) throw new Error('Permission denied.');

  const lead = getRowByIndexedId_(SHEET_NAMES.LEADS, 'Lead ID', leadId);
  if (!lead) return respond(null, 'Lead not found.');
  if (!_canReadAssignedRow(lead, user)) return respond(null, 'Permission denied.');

  const ts = now();
  updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_({
    'Lead Status': 'Open',
    'Is Archived': '',
    'Archived At': '',
    'Archived By': '',
    'Archive Reason': '',
    'Updated At': ts
  }));
  getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId).forEach(followup => {
    if (String(followup['Status'] || '') !== 'Archived' || !followup['Follow-up ID']) return;
    updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID'], {
      'Status': 'Open',
      'Updated At': ts
    });
  });
  insertLeadActivityLog_(leadId, 'Restore Lead', 'Archived', 'Open', 'Lead restored from archive.', user.id);
  _bumpArchiveStamps_();
  return respond({ leadId });
}

function _archiveLeadNeedsAlert_(lead, notPickedCount, cutoff) {
  if (_isArchivedLead_(lead)) return false;
  if (String(lead['Lead Status'] || 'Open').trim().toLowerCase() !== 'open') return false;
  if (Number(notPickedCount || 0) < 10) return false;
  const pendingDate = formatDate(lead['Created At'] || '');
  if (!pendingDate) return false;
  const pending = new Date(pendingDate);
  pending.setHours(0, 0, 0, 0);
  return pending <= cutoff;
}

function _archiveEnrichLead_(lead, followups, notPickedCount) {
  const latestOpen = (followups || [])
    .filter(f => String(f['Status'] || '').trim().toLowerCase() !== 'closed')
    .sort((a, b) => new Date(b['Created At'] || 0) - new Date(a['Created At'] || 0))[0] || {};
  return {
    ...lead,
    _notPickedCount: Number(notPickedCount || 0),
    _followupCount: (followups || []).length,
    _latestFollowupStatus: latestOpen['Status'] || '',
    _pendingDays: daysDiff(lead['Created At'] || '') || 0
  };
}

function _bumpArchiveStamps_() {
  _bumpStamp('leads');
  _bumpStamp('followups');
  _bumpStamp('activity_logs');
}

function ensureArchiveSchema_() {
  safeInitHeaders(SHEET_NAMES.LEADS, LEAD_MASTER_FIELDS);
  ensureFollowupSheets_();
}
