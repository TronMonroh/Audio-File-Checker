# Robertsonics Audio File Checker

## What this is

A standalone web app that answers one question for Robertsonics customers: **"Will this file play on my board?"**

It replaces the file-check utility currently on robertsonics.com/technical. It is built by Seth (contractor) for Robertsonics (Jamie Robertson) and hosted on Seth's GitHub (GitHub Pages).

Robertsonics players fail silently. A file in the wrong format is simply ignored, with no error. This app turns that silence into a clear **green light** (will play) or **red light** (won't play, and here's how to fix it).

## User flow (v1)

The flow, product list, red/green result, Audacity guidance, logo, and "only check the beginning of the file" rule are **Jamie's requirements**. Do not change them without Seth's approval.

1. **"Which product are you using?"** User picks one:
   * WAV Trigger
   * Tsunami Mono
   * Tsunami Stereo
   * WAV Trigger Pro
2. **Drag and drop a WAV file** onto the page (a "Select file" button is also provided as a fallback).
3. **Analyze.** The app reads the beginning of the file and checks it against the selected product.
4. **Result: green light or red light.**
   * Green: "This file will play on your [product]."
   * Red: each problem listed in plain English, with a fix.
   * In both cases, also show what was detected: channels, sample rate, bit depth, and whether metadata was found before the audio. (The current utility shows these values; keep them so v1 doesn't regress.)
5. **Audacity help.** On a red light, show how to fix the file in Audacity (see "Audacity guidance"). Also available as a short "How to create a compatible file" section on the page.

The page displays **Jamie's Robertsonics logo** in the header.

Tsunami Mono and Tsunami Stereo are separate products because users can load either firmware (Jamie's decision). Add a one-line hint under the picker: "Not sure? The Qwiic Tsunami ships with mono firmware."

## Hard requirements

* **Files never leave the user's computer.** Jamie's requirement: the app opens local files; it does not upload them. All parsing happens in the browser.
* **No server, no network calls.** Static files only. Enforce with a Content Security Policy meta tag (`connect-src 'none'`). No analytics, no CDNs, no external fonts.
* **Only check the beginning of the file (Jamie).** Anything after the audio data is never looked at by the players, so the app never looks at it either. Read only the first few KB with `file.slice()`.
* **Binary result (Jamie).** Green or red only. No "warning" state.
* **No AI in v1.**
* **Accept `.wav` in any letter case** (`.wav`, `.WAV`). The current utility rejects `.WAV`; don't repeat that.

## Tech stack

Keep it simple. Seth is new to app development, so favor plain, readable code over clever code.

* Plain HTML, CSS and JavaScript. No framework, no build step, no npm dependencies.
* `index.html`: the page and UI.
* `validator.js`: the checking logic as pure functions (header bytes and filename in; result out). No DOM access, so it can be tested on its own.
* `profiles.js`: device rules as a data object, one entry per product.
* `assets/`: Jamie's logo (original file supplied by Jamie).
* `reference/current-utility.js`: the existing website utility, kept for comparison only. Do not copy its parsing logic (see "Known problems in the current utility").
* `tests/`: tests run with Node's built-in test runner (`node --test`). No test framework.
* **Node.js is a development tool only**, installed on Seth's Mac for running tests and generating test files. The app itself never needs Node, npm or any package. Never add a `package.json` dependency.
* **`index.html` must work when opened directly from the file system** (double-click, `file://`), with no web server. Load scripts with plain `<script src="...">` tags, not JavaScript modules (`type="module"` and `import` are blocked on `file://`). This is how Jamie tests the app before launch: download ZIP, unzip, double-click.
* `.gitignore` excludes macOS `.DS_Store` files.
* Hosting: GitHub Pages on Seth's GitHub. Plain static files in the repo root, no build step. Use relative paths only, so a custom domain can be added later without code changes.
* The repo stays **private** during development. Jamie is added as a collaborator and gives feedback through GitHub Issues. At launch the repo becomes public so Pages can serve it (license to be agreed with Jamie first).

## The rule (v1)

Jamie confirmed: the `fmt ` chunk must be exactly 16 bytes, nothing may come before the audio data, and anything after the audio data is ignored. Together that means **a green file has the canonical 44-byte WAV header**:

| Bytes | Must be |
|---|---|
| 0 to 3 | `RIFF` |
| 8 to 11 | `WAVE` |
| 12 to 15 | `fmt ` |
| 16 to 19 | fmt chunk size = 16 |
| 20 to 21 | Audio format = 1 (PCM) |
| 22 to 23 | Channels, as the product requires |
| 24 to 27 | Sample rate = 44100 |
| 34 to 35 | Bits per sample = 16 |
| 36 to 39 | `data` |

So the pass/fail decision needs only the first 44 bytes. Read a few KB anyway, and walk the chunk list only to **explain** a red light (for example, "Found a LIST metadata chunk before the audio"). If the walk reaches the end of the bytes read without finding `data`, report a large metadata block before the audio.

### Red-light reasons and fixes

Report every reason that applies, not just the first:

* Not a WAV file (no `RIFF`/`WAVE`).
* Metadata before the audio (any chunk other than `fmt ` before `data`, including a chunk before `fmt `). Name the chunk if found.
* fmt chunk is not 16 bytes (common with 18-byte or extensible headers from some software).
* Not PCM (format code 3 is 32-bit float; 0xFFFE is extensible).
* Not 16-bit.
* Not 44.1kHz.
* Wrong channel count for the product.

Each reason gets a one-line, plain-English fix that points to the Audacity steps.

### Decisions (approved by Seth, 2026-11-10)

These settle cases "The rule" leaves open. They change only what the app **says** or how it reads files, except B, which adds a red reason.

* **A. Missing chunks.** If the read reached the real end of the file without finding `data`, say "No audio data found" (not "large metadata block"). Same idea for a missing `fmt ` chunk: say no format information was found. Both are red.
* **B. File extension (Seth's decision, pending Jamie).** Red if the file name does not end in `.wav` (any case), with the fix "Rename the file to end in .wav." This is the one filename check in v1. Keep it in its own function and check id, separate from the header checks, so it can be removed in one small change if Jamie decides against it.
* **C. Checking is automatic.** Check as soon as a file is dropped or selected (no Analyze button), and recheck automatically when the product changes.
* **D. Read the first 4KB** (4096 bytes) of the file. This only affects how far the app can explain a metadata block; the red/green decision needs just the first 44 bytes.
* **E. "Show all checks" table.** Keep it, listing only the v1 rules above (plus B). It sits below the result and the fix, collapsed by default. Its toggle is styled as a clear secondary button (larger label, a border, an arrow that turns when it opens), less prominent than the green or red light, and works from the keyboard (2026-11-22).
* **F. Logo.** Done (2026-11-22): Jamie's logo is in `assets/` (`robertsonics-logo.png`, and `robertsonics-logo-white.png` for dark mode), shown in the header with a `<picture>` element, alt text "Robertsonics", about 270px wide and smaller on phones.
* **G. id3 after data** stays in the corpus as a green test file (anything after the audio data is ignored).
* **Red for a non-format reason.** When the audio format (format code, bit depth, sample rate, channels) is correct but the file is red for another reason, say the audio format is correct and name the actual reason.
* **Back/forward.** When the page is shown again (browser back or forward), clear the selected file, so a file name never shows without its result.

## Product profiles (confirmed by Jamie)

| Product | Format | Channels |
|---|---|---|
| WAV Trigger | 16-bit, 44.1kHz PCM | Stereo only (mono is a red light) |
| Tsunami Mono | 16-bit, 44.1kHz PCM | Mono only |
| Tsunami Stereo | 16-bit, 44.1kHz PCM | Stereo only |
| WAV Trigger Pro | 16-bit, 44.1kHz PCM | Mono or stereo |

## Audacity guidance

Tested by Seth with **Audacity 4.0.2** (2026-11-22). The app says "These steps were tested with Audacity 4.0.2." under the steps.

Main steps, shown on every red light (except when only the file name is wrong) and in the "How to create a compatible file" section:

* Open the file in Audacity.
* File > Export audio.
* Format: **WAV (Microsoft)**.
* Channels: **Mono** or **Stereo**, as your product requires. (On a red light, name what the selected product needs.)
* Sample rate: **44100 Hz**.
* Encoding: **Signed 16-bit PCM**. Check Encoding again after choosing the format, because it may not change automatically.

Shown only when it applies:

* "Click Edit metadata and clear every field." Only on a red light where metadata was found before the audio. Audacity 4 writes its metadata (LIST and id3) after the audio, which is ignored, so clearing it is not needed otherwise.
* Note: Audacity works internally in 32-bit float, so the file only becomes 16-bit at export. Shown for bit depth and encoding problems, and in the general section.

Do not tell users to "convert the track" or "set the project rate"; the export settings above do both.

Seth's Audacity 4.0.2 tests, all in the test corpus:

* `audacity4_0010.wav`: a file with title and artist tags, exported as WAV (Microsoft), Stereo, 44100 Hz, Signed 16-bit PCM **without** clearing metadata. Green on WAV Trigger, red on Tsunami Mono (stereo).
* `audacity4_0005.wav`: a 48kHz file exported at 44100 Hz. Green.
* `audacity4_0001.wav`: a stereo file exported with Channels set to Mono. Green on Tsunami Mono.

## Known problems in the current utility (do not repeat)

The existing utility (`reference/current-utility.js`) reads the first 2048 bytes and reports channels, sample rate and bit depth. It never gives a pass/fail and ignores the product. Its parsing has bugs that v1 must avoid:

* **Misses metadata between `fmt ` and `data`.** It only flags chunks found before `fmt `, so a LIST chunk after `fmt ` is reported as "No metadata before audio." This is a false pass on a common case.
* **Does not check the fmt chunk size or format code**, so 18-byte headers, 32-bit float and extensible files are not caught.
* **No bounds checking.** A chunk that runs past the 2048 bytes read can throw an uncaught error (user sees nothing), or end the loop with a misleading message such as "No fmt chunk found."
* **Ignores RIFF chunk padding** (odd-sized chunks are followed by a pad byte).
* **Rejects `.WAV`** because the extension check is case-sensitive.
* Despite the page text, it **does not check .mp3 files**, so leaving MP3 out of v1 is not a regression.

## Explicitly not checked

v1 does **not** show a "What this does not check" section on the page (Seth, 2026-11-10). SD card guidance comes in a later version. For scope, v1 does not check:

* **SD card format and cluster size.** (Later version: tell users the requirement, FAT16 or FAT32, 32KB allocation size.)
* **SD card read speed.** (Later version: audio glitches are almost always the card being too slow on a read. Point users to Jamie's microSD test firmware and his "microSD Cards for Audio 2024" article.)
* Filenames (except the `.wav` extension, decision B), MP3 files, multiple files, folders.

## Roadmap

* **v1:** Above.
* **v2 candidates:** SD card guidance on the page (format, cluster size, read speed), filename and track-number checks, multiple files and duplicate track numbers, folder checks, Tsunami Pro, MP3 Trigger. Ask Jamie whether a file whose data size claims more bytes than the file contains (a truncated file) should be red.
* **v3 candidates:** Auto-fix (strip metadata, rewrite to the canonical header), saved locally.
* **Later:** AI explanations, if support data shows users need them.

## Test corpus

* `test-files/` holds known good and known bad .wav files, one problem per bad file:
  * Green: canonical mono, canonical stereo, Audacity export (Seth's three Audacity 4.0.2 exports, `audacity4_*.wav`, `builtBy: "hand"`), LIST chunk **after** data, `.WAV` uppercase extension.
  * Green: id3 chunk after data (decision G).
  * Red: 48kHz, 24-bit, 32-bit float, extensible format, 18-byte fmt chunk, mono on WAV Trigger, mono on Tsunami Stereo, stereo on Tsunami Mono, LIST before fmt, LIST between fmt and data, metadata block larger than the bytes read, not a WAV file.
  * Red (decisions A and B): no data chunk, no fmt chunk, good audio with a non-.wav extension.
* Tests read only the first 4KB of each file, the same way the app does.
* `test-files/manifest.json` lists each file, its expected result per product, and whether that result was **confirmed on real hardware**.
* Include a test proving each "Known problems in the current utility" case is handled correctly.
* Every change must keep all tests passing.

## Open items

* ~~Logo: Seth is getting the original file and usage guidance from Jamie.~~ Done (2026-11-22), see decision F.
* Ownership: agree with Jamie that the repo can transfer to a Robertsonics GitHub account later, and whether to use a Robertsonics subdomain for the URL.

## How to work in this repo (instructions for Claude Code)

* Seth is learning. Work in small steps, and after each change explain briefly what changed and why.
* Never add a dependency, framework, build tool or network call without asking first.
* Keep `validator.js` free of DOM code so it stays testable.
* Never invent a rule. Everything in "The rule" and "Product profiles" is confirmed by Jamie; anything else needs Seth's approval.
* Add a test file and a manifest entry for every rule.
* Keep the UI plain and readable. Accessibility: labels on inputs, keyboard usable, and the red/green result must also be stated in words, never by color alone.
