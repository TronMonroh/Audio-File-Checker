// app.js
// Everything the page does: showing the board choices, reading the files
// the user picks, and displaying results.
//
// All the actual checking is done by validator.js. This file only reads
// files from the user's computer and shows what validator.js says.
// Nothing is sent anywhere.

// The files the user has chosen, as { name, bytes }. Kept so the results
// can be re-checked if the user switches boards.
let chosenFiles = [];

// Icons are written as codes (✓ is a check mark) so they display
// correctly even if a web host sends this file with the wrong encoding.
const STATUS_TEXT = {
  pass: { icon: '✓', word: 'Pass' }, // ✓
  warning: { icon: '!', word: 'Warning' },
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

// A status shown as an icon plus a word, so it is readable without color.
function statusBadge(status) {
  const text = STATUS_TEXT[status];
  return el('span', { className: `badge badge-${status}` }, [
    el('span', { text: text.icon, attrs: { 'aria-hidden': 'true' } }),
    ` ${text.word}`,
  ]);
}

// ---------------------------------------------------------------------------
// Setting up the page
// ---------------------------------------------------------------------------

function showProductChoices() {
  const fieldset = document.getElementById('products');
  for (const profile of Object.values(PROFILES)) {
    const id = `product-${profile.id}`;
    const input = el('input', { attrs: { type: 'radio', name: 'product', id, value: profile.id } });
    input.addEventListener('change', showResults);

    const label = el('label', { attrs: { for: id } }, [el('strong', { text: profile.name })]);
    if (profile.note) {
      label.append(el('span', { className: 'hint', text: profile.note }));
    }
    fieldset.append(el('div', { className: 'choice' }, [input, label]));
  }
}

function showNotChecked() {
  const list = document.getElementById('not-checked-list');
  for (const item of NOT_CHECKED) {
    list.append(el('li', {}, [el('strong', { text: `${item.topic}: ` }), item.detail]));
  }
}

function selectedProfile() {
  const checked = document.querySelector('input[name="product"]:checked');
  return checked ? PROFILES[checked.value] : null;
}

// ---------------------------------------------------------------------------
// Reading files from the user's computer
// ---------------------------------------------------------------------------

async function useFiles(fileList) {
  const files = Array.from(fileList);
  chosenFiles = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      chosenFiles.push({ name: file.name, bytes });
    } catch (error) {
      chosenFiles.push({ name: file.name, bytes: null });
    }
  }
  // Show files in name order, which is usually track order.
  chosenFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  showResults();
}

function clearFiles() {
  chosenFiles = [];
  document.getElementById('file-input').value = '';
  showResults();
}

// ---------------------------------------------------------------------------
// Showing results
// ---------------------------------------------------------------------------

function showResults() {
  const section = document.getElementById('results');
  const summary = document.getElementById('summary');
  const container = document.getElementById('file-results');
  container.replaceChildren();

  document.getElementById('clear-button').hidden = chosenFiles.length === 0;

  if (chosenFiles.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const profile = selectedProfile();
  if (!profile) {
    summary.textContent = `${chosenFiles.length} file(s) chosen. Choose your board above to see results.`;
    return;
  }

  const readable = chosenFiles.filter((f) => f.bytes !== null);
  const unreadable = chosenFiles.filter((f) => f.bytes === null);
  const results = validateFiles(readable, profile);

  const counts = { pass: 0, warning: 0, fail: 0 };
  for (const r of results) counts[r.status]++;
  counts.fail += unreadable.length;

  const fileWord = chosenFiles.length === 1 ? 'file' : 'files';
  summary.textContent =
    `${chosenFiles.length} ${fileWord} checked for ${profile.name}: ` +
    `${counts.pass} pass, ${counts.warning} warning, ${counts.fail} fail.`;

  for (const name of unreadable.map((f) => f.name)) {
    container.append(
      el('article', { className: 'file file-fail' }, [
        el('h3', {}, [statusBadge('fail'), ` ${name}`]),
        el('p', { text: 'This file could not be read. Try selecting it again.' }),
      ])
    );
  }
  for (const result of results) {
    container.append(fileResult(result));
  }
}

// One-line summary of the audio, e.g. "Stereo, 44.1kHz, 16-bit".
function describeAudio(info) {
  if (info.channels === null) return null;
  const channels = info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : `${info.channels} channels`;
  return `${channels}, ${formatSampleRate(info.sampleRate)}, ${info.bitsPerSample}-bit`;
}

function fileResult(result) {
  const article = el('article', { className: `file file-${result.status}` });
  article.append(el('h3', {}, [statusBadge(result.status), ` ${result.filename}`]));

  const audio = describeAudio(result.info);
  if (audio) article.append(el('p', { className: 'audio-info', text: audio }));

  // Problems first, each with its fix.
  const problems = result.checks.filter((c) => c.status === 'fail' || c.status === 'warning');
  if (problems.length > 0) {
    const list = el('ul', { className: 'problems' });
    for (const check of problems) {
      const unconfirmed = check.confirmed ? null : el('span', { className: 'unconfirmed', text: ' (rule not yet confirmed)' });
      list.append(
        el('li', { className: `problem problem-${check.status}` }, [
          el('p', {}, [statusBadge(check.status), ' ', el('strong', { text: `${check.label}: ` }), check.message, unconfirmed]),
          el('p', { className: 'fix' }, [el('strong', { text: 'Fix: ' }), check.fix]),
        ])
      );
    }
    article.append(list);
  } else {
    article.append(el('p', { text: 'Every check passed.' }));
  }

  // Every check, so the user can see what was and was not checked.
  const details = el('details', {}, [el('summary', { text: 'Show all checks' })]);
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
  const body = el('tbody');
  for (const check of result.checks) {
    body.append(
      el('tr', {}, [
        el('td', { text: check.group }),
        el('td', { text: check.label }),
        el('td', {}, [statusBadge(check.status)]),
        el('td', { text: check.message }),
      ])
    );
  }
  table.append(body);
  details.append(el('div', { className: 'table-wrap' }, [table]));
  article.append(details);

  return article;
}

// ---------------------------------------------------------------------------
// Wiring up the page
// ---------------------------------------------------------------------------

function setUpDropZone() {
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
    useFiles(event.dataTransfer.files);
  });

  // Stop a file dropped just outside the zone from opening in the browser.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

showProductChoices();
showNotChecked();
setUpDropZone();
document.getElementById('file-input').addEventListener('change', (event) => useFiles(event.target.files));
document.getElementById('clear-button').addEventListener('click', clearFiles);
