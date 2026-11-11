// tools/make-test-files.js
// Builds the test corpus in test-files/. Each red file has exactly one problem.
//
// Run from the project folder:   node tools/make-test-files.js
//
// The output is always byte-for-byte the same, and a test checks that the
// files in test-files/ match what this script builds. If you change this
// script, run it again and commit the new files.
//
// Some test files are not built by this script (for example the Audacity
// export, which must come from real Audacity). Those are marked
// "builtBy": "hand" in manifest.json, and this script leaves them alone.
//
// Expected results for each file live in test-files/manifest.json. Update it
// by hand when you add a file: it records what SHOULD happen, so it must not
// be generated from the validator's output.

const fs = require('node:fs');
const path = require('node:path');

const SECONDS = 0.1; // Short files keep the repo small, but still over 4KB.

// One chunk: 4-letter id, 4-byte size, body, and a pad byte if the size is odd.
function chunk(id, body) {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, body, pad]);
}

// A whole file: "RIFF", size, "WAVE", then the chunks.
function riff(chunks) {
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// The 16-byte "fmt " chunk body.
function fmtBody({ formatCode = 1, channels, sampleRate = 44100, bits = 16 }) {
  const blockAlign = channels * (bits / 8);
  const body = Buffer.alloc(16);
  body.writeUInt16LE(formatCode, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(sampleRate, 4);
  body.writeUInt32LE(sampleRate * blockAlign, 8);
  body.writeUInt16LE(blockAlign, 12);
  body.writeUInt16LE(bits, 14);
  return body;
}

// A 440Hz tone. No randomness, so the bytes are always the same.
function tone({ channels, sampleRate = 44100, bits = 16, float = false, seconds = SECONDS }) {
  const frames = Math.round(sampleRate * seconds);
  const bytesPerSample = bits / 8;
  const out = Buffer.alloc(frames * channels * bytesPerSample);
  let pos = 0;
  for (let i = 0; i < frames; i++) {
    const value = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      if (float) {
        out.writeFloatLE(value, pos);
      } else if (bits === 16) {
        out.writeInt16LE(Math.round(value * 32767), pos);
      } else if (bits === 24) {
        out.writeIntLE(Math.round(value * 8388607), pos, 3);
      }
      pos += bytesPerSample;
    }
  }
  return out;
}

// A correct file: 16-bit, 44.1kHz PCM with the canonical 44-byte header.
function canonicalWav(channels) {
  return riff([chunk('fmt ', fmtBody({ channels })), chunk('data', tone({ channels }))]);
}

// A LIST/INFO metadata chunk, the way many editors write tags.
function listChunk(text = 'Lavf58.76.100') {
  const software = Buffer.from(text + '\0', 'latin1');
  return chunk('LIST', Buffer.concat([Buffer.from('INFO', 'latin1'), chunk('ISFT', software)]));
}

function buildCorpus() {
  const files = {};

  // --- Green (for products that take the file's channel count) ---

  files['canonical_stereo.wav'] = canonicalWav(2);
  files['canonical_mono.wav'] = canonicalWav(1);
  files['canonical_uppercase_ext.WAV'] = canonicalWav(2);

  // Metadata AFTER the audio is ignored. The audio is kept very short so the
  // LIST chunk falls inside the first 4KB: this proves the checker stops at
  // "data" rather than only passing because it never read that far.
  files['list_after_data.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2 })),
    chunk('data', tone({ channels: 2, seconds: 0.005 })),
    listChunk(),
  ]);

  // An "id3 " chunk after the audio, as some tag editors add (decision G).
  const id3Body = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0, 0, 0, 0, 0])]);
  files['id3_after_data.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2 })),
    chunk('data', tone({ channels: 2 })),
    chunk('id3 ', id3Body),
  ]);

  // --- Red: audio format ---

  files['48khz.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2, sampleRate: 48000 })),
    chunk('data', tone({ channels: 2, sampleRate: 48000 })),
  ]);

  files['24bit.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2, bits: 24 })),
    chunk('data', tone({ channels: 2, bits: 24 })),
  ]);

  // Real float files usually also have a "fact" chunk. It is left out so
  // this file has only one kind of problem.
  files['float32.wav'] = riff([
    chunk('fmt ', fmtBody({ formatCode: 3, channels: 2, bits: 32 })),
    chunk('data', tone({ channels: 2, bits: 32, float: true })),
  ]);

  // WAVE_FORMAT_EXTENSIBLE wrapping ordinary 16-bit PCM. The fmt chunk is
  // 40 bytes instead of 16.
  const extensible = Buffer.concat([
    fmtBody({ formatCode: 0xfffe, channels: 2 }),
    Buffer.from([22, 0]), // size of the extension
    Buffer.from([16, 0]), // valid bits per sample
    Buffer.from([3, 0, 0, 0]), // speaker mask: front left + front right
    // Sub-format GUID for PCM: 00000001-0000-0010-8000-00aa00389b71
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]),
  ]);
  files['extensible.wav'] = riff([chunk('fmt ', extensible), chunk('data', tone({ channels: 2 }))]);

  // --- Red: header layout and metadata ---

  // An 18-byte fmt chunk (16 bytes plus an empty extension size), which
  // some programs write.
  const fmt18 = Buffer.concat([fmtBody({ channels: 2 }), Buffer.from([0, 0])]);
  files['fmt_18_bytes.wav'] = riff([chunk('fmt ', fmt18), chunk('data', tone({ channels: 2 }))]);

  files['list_before_fmt.wav'] = riff([
    listChunk(),
    chunk('fmt ', fmtBody({ channels: 2 })),
    chunk('data', tone({ channels: 2 })),
  ]);

  files['list_between_fmt_and_data.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2 })),
    listChunk(),
    chunk('data', tone({ channels: 2 })),
  ]);

  // A LIST chunk bigger than the first 4KB, e.g. from embedded artwork or a
  // long comment. The checker never reaches "data".
  files['large_metadata_block.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2 })),
    listChunk('x'.repeat(8000)),
    chunk('data', tone({ channels: 2 })),
  ]);

  // --- Red: not a WAV, missing chunks (decision A) ---

  // The start of an MP3 file, renamed to .wav.
  const fakeMp3 = Buffer.alloc(256);
  Buffer.from('ID3', 'latin1').copy(fakeMp3, 0);
  fakeMp3[3] = 3;
  fakeMp3[10] = 0xff;
  fakeMp3[11] = 0xfb;
  files['not_a_wav.wav'] = fakeMp3;

  // A format chunk but no audio. Small, so the whole file is read.
  files['no_data_chunk.wav'] = riff([chunk('fmt ', fmtBody({ channels: 2 }))]);

  // Audio but no format chunk.
  files['no_fmt_chunk.wav'] = riff([chunk('data', tone({ channels: 2 }))]);

  // --- Red: file name (decision B) ---

  files['wrong_extension.mp3'] = canonicalWav(2);

  return files;
}

// Write the files only when this script is run directly, not when a test
// loads it to compare. Old built files that are no longer in the corpus are
// deleted, but handmade files and manifest.json are kept.
if (require.main === module) {
  const dir = path.join(__dirname, '..', 'test-files');
  fs.mkdirSync(dir, { recursive: true });
  const files = buildCorpus();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const handmade = manifest.files.filter((f) => f.builtBy === 'hand').map((f) => f.file);
  const keep = new Set([...Object.keys(files), ...handmade, 'manifest.json']);
  for (const name of fs.readdirSync(dir)) {
    if (!keep.has(name) && !name.startsWith('.')) {
      fs.unlinkSync(path.join(dir, name));
      console.log(`Removed ${name}`);
    }
  }
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), bytes);
  }
  console.log(`Wrote ${Object.keys(files).length} files to test-files/`);
}

module.exports = { buildCorpus, chunk, riff, fmtBody, tone, canonicalWav, listChunk };
