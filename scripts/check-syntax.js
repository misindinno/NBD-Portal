const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const failures = [];

function checkJavaScript(file, source, label) {
  try {
    new vm.Script(source, { filename: label || file });
  } catch (error) {
    failures.push(`${label || file}: ${error.message}`);
  }
}

const serverDir = path.join(root, 'src', 'server');
for (const name of fs.readdirSync(serverDir).filter(name => name.endsWith('.js'))) {
  const file = path.join(serverDir, name);
  checkJavaScript(file, fs.readFileSync(file, 'utf8'));
}

const srcDir = path.join(root, 'src');
for (const name of fs.readdirSync(srcDir).filter(name => name.endsWith('.html'))) {
  const file = path.join(srcDir, name);
  const html = fs.readFileSync(file, 'utf8');
  const scripts = html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi);
  let index = 0;
  for (const match of scripts) {
    index += 1;
    const source = match[1].replace(/<\?(?:!=|=)?[\s\S]*?\?>/g, 'null');
    const mimeWildcard = source.match(/\b[a-z][a-z0-9.+-]*\/\*/i);
    if (mimeWildcard) {
      failures.push(`${file}#script-${index}: Apps Script HtmlService can truncate inline scripts containing MIME wildcard ${mimeWildcard[0]}; use explicit MIME types.`);
    }
    checkJavaScript(file, source, `${file}#script-${index}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Syntax OK: server JavaScript and inline HTML scripts.');
