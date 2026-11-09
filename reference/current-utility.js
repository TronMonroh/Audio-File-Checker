<div id="drop-zone" style="border: 2px dashed #aaa; padding: 30px; text-align: center; border-radius: 10px;">
  <p><strong>Drop your .wav file here</strong></p>
  <p>or</p>
  <button onclick="document.getElementById('fileInput').click()" style="padding: 10px 20px; font-size: 16px; cursor: pointer;">Select File</button>
  <input type="file" id="fileInput" accept=".wav" style="display: none;">
  <p id="status" style="margin-top: 20px;"></p>
</div>

<script>
document.getElementById('drop-zone').addEventListener('dragover', function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

document.getElementById('drop-zone').addEventListener('drop', function(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

document.getElementById('fileInput').addEventListener('change', function(e) {
  const file = e.target.files[0];
  handleFile(file);
});

function handleFile(file) {
  const status = document.getElementById('status');
  if (!file || !file.name.endsWith('.wav')) {
    status.textContent = 'Please select a valid .wav file.';
    return;
  }

  const reader = new FileReader();
  reader.onload = function(event) {
    const buffer = event.target.result;
    const view = new DataView(buffer);

    const riff = getString(view, 0, 4);
    const wave = getString(view, 8, 4);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      status.textContent = 'Invalid WAV file format.';
      return;
    }

    let offset = 12;
    let fmtChunkFound = false;
    let metadataBeforeData = false;
    let resultMessage = '';

    while (offset < buffer.byteLength) {
      const chunkId = getString(view, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkId === 'fmt ') {
        fmtChunkFound = true;
        const numChannels = view.getUint16(offset + 8 + 2, true);
        const sampleRate = view.getUint32(offset + 8 + 4, true);
        const bitsPerSample = view.getUint16(offset + 8 + 14, true);

        resultMessage += `Channels: ${numChannels}, Sample Rate: ${sampleRate} Hz, Bit Depth: ${bitsPerSample} bits`;
      } else if (chunkId !== 'data' && !fmtChunkFound) {
        metadataBeforeData = true;
      }

      if (chunkId === 'data') break;

      offset += 8 + chunkSize;
    }

    if (!fmtChunkFound) {
      status.textContent = 'No "fmt " chunk found.';
    } else {
      if (metadataBeforeData) {
        resultMessage += ' — Metadata found before audio.';
      } else {
        resultMessage += ' — No metadata before audio.';
      }
      status.textContent = resultMessage;
    }
  };

  reader.readAsArrayBuffer(file.slice(0, 2048)); // read just the start
}

function getString(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;