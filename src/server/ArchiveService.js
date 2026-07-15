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
      { sheetName: SHEET_NAMES.LEADS, range: 'A:AC' },
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
// Leads that were called this many times but never picked up ("Not Picked") are
// unreachable/dead → suggested for archiving. We flag on the TOTAL number of Not Picked
// contacts; the longest consecutive run of Not Picked is kept as extra info.
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
      { sheetName: SHEET_NAMES.LEADS, range: 'A:AC' },
      { sheetName: SHEET_NAMES.FOLLOWUP_HISTORY, range: 'A:Z' },
      { sheetName: SHEET_NAMES.STAGES, range: 'A:K' }
    ]);
  } finally { _bootstrapReadMode_ = false; }

  // Leads in a final stage are excluded — they're won/closed, not archive candidates.
  const finalStageIds = {};
  (rows[SHEET_NAMES.STAGES] || []).forEach(s => {
    const isFinal = s['Is Final Stage'] === true || String(s['Is Final Stage'] || '').trim().toLowerCase() === 'true';
    if (isFinal) finalStageIds[String(s['Stage ID'] || '').trim()] = true;
  });

  const leads = _scopeAssignedRows(
    (rows[SHEET_NAMES.LEADS] || []).filter(l =>
      !_isArchivedLead_(l) &&
      !_isLeadPushedToNbd_(l) &&
      !finalStageIds[String(l['Stage ID'] || '').trim()]
    ),
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
    if (total >= ARCHIVE_SUGGESTION_MIN_) {
      suggestions.push(Object.assign({}, lead, {
        _notPickedTotal: total,
        _notPickedStreak: maxStreak,
        _lastNotPickedDate: lastDate
      }));
    }
  });
  return suggestions.sort((a, b) =>
    (b._notPickedTotal - a._notPickedTotal) || (b._notPickedStreak - a._notPickedStreak)
  );
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
  if (_isLeadInFinalStage_(lead)) return respond(null, 'This lead is in a final stage and cannot be archived.');

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

  // Archiving a lead closes its open follow-ups so nobody is prompted to chase it.
  getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId).forEach(followup => {
    if (!followup['Follow-up ID']) return;
    const fuPatch = {
      'Status': 'Closed',
      'Next Follow-up Date': '',
      'Planned Date': '',
      'Updated At': ts
    };
    // Tag only the ones that weren't already completed, so a restore can reopen exactly these.
    if (!followup['Outcome'] && !followup['Done Date']) {
      fuPatch['Outcome'] = 'Lead archived';
      fuPatch['Done Date'] = today();
    }
    updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID'], fuPatch);
  });
  insertLeadActivityLog_(leadId, 'Archive Lead', '', 'Archived', patch['Archive Reason'], user.id);
  // Bulk archive bumps once for the whole batch (3 PropertiesService writes per lead
  // otherwise dominate large batches); single archive bumps here as before.
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

  const ts = now();
  updateRow(SHEET_NAMES.LEADS, 'Lead ID', leadId, pickLeadMasterFields_({
    'Lead Status': 'Open',
    'Is Archived': '',
    'Archived At': '',
    'Archived By': '',
    'Archive Reason': '',
    'Updated At': ts
  }));
  // Reopen only the follow-ups that were auto-closed by archiving this lead.
  getRowsByIndexedColumn_(SHEET_NAMES.FOLLOWUPS, 'Lead ID', leadId).forEach(followup => {
    if (!followup['Follow-up ID']) return;
    const wasAutoClosed = String(followup['Status'] || '') === 'Closed' && String(followup['Outcome'] || '') === 'Lead archived';
    if (!wasAutoClosed) return;
    updateRow(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', followup['Follow-up ID'], {
      'Status': 'Open',
      'Outcome': '',
      'Done Date': '',
      'Updated At': ts
    });
  });
  insertLeadActivityLog_(leadId, 'Restore Lead', 'Archived', 'Open', 'Lead restored from archive.', user.id);
  _bumpArchiveStamps_();
  return respond({ leadId });
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
