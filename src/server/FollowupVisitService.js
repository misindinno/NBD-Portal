// Date-only inbound requests reuse the visit register and its atomic audit writer.
// They do not complete, reschedule or write to a follow-up/lead.
function _cfvFollowupLead_(user, followupId, options) {
  const id = _cfvText_(followupId, 160, true);
  const row = getRowByIndexedId_(SHEET_NAMES.FOLLOWUPS, 'Follow-up ID', id);
  if (!row || !_scopeFollowupRows([row], user).length) throw new Error('Permission denied. Follow-up is unavailable.');
  const lead = options.leads.find(item => item.id === String(row['Lead ID'] || ''));
  if (!lead) throw new Error('Permission denied. An active lead with visit linking access is required.');
  return lead;
}
function _cfvFollowupRequestFields_(user, p, options) {
  if (p.id) throw new Error('Invalid visit request. This action only creates a new request.');
  const lead = _cfvFollowupLead_(user, p.followupId, options);
  const date = _cfvText_(p.date, 10, true), remark = _cfvText_(p.remark, 1000, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid visit date.');
  _cfvTime_(date + 'T00:00', true); // validation only; no invented appointment time
  if (!['Office','Factory'].includes(p.visitType)) throw new Error('Invalid visit type. Choose Office or Factory.');
  return { Company: lead.name, 'Lead ID': lead.id, 'Lead Key': lead.key,
    'Planned Start': date, Purpose: remark, Destination: p.visitType, Status: 'New' };
}
function _cfvFollowupUser_() {
  _requireModule('Followups');
  const user = _cfvUser_(true);
  if (!_cfvGrant_(user, 'ClientFactoryVisitsCreate')) throw new Error('Permission denied. Visit creation access is required.');
  return user;
}
function apiGetFollowupVisitOptions(token, followupId) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiGetFollowupVisitOptions', () => {
    const user = _cfvFollowupUser_();
    _cfvFollowupLead_(user, followupId, _cfvOptions_(user));
    const tables = _cfvTables_();
    if (!tables.visits || !tables.events) throw new Error('Module setup is required. Ask an administrator to initialize it.');
    return respond({ types: ['Office','Factory'], today: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd') });
  });
}
function apiSaveFollowupVisit(token, payload) {
  _currentApiToken_ = token || '';
  return apiGuard_('apiSaveFollowupVisit', () => {
    const user = _cfvFollowupUser_();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(key => !['requestId','followupId','date','remark','visitType'].includes(key))) throw new Error('Invalid visit request.');
    // Recheck both grants and current lead/follow-up visibility even for a replay.
    _cfvFollowupLead_(user, payload.followupId, _cfvOptions_(user));
    return respond(_cfvSave_(user, payload, true));
  });
}
