// ─── Utils.gs ───────────────────────────────────────────────────────────────

const SHEET_NAMES = {
  USERS: 'Staff List',
  USER_PORTAL_ACCESS: 'USER_PORTAL_ACCESS',
  LEADS: 'LEAD_MASTER',
  FOLLOWUPS: 'FOLLOWUPS',
  FOLLOWUP_HISTORY: 'FOLLOWUP_HISTORY',
  LEAD_ACTIVITY_LOGS: 'LEAD_ACTIVITY_LOGS',
  IDX_LEADS: 'IDX_LEADS',
  IDX_FOLLOWUPS: 'IDX_FOLLOWUPS',
  IDX_USERS: 'IDX_USERS',
  LEAD_FIELD_VALUES: 'LEAD_FIELD_VALUES',
  FOLLOWUP_FIELD_VALUES: 'FOLLOWUP_FIELD_VALUES',
  STAGES: 'PIPELINE_STAGES',
  FIELD_CONFIG: 'FIELD_CONFIG',
  CONFIG: 'CONFIG',
  QUEUE: 'JOB_QUEUE',
  CHANGE_LOG: 'CHANGE_LOG',
  BULK_CONFIG: 'Bulk_Config',
  BULK_AUDIT_LOG: 'BULK_IMPORT_LOG'
};

function generateUUID() {
  return Utilities.getUuid().toUpperCase();
}

function now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function today() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatDate(date) {
  if (!date) return '';
  return Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function daysDiff(dateStr) {
  if (!dateStr) return null;
  const diff = new Date() - new Date(dateStr);
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toJSON(obj) {
  return JSON.stringify(obj);
}

function respond(data, error) {
  return error ? { success: false, error } : { success: true, data };
}

function _bumpStamp(collection) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty('STAMP_' + String(collection).toUpperCase(), String(Date.now()));
  } catch (e) {}
}
