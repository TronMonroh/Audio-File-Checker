// tests/validator.test.js
// Run from the project folder:   node --test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  READ_BYTES,
  CHECKS,
  GENERAL_AUDACITY_STEPS,
  AUDACITY_VERSION_NOTE,
  validateFile,
  hasCanonicalHeader,
  formatSampleRate,
} = require('../validator.js');
const { PROFILES } = require('../profiles.js');
const { buildCorpus, chunk, riff, fmtBody, tone, canonicalWav, listChunk } = require('../tools/make-test-files.js');

const TEST_DIR = path.join(__dirname, '..', 'test-files');
const manifest = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'manifest.json'), 'utf8'));
const ALL_PRODUCTS = Object.keys(PROFILES);

// Check a test file the same way the app does: only the first 4KB is read,
// and the real file size is passed along.
function checkTestFile(name, productId) {
  const whole = fs.readFileSync(path.join(TEST_DIR, name));
  return validateFile(whole.subarray(0, READ_BYTES), name, PROFILES[productId], whole.length);
}

// Check bytes built in a test, as if they were a whole file.
function checkBytes(bytes, name, productId) {
  return validateFile(bytes.subarray(0, READ_BYTES), name, PROFILES[productId], bytes.length);
}

function failedIds(result) {
  return result.reasons.map((c) => c.id).sort();
}

function findCheck(result, id) {
  return result.checks.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// The test corpus, driven by manifest.json
// ---------------------------------------------------------------------------

for (const entry of manifest.files) {
  for (const [productId, expected] of Object.entries(entry.expected)) {
    test(`${entry.file} on ${productId}`, () => {
      const result = checkTestFile(entry.file, productId);
      if (expected === 'green') {
        assert.equal(result.result, 'green');
        assert.deepEqual(failedIds(result), []);
      } else {
        assert.equal(result.result, 'red');
        assert.deepEqual(failedIds(result), [...expected.because].sort());
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
  assert.deepEqual(manifest.products.slice().sort(), ALL_PRODUCTS.slice().sort());
  for (const entry of manifest.files) {
    assert.deepEqual(Object.keys(entry.expected).sort(), ALL_PRODUCTS.slice().sort(), entry.file);
    assert.ok(['script', 'hand'].includes(entry.builtBy), `${entry.file}: builtBy must be "script" or "hand"`);
  }
});

test('every check has at least one test file that fails it', () => {
  const triggered = new Set();
  for (const entry of manifest.files) {
    for (const expected of Object.values(entry.expected)) {
      if (expected !== 'green') expected.because.forEach((id) => triggered.add(id));
    }
  }
  for (const id of Object.keys(CHECKS)) {
    assert.ok(triggered.has(id), `No test file fails the "${id}" check. Add one to test-files/ and manifest.json.`);
  }
});

test('script-built test files match what tools/make-test-files.js builds', () => {
  const built = buildCorpus();
  const scriptFiles = manifest.files.filter((f) => f.builtBy === 'script').map((f) => f.file);
  assert.deepEqual(Object.keys(built).sort(), scriptFiles.sort(), 'manifest "script" files and the generator differ');
  for (const [name, bytes] of Object.entries(built)) {
    const onDisk = fs.readFileSync(path.join(TEST_DIR, name));
    assert.ok(onDisk.equals(bytes), `${name} is out of date. Run: node tools/make-test-files.js`);
  }
});

// ---------------------------------------------------------------------------
// The rule: Jamie's 44-byte header decides
// ---------------------------------------------------------------------------

test('reads exactly the first 4KB', () => {
  assert.equal(READ_BYTES, 4096);
});

test('the explanations always agree with the 44-byte rule', () => {
  for (const entry of manifest.files) {
    for (const productId of ALL_PRODUCTS) {
      const result = checkTestFile(entry.file, productId);
      const whole = fs.readFileSync(path.join(TEST_DIR, entry.file));
      const headerGreen = hasCanonicalHeader(whole.subarray(0, READ_BYTES), PROFILES[productId]);
      const extensionOk = findCheck(result, 'extension').status === 'pass';
      assert.equal(result.result === 'green', headerGreen && extensionOk, `${entry.file} / ${productId}`);
      // The safety-net reason should never be needed.
      assert.ok(!findCheck(result, 'header-layout'), `${entry.file} / ${productId} needed the safety net`);
    }
  }
});

test('only "green" and "red" results exist', () => {
  for (const entry of manifest.files) {
    for (const productId of ALL_PRODUCTS) {
      assert.ok(['green', 'red'].includes(checkTestFile(entry.file, productId).result));
    }
  }
});

test('the show-all-checks list is exactly the v1 rules', () => {
  const result = checkTestFile('canonical_stereo.wav', 'wav-trigger');
  assert.deepEqual(result.checks.map((c) => c.id), Object.keys(CHECKS));
  assert.deepEqual(Object.keys(CHECKS), [
    'wav-file',
    'metadata',
    'audio-data',
    'fmt-chunk',
    'fmt-size',
    'format-code',
    'bit-depth',
    'sample-rate',
    'channels',
    'extension',
  ]);
});

// ---------------------------------------------------------------------------
// Each "Known problem in the current utility" is handled (CLAUDE.md)
// ---------------------------------------------------------------------------

test('current utility bug: misses metadata between fmt and data', () => {
  const result = checkTestFile('list_between_fmt_and_data.wav', 'wav-trigger');
  assert.equal(result.result, 'red');
  assert.match(findCheck(result, 'metadata').message, /LIST/);
  assert.equal(result.detected.metadataBeforeAudio, true);
});

test('current utility bug: does not check fmt size or format code', () => {
  assert.equal(findCheck(checkTestFile('fmt_18_bytes.wav', 'wav-trigger'), 'fmt-size').status, 'fail');
  assert.equal(findCheck(checkTestFile('float32.wav', 'wav-trigger'), 'format-code').status, 'fail');
  assert.equal(findCheck(checkTestFile('extensible.wav', 'wav-trigger'), 'format-code').status, 'fail');
});

test('current utility bug: no bounds checking (chunk runs past the bytes read)', () => {
  const result = checkTestFile('large_metadata_block.wav', 'wav-trigger');
  // A clear reason, not "No fmt chunk found".
  assert.match(findCheck(result, 'metadata').message, /large metadata block/);
  assert.equal(findCheck(result, 'fmt-chunk').status, 'pass');
});

test('current utility bug: no bounds checking (never throws on short or cut-off bytes)', () => {
  // Every corpus file, cut off at every length from 0 to 100 bytes, plus
  // a few lengths around chunk boundaries.
  for (const entry of manifest.files) {
    const whole = fs.readFileSync(path.join(TEST_DIR, entry.file));
    const lengths = [];
    for (let n = 0; n <= 100; n++) lengths.push(n);
    lengths.push(1000, READ_BYTES - 1, READ_BYTES);
    for (const n of lengths) {
      for (const productId of ALL_PRODUCTS) {
        assert.doesNotThrow(() => validateFile(whole.subarray(0, n), entry.file, PROFILES[productId], whole.length));
        assert.doesNotThrow(() => validateFile(whole.subarray(0, n), entry.file, PROFILES[productId]));
      }
    }
  }
});

test('current utility bug: ignores RIFF chunk padding', () => {
  // A 3-byte chunk is followed by 1 padding byte. Without handling it, the
  // walk would lose its place and never find "data".
  const bytes = riff([chunk('fmt ', fmtBody({ channels: 2 })), chunk('abc ', Buffer.from([1, 2, 3])), chunk('data', tone({ channels: 2 }))]);
  const result = checkBytes(bytes, 'padding.wav', 'wav-trigger');
  assert.equal(findCheck(result, 'audio-data').status, 'pass');
  assert.match(findCheck(result, 'metadata').message, /abc/);
});

test('current utility bug: rejects .WAV', () => {
  assert.equal(checkTestFile('canonical_uppercase_ext.WAV', 'wav-trigger').result, 'green');
  assert.equal(checkBytes(canonicalWav(2), 'mixed_case.Wav', 'wav-trigger').result, 'green');
});

// ---------------------------------------------------------------------------
// Only the start of the file; anything after the audio is ignored
// ---------------------------------------------------------------------------

test('metadata after the audio is ignored, even inside the bytes read', () => {
  const whole = fs.readFileSync(path.join(TEST_DIR, 'list_after_data.wav'));
  assert.ok(whole.length < READ_BYTES, 'list_after_data.wav should be read whole');
  const result = checkTestFile('list_after_data.wav', 'wav-trigger');
  assert.equal(result.result, 'green');
  assert.equal(result.detected.metadataBeforeAudio, false);
});

test('never looks past the first 4KB, even if given more', () => {
  // Same file, given whole or as the first 4KB: same result.
  const whole = fs.readFileSync(path.join(TEST_DIR, 'large_metadata_block.wav'));
  const fromWhole = validateFile(whole, 'large_metadata_block.wav', PROFILES['wav-trigger']);
  const fromStart = checkTestFile('large_metadata_block.wav', 'wav-trigger');
  assert.deepEqual(fromWhole, fromStart);
});

// ---------------------------------------------------------------------------
// Decisions A and B
// ---------------------------------------------------------------------------

test('decision A: "No audio data found" when the whole file was read', () => {
  const result = checkTestFile('no_data_chunk.wav', 'wav-trigger');
  assert.equal(findCheck(result, 'audio-data').message, 'No audio data found.');
  assert.equal(findCheck(result, 'metadata').status, 'pass');
});

test('decision A: missing fmt chunk is named', () => {
  const result = checkTestFile('no_fmt_chunk.wav', 'wav-trigger');
  assert.match(findCheck(result, 'fmt-chunk').message, /No format information/);
});

test('decision B: wrong extension is red, with the agreed fix', () => {
  const result = checkTestFile('wrong_extension.mp3', 'wav-trigger');
  assert.equal(result.result, 'red');
  assert.equal(findCheck(result, 'extension').fix, 'Rename the file to end in .wav.');
  // Only a rename is needed, so no Audacity steps.
  assert.deepEqual(result.audacitySteps, []);
});

// ---------------------------------------------------------------------------
// What the result says
// ---------------------------------------------------------------------------

test('green says the file will play on the product', () => {
  assert.equal(checkTestFile('canonical_stereo.wav', 'wav-trigger').headline, 'This file will play on your WAV Trigger.');
  assert.equal(checkTestFile('canonical_mono.wav', 'tsunami-mono').headline, 'This file will play on your Tsunami Mono.');
});

test('red for a non-format reason says the audio format is correct and names the reason', () => {
  const cases = [
    ['list_before_fmt.wav', /metadata before the audio/],
    ['list_between_fmt_and_data.wav', /metadata before the audio/],
    ['large_metadata_block.wav', /large metadata block/],
    ['fmt_18_bytes.wav', /format chunk is 18 bytes/],
    ['wrong_extension.mp3', /does not end in \.wav/],
  ];
  for (const [file, reason] of cases) {
    const result = checkTestFile(file, 'wav-trigger');
    assert.equal(result.result, 'red', file);
    assert.equal(result.audioFormatCorrect, true, file);
    assert.match(result.headline, /The audio format is correct \(stereo, 44\.1kHz, 16-bit PCM\)/, file);
    assert.match(result.headline, reason, file);
  }
});

test('red for an audio format reason does not say the format is correct', () => {
  for (const [file, productId] of [
    ['48khz.wav', 'wav-trigger'],
    ['float32.wav', 'wav-trigger'],
    ['canonical_mono.wav', 'wav-trigger'],
    ['not_a_wav.wav', 'wav-trigger'],
  ]) {
    const result = checkTestFile(file, productId);
    assert.equal(result.audioFormatCorrect, false, file);
    assert.doesNotMatch(result.headline, /format is correct/, file);
  }
});

test('every red reason has a fix, and fixes point to the Audacity steps', () => {
  for (const entry of manifest.files) {
    for (const productId of ALL_PRODUCTS) {
      const result = checkTestFile(entry.file, productId);
      for (const reason of result.reasons) {
        assert.ok(reason.fix.length > 0, `${entry.file} / ${productId} / ${reason.id} has no fix`);
        if (reason.id !== 'extension') {
          assert.match(reason.fix, /Audacity/, `${entry.file} / ${productId} / ${reason.id}`);
        }
      }
      if (result.result === 'red' && failedIds(result).join() !== 'extension') {
        assert.ok(result.audacitySteps.length > 0, `${entry.file} / ${productId} has no Audacity steps`);
      }
    }
  }
});

// The main export steps from CLAUDE.md, shown on every red light that needs
// a re-export (tested by Seth with Audacity 4.0.2).
const MAIN_EXPORT_STEPS = [
  /File > Export audio/,
  /Format: WAV \(Microsoft\)/,
  /Channels: (Mono|Stereo|Mono or Stereo)/,
  /Sample rate: 44100 Hz/,
  /Encoding: Signed 16-bit PCM\. Check Encoding again after choosing the format, because it may not change automatically\./,
];

test('every red light that needs a re-export shows the main export steps', () => {
  for (const entry of manifest.files) {
    for (const productId of ALL_PRODUCTS) {
      const result = checkTestFile(entry.file, productId);
      if (result.result === 'red' && failedIds(result).join() !== 'extension') {
        const text = result.audacitySteps.join('\n');
        for (const step of MAIN_EXPORT_STEPS) {
          assert.match(text, step, `${entry.file} / ${productId}`);
        }
      }
    }
  }
});

test('Channels names what the product needs', () => {
  const steps = (file, productId) => checkTestFile(file, productId).audacitySteps;
  assert.ok(steps('canonical_mono.wav', 'wav-trigger').includes('Channels: Stereo, as WAV Trigger requires.'));
  assert.ok(steps('canonical_stereo.wav', 'tsunami-mono').includes('Channels: Mono, as Tsunami Mono requires.'));
  assert.ok(steps('48khz.wav', 'wav-trigger-pro').includes('Channels: Mono or Stereo, as WAV Trigger Pro requires.'));
});

test('Edit metadata is shown only when metadata was found before the audio', () => {
  for (const entry of manifest.files) {
    for (const productId of ALL_PRODUCTS) {
      const result = checkTestFile(entry.file, productId);
      const shown = result.audacitySteps.includes('Click Edit metadata and clear every field.');
      assert.equal(shown, failedIds(result).includes('metadata'), `${entry.file} / ${productId}`);
    }
  }
  // Checked directly too, so the test above can't pass by never showing it.
  assert.ok(checkTestFile('list_before_fmt.wav', 'wav-trigger').audacitySteps.includes('Click Edit metadata and clear every field.'));
  assert.ok(checkTestFile('large_metadata_block.wav', 'wav-trigger').audacitySteps.includes('Click Edit metadata and clear every field.'));
  assert.ok(!checkTestFile('48khz.wav', 'wav-trigger').audacitySteps.some((s) => /metadata/i.test(s)));
});

test('the 32-bit float note is shown for bit depth and encoding problems', () => {
  assert.ok(checkTestFile('float32.wav', 'wav-trigger').audacitySteps.some((s) => /32-bit float internally/.test(s)));
  assert.ok(!checkTestFile('48khz.wav', 'wav-trigger').audacitySteps.some((s) => /32-bit float/.test(s)));
  assert.deepEqual(checkTestFile('canonical_stereo.wav', 'wav-trigger').audacitySteps, []);
});

test('the general Audacity steps match CLAUDE.md', () => {
  const text = GENERAL_AUDACITY_STEPS.join('\n');
  assert.match(text, /Open the file in Audacity/);
  for (const step of MAIN_EXPORT_STEPS) assert.match(text, step);
  assert.match(text, /32-bit float/);
  // Audacity 4 writes no metadata before the audio, so Edit metadata is only
  // shown in a red result where metadata was found.
  assert.doesNotMatch(text, /Edit metadata/i);
  assert.equal(AUDACITY_VERSION_NOTE, 'These steps were tested with Audacity 4.0.2.');
});

test('the removed steps are gone from every step and fix', () => {
  for (const entry of manifest.files) {
    for (const productId of ALL_PRODUCTS) {
      const result = checkTestFile(entry.file, productId);
      const text = [...result.audacitySteps, ...result.reasons.map((r) => r.fix), ...GENERAL_AUDACITY_STEPS].join('\n');
      assert.doesNotMatch(text, /convert the track|project rate/i, `${entry.file} / ${productId}`);
    }
  }
});

test('detected values are reported for green and red', () => {
  assert.deepEqual(checkTestFile('canonical_mono.wav', 'tsunami-mono').detected, {
    channels: 1,
    sampleRate: 44100,
    bitsPerSample: 16,
    formatCode: 1,
    metadataBeforeAudio: false,
  });
  assert.deepEqual(checkTestFile('list_before_fmt.wav', 'wav-trigger').detected, {
    channels: 2,
    sampleRate: 44100,
    bitsPerSample: 16,
    formatCode: 1,
    metadataBeforeAudio: true,
  });
  const notWav = checkTestFile('not_a_wav.wav', 'wav-trigger').detected;
  assert.equal(notWav.channels, null);
  assert.equal(notWav.metadataBeforeAudio, null);
});

// ---------------------------------------------------------------------------
// Other
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

test('the same file always gets the same result', () => {
  const first = checkTestFile('list_before_fmt.wav', 'wav-trigger');
  const second = checkTestFile('list_before_fmt.wav', 'wav-trigger');
  assert.deepEqual(first, second);
});

test('accepts an ArrayBuffer as well as a Uint8Array', () => {
  const bytes = canonicalWav(2);
  const start = bytes.subarray(0, READ_BYTES);
  const arrayBuffer = start.buffer.slice(start.byteOffset, start.byteOffset + start.length);
  assert.equal(validateFile(arrayBuffer, 'test.wav', PROFILES['wav-trigger'], bytes.length).result, 'green');
});

test('a second fmt chunk before the audio counts as metadata', () => {
  const bytes = riff([chunk('fmt ', fmtBody({ channels: 2 })), chunk('fmt ', fmtBody({ channels: 2 })), chunk('data', tone({ channels: 2 }))]);
  const result = checkBytes(bytes, 'two_fmt.wav', 'wav-trigger');
  assert.equal(result.result, 'red');
  assert.deepEqual(failedIds(result), ['metadata']);
});

test('a LIST chunk named in the large-block message', () => {
  const bytes = riff([listChunk('y'.repeat(6000)), chunk('fmt ', fmtBody({ channels: 2 })), chunk('data', tone({ channels: 2 }))]);
  const result = checkBytes(bytes, 'big_list_first.wav', 'wav-trigger');
  assert.match(findCheck(result, 'metadata').message, /large metadata block \(LIST/);
  // The format chunk is past the first 4KB, so format checks are skipped.
  assert.equal(findCheck(result, 'fmt-chunk').status, 'skipped');
  assert.deepEqual(failedIds(result), ['metadata']);
});
