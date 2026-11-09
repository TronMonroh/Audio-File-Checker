# Robertsonics Audio File Checker

## What this is

A standalone web app that answers one question for Robertsonics customers: **"Will these files play on my board?"**

It replaces the file-check utility currently on robertsonics.com/technical. It is built by Seth (contractor) for Robertsonics (Jamie Robertson). Either Jamie or Seth will host it.

Robertsonics players fail silently. A file in the wrong format is simply ignored, with no error. This app exists to turn that silence into a clear pass or fail with a specific fix.

## Hard requirements

* **Files never leave the user's computer.** Jamie's requirement: the app opens local files; it does not upload them. All parsing happens in the browser.
* **No server, no network calls.** The app is static files only. Enforce this with a Content Security Policy meta tag (`connect-src 'none'`). No analytics, no CDNs, no external fonts.
* **No AI in v1.** Keep v1 simple and deterministic: the same file always gets the same result. AI may return in a later version if it proves useful.
* **v1 must not regress from the current utility.** Before v1 ships, confirm what the current robertsonics.com checker detects and reports, and match it at minimum. (The current page accepts .mp3 files; confirm whether it actually checks them.)

## Tech stack

Keep it simple. Seth is new to app development, so favor plain, readable code over clever code.

* Plain HTML, CSS and JavaScript. No framework, no build step, no npm dependencies.
* `index.html`: the page and UI.
* `validator.js`: the checking logic as pure functions (bytes and filename in, results out). No DOM access, so it can be tested on its own.
* `profiles.js`: device rules as a data object, one entry per product. Adding a product should mean adding data, not code.
* `tests/`: tests run with Node's built-in test runner (`node --test`). No test framework.
* Hosting: any static host (Jamie's Squarespace site, GitHub Pages, or similar). Hosting must not require code changes.

## Device profiles

Status key: **Confirmed** means it is in Robertsonics or SparkFun documentation. **TBD** means it must be confirmed with Jamie before it is enforced as a hard failure. Treat TBD rules as warnings, not failures.

| Product | Format | Channels | Track numbers | Init / preset files |
|---|---|---|---|---|
| WAV Trigger | 16-bit, 44.1kHz PCM (Confirmed) | Stereo (Confirmed in user guide; confirm whether mono is supported in current firmware) | 1 to 4096 (Confirmed) | `wavtrigr.ini` in root (Confirmed) |
| Tsunami, mono firmware | 16-bit, 44.1kHz PCM (Confirmed) | Mono (Confirmed) | 1 to 4096 (Confirmed) | `tsunami.ini` in root (Confirmed) |
| Tsunami, stereo firmware | 16-bit, 44.1kHz PCM (Confirmed) | Stereo (Confirmed) | 1 to 4096 (Confirmed) | `tsunami.ini` in root (Confirmed) |
| WAV Trigger Pro | 16-bit, 44.1kHz PCM (Confirmed) | Mono or stereo, mixed freely (Confirmed) | 4-digit prefix, e.g. `0123_piano.wav` (Confirmed) | Presets `set_0001.csv` style (Confirmed); card should hold only .wav and .csv files |
| Tsunami Pro | TBD (unreleased) | TBD | TBD | TBD |
| MP3 Trigger | Not in v1 | | | |

Notes:
* The Qwiic Tsunami ships with **mono** firmware by default. A stereo file on a mono board is a common silent failure. The UI must make the firmware choice obvious.
* Filename separators differ in practice. Tsunami docs show `1-Music Loop 21.wav` as valid. A WAV Trigger user's `0001 Track.wav` (space) failed and `0001_Track.wav` worked. Exact parsing rules per product are **TBD with Jamie**.

## v1 scope

User picks a product, selects one or more .wav files from disk, and gets a result per file.

### Checks

**File structure**
* Starts with `RIFF` and `WAVE`.
* RIFF size and data chunk size are consistent with the actual file length (catches truncated files).
* Has exactly one `fmt ` chunk and one `data` chunk.

**Audio format**
* Format code is 1 (PCM). Flag `WAVE_FORMAT_EXTENSIBLE` (0xFFFE) and 32-bit float as failures, with a fix.
* Bit depth is 16.
* Sample rate is 44100.
* Channel count matches the selected product.

**Metadata ("no additional header information")**
* Any chunk other than `fmt ` and `data` (for example `LIST`, `bext`, `id3 `, `JUNK`, `cue `, `smpl`) is a failure.
* TBD with Jamie: whether the firmware requires the exact canonical 44-byte header (16-byte `fmt ` chunk, `data` starting at byte 36), or only the absence of extra chunks. Until confirmed, report a non-canonical layout as a warning.

**Filename**
* Ends in `.wav` (case-insensitive).
* Begins with a track number in the product's valid range.
* Separator after the number follows the product's rule (TBD, warning until confirmed).

**Across the selected files**
* Duplicate track numbers (two files mapping to the same track).

### Results

* Each file gets **Pass**, **Warning**, or **Fail**.
* Every warning and failure includes a one-line, plain-English fix. Example: "Sample rate is 48kHz. Re-export at 44.1kHz." For metadata, point to exporting as WAV (Microsoft) signed 16-bit PCM in Audacity with the metadata cleared.
* Show what was checked and what was **not** checked (see below), so a pass is never misread as "the card will work."

### Explicitly out of scope for v1

* **SD card format and cluster size.** A browser cannot read FAT type or allocation size. Tell users the requirement: FAT16 or FAT32, 32KB allocation size.
* **SD card read speed.** Audio glitches are almost always the card taking too long on a block read (over about 23ms). Files cannot reveal this. Point users to Jamie's microSD test firmware and his "microSD Cards for Audio 2024" article.
* MP3 files, folder/set checks, auto-fix, AI.

## Roadmap

* **v1:** Above.
* **v2:** Select a whole folder (set checks: ini/csv presence, stray files). MP3 Trigger support.
* **v3:** Auto-fix: strip extra chunks, rename, possibly convert format, with the fixed file saved locally.
* **Later:** AI explanations, if support data shows users need them.

## Test corpus

* `test-files/` holds known good and known bad .wav files, one problem per bad file (48kHz, 24-bit, 32-bit float, mono on stereo product, LIST chunk, id3 chunk, truncated, bad filename, duplicate track).
* `test-files/manifest.json` lists each file, its expected result per product, and whether that result was **confirmed on real hardware**.
* Every change must keep all tests passing. A rule is only "confirmed" when the hardware column says so.

## Open questions for Jamie

1. Exact header rules: canonical 44-byte header required, or just no extra chunks?
2. Filename parsing per product: allowed separators, leading zeros, max digits.
3. Does current WAV Trigger firmware accept mono files?
4. What does the current website utility check, and does it actually analyze .mp3 files?
5. Tsunami Pro file rules.
6. Hosting: Jamie's site or Seth's?
7. Most common "won't play" support cases, to prioritize rules.

## How to work in this repo (instructions for Claude Code)

* Seth is learning. Work in small steps, and after each change explain briefly what changed and why.
* Never add a dependency, framework, build tool or network call without asking first.
* Keep `validator.js` free of DOM code so it stays testable.
* Never treat a TBD rule as confirmed. If a rule's status is unclear, make it a warning and say so.
* Add a test file and a manifest entry for every new rule.
* Keep the UI plain and readable. Accessibility basics: labels on inputs, keyboard usable, results readable without color alone.
