// profiles.js
// Device rules, one entry per product. All of these are confirmed by Jamie
// (see "Product profiles" in CLAUDE.md). Adding a product should mean adding
// an entry here, not changing validator.js.
//
// channels lists the channel counts the product plays: 1 = mono, 2 = stereo.

const PROFILES = {
  'wav-trigger': {
    id: 'wav-trigger',
    name: 'WAV Trigger',
    sampleRate: 44100,
    bitsPerSample: 16,
    channels: [2], // Stereo only. Mono is a red light.
  },
  'tsunami-mono': {
    id: 'tsunami-mono',
    name: 'Tsunami Mono',
    sampleRate: 44100,
    bitsPerSample: 16,
    channels: [1], // Mono only
  },
  'tsunami-stereo': {
    id: 'tsunami-stereo',
    name: 'Tsunami Stereo',
    sampleRate: 44100,
    bitsPerSample: 16,
    channels: [2], // Stereo only
  },
  'wav-trigger-pro': {
    id: 'wav-trigger-pro',
    name: 'WAV Trigger Pro',
    sampleRate: 44100,
    bitsPerSample: 16,
    channels: [1, 2], // Mono or stereo
  },
};

// Lets Node (the tests) load this file. In the browser, PROFILES is a global.
if (typeof module !== 'undefined') {
  module.exports = { PROFILES };
}
