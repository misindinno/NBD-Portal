function getArchiveData(user) {
  ensureArchiveSchema_();
  // One batched read (Sheets API when available, SpreadsheetApp fallback inside) instead
  // of three sequential full scans. The archived table renders master fields only, so the
  // custom-field join is skipped, and the old `alerts` list is gone — the client never
  // read it (suggestions have their own computation).
  _bootstrapReadMode_ = true;
  let batch;
  try {
    batch = sheetApiBatchGetRows_([
      { sheetName: SHEET_NAMES.LEADS, range: 'A:AZ' },
      { sheetName: SHEET_NAMES.FOLLOWUPS, range: 'A:Q' },
      { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:O' }
    ]);
  } finally { _bootstrapReadMode_ = false; }

  const scopedLeads = _scopeAssignedRows(batch[SHEET_NAMES.LEADS] || [], user);
  const notPickedByLead = (batch[SHEET_NAMES.FOLLOWUP_HISTORY] || []).reduce((map, row) => {
    if (String(row['Contact Mode'] || '').trim() !== 'Not Picked') return map;
    const leadId = String(row['Lead ID'] || '').trim();
    if (!leadId) return map;
    map[leadId] = (map[leadId] || 0) + 1;
    return map;
  }, {});
  const followupByLead = (batch[SHEET_NAMES.FOLLOWUPS] || []).reduce((map, row) => {
    const leadId = String(row['Lead ID'] || '').trim();
    if (!leadId) return map;
    if (!map[leadId]) map[leadId] = [];
    map[leadId].push(row);
    return map;
  }, {});

  const archived = [];
  scopedLeads.forEach(lead => {
    if (!_isArchivedLead_(lead)) return;
    const leadId = String(lead['Lead ID'] || '').trim();
    if (!leadId) return;
    archived.push(_archiveEnrichLead_(lead, followupByLead[leadId] || [], notPickedByLead[leadId] || 0));
  });
  return {
    archived: archived.sort((a, b) => new Date(b['Archived At'] || 0) - new Date(a['Archived At'] || 0))
  };
}

// ── Archive suggestions ─────────────────────────────────────────────────────────
// Leads whose last calls went unanswered ("Not Picked") this many times IN A ROW are
// unreachable/dead → suggested for archiving. We flag on the longest CONSECUTIVE run of
// Not Picked contacts (any answered call breaks the run); the total is kept as extra info.
const ARCHIVE_SUGGESTION_MODE_ = 'Not Picked';
const ARCHIVE_SUGGESTION_MIN_ = 7;

function _archiveHistTime_(h) {
  const v = (h && (h['Done Date'] || h['Created At'])) || '';
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;                 // Sheets serial — monotonic, fine for sorting
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

// Reads leads + follow-up history via the Advanced Sheets service (batchGet) and returns
// the leads with >= MIN total "Not Picked" contacts (final-stage, archived and NBD-pushed
// leads excluded). SpreadsheetApp fallback is handled in sheetApiBatchGetRows_.
function getArchiveSuggestionsFast_(user) {
  ensureArchiveSchema_();
  _bootstrapReadMode_ = true;
  let rows;
  try {
    rows = sheetApiBatchGetRows_([
      { sheetName: SHEET_NAMES.LEADS, range: 'A:AZ' },
      { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:Z' },
      { sheetName: SHEET_NAMES.STAGES, range: 'A:K' }
    ]);
  } finally { _bootstrapReadMode_ = false; }

  // Leads in a final stage are excluded — they're won/closed, not archive candidates.
  const stageMap = {};
  (rows[SHEET_NAMES.STAGES] || []).forEach(s => {
    const id = String(s['Stage ID'] || '').trim();
    if (id) stageMap[id] = s;
  });

  const leads = _scopeAssignedRows(
    (rows[SHEET_NAMES.LEADS] || []).filter(l => {
      if (_isArchivedLead_(l) || _isLeadPushedToNbd_(l)) return false;
      const stage = stageMap[String(l['Stage ID'] || '').trim()] || {};
      const isFinal = stage['Is Final Stage'] === true || String(stage['Is Final Stage'] || '').trim().toLowerCase() === 'true';
      return !isFinal || _isLostArchiveLead_(l, stage);
    }),
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
    const stage = stageMap[String(lead['Stage ID'] || '').trim()] || {};
    const isLost = _isLostArchiveLead_(lead, stage);
    const hist = (byLead[id] || []).slice().sort((a, b) => _archiveHistTime_(a) - _archiveHistTime_(b));
    let streak = 0, maxStreak = 0, total = 0, lastDate = '';
    hist.forEach(h => {
      const mode = String(h['Contact Mode'] || '').trim();
      if (!mode) return;                                 // system / stage-change rows: not a contact attempt
      if (mode === ARCHIVE_SUGGESTION_MODE_) {
        streak++; total++;
        if (streak > maxStreak) maxStreak = streak;
        lastDate = h['Done Date'] || h['Created At'] || lastDate;
      } else {
        streak = 0;                                      // any answered/other contact breaks the run
      }
    });
    if (maxStreak >= ARCHIVE_SUGGESTION_MIN_ || isLost) {
      suggestions.push(Object.assign({}, lead, {
        _notPickedTotal: total,
        _notPickedStreak: maxStreak,
        _lastNotPickedDate: lastDate,
        _stageName: stage['Stage Name'] || '',
        _stageOutcome: stage['Stage Outcome'] || ''
      }));
    }
  });
  return suggestions.sort((a, b) =>
    (b._notPickedStreak - a._notPickedStreak) || (b._notPickedTotal - a._notPickedTotal)
  );
}

function getLostArchiveLeads_(user) {
  ensureArchiveSchema_();
  _bootstrapReadMode_ = true;
  let rows;
  try {
    rows = sheetApiBatchGetRows_([
      { sheetName: SHEET_NAMES.LEADS, range: 'A:AZ' },
      { sheetName: SHEET_NAMES.FOLLOWUPS, range: 'A:Q' },
      { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:O' },
      { sheetName: SHEET_NAMES.STAGES, range: 'A:K' }
    ]);
  } finally { _bootstrapReadMode_ = false; }

  const stageMap = (rows[SHEET_NAMES.STAGES] || []).reduce((map, stage) => {
    const id = String(stage['Stage ID'] || '').trim();
    if (id) map[id] = stage;
    return map;
  }, {});
  const notPickedByLead = (rows[SHEET_NAMES.FOLLOWUP_HISTORY] || []).reduce((map, row) => {
    if (String(row['Contact Mode'] || '').trim() !== 'Not Picked') return map;
    const leadId = String(row['Lead ID'] || '').trim();
    if (!leadId) return map;
    map[leadId] = (map[leadId] || 0) + 1;
    return map;
  }, {});
  const followupByLead = (rows[SHEET_NAMES.FOLLOWUPS] || []).reduce((map, row) => {
    const leadId = String(row['Lead ID'] || '').trim();
    if (!leadId) return map;
    if (!map[leadId]) map[leadId] = [];
    map[leadId].push(row);
    return map;
  }, {});

  const leads = _scopeAssignedRows((rows[SHEET_NAMES.LEADS] || []).filter(lead => {
    if (_isArchivedLead_(lead)) return false;
    return _isLostArchiveLead_(lead, stageMap[String(lead['Stage ID'] || '').trim()]);
  }), user);

  return leads.map(lead => {
    const leadId = String(lead['Lead ID'] || '').trim();
    const stage = stageMap[String(lead['Stage ID'] || '').trim()] || {};
    return Object.assign(
      _archiveEnrichLead_(lead, followupByLead[leadId] || [], notPickedByLead[leadId] || 0),
      { _stageName: stage['Stage Name'] || '', _stageOutcome: stage['Stage Outcome'] || '' }
    );
  }).sort((a, b) => _archiveDateMs_(b['Updated At'] || b['Stage Updated At'] || b['Created At']) -
                    _archiveDateMs_(a['Updated At'] || a['Stage Updated At'] || a['Created At']));
}

function _archiveDateMs_(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const t = new Date(String(value).replace(' ', 'T')).getTime();
  return isNaN(t) ? 0 : t;
}

function _isLostArchiveLead_(lead, stage) {
  const status = String(lead && lead['Lead Status'] || '').trim().toLowerCase();
  if (status === 'lost') return true;
  const outcome = String(stage && stage['Stage Outcome'] || '').trim().toLowerCase();
  const name = String(stage && stage['Stage Name'] || '').trim().toLowerCase();
  return outcome === 'lost' || name.includes('lost');
}

function archiveLead(leadId, reason, email, opts) {
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
  const stage = queryRows(SHEET_NAMES.STAGES, r => String(r['Stage ID'] || '').trim() === String(lead['Stage ID'] || '').trim())[0] || null;
  if (_isLeadInFinalStage_(lead) && !_isLostArchiveLead_(lead, stage)) {
    return respond(null, 'This lead is in a final stage and cannot be archived.');
  }

  const ts = now();
  const followups = getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId);
  const previousStatus = leadLifecycleStatus_(lead, stage);
  const patch = {
    'Pre-Archive Status': previousStatus,
    'Is Archived': true,
    'Archived At': ts,
    'Archived By': user.id,
    'Archive Reason': String(reason || '').trim() || 'Archived from portal',
    'Next Follow-up Date': '',
    'Updated At': ts
  };

  try {
    const updated = updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_(patch));
    if (!updated) return respond(null, 'Lead not found.');
    followups.forEach(followup => {
      if (!followup['Follow-up ID']) return;
      if (String(followup['Status'] || '').toLowerCase() === 'closed') return;
      const fuPatch = {
        'Status': 'Closed',
        'Next Follow-up Date': '',

        'Updated At': ts
      };
      if (!followup['Outcome'] && !followup['Done Date']) {
        fuPatch['Outcome'] = 'Lead archived';
        fuPatch['Done Date'] = today();
      }
      updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID'], fuPatch);
    });
    insertLeadActivityLog_(leadId, 'Archive Lead', previousStatus, 'Archived', patch['Archive Reason'], user.id);
  } catch (error) {
    _restoreArchiveMutationSnapshot_(lead, followups);
    throw error;
  }

  if (!(opts && opts.skipStamps)) _bumpArchiveStamps_();
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

  const stage = queryRows(SHEET_NAMES.STAGES, r => String(r['Stage ID'] || '').trim() === String(lead['Stage ID'] || '').trim())[0] || null;
  let restoredStatus = String(lead['Pre-Archive Status'] || '').trim();
  if (!restoredStatus || restoredStatus.toLowerCase() === 'archived') restoredStatus = leadLifecycleStatus_(lead, stage);
  const ts = now();
  const followups = getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId);
  try {
    updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_({
      'Lead Status': restoredStatus || 'Open',
      'Pre-Archive Status': '',
      'Is Archived': '',
      'Archived At': '',
      'Archived By': '',
      'Archive Reason': '',
      'Updated At': ts
    }));
    followups.forEach(followup => {
      if (!followup['Follow-up ID']) return;
      const wasAutoClosed = String(followup['Status'] || '') === 'Closed' && String(followup['Outcome'] || '') === 'Lead archived';
      if (!wasAutoClosed) return;
      const restoredPlannedDate = followup['Planned Date'] || today();
      updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID'], {
        'Status': 'Open',
        'Outcome': '',
        'Done Date': '',
        'Planned Date': restoredPlannedDate,
        'Next Follow-up Date': restoredPlannedDate,
        'Updated At': ts
      });
    });
    insertLeadActivityLog_(leadId, 'Restore Lead', 'Archived', restoredStatus || 'Open', 'Lead restored from archive.', user.id);
  } catch (error) {
    _restoreArchiveMutationSnapshot_(lead, followups);
    throw error;
  }
  _bumpArchiveStamps_();
  return respond({ leadId, status: restoredStatus || 'Open' });
}

function _restoreArchiveMutationSnapshot_(lead, followups) {
  try {
    updateRow(SHEET_NAMES.LEADS, 'Lead ID', lead['Lead ID'], pickLeadMasterFields_(lead));
    (followups || []).forEach(followup => {
      if (followup['Follow-up ID']) {
        updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID'], pickFollowupMasterFields_(followup));
      }
    });
  } catch (rollbackError) {
    logServerError_(rollbackError, { operation: 'archive-rollback', leadId: lead && lead['Lead ID'] });
  }
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

// Per-execution guard: the header check invalidates the read cache and does Sheets
// round-trips, so run it once per request instead of once per lead in a bulk archive.
let _archiveSchemaEnsured_ = false;
function ensureArchiveSchema_() {
  if (_archiveSchemaEnsured_) return;
  safeInitHeaders(SHEET_NAMES.LEADS, LEAD_MASTER_FIELDS);
  ensureFollowupSheets_();
  _archiveSchemaEnsured_ = true;
}
