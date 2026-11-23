// app.js
// Everything the page does: showing the product choices, reading the file
// the user drops or selects, and displaying the result.
//
// All the actual checking is done by validator.js. This file only reads the
// start of the file on the user's computer and shows what validator.js says.
// Nothing is sent anywhere.

// The file being checked, as { name, size, bytes }, or null. Kept so the file
// can be rechecked when the user switches products (decision C).
let chosenFile = null;
// True when several files were dropped and only the first was checked.
let extraFilesIgnored = false;

const CHECK_STATUS_TEXT = {
  pass: { icon: '✓', word: 'Pass' }, // ✓
  fail: { icon: '✗', word: 'Fail' }, // ✗
  skipped: { icon: '–', word: 'Not checked' }, // –
};

// ---------------------------------------------------------------------------
// A small helper for building page elements. Text is always set with
// textContent, so a strange file name can never be treated as HTML.
// ---------------------------------------------------------------------------

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs || {})) {
    node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Setting up the page
// ---------------------------------------------------------------------------

function showProductChoices() {
  const fieldset = document.getElementById('products');
  for (const profile of Object.values(PROFILES)) {
    const id = `product-${profile.id}`;
    const input = el('input', { attrs: { type: 'radio', name: 'product', id, value: profile.id } });
    input.addEventListener('change', showResult); // Recheck on product change
    const label = el('label', { text: profile.name, attrs: { for: id } });
    fieldset.append(el('div', { className: 'choice' }, [input, label]));
  }
}

function showHowToSteps() {
  const list = document.getElementById('howto-steps');
  for (const step of GENERAL_AUDACITY_STEPS) {
    list.append(el('li', { text: step }));
  }
  list.after(el('p', { className: 'tested-with', text: AUDACITY_VERSION_NOTE }));
}

function selectedProfile() {
  const checked = document.querySelector('input[name="product"]:checked');
  return checked ? PROFILES[checked.value] : null;
}

// ---------------------------------------------------------------------------
// Reading the file from the user's computer
// ---------------------------------------------------------------------------

async function useFile(file, othersIgnored) {
  try {
    // Only the start of the file is read (Jamie's rule, decision D).
    const bytes = new Uint8Array(await file.slice(0, READ_BYTES).arrayBuffer());
    chosenFile = { name: file.name, size: file.size, bytes };
  } catch (error) {
    chosenFile = { name: file.name, size: file.size, bytes: null };
  }
  extraFilesIgnored = othersIgnored;
  showResult();
}

// Forget the file, e.g. when the page is shown again after back/forward.
function clearFile() {
  chosenFile = null;
  extraFilesIgnored = false;
  document.getElementById('file-input').value = '';
  showResult();
}

// ---------------------------------------------------------------------------
// Showing the result
// ---------------------------------------------------------------------------

function showResult() {
  const section = document.getElementById('result');
  const body = document.getElementById('result-body');
  body.replaceChildren();

  if (!chosenFile) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  if (extraFilesIgnored) {
    body.append(el('p', { className: 'note', text: 'Only the first file was checked. Check one file at a time.' }));
  }

  const profile = selectedProfile();
  if (!profile) {
    body.append(el('p', { text: `Choose your product above to check ${chosenFile.name}.` }));
    return;
  }

  if (chosenFile.bytes === null) {
    body.append(el('p', { text: `${chosenFile.name} could not be read. Try selecting it again.` }));
    return;
  }

  const result = validateFile(chosenFile.bytes, chosenFile.name, profile, chosenFile.size);
  const isGreen = result.result === 'green';

  // The light, stated in words as well as color.
  body.append(
    el('div', { className: `light light-${result.result}` }, [
      el('span', { className: 'lamp', attrs: { 'aria-hidden': 'true' } }),
      el('div', {}, [
        el('p', { className: 'light-word', text: isGreen ? 'Green light: will play' : "Red light: won't play" }),
        el('p', { className: 'headline', text: result.headline }),
      ]),
    ])
  );
  body.append(el('p', { className: 'file-name' }, [el('strong', { text: 'File: ' }), chosenFile.name]));

  body.append(detectedValues(result.detected));

  // Red: every reason, each with its fix.
  if (!isGreen) {
    body.append(el('h3', { text: "Why it won't play" }));
    const list = el('ul', { className: 'reasons' });
    for (const reason of result.reasons) {
      list.append(
        el('li', {}, [
          el('p', {}, [el('strong', { text: `${reason.label}: ` }), reason.message]),
          el('p', { className: 'fix' }, [el('strong', { text: 'Fix: ' }), reason.fix]),
        ])
      );
    }
    body.append(list);
  }

  if (result.audacitySteps.length > 0) {
    body.append(el('h3', { text: 'How to fix it in Audacity' }));
    body.append(el('ol', {}, result.audacitySteps.map((step) => el('li', { text: step }))));
    body.append(el('p', { className: 'tested-with', text: AUDACITY_VERSION_NOTE }));
  }

  body.append(allChecksTable(result.checks));
}

// Channels, sample rate, bit depth and metadata, shown for green and red.
function detectedValues(detected) {
  const unknown = 'Could not tell';
  let channels = unknown;
  if (detected.channels === 1) channels = 'Mono';
  else if (detected.channels === 2) channels = 'Stereo';
  else if (detected.channels !== null) channels = `${detected.channels} channels`;

  let metadata = unknown;
  if (detected.metadataBeforeAudio === true) metadata = 'Yes';
  if (detected.metadataBeforeAudio === false) metadata = 'No';

  const rows = [
    ['Channels', channels],
    ['Sample rate', detected.sampleRate === null ? unknown : formatSampleRate(detected.sampleRate)],
    ['Bit depth', detected.bitsPerSample === null ? unknown : `${detected.bitsPerSample}-bit`],
    ['Metadata before the audio', metadata],
  ];
  const list = el('dl', { className: 'detected' });
  for (const [name, value] of rows) {
    list.append(el('div', {}, [el('dt', { text: name }), el('dd', { text: value })]));
  }
  return el('div', {}, [el('h3', { text: 'What was found' }), list]);
}

// Every v1 check, so the user can see what was checked.
function allChecksTable(checks) {
  // A <details> element: closed by default, and its <summary> can be opened
  // with the mouse, or with Tab then Enter or Space on the keyboard.
  const details = el('details', { className: 'all-checks' }, [el('summary', { text: 'Show all checks' })]);
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Area', attrs: { scope: 'col' } }),
        el('th', { text: 'Check', attrs: { scope: 'col' } }),
        el('th', { text: 'Result', attrs: { scope: 'col' } }),
        el('th', { text: 'Details', attrs: { scope: 'col' } }),
      ]),
    ]),
  ]);
  const tbody = el('tbody');
  for (const check of checks) {
    const status = CHECK_STATUS_TEXT[check.status];
    tbody.append(
      el('tr', {}, [
        el('td', { text: check.group }),
        el('td', { text: check.label }),
        el('td', { className: `status status-${check.status}` }, [
          el('span', { text: status.icon, attrs: { 'aria-hidden': 'true' } }),
          ` ${status.word}`,
        ]),
        el('td', { text: check.message }),
      ])
    );
  }
  table.append(tbody);
  details.append(el('div', { className: 'table-wrap' }, [table]));
  return details;
}

// ---------------------------------------------------------------------------
// Wiring up the page
// ---------------------------------------------------------------------------

function setUpFileInputs() {
  const input = document.getElementById('file-input');
  document.getElementById('select-button').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length > 0) useFile(input.files[0], false);
  });

  const zone = document.getElementById('drop-zone');
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragging');
    const files = event.dataTransfer.files;
    if (files.length > 0) useFile(files[0], files.length > 1);
  });

  // Stop a file dropped just outside the zone from opening in the browser.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

showProductChoices();
showHowToSteps();
setUpFileInputs();

// When the page is shown again (browser back or forward), forget the file,
// so a file name never shows without its result. "pageshow" also fires on
// the first load, which is harmless.
window.addEventListener('pageshow', clearFile);
