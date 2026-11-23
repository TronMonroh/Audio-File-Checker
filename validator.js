// validator.js
// Checks the start of a .wav file against a product from profiles.js.
//
// Pure functions only: header bytes and a filename go in, a result comes out.
// This file must never touch the web page, so it can be tested with Node.
//
// Main entry point:
//   validateFile(headerBytes, filename, profile, fileSize) -> result
//
// The result is 'green' (will play) or 'red' (won't play). There is no
// in-between. See "The rule (v1)" in CLAUDE.md.
//
// How it works:
//   1. The green/red decision is hasCanonicalHeader(): a direct copy of
//      Jamie's 44-byte header table.
//   2. The other checks walk the chunk list only to EXPLAIN a red light in
//      plain English ("Found a LIST metadata chunk before the audio").
//   3. The file name check (decision B) is separate, in checkExtension().

// How much of the file the app reads (decision D). Only the first 44 bytes
// decide green or red; the rest lets us name a metadata block.
const READ_BYTES = 4096;

// Every check, in the order shown in the "Show all checks" table. Labels are
// neutral names (not "No metadata..."), because they appear next to both
// passing and failing messages.
const CHECKS = {
  'wav-file': { group: 'File structure', label: 'WAV file' },
  'metadata': { group: 'File structure', label: 'Metadata before the audio' },
  'audio-data': { group: 'File structure', label: 'Audio data' },
  'fmt-chunk': { group: 'File structure', label: 'Format information' },
  'fmt-size': { group: 'File structure', label: 'Format chunk size' },
  'format-code': { group: 'Audio format', label: 'Audio encoding' },
  'bit-depth': { group: 'Audio format', label: 'Bit depth' },
  'sample-rate': { group: 'Audio format', label: 'Sample rate' },
  'channels': { group: 'Audio format', label: 'Channels' },
  // Decision B: the one file name check. Remove this line and
  // checkExtension() to drop it.
  'extension': { group: 'File name', label: 'File extension' },
};

// The checks that make up "the audio format". When all of these pass but the
// file is still red, the result says the audio format is correct.
const AUDIO_FORMAT_CHECKS = ['format-code', 'bit-depth', 'sample-rate', 'channels'];

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

// Names for format codes people are likely to run into.
const FORMAT_NAMES = {
  2: 'Microsoft ADPCM',
  3: '32-bit floating point',
  6: 'A-law',
  7: 'µ-law', // µ-law, written as a code so any file encoding works
  0x11: 'IMA ADPCM',
  0x55: 'MP3',
  0xfffe: 'WAVE_FORMAT_EXTENSIBLE',
};

// Plain-English descriptions of common metadata chunks.
const CHUNK_DESCRIPTIONS = {
  'LIST': 'tags such as title, artist or software',
  'bext': 'broadcast information',
  'id3 ': 'ID3 tags',
  'ID3 ': 'ID3 tags',
  'JUNK': 'padding',
  'PAD ': 'padding',
  'cue ': 'cue points',
  'smpl': 'sampler loop information',
  'inst': 'instrument information',
  'acid': 'loop information',
  'fact': 'sample count information',
};

// Every fix points to the Audacity steps, which the page shows below the
// result (see audacitySteps()).
const SEE_STEPS = '(see the Audacity steps below)';
const EXPORT_FIX = `Re-export the file from Audacity as WAV (Microsoft), Signed 16-bit PCM ${SEE_STEPS}.`;

// The Audacity steps, from CLAUDE.md. Seth tested these with Audacity 4.0.2
// (2026-11-22): every export made this way was green. Audacity 4 does not
// write metadata before the audio, so the Edit metadata step is only shown
// when metadata was actually found there.
const AUDACITY_VERSION_NOTE = 'These steps were tested with Audacity 4.0.2.';
const AUDACITY_STEPS = {
  open: 'Open the file in Audacity.',
  exportAudio: 'Choose File > Export audio.',
  format: 'Format: WAV (Microsoft).',
  channels: 'Channels: Mono or Stereo, as your product requires. Tsunami Mono needs Mono. WAV Trigger and Tsunami Stereo need Stereo. WAV Trigger Pro takes either.',
  rate: 'Sample rate: 44100 Hz.',
  encoding: 'Encoding: Signed 16-bit PCM. Check Encoding again after choosing the format, because it may not change automatically.',
  metadata: 'Click Edit metadata and clear every field.',
  floatNote: 'Note: Audacity works in 32-bit float internally, so the file only becomes 16-bit when you export it.',
};
const GENERAL_AUDACITY_STEPS = [
  AUDACITY_STEPS.open,
  AUDACITY_STEPS.exportAudio,
  AUDACITY_STEPS.format,
  AUDACITY_STEPS.channels,
  AUDACITY_STEPS.rate,
  AUDACITY_STEPS.encoding,
  AUDACITY_STEPS.floatNote,
];

// The names Audacity uses in its Channels setting: "Mono or Stereo".
function audacityChannels(profile) {
  return profile.channels.map((count) => (count === 1 ? 'Mono' : 'Stereo')).join(' or ');
}

// ---------------------------------------------------------------------------
// Small helpers for reading bytes. WAV files store numbers little-endian
// (lowest byte first). Each helper returns null if the bytes aren't there,
// so a short file can never cause an error.
// ---------------------------------------------------------------------------

function readId(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += String.fromCharCode(bytes[offset + i]);
  }
  return id;
}

function readU16(bytes, offset) {
  if (offset + 2 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  // ">>> 0" keeps the result a positive number.
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

// Make a chunk id safe to show to a person (some ids contain odd bytes).
function displayId(id) {
  const printable = id.replace(/[^\x20-\x7e]/g, '?').trim();
  return printable === '' ? '(blank)' : printable;
}

// 44100 -> "44.1kHz", 48000 -> "48kHz", 22050 -> "22.05kHz"
function formatSampleRate(rate) {
  return `${rate / 1000}kHz`;
}

function channelName(count) {
  if (count === 1) return 'mono';
  if (count === 2) return 'stereo';
  return `${count}-channel`;
}

function makeCheck(id, status, message, fix = '') {
  return { id, group: CHECKS[id].group, label: CHECKS[id].label, status, message, fix };
}

// ---------------------------------------------------------------------------
// The rule: Jamie's canonical 44-byte header. This alone decides whether the
// header is green. Byte positions are from the table in CLAUDE.md.
// ---------------------------------------------------------------------------

function hasCanonicalHeader(bytes, profile) {
  return (
    bytes.length >= 44 &&
    readId(bytes, 0) === 'RIFF' &&
    readId(bytes, 8) === 'WAVE' &&
    readId(bytes, 12) === 'fmt ' &&
    readU32(bytes, 16) === 16 &&
    readU16(bytes, 20) === FORMAT_PCM &&
    profile.channels.includes(readU16(bytes, 22)) &&
    readU32(bytes, 24) === profile.sampleRate &&
    readU16(bytes, 34) === profile.bitsPerSample &&
    readId(bytes, 36) === 'data'
  );
}

// ---------------------------------------------------------------------------
// Walking the chunks, to explain a red light
// ---------------------------------------------------------------------------

// After "RIFF", a size and "WAVE", a WAV file is a list of chunks. Each chunk
// is a 4-letter id, a 4-byte size, then that many bytes, plus one padding byte
// if the size is odd. The walk stops at "data": anything after the audio is
// never looked at by the players, so we never look at it either.
function walkChunks(bytes) {
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readId(bytes, offset);
    const size = readU32(bytes, offset + 4);
    chunks.push({ id, offset, size });
    if (id === 'data') return { chunks, foundData: true };
    offset += 8 + size + (size % 2);
  }
  // Reached the end of the bytes read without finding "data".
  return { chunks, foundData: false };
}

// Read the format fields from a "fmt " chunk. Returns null if they are not
// all inside the bytes read.
function readFmtFields(bytes, chunk) {
  const start = chunk.offset + 8;
  if (chunk.size < 16 || start + 16 > bytes.length) return null;
  return {
    formatCode: readU16(bytes, start),
    channels: readU16(bytes, start + 2),
    sampleRate: readU32(bytes, start + 4),
    bitsPerSample: readU16(bytes, start + 14),
  };
}

function describeChunks(chunks) {
  return chunks
    .map((c) => {
      const description = CHUNK_DESCRIPTIONS[c.id];
      return description ? `${displayId(c.id)} (${description})` : displayId(c.id);
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

// Structure: metadata before the audio, audio data, format chunk.
//   readWholeFile: true when the bytes read reach the real end of the file.
function checkStructure(bytes, walk, readWholeFile) {
  const checks = [];
  const fmtChunk = walk.chunks.find((c) => c.id === 'fmt ');
  // Everything before "data" except the first "fmt " chunk is metadata.
  const metadata = walk.chunks.filter((c) => c !== fmtChunk && c.id !== 'data');
  // Ran out of bytes read before finding "data", but the file goes on.
  const largeBlock = !walk.foundData && !readWholeFile;

  // Metadata before the audio
  if (largeBlock) {
    const named = metadata.length > 0 ? ` (${describeChunks(metadata)})` : '';
    checks.push(
      makeCheck(
        'metadata',
        'fail',
        `Found a large metadata block${named} before the audio. It is bigger than the first ${READ_BYTES / 1024}KB this checker reads.`,
        `Re-export from Audacity and click Edit metadata to clear every field ${SEE_STEPS}.`
      )
    );
  } else if (metadata.length > 0) {
    checks.push(
      makeCheck(
        'metadata',
        'fail',
        `Found metadata before the audio: ${describeChunks(metadata)}.`,
        `Re-export from Audacity and click Edit metadata to clear every field ${SEE_STEPS}.`
      )
    );
  } else {
    checks.push(makeCheck('metadata', 'pass', 'No metadata before the audio.'));
  }

  // Audio data (decision A)
  if (walk.foundData) {
    checks.push(makeCheck('audio-data', 'pass', 'Found the audio data.'));
  } else if (readWholeFile) {
    checks.push(makeCheck('audio-data', 'fail', 'No audio data found.', EXPORT_FIX));
  } else {
    checks.push(makeCheck('audio-data', 'skipped', `Not checked: the audio starts after the first ${READ_BYTES / 1024}KB.`));
  }

  // Format chunk (decision A)
  let fmt = null;
  if (fmtChunk) {
    fmt = readFmtFields(bytes, fmtChunk);
    if (fmt) {
      checks.push(makeCheck('fmt-chunk', 'pass', 'Found the format information.'));
    } else if (fmtChunk.size < 16) {
      checks.push(makeCheck('fmt-chunk', 'fail', 'The format information is incomplete.', EXPORT_FIX));
    } else {
      checks.push(makeCheck('fmt-chunk', 'skipped', `Not checked: the format information is past the first ${READ_BYTES / 1024}KB.`));
    }
  } else if (walk.foundData || readWholeFile) {
    checks.push(makeCheck('fmt-chunk', 'fail', 'No format information (fmt chunk) found before the audio.', EXPORT_FIX));
  } else {
    checks.push(makeCheck('fmt-chunk', 'skipped', `Not checked: not found in the first ${READ_BYTES / 1024}KB.`));
  }

  // Format chunk size
  if (!fmtChunk) {
    checks.push(makeCheck('fmt-size', 'skipped', 'Not checked: no format chunk found.'));
  } else if (fmtChunk.size === 16) {
    checks.push(makeCheck('fmt-size', 'pass', 'Format chunk is 16 bytes.'));
  } else {
    checks.push(
      makeCheck(
        'fmt-size',
        'fail',
        `The format chunk is ${fmtChunk.size} bytes, but it must be 16. Some programs write 18-byte or extensible headers.`,
        EXPORT_FIX
      )
    );
  }

  return { checks, fmt, metadataBeforeAudio: largeBlock || metadata.length > 0 };
}

function checkFormat(fmt, profile) {
  if (!fmt) {
    const reason = 'Not checked: the format information could not be read.';
    return AUDIO_FORMAT_CHECKS.map((id) => makeCheck(id, 'skipped', reason));
  }

  const checks = [];

  // Format code: must be plain PCM (1)
  if (fmt.formatCode === FORMAT_PCM) {
    checks.push(makeCheck('format-code', 'pass', 'Audio is PCM.'));
  } else {
    const name = FORMAT_NAMES[fmt.formatCode];
    const described = name ? `${name} (format code ${fmt.formatCode})` : `format code ${fmt.formatCode}`;
    checks.push(makeCheck('format-code', 'fail', `Audio is not plain PCM: it is ${described}.`, EXPORT_FIX));
  }

  // Bit depth
  if (fmt.bitsPerSample === profile.bitsPerSample) {
    checks.push(makeCheck('bit-depth', 'pass', `Bit depth is ${fmt.bitsPerSample}-bit.`));
  } else {
    checks.push(
      makeCheck(
        'bit-depth',
        'fail',
        `Bit depth is ${fmt.bitsPerSample}-bit, but it must be ${profile.bitsPerSample}-bit.`,
        `Re-export from Audacity with Encoding set to Signed 16-bit PCM ${SEE_STEPS}.`
      )
    );
  }

  // Sample rate
  if (fmt.sampleRate === profile.sampleRate) {
    checks.push(makeCheck('sample-rate', 'pass', `Sample rate is ${formatSampleRate(fmt.sampleRate)}.`));
  } else {
    checks.push(
      makeCheck(
        'sample-rate',
        'fail',
        `Sample rate is ${formatSampleRate(fmt.sampleRate)}, but it must be ${formatSampleRate(profile.sampleRate)}.`,
        `Re-export from Audacity with Sample rate set to 44100 Hz ${SEE_STEPS}.`
      )
    );
  }

  // Channels
  const needed = profile.channels.map(channelName).join(' or ');
  if (profile.channels.includes(fmt.channels)) {
    checks.push(makeCheck('channels', 'pass', `File is ${channelName(fmt.channels)}.`));
  } else {
    checks.push(
      makeCheck(
        'channels',
        'fail',
        `File is ${channelName(fmt.channels)}, but ${profile.name} needs ${needed}.`,
        `Re-export from Audacity with Channels set to ${audacityChannels(profile)} ${SEE_STEPS}.`
      )
    );
  }

  return checks;
}

// Decision B (Seth, pending Jamie): the file name must end in .wav, in any
// letter case. Kept separate so it can be removed in one small change.
function checkExtension(filename) {
  if (/\.wav$/i.test(filename)) {
    return makeCheck('extension', 'pass', 'File name ends in .wav.');
  }
  return makeCheck('extension', 'fail', 'File name does not end in .wav.', 'Rename the file to end in .wav.');
}

// The Audacity steps for a red light, tailored to what failed.
function audacitySteps(checks, profile) {
  const failed = new Set(checks.filter((c) => c.status === 'fail').map((c) => c.id));
  // Only a wrong file name: no need to re-export.
  if (failed.size === 1 && failed.has('extension')) return [];

  // The main export steps, shown on every red light. Channels names what
  // this product needs.
  const steps = [
    AUDACITY_STEPS.open,
    AUDACITY_STEPS.exportAudio,
    AUDACITY_STEPS.format,
    `Channels: ${audacityChannels(profile)}, as ${profile.name} requires.`,
    AUDACITY_STEPS.rate,
    AUDACITY_STEPS.encoding,
  ];
  // Only when metadata was found before the audio.
  if (failed.has('metadata')) steps.push(AUDACITY_STEPS.metadata);
  if (failed.has('bit-depth') || failed.has('format-code')) steps.push(AUDACITY_STEPS.floatNote);
  if (failed.has('extension')) steps.push('Make sure the file name ends in .wav.');
  return steps;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// Check one file.
//   headerBytes: the start of the file (the first READ_BYTES bytes), as a
//                Uint8Array or ArrayBuffer
//   filename:    the file's name, e.g. "piano.wav"
//   profile:     one entry from PROFILES
//   fileSize:    the real size of the whole file in bytes. Tells us whether
//                headerBytes reaches the end of the file. If left out, the
//                bytes are assumed to be the whole file.
function validateFile(headerBytes, filename, profile, fileSize) {
  let bytes = headerBytes instanceof ArrayBuffer ? new Uint8Array(headerBytes) : headerBytes;
  // Never look past READ_BYTES, even if given more.
  if (bytes.length > READ_BYTES) bytes = bytes.subarray(0, READ_BYTES);
  if (fileSize === undefined) fileSize = headerBytes.byteLength;
  const readWholeFile = bytes.length >= fileSize;

  let checks = [];
  let fmt = null;
  let metadataBeforeAudio = null;
  const isWav = bytes.length >= 12 && readId(bytes, 0) === 'RIFF' && readId(bytes, 8) === 'WAVE';

  if (!isWav) {
    checks.push(
      makeCheck(
        'wav-file',
        'fail',
        'This is not a WAV file: it does not start with RIFF and WAVE.',
        `Open it in Audacity and export it as a WAV file ${SEE_STEPS}. Renaming a file to .wav does not convert it.`
      )
    );
    const reason = 'Not checked: this is not a WAV file.';
    for (const id of ['metadata', 'audio-data', 'fmt-chunk', 'fmt-size', ...AUDIO_FORMAT_CHECKS]) {
      checks.push(makeCheck(id, 'skipped', reason));
    }
  } else {
    checks.push(makeCheck('wav-file', 'pass', 'Starts with RIFF and WAVE.'));
    const structure = checkStructure(bytes, walkChunks(bytes), readWholeFile);
    fmt = structure.fmt;
    metadataBeforeAudio = structure.metadataBeforeAudio;
    checks = checks.concat(structure.checks, checkFormat(fmt, profile));
  }

  checks.push(checkExtension(filename));

  // Safety net: the 44-byte rule decides. If it says red but no check above
  // explains why, still show red with a general reason.
  const headerGreen = hasCanonicalHeader(bytes, profile);
  const headerChecksPass = checks.every((c) => c.id === 'extension' || c.status !== 'fail');
  if (!headerGreen && headerChecksPass) {
    checks.push({
      id: 'header-layout',
      group: 'File structure',
      label: 'Standard 44-byte header',
      status: 'fail',
      message: 'The header is not the standard 44-byte WAV layout.',
      fix: EXPORT_FIX,
    });
  }

  const reasons = checks.filter((c) => c.status === 'fail');
  const result = reasons.length === 0 ? 'green' : 'red';

  // "The audio format is correct" only when every audio format check passed.
  const audioFormatCorrect = AUDIO_FORMAT_CHECKS.every((id) => checks.find((c) => c.id === id).status === 'pass');

  let headline;
  if (result === 'green') {
    headline = `This file will play on your ${profile.name}.`;
  } else if (audioFormatCorrect) {
    headline =
      `This file will not play on your ${profile.name}. ` +
      `The audio format is correct (${channelName(fmt.channels)}, ${formatSampleRate(fmt.sampleRate)}, ${fmt.bitsPerSample}-bit PCM), ` +
      `but: ${reasons.map((r) => r.message).join(' ')}`;
  } else {
    headline = `This file will not play on your ${profile.name}.`;
  }

  return {
    filename,
    productId: profile.id,
    result,
    headline,
    audioFormatCorrect,
    reasons,
    checks,
    // What was detected, shown for both green and red. null means unknown.
    detected: {
      channels: fmt ? fmt.channels : null,
      sampleRate: fmt ? fmt.sampleRate : null,
      bitsPerSample: fmt ? fmt.bitsPerSample : null,
      formatCode: fmt ? fmt.formatCode : null,
      metadataBeforeAudio,
    },
    audacitySteps: result === 'red' ? audacitySteps(checks, profile) : [],
  };
}

// Lets Node (the tests) load this file. In the browser, these are globals.
if (typeof module !== 'undefined') {
  module.exports = {
    READ_BYTES,
    CHECKS,
    GENERAL_AUDACITY_STEPS,
    AUDACITY_VERSION_NOTE,
    validateFile,
    hasCanonicalHeader,
    walkChunks,
    formatSampleRate,
    channelName,
  };
}
