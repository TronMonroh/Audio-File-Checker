// tests/validator.test.js
// Run from the project folder:   node --test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHECKS, validateFile, validateFiles, parseWav, formatSampleRate } = require('../validator.js');
const { PROFILES } = require('../profiles.js');
const { buildCorpus, chunk, riff, fmtBody, tone, goodWav } = require('../tools/make-test-files.js');

const TEST_DIR = path.join(__dirname, '..', 'test-files');
const manifest = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'manifest.json'), 'utf8'));

function readTestFile(name) {
  return fs.readFileSync(path.join(TEST_DIR, name));
}

// The ids of every check that came out as a warning or fail, sorted.
function problemIds(result) {
  return result.checks
    .filter((c) => c.status === 'warning' || c.status === 'fail')
    .map((c) => c.id)
    .sort();
}

// ---------------------------------------------------------------------------
// The test corpus, driven by manifest.json
// ---------------------------------------------------------------------------

for (const entry of manifest.files) {
  for (const [productId, expected] of Object.entries(entry.expected)) {
    test(`${entry.file} on ${productId}`, () => {
      const result = validateFile(readTestFile(entry.file), entry.file, PROFILES[productId]);
      if (expected === 'pass') {
        assert.equal(result.status, 'pass');
        assert.deepEqual(problemIds(result), []);
      } else {
        assert.equal(result.status, expected.status);
        assert.deepEqual(problemIds(result), [...expected.because].sort());
      }
    });
  }
}

for (const group of manifest.groups) {
  for (const [productId, expectedStatus] of Object.entries(group.expectedCheckStatus)) {
    test(`group [${group.files.join(', ')}] ${group.check} on ${productId}`, () => {
      const files = group.files.map((name) => ({ name, bytes: readTestFile(name) }));
      const results = validateFiles(files, PROFILES[productId]);
      for (const result of results) {
        const check = result.checks.find((c) => c.id === group.check);
        assert.equal(check.status, expectedStatus, result.filename);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Keeping the corpus and manifest honest
// ---------------------------------------------------------------------------

test('every file in test-files/ is in the manifest, and the other way round', () => {
  const onDisk = fs.readdirSync(TEST_DIR).filter((f) => f !== 'manifest.json' && !f.startsWith('.'));
  const listed = manifest.files.map((f) => f.file);
  assert.deepEqual(onDisk.sort(), listed.slice().sort());
});

test('every manifest file has an expected result for every product', () => {
  const productIds = Object.keys(PROFILES).sort();
  assert.deepEqual(manifest.products.slice().sort(), productIds);
  for (const entry of manifest.files) {
    assert.deepEqual(Object.keys(entry.expected).sort(), productIds, entry.file);
  }
  for (const group of manifest.groups) {
    assert.deepEqual(Object.keys(group.expectedCheckStatus).sort(), productIds, group.files.join(', '));
  }
});

test('every check has at least one test file that triggers it', () => {
  const triggered = new Set();
  for (const entry of manifest.files) {
    for (const expected of Object.values(entry.expected)) {
      if (expected !== 'pass') expected.because.forEach((id) => triggered.add(id));
    }
  }
  for (const group of manifest.groups) {
    if (Object.values(group.expectedCheckStatus).some((s) => s !== 'pass')) triggered.add(group.check);
  }
  for (const id of Object.keys(CHECKS)) {
    assert.ok(triggered.has(id), `No test file triggers the "${id}" check. Add one to test-files/ and manifest.json.`);
  }
});

test('test-files/ matches what tools/make-test-files.js builds', () => {
  for (const [name, bytes] of Object.entries(buildCorpus())) {
    assert.ok(readTestFile(name).equals(bytes), `${name} is out of date. Run: node tools/make-test-files.js`);
  }
});

// ---------------------------------------------------------------------------
// Smaller unit tests
// ---------------------------------------------------------------------------

test('validator.js does not touch the web page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'validator.js'), 'utf8');
  assert.doesNotMatch(source, /\bdocument\.|\bwindow\./);
});

test('sample rates are written in plain kHz', () => {
  assert.equal(formatSampleRate(44100), '44.1kHz');
  assert.equal(formatSampleRate(48000), '48kHz');
  assert.equal(formatSampleRate(22050), '22.05kHz');
});

test('48kHz message and fix match the wording in CLAUDE.md', () => {
  const result = validateFile(readTestFile('0003_48khz.wav'), '0003_48khz.wav', PROFILES['wav-trigger']);
  const check = result.checks.find((c) => c.id === 'sample-rate');
  assert.equal(check.message, 'Sample rate is 48kHz.');
  assert.equal(check.fix, 'Re-export at 44.1kHz.');
});

test('every warning and failure has a fix', () => {
  for (const entry of manifest.files) {
    for (const productId of Object.keys(PROFILES)) {
      const result = validateFile(readTestFile(entry.file), entry.file, PROFILES[productId]);
      for (const c of result.checks) {
        if (c.status === 'warning' || c.status === 'fail') {
          assert.ok(c.fix.length > 0, `${entry.file} / ${productId} / ${c.id} has no fix`);
        }
      }
    }
  }
});

test('unconfirmed rules are never failures', () => {
  for (const entry of manifest.files) {
    for (const productId of Object.keys(PROFILES)) {
      const result = validateFile(readTestFile(entry.file), entry.file, PROFILES[productId]);
      for (const c of result.checks) {
        if (!c.confirmed) assert.notEqual(c.status, 'fail', `${entry.file} / ${productId} / ${c.id}`);
      }
    }
  }
});

test('the same file always gets the same result', () => {
  const bytes = readTestFile('0007_list_chunk.wav');
  const first = validateFile(bytes, '0007_list_chunk.wav', PROFILES['wav-trigger']);
  const second = validateFile(bytes, '0007_list_chunk.wav', PROFILES['wav-trigger']);
  assert.deepEqual(first, second);
});

test('accepts an ArrayBuffer as well as a Uint8Array', () => {
  const bytes = goodWav(2);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  const result = validateFile(arrayBuffer, '0001_test.wav', PROFILES['wav-trigger']);
  assert.equal(result.status, 'pass');
});

test('reads past an odd-sized chunk using its padding byte', () => {
  // A 3-byte chunk is followed by 1 padding byte before the next chunk.
  const bytes = riff([chunk('fmt ', fmtBody({ channels: 2 })), chunk('abc ', Buffer.from([1, 2, 3])), chunk('data', tone({ channels: 2 }))]);
  const ids = parseWav(bytes).chunks.map((c) => c.id);
  assert.deepEqual(ids, ['fmt ', 'abc ', 'data']);
});

test('names the extra chunks in the message', () => {
  const result = validateFile(readTestFile('0007_list_chunk.wav'), '0007_list_chunk.wav', PROFILES['wav-trigger']);
  const check = result.checks.find((c) => c.id === 'extra-chunks');
  assert.match(check.message, /LIST/);
  assert.match(check.fix, /Audacity/);
});

test('suggests a 4-digit name on WAV Trigger Pro', () => {
  const result = validateFile(goodWav(2), '123_three_digits.wav', PROFILES['wav-trigger-pro']);
  const check = result.checks.find((c) => c.id === 'track-number');
  assert.equal(check.fix, 'Rename it to 0123_three_digits.wav.');
});

test('a space separator on WAV Trigger suggests an underscore', () => {
  const result = validateFile(goodWav(2), '0010 Track.wav', PROFILES['wav-trigger']);
  const check = result.checks.find((c) => c.id === 'track-separator');
  assert.equal(check.fix, 'To be safe, rename it to 0010_Track.wav.');
});

test('"12" and "0012" count as the same track', () => {
  const results = validateFiles(
    [
      { name: '12_a.wav', bytes: goodWav(2) },
      { name: '0012_b.wav', bytes: goodWav(2) },
    ],
    PROFILES['wav-trigger']
  );
  for (const r of results) {
    assert.equal(r.checks.find((c) => c.id === 'duplicate-track').status, 'warning');
  }
});

test('reports file facts for display', () => {
  const result = validateFile(readTestFile('0002_good_mono.wav'), '0002_good_mono.wav', PROFILES['tsunami-mono']);
  assert.deepEqual(result.info, {
    formatCode: 1,
    channels: 1,
    sampleRate: 44100,
    bitsPerSample: 16,
    chunks: ['fmt', 'data'],
  });
  assert.equal(result.trackNumber, 2);
});
