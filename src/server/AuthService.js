// ─── AuthService.js ──────────────────────────────────────────────────────────

const ROLE_PERMISSIONS = {
  ADMIN:   ['Dashboard','Leads','Pipeline','Followups','Reports','Config','Users','LeadForm','BulkEntry'],
  MANAGER: ['Dashboard','Leads','Pipeline','Followups','Reports'],
  SALES:   ['Dashboard','Leads','Pipeline','Followups'],
  USER:    ['Dashboard','Followups'],
  VIEWER:  ['Dashboard','Leads','Pipeline','Followups','Reports']
};
const ALL_MODULES = ['Dashboard','Leads','Pipeline','Followups','Reports','Config','Users','LeadForm','BulkEntry'];
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
  const baseUser = _getUserByEmailIndexed_(normalised);
  if (!baseUser) return respond(null, 'ACCESS_DENIED');
  const access = getPortalAccessForUser_(baseUser, normalised);
  if (access && !isActiveUserValue(access['Is Active'])) return respond(null, 'ACCESS_DENIED');
  const user = mergeUserPortalAccess_(baseUser, access);
  const role = normalizeStaffPermission(user['Permission'] || user['Role']);
  const modules = getEffectiveUserModules(user, role);
  return respond({
    id:            getStaffUserId(user, normalised),
    name:          user['Name'],
    title:         user['Title'],
    email:         user['Email Address'],
    role,
    portalKey:     currentPortalKey_(),
    department:    user['Department'],
    jobTitle:      user['Job Title'],
    modules,
    canEditConfig: role === 'ADMIN' || isTruthyPermission(user['Can Edit Config']) || userHasModule({ modules }, 'Config'),
    canManageUsers:role === 'ADMIN' || isTruthyPermission(user['Can Manage Users']) || userHasModule({ modules }, 'Users')
  });
}

function currentPortalKey_() {
  const configured = String(CLIENT_CONFIG.PORTAL_KEY || '').trim().toUpperCase();
  if (configured) return configured;
  const title = String(CLIENT_CONFIG.APP_TITLE || '').toLowerCase();
  if (title.includes('lq')) return 'LQ';
  if (title.includes('nbd')) return 'NBD';
  return 'DEFAULT';
}

function portalAccessHeaders_() {
  return [
    'Access ID','User ID','Email Address','Portal Key',
    'Permission','Allowed Modules','Can Edit Config','Can Manage Users',
    'Department Scope','Is Active','Created At','Updated At'
  ];
}

function ensureUserPortalAccessSheet_() {
  safeInitHeaders(SHEET_NAMES.USER_PORTAL_ACCESS, portalAccessHeaders_());
}

function getPortalAccessForUser_(user, email, portalKey) {
  const key = String(portalKey || currentPortalKey_()).trim().toUpperCase();
  const userId = getStaffUserId(user, email);
  const normEmail = String(email || user['Email Address'] || '').trim().toLowerCase();
  try {
    ensureUserPortalAccessSheet_();
    return _findPortalAccessRow_(getAllRows(SHEET_NAMES.USER_PORTAL_ACCESS), key, userId, normEmail);
  } catch (e) {
    return null;
  }
}

function _findPortalAccessRow_(accessRows, key, userId, normEmail) {
  return (accessRows || []).find(r =>
    String(r['Portal Key'] || '').trim().toUpperCase() === key &&
    (
      (userId && String(r['User ID'] || '') === String(userId)) ||
      (normEmail && String(r['Email Address'] || '').trim().toLowerCase() === normEmail)
    )
  ) || null;
}

function mergeUserPortalAccess_(user, access) {
  const email = String(user['Email Address'] || access?.['Email Address'] || '').trim().toLowerCase();
  if (!access) return { ...user, 'ID': user['ID'] || user['User ID'] || email };
  return {
    ...user,
    'ID': user['ID'] || user['User ID'] || access['User ID'] || email,
    'Permission': access['Permission'] || user['Permission'] || user['Role'],
    'Allowed Modules': access['Allowed Modules'] !== '' && access['Allowed Modules'] !== undefined
      ? access['Allowed Modules']
      : user['Allowed Modules'],
    'Can Edit Config': access['Can Edit Config'] !== '' && access['Can Edit Config'] !== undefined
      ? access['Can Edit Config']
      : user['Can Edit Config'],
    'Can Manage Users': access['Can Manage Users'] !== '' && access['Can Manage Users'] !== undefined
      ? access['Can Manage Users']
      : user['Can Manage Users'],
    'Is Active': access['Is Active'] !== '' && access['Is Active'] !== undefined
      ? access['Is Active']
      : user['Is Active'],
    'Portal Key': access['Portal Key'] || currentPortalKey_(),
    '_Portal Access ID': access['Access ID'] || ''
  };
}

function getUsersWithPortalAccess_(portalKey, includeInactive) {
  const key = String(portalKey || currentPortalKey_()).trim().toUpperCase();
  ensureUserPortalAccessSheet_();
  const accessRows = getAllRows(SHEET_NAMES.USER_PORTAL_ACCESS);
  return getAllRows(SHEET_NAMES.USERS)
    .filter(u => includeInactive || isActiveUserValue(u['Is Active']))
    .map(u => {
      const email = String(u['Email Address'] || '').trim().toLowerCase();
      const access = _findPortalAccessRow_(accessRows, key, getStaffUserId(u, email), email);
      return mergeUserPortalAccess_(u, access);
    })
    .filter(u => includeInactive || isActiveUserValue(u['Is Active']));
}

function upsertUserPortalAccess_(user, data) {
  ensureUserPortalAccessSheet_();
  const key = currentPortalKey_();
  const email = String(data['Email Address'] || user['Email Address'] || '').trim().toLowerCase();
  const userId = getStaffUserId(user, email);
  const existing = getPortalAccessForUser_(user, email, key);
  const modules = parseUserModules(data['Allowed Modules']);
  const row = {
    'Access ID': existing?.['Access ID'] || generateUUID(),
    'User ID': userId,
    'Email Address': email,
    'Portal Key': key,
    'Permission': normalizeStaffPermission(data['Permission'] || data['Role']),
    'Allowed Modules': String(data['Allowed Modules'] || '').trim().toUpperCase() === 'NONE'
      ? 'NONE'
      : (modules.length ? modules.join(',') : getRoleModules(normalizeStaffPermission(data['Permission'] || data['Role'])).join(',')),
    'Can Edit Config': isTruthyPermission(data['Can Edit Config']) || modules.some(m => _moduleKey(m) === 'config'),
    'Can Manage Users': isTruthyPermission(data['Can Manage Users']) || modules.some(m => _moduleKey(m) === 'users'),
    'Department Scope': data['Department Scope'] || '',
    'Is Active': data['Is Active'] === true || data['Is Active'] === 'TRUE',
    'Created At': existing?.['Created At'] || now(),
    'Updated At': now()
  };
  if (existing?.['Access ID']) updateRow(SHEET_NAMES.USER_PORTAL_ACCESS, 'Access ID', existing['Access ID'], row);
  else insertRow(SHEET_NAMES.USER_PORTAL_ACCESS, row);
  return row;
}

function migrateUserPortalAccess() {
  return withServerContext_(() => {
    const count = migrateUserPortalAccess_();
    return 'Migrated ' + count + ' user portal access rows for ' + currentPortalKey_() + '.';
  });
}

function migrateUserPortalAccess_() {
  ensureUserPortalAccessSheet_();
  const key = currentPortalKey_();
  let created = 0;
  getAllRows(SHEET_NAMES.USERS).forEach(user => {
    const email = String(user['Email Address'] || '').trim().toLowerCase();
    if (!email) return;
    if (getPortalAccessForUser_(user, email, key)) return;
    upsertUserPortalAccess_(user, {
      ...user,
      'Permission': user['Permission'] || user['Role'] || 'USER',
      'Allowed Modules': user['Allowed Modules'] || '',
      'Can Edit Config': user['Can Edit Config'],
      'Can Manage Users': user['Can Manage Users'],
      'Is Active': user['Is Active'] === false || user['Is Active'] === 'FALSE' ? false : true
    });
    created++;
  });
  return created;
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
  if (!trustedEmail) throw new Error('Direct write calls are disabled. Use the queue API.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  if (!canEditConfigPermission(result.data)) throw new Error('Permission denied.');
  return result.data;
}

function requireUserManager() {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled. Use the queue API.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  if (!canManageUsersPermission(result.data)) throw new Error('Permission denied.');
  return result.data;
}

// Used by queued writes — validates email + role before any write
function requireRole(allowedRoles) {
  const trustedEmail = TRUSTED_WRITE_EMAIL;
  if (!trustedEmail) throw new Error('Direct write calls are disabled. Use the queue API.');
  const result = getCurrentUserByEmail_(trustedEmail);
  if (!result.success) throw new Error(result.error);
  if (!allowedRoles.includes(result.data.role)) throw new Error('Permission denied.');
  return result.data;
}

function requireRoleForEmail_(allowedRoles, email) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return requireRole(allowedRoles);
  const result = getCurrentUserByEmail_(norm);
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
  const user = _getUserByEmailIndexed_(norm);
  if (!user) return null;
  const stored = String(user['Password'] || '').trim();
  if (!stored) return null;
  const hashed = _hashPassword(password);
  // Accept hashed password or plain-text (plain allowed during initial setup only)
  if (stored !== hashed && stored !== password) return null;
  return user;
}

function _getUserByEmailIndexed_(email) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return null;
  let rows = getRowsByIndexedColumn_(SHEET_NAMES.USERS, 'Email Address', norm);
  if (!rows.length && getSheet(SHEET_NAMES.USERS).getLastRow() > 1) {
    rebuildIndexForSheet_(SHEET_NAMES.USERS);
    rows = getRowsByIndexedColumn_(SHEET_NAMES.USERS, 'Email Address', norm);
  }
  return rows.find(u =>
    String(u['Email Address']).trim().toLowerCase() === norm &&
    isActiveUserValue(u['Is Active'])
  ) || null;
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
