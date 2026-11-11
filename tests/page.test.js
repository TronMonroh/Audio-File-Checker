// tests/page.test.js
// Checks the page files for the hard requirements in CLAUDE.md. These read
// the files as text; they do not run a browser.
// Run from the project folder:   node --test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const pageFiles = ['index.html', 'app.js', 'styles.css', 'validator.js', 'profiles.js'];

test('CSP blocks all network connections', () => {
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /connect-src 'none'/);
});

test('no external URLs (no CDNs, fonts or analytics)', () => {
  for (const name of pageFiles) {
    assert.doesNotMatch(read(name), /(https?:)?\/\/[a-z0-9-]+\.[a-z]/i, `${name} contains an external URL`);
  }
});

test('works from file://: plain script tags with relative paths, no modules', () => {
  assert.doesNotMatch(html, /type="module"/);
  for (const name of pageFiles) {
    assert.doesNotMatch(read(name), /^\s*(import|export)\s/m, `${name} uses import/export`);
  }
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['profiles.js', 'validator.js', 'app.js']);
});

test('the page reads only the start of the file', () => {
  const app = read('app.js');
  assert.match(app, /file\.slice\(0, READ_BYTES\)/);
  assert.doesNotMatch(app, /file\.arrayBuffer\(\)/);
});

test('the file input accepts .wav and takes one file', () => {
  const input = html.match(/<input type="file"[^>]*>/)[0];
  assert.match(input, /accept="[^"]*\.wav/i);
  assert.doesNotMatch(input, /multiple/);
});

test('page shows the product question, Qwiic hint and Audacity help', () => {
  assert.match(html, /Which product are you using\?/);
  assert.match(html, /Not sure\? The Qwiic Tsunami ships with mono firmware\./);
  assert.match(html, /How to create a compatible file/);
});

test('no "What this does not check" section in v1', () => {
  assert.doesNotMatch(html, /does not check/i);
});

test('the selected file is cleared when the page is shown again', () => {
  assert.match(read('app.js'), /addEventListener\('pageshow', clearFile\)/);
});
