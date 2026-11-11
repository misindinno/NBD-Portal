// Persistent refresh sessions survive CacheService eviction; only token hashes are stored.
const AUTH_REFRESH_TTL = 7 * 24 * 60 * 60;
function refreshSessionKey_(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) throw new Error('SESSION_EXPIRED');
  return 'AUTH_REFRESH:' + _hexBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
}
function refreshCredentialStamp_(row) {
  return _base64UrlBytes_(Utilities.computeHmacSha256Signature(String(row.Password || ''), _authSigningSecret_()));
}
function createRefreshSession_(email, userId) {
  const row = _getUserByEmailIndexed_(email);
  if (!row) throw new Error('ACCESS_DENIED');
  const properties = PropertiesService.getScriptProperties();
  const now = Date.now();
  const all = properties.getProperties();
  Object.keys(all).filter(k => k.indexOf('AUTH_REFRESH:') === 0).forEach(k => {
    try { if (JSON.parse(all[k]).expiresAt <= now) properties.deleteProperty(k); } catch (_) { properties.deleteProperty(k); }
  });
  const refreshToken = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const expiresAt = now + AUTH_REFRESH_TTL * 1000;
  properties.setProperty(refreshSessionKey_(refreshToken), JSON.stringify({email, userId, portal: currentPortalKey_(), expiresAt, credential: refreshCredentialStamp_(row)}));
  return {refreshToken, refreshExpiresAt: expiresAt};
}
function exchangeRefreshSession_(token) {
  const properties = PropertiesService.getScriptProperties();
  const key = refreshSessionKey_(token);
  const raw = properties.getProperty(key);
  if (!raw) throw new Error('SESSION_EXPIRED');
  const record = JSON.parse(raw);
  if (record.expiresAt <= Date.now() || record.portal !== currentPortalKey_()) {
    properties.deleteProperty(key);
    throw new Error('SESSION_EXPIRED');
  }
  const row = _getUserByEmailIndexed_(record.email);
  const user = getCurrentUserByEmail_(record.email);
  if (!row || !user.success || String(user.data.id) !== String(record.userId) || !_constantTimeEqual_(record.credential, refreshCredentialStamp_(row))) {
    properties.deleteProperty(key);
    throw new Error('ACCESS_DENIED');
  }
  return {token: createAuthSession_(record.email, record.userId), refreshExpiresAt: record.expiresAt};
}
function destroyRefreshSession_(token) {
  if (!token) return;
  PropertiesService.getScriptProperties().deleteProperty(refreshSessionKey_(token));
}
