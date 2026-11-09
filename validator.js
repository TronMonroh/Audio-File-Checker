// validator.js
// Checks .wav files against a device profile from profiles.js.
//
// Pure functions only: bytes and a filename go in, a result comes out.
// This file must never touch the web page, so it can be tested with Node.
//
// Main entry points:
//   validateFile(bytes, filename, profile)  -> result for one file
//   validateFiles(files, profile)           -> results for several files,
//                                              including duplicate track checks
//
// Every result has a status: 'pass', 'warning' or 'fail'.
// Every check inside it has a status: 'pass', 'warning', 'fail' or 'skipped'
// ('skipped' means an earlier problem made the check impossible).

// ---------------------------------------------------------------------------
// The list of checks. The id is used in tests and in test-files/manifest.json.
// ---------------------------------------------------------------------------

const CHECKS = {
  'riff-header': { group: 'File structure', label: 'WAV file header' },
  'file-length': { group: 'File structure', label: 'File is complete' },
  'required-chunks': { group: 'File structure', label: 'Format and audio sections' },
  'format-code': { group: 'Audio format', label: 'PCM audio' },
  'bit-depth': { group: 'Audio format', label: 'Bit depth' },
  'sample-rate': { group: 'Audio format', label: 'Sample rate' },
  'channels': { group: 'Audio format', label: 'Mono or stereo' },
  'extra-chunks': { group: 'Metadata', label: 'No extra metadata' },
  'canonical-header': { group: 'Metadata', label: 'Standard 44-byte header' },
  'extension': { group: 'Filename', label: 'Ends in .wav' },
  'track-number': { group: 'Filename', label: 'Track number' },
  'track-separator': { group: 'Filename', label: 'Separator after track number' },
  'duplicate-track': { group: 'Across files', label: 'Unique track number' },
};

// Things this app cannot check. Show these so a pass is never misread as
// "the card will work".
const NOT_CHECKED = [
  {
    topic: 'SD card format',
    detail:
      'A browser cannot see how your card is formatted. Use FAT16 or FAT32 with a 32KB allocation size.',
  },
  {
    topic: 'SD card speed',
    detail:
      'Clicks, pops or dropouts usually mean the card is too slow on some reads (over about 23ms). Files cannot show this. Test your card with the Robertsonics microSD test firmware, and see the "microSD Cards for Audio 2024" article.',
  },
  {
    topic: 'Other files on the card',
    detail:
      'This app checks only the files you select. It does not check init or preset files, folders, or other files on the card.',
  },
];

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

// Names for format codes people are likely to run into.
const FORMAT_NAMES = {
  2: 'Microsoft ADPCM',
  6: 'A-law',
  7: 'µ-law',
  0x11: 'IMA ADPCM',
  0x55: 'MP3',
};

// Plain-English descriptions of common extra chunks.
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

const EXPORT_FIX = 'Re-export as WAV (Microsoft) signed 16-bit PCM.';
const METADATA_FIX =
  'In Audacity, export as "WAV (Microsoft) signed 16-bit PCM" and click "Clear" in the metadata dialog so no tags are saved.';

// ---------------------------------------------------------------------------
// Small helpers for reading bytes. WAV files store numbers little-endian
// (lowest byte first).
// ---------------------------------------------------------------------------

function readId(bytes, offset) {
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += String.fromCharCode(bytes[offset + i]);
  }
  return id;
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
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
  const printable = id.replace(/[^\x20-\x7e]/g, '?');
  return printable.trim() === '' ? '(blank)' : printable.trim();
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

function makeCheck(id, status, message, fix = '', confirmed = true) {
  return {
    id,
    group: CHECKS[id].group,
    label: CHECKS[id].label,
    status,
    message,
    fix,
    // false means the rule is not yet confirmed with Robertsonics.
    confirmed,
  };
}

// The worst status wins: fail beats warning beats pass.
function overallStatus(checks) {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warning')) return 'warning';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Reading the file's structure
// ---------------------------------------------------------------------------

// A WAV file is "RIFF", a size, "WAVE", then a list of chunks.
// Each chunk is a 4-letter id, a 4-byte size, then that many bytes
// (plus one padding byte if the size is odd).
function parseWav(bytes) {
  const wav = {
    isRiffWave: false,
    riffSize: null,
    fileLength: bytes.length,
    chunks: [],
  };

  if (bytes.length < 12 || readId(bytes, 0) !== 'RIFF' || readId(bytes, 8) !== 'WAVE') {
    return wav;
  }
  wav.isRiffWave = true;
  wav.riffSize = readU32(bytes, 4);

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readId(bytes, offset);
    const size = readU32(bytes, offset + 4);
    // "complete" is false when the chunk says it is longer than the file.
    const complete = offset + 8 + size <= bytes.length;
    wav.chunks.push({ id, offset, size, complete });
    if (!complete) break;
    offset += 8 + size + (size % 2);
  }

  return wav;
}

// Read the "fmt " chunk. Returns null if it is missing, cut off or too short.
function readFmt(bytes, wav) {
  const chunk = wav.chunks.find((c) => c.id === 'fmt ');
  if (!chunk || !chunk.complete || chunk.size < 16) return null;

  const start = chunk.offset + 8;
  const fmt = {
    formatCode: readU16(bytes, start),
    channels: readU16(bytes, start + 2),
    sampleRate: readU32(bytes, start + 4),
    bitsPerSample: readU16(bytes, start + 14),
    subFormatCode: null,
  };
  // WAVE_FORMAT_EXTENSIBLE stores the real format 24 bytes into the chunk.
  if (fmt.formatCode === FORMAT_EXTENSIBLE && chunk.size >= 40) {
    fmt.subFormatCode = readU16(bytes, start + 24);
  }
  return fmt;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function checkStructure(wav) {
  const checks = [];

  checks.push(makeCheck('riff-header', 'pass', 'Starts with RIFF and WAVE.'));

  // File length
  const cutOff = wav.chunks.some((c) => !c.complete);
  if (cutOff) {
    checks.push(
      makeCheck(
        'file-length',
        'fail',
        'The file is cut off: its header says it holds more data than the file contains.',
        'The file was not saved or copied completely. Export or copy it again.'
      )
    );
  } else if (wav.riffSize + 8 !== wav.fileLength) {
    checks.push(
      makeCheck(
        'file-length',
        'warning',
        `The size written in the file header (${wav.riffSize + 8} bytes) does not match the real file size (${wav.fileLength} bytes). It is not yet confirmed whether the board cares.`,
        `To be safe, ${EXPORT_FIX.charAt(0).toLowerCase()}${EXPORT_FIX.slice(1)}`,
        false
      )
    );
  } else {
    checks.push(makeCheck('file-length', 'pass', 'File size matches its header.'));
  }

  // Exactly one "fmt " and one "data" chunk
  const fmtChunks = wav.chunks.filter((c) => c.id === 'fmt ');
  const dataChunks = wav.chunks.filter((c) => c.id === 'data');
  const problems = [];
  if (fmtChunks.length === 0) problems.push('it has no format section ("fmt " chunk)');
  if (fmtChunks.length > 1) problems.push(`it has ${fmtChunks.length} format sections`);
  if (fmtChunks.length === 1 && fmtChunks[0].size < 16) problems.push('its format section is too short');
  if (dataChunks.length === 0) problems.push('it has no audio section ("data" chunk)');
  if (dataChunks.length > 1) problems.push(`it has ${dataChunks.length} audio sections`);

  if (problems.length === 0) {
    checks.push(makeCheck('required-chunks', 'pass', 'Has one format section and one audio section.'));
  } else {
    checks.push(
      makeCheck('required-chunks', 'fail', `This file is not a normal WAV file: ${problems.join(', ')}.`, EXPORT_FIX)
    );
  }

  return checks;
}

function checkFormat(fmt, profile) {
  if (!fmt) {
    const reason = 'Not checked: the format section is missing or unreadable.';
    return ['format-code', 'bit-depth', 'sample-rate', 'channels'].map((id) => makeCheck(id, 'skipped', reason));
  }

  const checks = [];

  // Format code: must be plain PCM (1)
  if (fmt.formatCode === FORMAT_PCM) {
    checks.push(makeCheck('format-code', 'pass', 'Audio is PCM.'));
  } else if (fmt.formatCode === FORMAT_FLOAT) {
    checks.push(makeCheck('format-code', 'fail', 'Audio is 32-bit floating point.', EXPORT_FIX));
  } else if (fmt.formatCode === FORMAT_EXTENSIBLE) {
    const inner = fmt.subFormatCode === FORMAT_FLOAT ? ' with floating-point audio' : '';
    checks.push(
      makeCheck(
        'format-code',
        'fail',
        `File uses the "WAVE_FORMAT_EXTENSIBLE" header${inner}, which the board does not read.`,
        `${EXPORT_FIX} Some programs write this header for 24-bit or multichannel audio.`
      )
    );
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
        `Bit depth is ${fmt.bitsPerSample}-bit.`,
        `Re-export at ${profile.bitsPerSample}-bit.`
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
        `Sample rate is ${formatSampleRate(fmt.sampleRate)}.`,
        `Re-export at ${formatSampleRate(profile.sampleRate)}.`
      )
    );
  }

  // Channels
  const rule = profile.channels;
  const name = channelName(fmt.channels);
  if (rule.allowed.includes(fmt.channels)) {
    checks.push(makeCheck('channels', 'pass', `File is ${name}.`));
  } else if (rule.unconfirmed.includes(fmt.channels)) {
    checks.push(makeCheck('channels', 'warning', rule.unconfirmedMessage, rule.unconfirmedFix, false));
  } else {
    const needed = rule.allowed.map(channelName).join(' or ');
    checks.push(
      makeCheck('channels', 'fail', `File is ${name}, but ${profile.name} needs ${needed}.`, rule.fix)
    );
  }

  return checks;
}

function checkMetadata(wav) {
  const checks = [];
  const extras = wav.chunks.filter((c) => c.id !== 'fmt ' && c.id !== 'data');

  // Extra chunks (metadata). The board needs files with no additional
  // header information.
  if (extras.length === 0) {
    checks.push(makeCheck('extra-chunks', 'pass', 'No extra metadata.'));
  } else {
    const list = extras
      .map((c) => {
        const description = CHUNK_DESCRIPTIONS[c.id];
        return description ? `${displayId(c.id)} (${description})` : displayId(c.id);
      })
      .join(', ');
    checks.push(
      makeCheck('extra-chunks', 'fail', `File contains extra information the board does not expect: ${list}.`, METADATA_FIX)
    );
  }

  // Canonical 44-byte header: "fmt " is 16 bytes and comes first, and "data"
  // starts at byte 36. Not confirmed as a requirement, so only a warning.
  const fmt = wav.chunks.find((c) => c.id === 'fmt ');
  const data = wav.chunks.find((c) => c.id === 'data');
  if (extras.length > 0) {
    checks.push(makeCheck('canonical-header', 'skipped', 'Not checked: remove the extra metadata first.'));
  } else if (!fmt || !data) {
    checks.push(makeCheck('canonical-header', 'skipped', 'Not checked: the format or audio section is missing.'));
  } else if (fmt.offset === 12 && fmt.size === 16 && data.offset === 36) {
    checks.push(makeCheck('canonical-header', 'pass', 'Header is the standard 44-byte layout.'));
  } else {
    const detail = fmt.size !== 16 ? ` (the format section is ${fmt.size} bytes; standard is 16)` : '';
    checks.push(
      makeCheck(
        'canonical-header',
        'warning',
        `Header is not the standard 44-byte layout${detail}. It is not yet confirmed whether the board requires the standard layout.`,
        `To be safe, ${EXPORT_FIX.charAt(0).toLowerCase()}${EXPORT_FIX.slice(1)}`,
        false
      )
    );
  }

  return checks;
}

// Describe a separator character in words.
function describeSeparator(char) {
  if (char === ' ') return 'a space';
  if (char === '_') return 'an underscore (_)';
  if (char === '-') return 'a hyphen (-)';
  if (char === '.') return 'nothing (the name is only a number)';
  if (char === undefined) return 'nothing';
  return `"${char}"`;
}

function checkFilename(filename, profile) {
  const checks = [];
  let trackNumber = null;

  // Extension
  if (/\.wav$/i.test(filename)) {
    checks.push(makeCheck('extension', 'pass', 'File name ends in .wav.'));
  } else {
    checks.push(
      makeCheck(
        'extension',
        'fail',
        'File name does not end in .wav.',
        'Rename it to end in .wav. If it is not really a WAV file, export it as WAV instead.'
      )
    );
  }

  // Track number: the digits at the start of the name
  const track = profile.track;
  const match = filename.match(/^(\d+)/);
  if (!match) {
    checks.push(
      makeCheck(
        'track-number',
        'fail',
        'File name does not start with a track number.',
        `Rename it to start with a track number, for example ${track.example}.`
      )
    );
    checks.push(makeCheck('track-separator', 'skipped', 'Not checked: there is no track number.'));
    return { checks, trackNumber };
  }

  const digits = match[1];
  trackNumber = parseInt(digits, 10);
  const rest = filename.slice(digits.length);

  if (track.digits && digits.length !== track.digits) {
    const padded = String(trackNumber).padStart(track.digits, '0');
    const fix =
      padded.length === track.digits
        ? `Rename it to ${padded}${rest}.`
        : `Use a ${track.digits}-digit track number, for example ${track.example}.`;
    checks.push(
      makeCheck(
        'track-number',
        'fail',
        `File name starts with ${digits.length} digits, but ${profile.name} needs exactly ${track.digits}, for example ${track.example}.`,
        fix
      )
    );
  } else if (trackNumber < track.min || trackNumber > track.max) {
    const status = track.rangeConfirmed ? 'fail' : 'warning';
    const unsure = track.rangeConfirmed ? '' : ' The valid range is not yet confirmed.';
    checks.push(
      makeCheck(
        'track-number',
        status,
        `Track number ${trackNumber} is outside ${track.min} to ${track.max}.${unsure}`,
        `Renumber the file to a track between ${track.min} and ${track.max}.`,
        track.rangeConfirmed
      )
    );
  } else {
    checks.push(makeCheck('track-number', 'pass', `Track number is ${trackNumber}.`));
  }

  // Separator after the number. Exact rules are not confirmed yet, so
  // anything other than a known-good separator is a warning.
  const separators = profile.separators;
  const sep = rest.charAt(0) || undefined;
  if (separators.knownGood.includes(sep)) {
    checks.push(makeCheck('track-separator', 'pass', `Track number is followed by ${describeSeparator(sep)}.`));
  } else {
    const good = separators.knownGood[0];
    const goodList = separators.knownGood.map(describeSeparator).join(' or ');
    // Suggest a new name: swap a separator-like character, or insert one.
    let suggestion;
    if (sep === '.' || sep === undefined) suggestion = `${digits}${good}name${rest}`;
    else if (sep === ' ' || sep === '-' || sep === '_') suggestion = `${digits}${good}${rest.slice(1)}`;
    else suggestion = `${digits}${good}${rest}`;

    const note = separators.notes[sep] ? ` ${separators.notes[sep]}` : '';
    checks.push(
      makeCheck(
        'track-separator',
        'warning',
        `Track number is followed by ${describeSeparator(sep)}. Only ${goodList} is confirmed to work on ${profile.name}.${note}`,
        `To be safe, rename it to ${suggestion}.`,
        false
      )
    );
  }

  return { checks, trackNumber };
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

// Check one file.
//   bytes:    the whole file, as a Uint8Array or ArrayBuffer
//   filename: the file's name, e.g. "0001_Track.wav"
//   profile:  one entry from PROFILES
function validateFile(bytes, filename, profile) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);

  const wav = parseWav(bytes);
  const fmt = wav.isRiffWave ? readFmt(bytes, wav) : null;
  let checks = [];

  if (!wav.isRiffWave) {
    checks.push(
      makeCheck(
        'riff-header',
        'fail',
        'This is not a WAV file: it does not start with RIFF and WAVE.',
        'Export the audio as a WAV file. Renaming a file to .wav does not convert it.'
      )
    );
    const reason = 'Not checked: this is not a WAV file.';
    for (const id of ['file-length', 'required-chunks', 'format-code', 'bit-depth', 'sample-rate', 'channels', 'extra-chunks', 'canonical-header']) {
      checks.push(makeCheck(id, 'skipped', reason));
    }
  } else {
    checks = checks.concat(checkStructure(wav), checkFormat(fmt, profile), checkMetadata(wav));
  }

  const name = checkFilename(filename, profile);
  checks = checks.concat(name.checks);

  return {
    filename,
    productId: profile.id,
    status: overallStatus(checks),
    trackNumber: name.trackNumber,
    // Facts about the file, for display. null when unknown.
    info: {
      formatCode: fmt ? fmt.formatCode : null,
      channels: fmt ? fmt.channels : null,
      sampleRate: fmt ? fmt.sampleRate : null,
      bitsPerSample: fmt ? fmt.bitsPerSample : null,
      chunks: wav.chunks.map((c) => displayId(c.id)),
    },
    checks,
  };
}

// Add a duplicate-track check to each result. Returns new results; the
// originals are not changed.
function checkDuplicates(results) {
  // Map each track number to the files that use it.
  const byTrack = new Map();
  for (const r of results) {
    if (r.trackNumber === null) continue;
    if (!byTrack.has(r.trackNumber)) byTrack.set(r.trackNumber, []);
    byTrack.get(r.trackNumber).push(r.filename);
  }

  return results.map((r, index) => {
    let check;
    if (r.trackNumber === null) {
      check = makeCheck('duplicate-track', 'skipped', 'Not checked: there is no track number.');
    } else {
      // Remove this file from the list once (two selected files may share a name).
      const others = byTrack.get(r.trackNumber).slice();
      others.splice(others.indexOf(r.filename), 1);
      if (others.length === 0) {
        check = makeCheck('duplicate-track', 'pass', `No other selected file uses track ${r.trackNumber}.`);
      } else {
        check = makeCheck(
          'duplicate-track',
          'warning',
          `Track ${r.trackNumber} is also used by ${others.join(', ')}. The board can only play one of them, and it is not confirmed which.`,
          'Give each file its own track number.',
          false
        );
      }
    }
    const checks = r.checks.concat([check]);
    return { ...r, checks, status: overallStatus(checks) };
  });
}

// Check several files together.
//   files:   array of { name, bytes }
//   profile: one entry from PROFILES
function validateFiles(files, profile) {
  const results = files.map((f) => validateFile(f.bytes, f.name, profile));
  return checkDuplicates(results);
}

// Lets Node (the tests) load this file. In the browser, these functions
// are globals.
if (typeof module !== 'undefined') {
  module.exports = {
    CHECKS,
    NOT_CHECKED,
    validateFile,
    validateFiles,
    checkDuplicates,
    parseWav,
    formatSampleRate,
    overallStatus,
  };
}
