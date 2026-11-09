// profiles.js
// Device rules, one entry per product. Adding a product should mean adding
// an entry here, not changing validator.js.
//
// "Confirmed" means the rule is in Robertsonics or SparkFun documentation.
// Anything not confirmed is reported as a warning, never a failure.
// See CLAUDE.md for the source of each rule and the open questions for Jamie.
//
// Tsunami Pro is not listed yet: it is unreleased and its rules are unknown.
// MP3 Trigger is not in v1.

const PROFILES = {
  'wav-trigger': {
    id: 'wav-trigger',
    name: 'WAV Trigger',
    sampleRate: 44100, // Confirmed
    bitsPerSample: 16, // Confirmed
    channels: {
      allowed: [2], // Stereo: confirmed in the user guide
      // Mono: not confirmed for current firmware, so it is only a warning.
      unconfirmed: [1],
      unconfirmedMessage:
        'This is a mono file. The WAV Trigger user guide specifies stereo, and it is not yet confirmed whether current firmware plays mono.',
      unconfirmedFix: 'To be safe, re-export as stereo.',
      fix: 'Re-export as stereo.',
    },
    track: {
      min: 1, // Confirmed
      max: 4096, // Confirmed
      rangeConfirmed: true,
      digits: null, // Exact digit count not confirmed, so not enforced
      example: '0001_Track.wav',
    },
    separators: {
      // Exact rules are TBD with Jamie. "_" is known to work.
      knownGood: ['_'],
      notes: {
        ' ': 'A WAV Trigger user reported that "0001 Track.wav" did not play but "0001_Track.wav" did.',
      },
    },
    initFile: 'wavtrigr.ini', // Confirmed: lives in the root of the card
  },

  'tsunami-mono': {
    id: 'tsunami-mono',
    name: 'Tsunami (mono firmware)',
    sampleRate: 44100, // Confirmed
    bitsPerSample: 16, // Confirmed
    channels: {
      allowed: [1], // Confirmed
      unconfirmed: [],
      fix: 'Re-export as mono, or install the Tsunami stereo firmware.',
    },
    track: {
      min: 1, // Confirmed
      max: 4096, // Confirmed
      rangeConfirmed: true,
      digits: null,
      example: '1-Music Loop 21.wav',
    },
    separators: {
      // Tsunami docs show "1-Music Loop 21.wav" as valid. Others are TBD.
      knownGood: ['-'],
      notes: {},
    },
    initFile: 'tsunami.ini', // Confirmed
    // The Qwiic Tsunami ships with mono firmware by default.
    note: 'The Qwiic Tsunami ships with mono firmware. A stereo file on a mono board is silently ignored.',
  },

  'tsunami-stereo': {
    id: 'tsunami-stereo',
    name: 'Tsunami (stereo firmware)',
    sampleRate: 44100, // Confirmed
    bitsPerSample: 16, // Confirmed
    channels: {
      allowed: [2], // Confirmed
      unconfirmed: [],
      fix: 'Re-export as stereo, or install the Tsunami mono firmware.',
    },
    track: {
      min: 1, // Confirmed
      max: 4096, // Confirmed
      rangeConfirmed: true,
      digits: null,
      example: '1-Music Loop 21.wav',
    },
    separators: {
      knownGood: ['-'],
      notes: {},
    },
    initFile: 'tsunami.ini', // Confirmed
  },

  'wav-trigger-pro': {
    id: 'wav-trigger-pro',
    name: 'WAV Trigger Pro',
    sampleRate: 44100, // Confirmed
    bitsPerSample: 16, // Confirmed
    channels: {
      allowed: [1, 2], // Mono and stereo can be mixed freely: confirmed
      unconfirmed: [],
      fix: 'Re-export as mono or stereo.',
    },
    track: {
      digits: 4, // Confirmed: 4-digit prefix, e.g. 0123_piano.wav
      // The valid range of 4-digit numbers is not confirmed, so out of range
      // is only a warning.
      min: 1,
      max: 9999,
      rangeConfirmed: false,
      example: '0123_piano.wav',
    },
    separators: {
      knownGood: ['_'], // From the documented example 0123_piano.wav
      notes: {},
    },
    presetFiles: 'set_0001.csv', // Confirmed naming style
  },
};

// Lets Node (the tests) load this file. In the browser, PROFILES is a global.
if (typeof module !== 'undefined') {
  module.exports = { PROFILES };
}
