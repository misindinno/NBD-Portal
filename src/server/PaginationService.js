// Server-side worklist queries. Google Sheets has no OFFSET/LIMIT query primitive,
// so each request scopes and filters in memory, but only the requested page crosses
// the Apps Script RPC boundary.

function getLeadsPage_(user, input) {
  const req = pageRequest_(input, { pageSize: 25, maxPageSize: 100, sortField: '_sortKey', sortDir: 'asc' });
  const filters = req.filters || {};
  const stages = getAllRows(SHEET_NAMES.STAGES);
  const stageMap = _pageRowsByKey_(stages, 'Stage ID');
  const scoped = _scopeAssignedRows(getAllRows(SHEET_NAMES.LEADS).filter(lead => !leadArchiveState_(lead)), user).map(lead => {
    const stage = stageMap[String(lead['Stage ID'] || '')] || {};
    return Object.assign({}, lead, {
      _lifecycleStatus: leadLifecycleStatus_(lead, stage),
      _sortKey: _leadServerSortKey_(lead, stage)
    });
  });

  const filtered = scoped.filter(lead => _leadMatchesPageQuery_(lead, stageMap, req, filters));
  const sortField = _pageSortField_(req.sortField, [
    '_sortKey','Company Name','Contact Person','Phone','City','State','Stage ID',
    'Priority','Assigned To','Lead Status','Created At','Updated At','Next Follow-up Date'
  ], '_sortKey');
  filtered.sort((a, b) => comparePageValues_(a[sortField], b[sortField], req.sortDir));

  const page = paginateRows_(filtered, req, {
    summary: _leadPageSummary_(filtered, stageMap),
    facets: {
      states: _pageDistinct_(scoped, 'State'),
      cities: _pageDistinct_(scoped, 'City'),
      statuses: _pageDistinct_(scoped, '_lifecycleStatus'),
      priorities: _pageDistinct_(scoped, 'Priority')
    }
  });
  page.items = getRowsWithCustomFieldValues_('Leads', page.items);
  return page;
}

function _leadMatchesPageQuery_(lead, stageMap, req, filters) {
  const stage = stageMap[String(lead['Stage ID'] || '')] || {};
  const isFinal = safeBooleanValue_(stage['Is Final Stage']);
  const isNbd = !!(lead['NBD Lead ID'] || lead['Pushed To NBD At']);
  if (req.search) {
    const haystack = [
      lead['Lead ID'], lead['Company Name'], lead['Contact Person'], lead['Client Description'],
      lead['Phone'], lead['Alternate No'], lead['Email'], lead['City'], lead['State'],
      lead['Remark'], lead['Remarks'], lead['Last Remark']
    ].map(value => String(value || '').toLowerCase()).join(' ');
    if (!haystack.includes(req.search)) return false;
  }
  if (filters.status && String(lead._lifecycleStatus || '') !== String(filters.status)) return false;
  if (filters.priority && String(lead['Priority'] || '') !== String(filters.priority)) return false;
  if (filters.stage && String(lead['Stage ID'] || '') !== String(filters.stage)) return false;
  if (filters.state && String(lead['State'] || '') !== String(filters.state)) return false;
  if (filters.city && String(lead['City'] || '') !== String(filters.city)) return false;

  const statusTab = String(filters.statusTab || 'all');
  if (statusTab === 'closed' && !isFinal) return false;
  if (statusTab === 'nbd' && !isNbd) return false;
  if (statusTab === 'active' && (isFinal || isNbd)) return false;

  const kpi = String(filters.kpi || '');
  if (kpi === 'open' && lead._lifecycleStatus !== 'Open') return false;
  if (['hot','warm','cold'].includes(kpi) && String(lead['Priority'] || '').toLowerCase() !== kpi) return false;
  if (kpi === 'closed' && !isFinal) return false;
  if (kpi === 'nbd' && !isNbd) return false;
  return true;
}

function _leadPageSummary_(rows, stageMap) {
  return (rows || []).reduce((summary, lead) => {
    summary.total++;
    const stage = stageMap[String(lead['Stage ID'] || '')] || {};
    const isFinal = safeBooleanValue_(stage['Is Final Stage']);
    const isNbd = !!(lead['NBD Lead ID'] || lead['Pushed To NBD At']);
    if (lead._lifecycleStatus === 'Open' && !isFinal) summary.open++;
    if (isFinal) summary.closed++;
    if (isNbd) summary.nbd++;
    const priority = String(lead['Priority'] || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, priority)) summary[priority]++;
    return summary;
  }, { total: 0, open: 0, hot: 0, warm: 0, cold: 0, closed: 0, nbd: 0 });
}

function _leadServerSortKey_(lead, stage) {
  const isNbd = !!(lead['NBD Lead ID'] || lead['Pushed To NBD At']);
  const bucket = isNbd ? 2 : (safeBooleanValue_(stage['Is Final Stage']) ? 1 : 0);
  const priority = { hot: 0, warm: 1, cold: 2 }[String(lead['Priority'] || '').toLowerCase()];
  const priorityRank = priority === undefined ? 3 : priority;
  const due = _pageDateMs_(lead['Next Follow-up Date']) || 9000000000000000;
  return bucket + '|' + priorityRank + '|' + String(due).padStart(16, '0');
}

function getFollowupsPage_(user, input) {
  const started = Date.now();
  const raw = input || {};
  const req = pageRequest_(raw, { pageSize: 25, maxPageSize: 100, sortField: '_dueSort', sortDir: 'asc' });
  const filters = req.filters || {};
  const tab = ['all','today','overdue','future','closed'].includes(String(raw.tab || 'all')) ? String(raw.tab || 'all') : 'all';
  const snapshot = getFollowupPageSnapshotFast_(user, { includeHistory: true });
  const leadMap = _pageRowsByKey_(snapshot.leads, 'Lead ID');
  const openRows = (snapshot.followups || [])
    .filter(row => String(row['Follow-up Type'] || '').toLowerCase() !== 'stage change')
    .filter(_pageIsOpenFollowup_)
    .filter(row => !!_pageFollowupDate_(row));
  const historyRows = (snapshot.followupHistory || [])
    .filter(row => String(row['Follow-up Type'] || '').toLowerCase() !== 'stage change');
  const historyIds = historyRows.reduce((map, row) => {
    if (row['Follow-up ID']) map[String(row['Follow-up ID'])] = true;
    return map;
  }, {});
  const noNextClosed = (snapshot.followups || [])
    .filter(row => String(row['Follow-up Type'] || '').toLowerCase() !== 'stage change')
    .filter(row => !_pageFollowupDate_(row))
    .filter(row => !historyIds[String(row['Follow-up ID'] || '')])
    .map(row => Object.assign({}, row, { _closedNoNext: true }));
  const closedRows = historyRows.concat(noNextClosed);
  const remarkMap = _pageFollowupRemarkMap_(snapshot.followups, snapshot.followupHistory);
  const allForTab = tab === 'closed' ? closedRows : openRows.filter(row => _pageFollowupTabMatch_(row, tab));
  const filtered = allForTab
    .filter(row => _followupMatchesPageQuery_(row, leadMap, remarkMap.search, req, filters))
    .map(row => Object.assign({}, row, { _dueSort: _pageFollowupSortValue_(row, tab) }));
  const sortField = _pageSortField_(req.sortField, [
    '_dueSort','Planned Date','Next Follow-up Date','Done Date','Created At',
    'Follow-up Type','Status','Lead ID','Created By','Done By'
  ], '_dueSort');
  filtered.sort((a, b) => comparePageValues_(a[sortField], b[sortField], req.sortDir));

  const summary = _followupPageSummary_(openRows, closedRows, leadMap, remarkMap.search, req, filters);
  const page = paginateRows_(filtered, req, {
    summary,
    facets: {
      states: _pageDistinct_(snapshot.leads, 'State'),
      cities: _pageDistinct_(snapshot.leads, 'City'),
      types: _pageDistinct_(snapshot.followups, 'Follow-up Type'),
      contactModes: _pageDistinct_(snapshot.followupHistory, 'Contact Mode')
    },
    source: snapshot.source || 'sheets-api',
    fetchMs: Date.now() - started,
    fetchedAt: now()
  });
  const pageLeadIds = page.items.reduce((map, row) => {
    if (row['Lead ID']) map[String(row['Lead ID'])] = true;
    return map;
  }, {});
  page.leads = (snapshot.leads || []).filter(lead => pageLeadIds[String(lead['Lead ID'] || '')]);
  page.followupHistory = (snapshot.followupHistory || []).filter(row => pageLeadIds[String(row['Lead ID'] || '')]);
  page.followups = page.items;
  return page;
}

function _pageFollowupTabMatch_(row, tab) {
  if (tab === 'all') return true;
  const due = _pageDateOnly_(_pageFollowupDate_(row));
  const todayValue = today();
  if (tab === 'today') return due === todayValue;
  if (tab === 'overdue') return !!due && due < todayValue;
  if (tab === 'future') return !!due && due > todayValue;
  return true;
}

function _followupMatchesPageQuery_(row, leadMap, remarkSearchMap, req, filters) {
  const leadId = String(row['Lead ID'] || '');
  const linkedLead = leadId ? leadMap[leadId] : null;
  if (leadId && !linkedLead) return false;
  const lead = linkedLead || {};
  if (req.search) {
    const haystack = [
      lead['Company Name'], lead['Contact Person'], lead['Phone'], lead['Alternate No'],
      lead['Client Description'], row['Discussion'], row['Remark'], row['Outcome'],
      remarkSearchMap[String(row['Lead ID'] || '')]
    ].map(value => String(value || '').toLowerCase()).join(' ');
    if (!haystack.includes(req.search)) return false;
  }
  if (filters.type && String(row['Follow-up Type'] || '') !== String(filters.type)) return false;
  if (filters.assignedTo && String(lead['Assigned To'] || '') !== String(filters.assignedTo)) return false;
  if (filters.contactMode && String(row['Contact Mode'] || '') !== String(filters.contactMode)) return false;
  if (filters.stage) {
    const stageValues = [lead['Stage ID'], row['Stage ID'], row['Updated Stage ID']].map(String);
    if (!stageValues.includes(String(filters.stage))) return false;
  }
  if (filters.state && String(lead['State'] || '') !== String(filters.state)) return false;
  if (filters.city && String(lead['City'] || '') !== String(filters.city)) return false;
  const date = _pageDateOnly_(row['Done Date'] || _pageFollowupDate_(row));
  if (filters.dateFrom && date && date < String(filters.dateFrom)) return false;
  if (filters.dateTo && date && date > String(filters.dateTo)) return false;
  return true;
}

function _followupPageSummary_(openRows, closedRows, leadMap, remarkSearchMap, req, filters) {
  const open = (openRows || []).filter(row => _followupMatchesPageQuery_(row, leadMap, remarkSearchMap, req, filters));
  const closed = (closedRows || []).filter(row => _followupMatchesPageQuery_(row, leadMap, remarkSearchMap, req, filters));
  const summary = { all: open.length, today: 0, overdue: 0, future: 0, closed: closed.length, closedToday: 0, notPicked: 0, connected: 0, connectionRate: 0, conversions: 0, conversionRate: 0 };
  open.forEach(row => {
    const due = _pageDateOnly_(_pageFollowupDate_(row));
    if (due < today()) summary.overdue++;
    else if (due === today()) summary.today++;
    else if (due > today()) summary.future++;
  });
  closed.forEach(row => {
    if (_pageDateOnly_(row['Done Date'] || row['Updated At'] || row['Created At']) === today()) summary.closedToday++;
    const mode = String(row['Contact Mode'] || '');
    if (mode === 'Not Picked') summary.notPicked++;
    if (mode === 'Call Connected' || mode === 'WhatsApp Chat') summary.connected++;
    if (/won|converted|qualified/i.test(String(row['Outcome'] || row['Status After'] || ''))) summary.conversions++;
  });
  const attempts = summary.connected + summary.notPicked;
  summary.connectionRate = attempts ? Math.round(summary.connected / attempts * 100) : 0;
  summary.conversionRate = summary.connected ? Math.round(summary.conversions / summary.connected * 100) : 0;
  return summary;
}

function _pageFollowupRemarkMap_(followups, history) {
  const rows = (followups || []).concat(history || []).slice().sort((a, b) =>
    _pageDateMs_(b['Done Date'] || b['Created At']) - _pageDateMs_(a['Done Date'] || a['Created At']));
  return rows.reduce((result, row) => {
    const leadId = String(row['Lead ID'] || '');
    if (!leadId) return result;
    const text = String(row['Discussion'] || row['Remark'] || '').trim();
    if (text && !/^(new lead created|lead created|stage change)$/i.test(text)) {
      if (!result.latest[leadId]) result.latest[leadId] = text;
      result.search[leadId] = (result.search[leadId] ? result.search[leadId] + ' ' : '') + text.toLowerCase();
    }
    return result;
  }, { latest: {}, search: {} });
}

function _pageIsOpenFollowup_(row) {
  return String(row['Status'] || (row['Outcome'] ? 'Closed' : 'Open')).toLowerCase() !== 'closed';
}

function _pageFollowupDate_(row) {
  return row && (row['Next Follow-up Date'] || row['Next Planned Date'] || row['Planned Date'] || row['Follow-up Date']) || '';
}

function _pageFollowupSortValue_(row, tab) {
  if (tab === 'closed') return 9000000000000000 - _pageDateMs_(row['Done Date'] || row['Updated At'] || row['Created At']);
  return _pageDateMs_(_pageFollowupDate_(row)) || 9000000000000000;
}

function getArchivePage_(user, input) {
  const raw = input || {};
  const tab = ['archived','suggestions','lost'].includes(String(raw.tab || 'archived')) ? String(raw.tab || 'archived') : 'archived';
  const defaultSort = tab === 'suggestions' ? 'streak' : (tab === 'lost' ? 'updated' : 'archived');
  const req = pageRequest_(raw, { pageSize: 10, maxPageSize: 100, sortField: defaultSort, sortDir: 'desc' });
  const filters = req.filters || {};
  let source;
  if (tab === 'suggestions') source = getArchiveSuggestionsFast_(user);
  else if (tab === 'lost') source = getLostArchiveLeads_(user);
  else source = getArchiveData(user).archived || [];

  const summary = _archivePageSummary_(tab, source);
  const facets = {
    owners: _pageDistinct_(source, 'Assigned To'),
    statuses: _pageDistinct_(source.map(row => Object.assign({}, row, { _status: _archiveRowLifecycleStatus_(row) })), '_status')
  };
  const filtered = source.filter(row => {
    if (filters.owner && String(row['Assigned To'] || '') !== String(filters.owner)) return false;
    if (tab === 'suggestions' && filters.status && _archiveRowLifecycleStatus_(row) !== String(filters.status)) return false;
    if (tab === 'suggestions' && filters.severity === 'warn' && Number(row._notPickedStreak || 0) !== 7) return false;
    if (tab === 'suggestions' && filters.severity === 'crit' && Number(row._notPickedStreak || 0) < 8) return false;
    if (req.search) {
      const haystack = [
        row['Lead ID'], row['Company Name'], row['Contact Person'], row['Client Description'],
        row['Phone'], row['City'], row['State'], row['Assigned To'], row._stageName, row['Archive Reason']
      ].map(value => String(value || '').toLowerCase()).join(' ');
      if (!haystack.includes(req.search)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => comparePageValues_(
    _archivePageSortValue_(a, tab, req.sortField),
    _archivePageSortValue_(b, tab, req.sortField),
    req.sortDir
  ));
  return paginateRows_(filtered, req, { summary, facets, tab });
}

function _archiveRowLifecycleStatus_(row) {
  const stage = {
    'Stage Outcome': row && row._stageOutcome || '',
    'Stage Name': row && row._stageName || ''
  };
  return leadLifecycleStatus_(row, stage);
}
function _archivePageSummary_(tab, rows) {
  if (tab === 'suggestions') return {
    total: rows.length,
    warning: rows.filter(row => Number(row._notPickedStreak || 0) === 7).length,
    critical: rows.filter(row => Number(row._notPickedStreak || 0) >= 8).length
  };
  return {
    total: rows.length,
    followups: rows.reduce((sum, row) => sum + Number(row._followupCount || 0), 0),
    notPicked: rows.reduce((sum, row) => sum + Number(row._notPickedCount || 0), 0)
  };
}

function _archivePageSortValue_(row, tab, field) {
  if (tab === 'suggestions') {
    if (field === 'last') return _pageDateMs_(row._lastNotPickedDate);
    if (field === 'total') return Number(row._notPickedTotal || 0);
    return Number(row._notPickedStreak || 0);
  }
  if (field === 'pending') return Number(row._pendingDays || 0);
  if (field === 'notpicked') return Number(row._notPickedCount || 0);
  if (field === 'fu') return Number(row._followupCount || 0);
  return _pageDateMs_(tab === 'archived' ? row['Archived At'] : (row['Updated At'] || row['Stage Updated At'] || row['Created At']));
}

function getGlobalSearch_(user, input, permissions) {
  const query = String(input || '').trim().toLowerCase().slice(0, 100);
  if (query.length < 2) {
    return { leads: [], contacts: [], followups: [], counts: { leads: 0, contacts: 0, followups: 0 }, total: 0 };
  }

  const snapshot = getFollowupPageSnapshotFast_(user, { includeHistory: false });
  const access = permissions || { leads: true, followups: true };
  const leads = snapshot.leads || [];
  const primaryMatches = [];
  const contactMatches = [];
  if (access.leads !== false) leads.forEach(lead => {
    const primaryText = [
      lead['Company Name'], lead['Client Description'], lead['City'], lead['State'],
      lead['Remark'], lead['Remarks'], lead['Last Remark']
    ].map(value => String(value || '').toLowerCase()).join(' ');
    const contactText = [
      lead['Contact Person'], lead['Phone'], lead['Alternate No'], lead['Email']
    ].map(value => String(value || '').toLowerCase()).join(' ');
    if (primaryText.includes(query)) primaryMatches.push(lead);
    else if (contactText.includes(query)) contactMatches.push(lead);
  });

  const leadMap = _pageRowsByKey_(leads, 'Lead ID');
  const followupMatches = (access.followups === false ? [] : (snapshot.followups || [])).filter(row => {
    const text = [
      row['Discussion'], row['Remark'], row['Outcome'], row['Next Action']
    ].map(value => String(value || '').toLowerCase()).join(' ');
    return text.includes(query);
  }).map(row => {
    const lead = leadMap[String(row['Lead ID'] || '')] || {};
    return Object.assign({}, row, {
      _leadCompanyName: lead['Company Name'] || '',
      _leadContactPerson: lead['Contact Person'] || ''
    });
  });

  const newestFirst = (a, b) =>
    _pageDateMs_(b['Updated At'] || b['Created At']) - _pageDateMs_(a['Updated At'] || a['Created At']);
  primaryMatches.sort(newestFirst);
  contactMatches.sort(newestFirst);
  followupMatches.sort(newestFirst);

  const counts = {
    leads: primaryMatches.length,
    contacts: contactMatches.length,
    followups: followupMatches.length
  };
  return {
    leads: primaryMatches.slice(0, 4),
    contacts: contactMatches.slice(0, 4),
    followups: followupMatches.slice(0, 4),
    counts,
    total: counts.leads + counts.contacts + counts.followups
  };
}
function getNavigationSummary_(user) {
  const leads = _scopeAssignedRows(
    getAllRows(SHEET_NAMES.LEADS).filter(lead => !leadArchiveState_(lead)),
    user
  );
  const stages = _pageRowsByKey_(getAllRows(SHEET_NAMES.STAGES), 'Stage ID');
  const followups = _scopeFollowupRows(getFollowups({}, false), user).filter(_pageIsOpenFollowup_);
  const todayValue = today();
  const todayCount = followups.filter(row => _pageDateOnly_(_pageFollowupDate_(row)) === todayValue).length;
  const overdueCount = followups.filter(row => {
    const due = _pageDateOnly_(_pageFollowupDate_(row));
    return !!due && due < todayValue;
  }).length;
  const pendingLeads = leads.filter(lead => {
    const stage = stages[String(lead['Stage ID'] || '')] || {};
    return !safeBooleanValue_(stage['Is Final Stage']) &&
      !(lead['NBD Lead ID'] || lead['Pushed To NBD At']) &&
      leadLifecycleStatus_(lead, stage) === 'Open';
  }).length;
  return {
    leads: leads.length,
    leadsOpen: pendingLeads,
    leadsPending: pendingLeads,
    pipeline: pendingLeads,
    followups: followups.length,
    followupsDue: todayCount + overdueCount,
    today: todayCount,
    overdue: overdueCount
  };
}

function _pageRowsByKey_(rows, key) {
  return (rows || []).reduce((map, row) => {
    const value = row && row[key];
    if (value !== '' && value !== null && value !== undefined) map[String(value)] = row;
    return map;
  }, {});
}

function _pageDistinct_(rows, field) {
  const values = {};
  (rows || []).forEach(row => {
    const value = String(row && row[field] || '').trim();
    if (value) values[value] = true;
  });
  return Object.keys(values).sort((a, b) => a.localeCompare(b));
}

function _pageSortField_(requested, allowed, fallback) {
  return allowed.includes(String(requested || '')) ? String(requested) : fallback;
}

function _pageDateOnly_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (typeof value === 'number') return String(_serialToDateTimeString_(value) || '').slice(0, 10);
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const date = new Date(value);
  return isNaN(date.getTime()) ? '' : Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function _pageDateMs_(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const date = new Date(String(value).replace(' ', 'T'));
  return isNaN(date.getTime()) ? 0 : date.getTime();
}
