// ─── AuthService.js ──────────────────────────────────────────────────────────

const ROLE_PERMISSIONS = {
  ADMIN:   ['Dashboard','Leads','Pipeline','Followups','Reports','Config','Users','LeadForm'],
  MANAGER: ['Dashboard','Leads','Pipeline','Followups','Reports'],
  SALES:   ['Dashboard','Leads','Pipeline','Followups'],
  USER:    ['Dashboard','Followups'],
  VIEWER:  ['Dashboard','Leads','Pipeline','Followups','Reports']
};
const ALL_MODULES = ['Dashboard','Leads','Pipeline','Followups','Reports','Config','Users','LeadForm'];
let TRUSTED_WRITE_EMAIL = '';

function withTrustedWriteUser_(email, fn) {
  const previous = TRUSTED_WRITE_EMAIL;
  TRUSTED_WRITE_EMAIL = email;
  try {
    return fn();
  } finally {
    TRUSTED_WRITE_EMAIL = previous;
  }
}

function getCurrentUser(email, includeWriteToken) {
  return withServerContext_(() => {
    const sessionEmail = Session.getActiveUser().getEmail();
    return getCurrentUserByEmail_(sessionEmail, includeWriteToken);
  });
}

function getCurrentUserByEmail_(email) {
  if (!email) return respond(null, 'Could not identify user.');
  const normalised = email.trim().toLowerCase();
  const users = getAllRows(SHEET_NAMES.USERS);
  const user  = users.find(u =>
    String(u['Email Address']).trim().toLowerCase() === normalised &&
    isActiveUserValue(u['Is Active'])
  );
  if (!user) return respond(null, 'ACCESS_DENIED');
  const role = normalizeStaffPermission(user['Permission'] || user['Role']);
  const modules = getEffectiveUserModules(user, role);
  return respond({
    id:            getStaffUserId(user, normalised),
    name:          user['Name'],
    title:         user['Title'],
    email:         user['Email Address'],
    role,
    department:    user['Department'],
    jobTitle:      user['Job Title'],
    modules,
    canEditConfig: role === 'ADMIN' || isTruthyPermission(user['Can Edit Config']) || userHasModule({ modules }, 'Config'),
    canManageUsers:role === 'ADMIN' || userHasModule({ modules }, 'Users')
  });
}

function getStaffUserId(row, fallbackEmail) {
  return row['ID'] || row['User ID'] || fallbackEmail || '';
}

function normalizeStaffPermission(value) {
  const text = String(value || '').trim().toUpperCase();
  if (ROLE_PERMISSIONS[text]) return text;
  if (text.includes('ADMIN')) return 'ADMIN';
  if (text.includes('MANAGER')) return 'MANAGER';
  if (text.includes('SALES')) return 'SALES';
  if (text.includes('VIEWER')) return 'VIEWER';
  if (text.includes('USER')) return 'USER';
  return 'USER';
}

function isActiveUserValue(value) {
  if (value === true) return true;
  const text = String(value ?? '').trim().toUpperCase();
  return text === '' || text === 'TRUE' || text === 'YES' || text === '1';
}

function isTruthyPermission(value) {
  if (value === true) return true;
  const text = String(value ?? '').trim().toUpperCase();
  return text === 'TRUE' || text === 'YES' || text === '1';
}

function getRoleModules(role) {
  return (ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.USER).slice();
}

function getEffectiveUserModules(row, role) {
  if (String(row['Allowed Modules'] || '').trim().toUpperCase() === 'NONE') return [];
  const modules = parseUserModules(row['Allowed Modules']);
  return modules.length ? modules : getRoleModules(role);
}

function parseUserModules(value) {
  if (Array.isArray(value)) return value.map(_canonicalModuleName).filter(Boolean);
  return String(value || '')
    .split(',')
    .map(_canonicalModuleName)
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
}

function _canonicalModuleName(value) {
  const target = _moduleKey(value);
  if (!target) return '';
  return ALL_MODULES.filter(m => _moduleKey(m) === target)[0] || '';
}

function _moduleKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function userHasModule(user, moduleName) {
  const target = _moduleKey(moduleName);
  return (user.modules || []).some(m => _moduleKey(m) === target);
}

function canEditConfigPermission(user) {
  return user.role === 'ADMIN' || user.canEditConfig === true || userHasModule(user, 'Config');
}

function canManageUsersPermission(user) {
  return user.role === 'ADMIN' || user.canManageUsers === true || userHasModule(user, 'Users');
}

function requireConfigEditor() {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled. Use apiWrite.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  if (!canEditConfigPermission(result.data)) throw new Error('Permission denied.');
  return result.data;
}

function requireUserManager() {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled. Use apiWrite.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  if (!canManageUsersPermission(result.data)) throw new Error('Permission denied.');
  return result.data;
}

// Used only by write webhook — validates email + role before any write
function requireRole(allowedRoles) {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled. Use apiWrite.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  if (!allowedRoles.includes(result.data.role)) throw new Error('Permission denied.');
  return result.data;
}


// ─── Custom session auth (email + password) ───────────────────────────────────
const AUTH_SESSION_TTL = 21600; // 6 hours (Apps Script CacheService maximum)

function _hashPassword(pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw + ':NBD_PORTAL_AUTH');
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function validateUserPassword_(email, password) {
  const norm = String(email || '').trim().toLowerCase();
  const users = getAllRows(SHEET_NAMES.USERS);
  const user = users.find(u =>
    String(u['Email Address']).trim().toLowerCase() === norm &&
    isActiveUserValue(u['Is Active'])
  );
  if (!user) return null;
  const stored = String(user['Password'] || '').trim();
  if (!stored) return null;
  const hashed = _hashPassword(password);
  // Accept hashed password or plain-text (plain allowed during initial setup only)
  if (stored !== hashed && stored !== password) return null;
  return user;
}

function createAuthSession_(email, userId) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(
    'AUTH:' + token,
    JSON.stringify({ email, userId, created: Date.now() }),
    AUTH_SESSION_TTL
  );
  return token;
}

function readAuthSession_(token) {
  if (!token || token.length < 32) return null;
  const raw = CacheService.getScriptCache().get('AUTH:' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function refreshAuthSession_(token) {
  const s = readAuthSession_(token);
  if (!s) return;
  CacheService.getScriptCache().put('AUTH:' + token, JSON.stringify(s), AUTH_SESSION_TTL);
}

function destroyAuthSession_(token) {
  if (token) CacheService.getScriptCache().remove('AUTH:' + token);
}

// ─── Auth token guard (used by apiExecuteWrite and read endpoints) ────────────

function _requireAuthToken_(token) {
  const session = readAuthSession_(token);
  if (!session) throw new Error('SESSION_EXPIRED');
  const result = getCurrentUserByEmail_(session.email);
  if (!result.success) throw new Error(result.error || 'ACCESS_DENIED');
  refreshAuthSession_(token);
  return result.data;
}

// ─── Google ID token verification ────────────────────────────────────────────

function _verifyGoogleIdToken_(idToken) {
  if (!idToken) return null;
  try {
    const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return null;
    const info = JSON.parse(response.getContentText());
    if (!info.email || info.email_verified !== 'true') return null;
    const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') || '';
    if (clientId && info.aud !== clientId) return null;
    return info;
  } catch (_) {
    return null;
  }
}
