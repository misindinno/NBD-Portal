/*
 * Emergency portal shell diagnostic.
 * Paste this whole file into the browser console only when PortalDiagnostics
 * is unavailable. It reports structure and capability signals, not app data.
 */
(function runEmergencyPortalDebug(global) {
  'use strict';

  var LIMITS = {
    reportLength: 30000,
    stringLength: 500,
    resources: 40,
    frames: 10,
    scripts: 30
  };
  var SENSITIVE_KEY = /password|passcode|token|secret|authorization|cookie|credential|api.?key|client.?id|spreadsheet.?id|folder.?id|drive.?id/i;

  function cap(value, maximum) {
    var text = String(value == null ? '' : value);
    return text.length > maximum ? text.slice(0, maximum) + '...[truncated]' : text;
  }

  function safeText(value) {
    return cap(value, LIMITS.stringLength)
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:token|auth|authorization|password|credential|secret|api_key)=)[^&#\s]+/gi, '$1[REDACTED]')
      .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, '[REDACTED_TOKEN]')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_ID]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  }

  function safeUrl(value) {
    try {
      var parsed = new URL(String(value || ''), global.location && global.location.href);
      return safeText(parsed.origin + parsed.pathname);
    } catch (error) {
      return safeText(String(value || '').split(/[?#]/)[0]);
    }
  }

  function sanitize(value, key, depth, seen) {
    var level = Number(depth || 0);
    var visited = seen || [];
    if (SENSITIVE_KEY.test(String(key || ''))) return typeof value === 'boolean' ? value : '[REDACTED]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return safeText(value);
    if (typeof value === 'function') return '[FUNCTION]';
    if (level >= 4) return '[TRUNCATED]';
    if (visited.indexOf(value) !== -1) return '[CIRCULAR]';
    var nextSeen = visited.concat([value]);
    if (Array.isArray(value)) {
      return value.slice(0, 40).map(function (item) { return sanitize(item, '', level + 1, nextSeen); });
    }
    var output = {};
    Object.keys(value).slice(0, 40).forEach(function (property) {
      output[property] = sanitize(value[property], property, level + 1, nextSeen);
    });
    return output;
  }

  function tokenPresent() {
    try {
      return Boolean(global.sessionStorage && global.sessionStorage.getItem('nbd_token')) ||
        Boolean(global.localStorage && global.localStorage.getItem('nbd_token'));
    } catch (error) {
      return null;
    }
  }

  function frameSummary(frame, index) {
    var summary = {
      index: index,
      id: safeText(frame.id || ''),
      name: safeText(frame.name || ''),
      src: safeUrl(frame.src || ''),
      visible: Boolean(frame.offsetWidth || frame.offsetHeight || frame.getClientRects().length)
    };
    try {
      var doc = frame.contentDocument;
      summary.sameOrigin = Boolean(doc);
      if (doc) {
        summary.inner = {
          readyState: doc.readyState,
          title: safeText(doc.title || ''),
          scriptCount: doc.scripts ? doc.scripts.length : 0,
          appShell: Boolean(doc.getElementById('app-shell')),
          diagnostics: Boolean(frame.contentWindow && frame.contentWindow.PortalDiagnostics)
        };
      }
    } catch (error) {
      summary.sameOrigin = false;
      summary.accessError = safeText(error && error.name || 'FRAME_ACCESS_BLOCKED');
    }
    return summary;
  }

  function collect() {
    var doc = global.document;
    var scripts = doc && doc.scripts ? Array.prototype.slice.call(doc.scripts, 0, LIMITS.scripts) : [];
    var frames = doc ? Array.prototype.slice.call(doc.querySelectorAll('iframe'), 0, LIMITS.frames) : [];
    var resources = [];
    try {
      resources = global.performance && typeof global.performance.getEntriesByType === 'function'
        ? global.performance.getEntriesByType('resource').slice(-LIMITS.resources).map(function (entry) {
          return {
            name: safeUrl(entry.name),
            initiatorType: safeText(entry.initiatorType || ''),
            durationMs: Math.max(0, Math.round(Number(entry.duration || 0)))
          };
        })
        : [];
    } catch (error) {}

    return sanitize({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      reason: 'PortalDiagnostics unavailable',
      page: {
        url: safeUrl(global.location && global.location.href),
        title: safeText(doc && doc.title || ''),
        readyState: doc && doc.readyState,
        online: global.navigator ? global.navigator.onLine !== false : null,
        visibility: doc && doc.visibilityState,
        userAgent: safeText(global.navigator && global.navigator.userAgent || '')
      },
      signals: {
        portalDiagnostics: Boolean(global.PortalDiagnostics),
        googleScriptRun: Boolean(global.google && global.google.script && global.google.script.run),
        appShell: Boolean(doc && doc.getElementById('app-shell')),
        loginOverlay: Boolean(doc && doc.getElementById('nbd-login-overlay')),
        tokenPresent: tokenPresent()
      },
      scripts: scripts.map(function (script) {
        return { src: script.src ? safeUrl(script.src) : 'inline', async: Boolean(script.async), defer: Boolean(script.defer) };
      }),
      frames: frames.map(frameSummary),
      recentResources: resources
    });
  }

  var report = collect();
  var json = JSON.stringify(report, null, 2);
  if (json.length > LIMITS.reportLength) {
    report.recentResources = [];
    report.reportTrimmed = true;
    json = JSON.stringify(report, null, 2);
  }
  if (json.length > LIMITS.reportLength) {
    json = JSON.stringify({
      schemaVersion: 1,
      generatedAt: report.generatedAt,
      reason: report.reason,
      page: report.page,
      signals: report.signals,
      reportTrimmed: true
    }, null, 2);
  }

  var formatted = 'PORTAL_DEBUG_REPORT_START\n' + json + '\nPORTAL_DEBUG_REPORT_END';
  global.console.log(formatted);
  try {
    if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
      global.navigator.clipboard.writeText(formatted).then(function () {
        global.console.log('Emergency portal debug report copied to clipboard.');
      }).catch(function () {});
    }
  } catch (error) {}
  return formatted;
})(window);
