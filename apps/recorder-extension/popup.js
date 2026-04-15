import { eventsToSteps, stepsToConfigTs, stepsToFlowSnippet } from './lib/converter.js';

const $ = (id) => document.getElementById(id);
const ui = {
  dot: $('dot'),
  statusText: $('statusText'),
  count: $('count'),
  start: $('start'),
  stop: $('stop'),
  copy: $('copy'),
  download: $('download'),
  reset: $('reset'),
  toast: $('toast'),
};

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
  });
}

function toast(text, isError = false) {
  ui.toast.textContent = text;
  ui.toast.classList.toggle('error', !!isError);
  ui.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => ui.toast.classList.remove('show'), 1800);
}

function setStatus(recording, count) {
  ui.dot.className = 'dot' + (recording ? ' rec' : (count > 0 ? ' ok' : ''));
  ui.statusText.textContent = recording ? 'Recording…' : (count > 0 ? 'Stopped' : 'Idle');
  ui.count.textContent = `${count} ${count === 1 ? 'event' : 'events'}`;
  ui.start.disabled = recording;
  ui.stop.disabled = !recording;
  const hasEvents = count > 0;
  ui.copy.disabled = !hasEvents || recording;
  ui.download.disabled = !hasEvents || recording;
  ui.reset.disabled = !hasEvents || recording;
}

async function refresh() {
  const s = await send({ type: 'uxinspect:get-state' });
  setStatus(!!s.recording, s.count || 0);
}

async function getSteps() {
  const resp = await send({ type: 'uxinspect:get-events' });
  const events = resp.events || [];
  return { events, steps: eventsToSteps(events) };
}

ui.start.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) { toast('No active tab', true); return; }
  if (!/^https?:/.test(tab.url || '')) {
    toast('Open an http(s) page first', true);
    return;
  }
  const r = await send({ type: 'uxinspect:start', tabId: tab.id, url: tab.url });
  if (!r.ok) { toast('Start failed: ' + (r.error || 'unknown'), true); return; }
  toast('Recording started');
  await refresh();
});

ui.stop.addEventListener('click', async () => {
  await send({ type: 'uxinspect:stop' });
  toast('Stopped');
  await refresh();
});

ui.reset.addEventListener('click', async () => {
  await send({ type: 'uxinspect:reset' });
  toast('Cleared');
  await refresh();
});

ui.copy.addEventListener('click', async () => {
  const { steps } = await getSteps();
  if (steps.length === 0) { toast('Nothing to copy', true); return; }
  const snippet = stepsToFlowSnippet(steps, 'recorded');
  try {
    await navigator.clipboard.writeText(snippet);
    toast(`Copied ${steps.length} steps`);
  } catch (_) {
    // Fallback: textarea copy
    const ta = document.createElement('textarea');
    ta.value = snippet;
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(`Copied ${steps.length} steps`); }
    catch (_) { toast('Copy failed — use Download instead', true); }
    finally { ta.remove(); }
  }
});

ui.download.addEventListener('click', async () => {
  const { steps } = await getSteps();
  if (steps.length === 0) { toast('Nothing to download', true); return; }
  const content = stepsToConfigTs(steps, 'recorded');
  const resp = await send({ type: 'uxinspect:download', content, filename: 'uxinspect.config.ts' });
  if (resp && resp.ok) toast('Download started');
  else toast('Download failed', true);
});

refresh();
setInterval(refresh, 700);
