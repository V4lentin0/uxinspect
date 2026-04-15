// popup.js - drives the recorder UI

const els = {
  status: document.getElementById('status-text'),
  count: document.getElementById('step-count'),
  dot: document.querySelector('.dot'),
  flowName: document.getElementById('flow-name'),
  btnStart: document.getElementById('btn-start'),
  btnStop: document.getElementById('btn-stop'),
  btnCopy: document.getElementById('btn-copy'),
  btnDownload: document.getElementById('btn-download'),
  btnClear: document.getElementById('btn-clear'),
  previewWrap: document.getElementById('preview-wrap'),
  preview: document.getElementById('preview'),
  previewSize: document.getElementById('preview-size'),
  message: document.getElementById('message'),
};

let currentState = null;
let renameTimer = null;

function flow(state) {
  return { name: state.flowName || 'Recorded flow', steps: state.steps || [] };
}

function render(state) {
  currentState = state;
  const recording = !!state.recording;
  const count = (state.steps && state.steps.length) || 0;

  els.status.textContent = recording ? 'Recording' : count > 0 ? 'Stopped' : 'Idle';
  els.status.classList.toggle('recording', recording);
  els.dot.classList.toggle('recording', recording);

  els.count.textContent = String(count);
  els.flowName.value = state.flowName || '';

  els.btnStart.disabled = recording;
  els.btnStop.disabled = !recording;
  els.btnCopy.disabled = count === 0;
  els.btnDownload.disabled = count === 0;
  els.btnClear.disabled = count === 0 || recording;

  if (count > 0) {
    const json = JSON.stringify(flow(state), null, 2);
    els.preview.textContent = json;
    els.previewSize.textContent = `${count} step${count === 1 ? '' : 's'}`;
    els.previewWrap.hidden = false;
  } else {
    els.previewWrap.hidden = true;
  }
}

function flashMessage(text, kind) {
  els.message.textContent = text;
  els.message.classList.remove('success', 'error');
  if (kind) els.message.classList.add(kind);
  clearTimeout(flashMessage._t);
  flashMessage._t = setTimeout(() => {
    els.message.textContent = '';
    els.message.classList.remove('success', 'error');
  }, 2500);
}

async function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    });
  });
}

async function refresh() {
  const state = await send({ type: 'GET_STATE' });
  if (state) render(state);
}

els.btnStart.addEventListener('click', async () => {
  const flowName = (els.flowName.value || '').trim() || 'Recorded flow';
  const res = await send({ type: 'START', flowName });
  if (res && res.ok) {
    render(res.state);
    flashMessage('Recording started. Interact with this page.', 'success');
  } else {
    flashMessage(res && res.error ? res.error : 'Failed to start.', 'error');
  }
});

els.btnStop.addEventListener('click', async () => {
  const res = await send({ type: 'STOP' });
  if (res && res.ok) {
    render(res.state);
    flashMessage('Stopped. Ready to copy or download.', 'success');
  } else {
    flashMessage('Failed to stop.', 'error');
  }
});

els.btnCopy.addEventListener('click', async () => {
  if (!currentState) return;
  const json = JSON.stringify(flow(currentState), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    flashMessage('Flow copied to clipboard.', 'success');
  } catch (err) {
    flashMessage('Copy failed: ' + err.message, 'error');
  }
});

els.btnDownload.addEventListener('click', async () => {
  if (!currentState) return;
  const json = JSON.stringify(flow(currentState), null, 2);
  const safeName = (currentState.flowName || 'flow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'flow';
  const filename = `${safeName}-${Date.now()}.json`;

  // Use a data URL — service workers cannot create blob: URLs reliably.
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true,
    });
    flashMessage('Download started.', 'success');
  } catch (err) {
    flashMessage('Download failed: ' + err.message, 'error');
  }
});

els.btnClear.addEventListener('click', async () => {
  const res = await send({ type: 'CLEAR' });
  if (res && res.ok) {
    render(res.state);
    flashMessage('Cleared.', 'success');
  }
});

els.flowName.addEventListener('input', () => {
  clearTimeout(renameTimer);
  const name = (els.flowName.value || '').trim() || 'Recorded flow';
  renameTimer = setTimeout(async () => {
    await send({ type: 'RENAME', flowName: name });
  }, 300);
});

// Live updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'STATE_CHANGED' && msg.state) {
    // Don't stomp on the user's in-flight edit
    const activeName = document.activeElement === els.flowName;
    const state = activeName ? { ...msg.state, flowName: els.flowName.value } : msg.state;
    render(state);
  }
});

document.addEventListener('DOMContentLoaded', refresh);
refresh();
