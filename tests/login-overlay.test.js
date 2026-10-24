'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('startup and cache-lock sign-in requests share one form and preserve entered values', () => {
  const mounted = [];
  let googleInitializations = 0;
  function node() {
    const children = new Map();
    return {
      style: {}, value: '', addEventListener() {}, focus() {},
      querySelector(selector) {
        if (selector === '.lo-err-msg, .lo-info-msg') return this.message || null;
        if (!children.has(selector)) children.set(selector, node());
        return children.get(selector);
      },
      prepend(value) { this.message = value; }
    };
  }
  const context = vm.createContext({
    document: {
      getElementById: id => mounted.find(el => el.id === id),
      createElement: node, body: { appendChild: el => mounted.push(el) }
    },
    APP_TITLE: 'Test Portal', escapeHtml: text => text, setTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/AppAuth.html'), 'utf8').replace(/<\/?script>/g, ''), context);
  context._ensureLoginFonts_ = () => {};
  context._initOverlayGoogleAuth = () => { googleInitializations++; };
  context.showLoginOverlay();
  const overlay = mounted[0];
  overlay.querySelector('#lo-email').value = 'user@example.test';
  overlay.querySelector('#lo-pw').value = 'entered password';
  context.showLoginOverlay('Please sign in again to verify your access.');
  context.showLoginOverlay('Your session expired. Please sign in again.');
  context.showLoginOverlay();
  assert.equal(mounted.length, 1);
  assert.equal(googleInitializations, 1);
  assert.equal(overlay.querySelector('#lo-email').value, 'user@example.test');
  assert.equal(overlay.querySelector('#lo-pw').value, 'entered password');
  assert.equal(overlay.querySelector('#lo-form').message.textContent, 'Your session expired. Please sign in again.');
  assert.equal(overlay.querySelector('#lo-form').message.className, 'lo-info-msg');
});
