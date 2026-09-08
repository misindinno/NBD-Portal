// ─── AuthService.js ──────────────────────────────────────────────────────────

const ROLE_PERMISSIONS = {
  ADMIN:   ['Leads','Pipeline','Followups','Reports','Archive','Config','Users','LeadForm','BulkEntry'],
  MANAGER: ['Leads','Pipeline','Followups','Reports'],
  SALES:   ['Leads','Pipeline','Followups'],
  USER:    ['Followups'],
  VIEWER:  ['Leads','Pipeline','Followups','Reports']
};
const ALL_MODULES = ['Leads','Pipeline','Followups','Reports','Archive','Config','Users','LeadForm','BulkEntry'];
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
    return getAllRows(SHEET_NAMES.USER_PORTAL_ACCESS).find(r =>
      String(r['Portal Key'] || '').trim().toUpperCase() === key &&
      (
        (userId && String(r['User ID'] || '') === String(userId)) ||
        (normEmail && String(r['Email Address'] || '').trim().toLowerCase() === normEmail)
      )
    ) || null;
  } catch (e) {
    return null;
  }
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
  return getAllRows(SHEET_NAMES.USERS)
    .filter(u => includeInactive || isActiveUserValue(u['Is Active']))
    .map(u => {
      const email = String(u['Email Address'] || '').trim().toLowerCase();
      const access = getPortalAccessForUser_(u, email, key);
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
  requireContainerAdmin_(false);
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
  const allowed = row['Allowed Modules'];
  // Explicit permissions may contain modules that no longer exist. An empty
  // parsed list must not grant the role defaults in that case.
  return String(allowed || '').trim() ? parseUserModules(allowed) : getRoleModules(role);
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

function requireContainerAdmin_(allowBootstrap) {
  const activeEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!activeEmail) throw new Error('Permission denied. Run this command from the bound spreadsheet.');
  const result = getCurrentUserByEmail_(activeEmail);
  if (result && result.success && result.data.role === 'ADMIN') return result.data;
  const effectiveEmail = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (allowBootstrap && activeEmail === effectiveEmail) return { email: activeEmail, role: 'ADMIN' };
  throw new Error('Permission denied. Container administrator access is required.');
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
  // The email argument is retained for compatibility, but identity always comes
  // from withTrustedWriteUser_ in the authenticated API layer.
  return requireRole(allowedRoles);
}

// ─── Custom session auth (email + password) ───────────────────────────────────
const AUTH_SESSION_TTL = 21600; // 6 hours (Apps Script CacheService maximum)
const AUTH_SESSION_TOKEN_MAX_LENGTH = 4096;
const AUTH_PASSWORD_ITERATIONS = 12000;
const AUTH_PASSWORD_MIN_ITERATIONS = 1000;
const AUTH_PASSWORD_MAX_ITERATIONS = 12000;
const AUTH_PASSWORD_MAX_LENGTH = 1024;
const AUTH_EMAIL_MAX_LENGTH = 320;
const AUTH_LOGIN_ATTEMPT_LIMIT = 8;
const AUTH_LOGIN_ATTEMPT_WINDOW = 300;

function _hashPassword(pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw + ':NBD_PORTAL_AUTH');
  return _hexBytes_(bytes);
}

function _hexBytes_(bytes) {
  return (bytes || []).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function _constantTimeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function _passwordV2Hash_(password, salt, iterations) {
  let bytes = Utilities.newBlob(String(password || '') + ':' + salt).getBytes();
  const requestedRounds = Number(iterations);
  const rounds = Number.isFinite(requestedRounds)
    ? Math.max(AUTH_PASSWORD_MIN_ITERATIONS, Math.min(AUTH_PASSWORD_MAX_ITERATIONS, Math.floor(requestedRounds)))
    : AUTH_PASSWORD_ITERATIONS;
  for (let i = 0; i < rounds; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  }
  return _hexBytes_(bytes);
}


function _verifyPasswordV2_(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'v2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < AUTH_PASSWORD_MIN_ITERATIONS || iterations > AUTH_PASSWORD_MAX_ITERATIONS) return false;
  if (!/^[a-f0-9]{64}$/i.test(parts[3]) || !/^[a-f0-9]{16,128}$/i.test(parts[2])) return false;
  return _constantTimeEqual_(_passwordV2Hash_(password, parts[2], iterations), parts[3]);
}
function _loginAttemptCacheKey_(email) {
  const normalized = String(email || '').trim().toLowerCase().slice(0, AUTH_EMAIL_MAX_LENGTH);
  return 'AUTH_LOGIN_FAIL:' + _hexBytes_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalized)
  ).slice(0, 32);
}

function assertLoginAllowed_(email) {
  const attempts = Number(CacheService.getScriptCache().get(_loginAttemptCacheKey_(email)) || 0);
  if (attempts >= AUTH_LOGIN_ATTEMPT_LIMIT) {
    throw new Error('Too many login attempts. Try again in 5 minutes.');
  }
}

function recordLoginFailure_(email) {
  const cache = CacheService.getScriptCache();
  const key = _loginAttemptCacheKey_(email);
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(2000);
  try {
    const attempts = Math.min(
      AUTH_LOGIN_ATTEMPT_LIMIT,
      Number(cache.get(key) || 0) + 1
    );
    cache.put(key, String(attempts), AUTH_LOGIN_ATTEMPT_WINDOW);
  } finally {
    if (locked) lock.releaseLock();
  }
}

function clearLoginFailures_(email) {
  CacheService.getScriptCache().remove(_loginAttemptCacheKey_(email));
}
function validateUserPassword_(email, password) {
  const norm = String(email || '').trim().toLowerCase();
  const candidatePassword = String(password ?? '');
  if (!norm || norm.length > AUTH_EMAIL_MAX_LENGTH || !candidatePassword || candidatePassword.length > AUTH_PASSWORD_MAX_LENGTH) return null;
  const user = _getUserByEmailIndexed_(norm);
  if (!user) return null;
  const stored = String(user['Password'] || '').trim();
  if (!stored) return null;

  let valid = false;
  let restorePlaintext = false;
  if (stored.indexOf('v2$') === 0) {
    valid = _verifyPasswordV2_(candidatePassword, stored);
    restorePlaintext = valid;
  } else if (/^[a-f0-9]{64}$/i.test(stored)) {
    valid = _constantTimeEqual_(_hashPassword(candidatePassword), stored);
    restorePlaintext = valid;
  } else {
    valid = _constantTimeEqual_(stored, candidatePassword);
  }
  if (!valid) return null;
  // Staff List passwords are stored as plaintext for this portal. Legacy hashes
  // remain readable and are converted after one successful login.
  if (restorePlaintext) {
    updateRow(SHEET_NAMES.USERS, 'Email Address', user['Email Address'], {
      'Password': candidatePassword
    });
  }
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

function _authSigningSecret_() {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty('AUTH_SIGNING_SECRET') || '';
  if (secret) return secret;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    secret = properties.getProperty('AUTH_SIGNING_SECRET') || '';
    if (secret) return secret;
    throw new Error('Authentication signing key is temporarily unavailable.');
  }
  try {
    // Another execution may have initialized the secret while this one waited.
    secret = properties.getProperty('AUTH_SIGNING_SECRET') || '';
    if (!secret) {
      secret = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
      properties.setProperty('AUTH_SIGNING_SECRET', secret);
    }
    return secret;
  } finally {
    lock.releaseLock();
  }
}
function _base64UrlText_(text) {
  return Utilities.base64EncodeWebSafe(String(text || ''), Utilities.Charset.UTF_8).replace(/=+$/g, '');
}

function _base64UrlBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function _base64UrlDecodeBytes_(encoded) {
  const value = String(encoded || '');
  if (!value || value.length > AUTH_SESSION_TOKEN_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url value.');
  }
  const remainder = value.length % 4;
  if (remainder === 1) throw new Error('Invalid base64url length.');
  return Utilities.base64DecodeWebSafe(value + (remainder ? '='.repeat(4 - remainder) : ''));
}
function _signSessionPayload_(encodedPayload) {
  return _base64UrlBytes_(Utilities.computeHmacSha256Signature(encodedPayload, _authSigningSecret_()));
}

function createAuthSession_(email, userId) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    email: String(email || '').trim().toLowerCase(),
    userId: String(userId || ''),
    portal: currentPortalKey_(),
    iat: issuedAt,
    exp: issuedAt + AUTH_SESSION_TTL,
    jti: Utilities.getUuid().replace(/-/g, '')
  };
  const encoded = _base64UrlText_(JSON.stringify(payload));
  return encoded + '.' + _signSessionPayload_(encoded);
}

function _readSignedAuthSession_(token) {
  const tokenText = String(token || '');
  if (!tokenText || tokenText.length > AUTH_SESSION_TOKEN_MAX_LENGTH) return null;
  const parts = tokenText.split('.');
  if (parts.length !== 2) return null;
  if (!parts[0] || !parts[1] || parts[1].length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  if (!_constantTimeEqual_(_signSessionPayload_(parts[0]), parts[1])) return null;
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(_base64UrlDecodeBytes_(parts[0])).getDataAsString());
  } catch (e) {
    return null;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const issuedAt = Number(payload.iat);
  const expiresAt = Number(payload.exp);
  if (typeof payload.email !== 'string' || !payload.email || payload.email.length > AUTH_EMAIL_MAX_LENGTH) return null;
  if (!/^[a-f0-9]{32}$/i.test(String(payload.jti || ''))) return null;
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return null;
  if (issuedAt <= 0 || issuedAt > nowSeconds + 60 || expiresAt <= nowSeconds || expiresAt <= issuedAt || expiresAt - issuedAt > AUTH_SESSION_TTL) return null;
  if (String(payload.portal || '') !== currentPortalKey_()) return null;
  if (CacheService.getScriptCache().get('AUTH_REVOKED:' + payload.jti)) return null;
  return payload;
}

function readAuthSession_(token) {
  if (!token || String(token).length < 32 || String(token).length > AUTH_SESSION_TOKEN_MAX_LENGTH) return null;
  const signed = _readSignedAuthSession_(token);
  if (signed) return signed;
  const raw = CacheService.getScriptCache().get('AUTH:' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function refreshAuthSession_(token) {
  if (String(token || '').indexOf('.') !== -1) return;
  const session = readAuthSession_(token);
  if (session) CacheService.getScriptCache().put('AUTH:' + token, JSON.stringify(session), AUTH_SESSION_TTL);
}

function destroyAuthSession_(token) {
  const session = _readSignedAuthSession_(token);
  if (session && session.jti) {
    const seconds = Math.max(1, Math.min(AUTH_SESSION_TTL, Number(session.exp || 0) - Math.floor(Date.now() / 1000)));
    CacheService.getScriptCache().put('AUTH_REVOKED:' + session.jti, '1', seconds);
  }
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
