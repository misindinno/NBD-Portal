'use strict';
// Synthetic records only. Shared by the VM tests and the isolated browser check.
function todayData() {
  const lead = (id, city, owner = 'u1') => ({ 'Lead ID': id, 'Company Name': 'Example ' + id, City: city, Source: id === '001' ? 'Referral' : id === '1' ? 'Website' : '', 'Assigned To': owner, 'Created By': owner, 'Created At': '2026-11-19 09:00:00', 'Lead Status': 'Open' });
  const history = (id, leadId, mode, type, date = '2026-11-20 10:00:00', owner = 'u1') => ({ 'History ID': id, 'Lead ID': leadId, 'Created At': date, 'Done By': owner, 'Contact Mode': mode, 'Follow-up Type': type, Remark: 'Synthetic activity', 'Was Productive': mode === 'Call Connected' ? 'Yes' : 'No' });
  const log = (id, leadId, date, value = 'Won', owner = 'u1', old = 'Open') => ({ 'Log ID': id, 'Lead ID': leadId, 'Created At': date, 'Created By': owner, 'Action Type': 'Stage Change', 'Old Value': old, 'New Value': value });
  return {
    leads: [lead('001', 'Delhi'), lead('1', 'Mumbai'), lead('002', '', 'u2'), { ...lead('old', 'Delhi'), 'Lead Status': 'Won' }],
    followups: [{ 'Follow-up ID': 'f1', 'Lead ID': '001', 'Next Follow-up Date': '2026-11-20', Status: 'Open', 'Follow-up Type': 'Call', 'Created By': 'u1' }],
    followupHistory: [history('h1', '001', 'Call Connected', 'Call'), history('h2', '001', 'Call Connected', 'Call'), history('h3', '1', 'WhatsApp Chat', 'WhatsApp'), history('h4', '002', '', 'Visit', '2026-11-20 12:00:00', 'u2'), history('h5', '001', 'Not Picked', 'Call'), history('h6', '001', 'Call Connected', 'Call', '2026-11-18 10:00:00')],
    activityLogs: [log('l1', '001', '2026-11-20 09:00:00'), log('l2', '001', '2026-11-20 11:00:00'), log('l3', '1', '2026-11-19T18:30:00Z'), log('l4', '002', '2026-11-20 11:00:00', 'Won', 'u2'), log('l5', 'old', '2026-11-18 11:00:00'), log('l6', 'old', '2026-11-20 11:00:00', 'Won', 'u1', 'Won')]
  };
}
function todayConfig() {
  return { users: [{ id: 'u1', email: 'one@example.test', name: 'Agent One' }, { id: 'u2', email: 'two@example.test', name: 'Agent Two' }], stages: [{ 'Stage ID': 'won-stage', 'Stage Name': 'Converted', 'Stage Outcome': 'Won' }], allStages: [], leadFields: [], followupFields: [] };
}
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
module.exports = { todayData, todayConfig, escapeHtml };
