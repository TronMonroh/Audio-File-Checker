// tools/make-test-files.js
// Builds the test corpus in test-files/. Each bad file has exactly one problem.
//
// Run from the project folder:   node tools/make-test-files.js
//
// The output is always byte-for-byte the same, and a test checks that the
// files in test-files/ match what this script builds. If you change this
// script, run it again and commit the new files.
//
// Expected results for each file live in test-files/manifest.json. Update it
// by hand when you add a file: it records what SHOULD happen, so it must not
// be generated from the validator's output.

const fs = require('node:fs');
const path = require('node:path');

const SECONDS = 0.1; // Short files keep the repo small.

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
function tone({ channels, sampleRate = 44100, bits = 16, float = false }) {
  const frames = Math.round(sampleRate * SECONDS);
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

// A correct file: 16-bit, 44.1kHz PCM with the standard 44-byte header.
function goodWav(channels) {
  return riff([chunk('fmt ', fmtBody({ channels })), chunk('data', tone({ channels }))]);
}

function buildCorpus() {
  const files = {};

  files['0001_good_stereo.wav'] = goodWav(2);
  files['0002_good_mono.wav'] = goodWav(1);

  files['0003_48khz.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2, sampleRate: 48000 })),
    chunk('data', tone({ channels: 2, sampleRate: 48000 })),
  ]);

  files['0004_24bit.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2, bits: 24 })),
    chunk('data', tone({ channels: 2, bits: 24 })),
  ]);

  // Real float files usually also have a "fact" chunk. It is left out so
  // this file has only one kind of problem.
  files['0005_float32.wav'] = riff([
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
  files['0006_extensible.wav'] = riff([chunk('fmt ', extensible), chunk('data', tone({ channels: 2 }))]);

  // A LIST/INFO chunk between fmt and data, the way many editors write tags.
  const software = Buffer.from('Lavf58.76.100\0', 'latin1');
  const listBody = Buffer.concat([Buffer.from('INFO', 'latin1'), chunk('ISFT', software)]);
  files['0007_list_chunk.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2 })),
    chunk('LIST', listBody),
    chunk('data', tone({ channels: 2 })),
  ]);

  // An "id3 " chunk after the audio, as some tag editors add.
  const id3Body = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0, 0, 0, 0, 0])]);
  files['0008_id3_chunk.wav'] = riff([
    chunk('fmt ', fmtBody({ channels: 2 })),
    chunk('data', tone({ channels: 2 })),
    chunk('id3 ', id3Body),
  ]);

  // A good file with the second half of its audio missing.
  const full = goodWav(2);
  const audioBytes = full.length - 44;
  files['0009_truncated.wav'] = full.subarray(0, full.length - audioBytes / 2);

  // Named the way a real WAV Trigger user named a file that did not play.
  files['0010 Track.wav'] = goodWav(2);

  // An 18-byte fmt chunk (16 bytes plus an empty extension size), which
  // some programs write. No extra chunks, but not the 44-byte layout.
  const fmt18 = Buffer.concat([fmtBody({ channels: 2 }), Buffer.from([0, 0])]);
  files['0011_fmt_18_bytes.wav'] = riff([chunk('fmt ', fmt18), chunk('data', tone({ channels: 2 }))]);

  // Two good files that share track number 12.
  files['0012_duplicate_a.wav'] = goodWav(2);
  files['0012_duplicate_b.wav'] = goodWav(2);

  // Not a WAV at all: the start of an MP3 file, renamed to .wav.
  const fakeMp3 = Buffer.alloc(256);
  Buffer.from('ID3', 'latin1').copy(fakeMp3, 0);
  fakeMp3[3] = 3;
  fakeMp3[10] = 0xff;
  fakeMp3[11] = 0xfb;
  files['0013_not_a_wav.wav'] = fakeMp3;

  // A good file with an upper-case extension. Should pass.
  files['0014_uppercase_ext.WAV'] = goodWav(2);

  // A good WAV with the wrong extension.
  files['0015_wrong_extension.mp3'] = goodWav(2);

  // A format section but no audio section.
  files['0016_no_data_chunk.wav'] = riff([chunk('fmt ', fmtBody({ channels: 2 }))]);

  // A good file whose RIFF size field is 100 bytes too big. All chunks are
  // complete, so the audio itself is intact.
  const mismatch = Buffer.from(goodWav(2));
  mismatch.writeUInt32LE(mismatch.readUInt32LE(4) + 100, 4);
  files['0017_riff_size_mismatch.wav'] = mismatch;

  // Filename problems, with good audio.
  files['5000_out_of_range.wav'] = goodWav(2);
  files['123_three_digits.wav'] = goodWav(2);
  files['no_track_number.wav'] = goodWav(2);

  return files;
}

// Write the files only when this script is run directly, not when a test
// loads it to compare.
if (require.main === module) {
  const dir = path.join(__dirname, '..', 'test-files');
  fs.mkdirSync(dir, { recursive: true });
  const files = buildCorpus();
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), bytes);
  }
  console.log(`Wrote ${Object.keys(files).length} files to test-files/`);
}

module.exports = { buildCorpus, chunk, riff, fmtBody, tone, goodWav };
