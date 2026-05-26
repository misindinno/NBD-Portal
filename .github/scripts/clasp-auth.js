// Writes CLASPRC_JSON secret to ~/.clasprc.json so clasp can authenticate
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const raw = process.env.CLASPRC_JSON || '';
if (!raw) {
  console.error('ERROR: CLASPRC_JSON env var is empty.');
  process.exit(1);
}

const candidates = [raw, raw.trim(), raw.replace(/\\n/g, '\n').trim()];
try {
  const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8');
  if (decoded.includes('{')) candidates.push(decoded.trim());
} catch (_) {}

let parsed = null;
for (const c of candidates) {
  try {
    parsed = JSON.parse(c);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (parsed && typeof parsed === 'object') break;
  } catch (_) {}
}

if (!parsed || typeof parsed !== 'object') {
  console.error('ERROR: CLASPRC_JSON could not be parsed as JSON.');
  process.exit(1);
}

const hasToken = !!(parsed.token?.refresh_token || parsed.tokens?.default?.refresh_token);
if (!hasToken) {
  console.error('ERROR: refresh_token missing in CLASPRC_JSON.');
  process.exit(1);
}

fs.writeFileSync(path.join(os.homedir(), '.clasprc.json'), JSON.stringify(parsed, null, 2));
console.log('clasp credentials written OK');
