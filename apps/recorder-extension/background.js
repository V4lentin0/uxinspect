// uxinspect Recorder — service worker (MV3)
// Owns recording state + message bus between popup and content scripts.

const state = {
  recording: false,
  tabId: null,
  events: [],
  startedAt: 0,
};

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color, tabId });
    await chrome.action.setBadgeText({ text, tabId });
  } catch (_) {}
}

async function persist() {
  await chrome.storage.local.set({ recording: state.recording, events: state.events, tabId: state.tabId, startedAt: state.startedAt });
}

async function hydrate() {
  const s = await chrome.storage.local.get(['recording', 'events', 'tabId', 'startedAt']);
  state.recording = !!s.recording;
  state.events = Array.isArray(s.events) ? s.events : [];
  state.tabId = typeof s.tabId === 'number' ? s.tabId : null;
  state.startedAt = typeof s.startedAt === 'number' ? s.startedAt : 0;
}

async function broadcastRecording(on) {
  if (state.tabId == null) return;
  try {
    await chrome.tabs.sendMessage(state.tabId, { type: 'uxinspect:set-recording', recording: on });
  } catch (_) {
    // content script not injected yet — inject it
    try {
      await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(state.tabId, { type: 'uxinspect:set-recording', recording: on });
    } catch (_) {}
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await hydrate();
});

chrome.runtime.onStartup.addListener(async () => {
  await hydrate();
});

// Re-inject on navigation within the recording tab so we keep capturing
chrome.webNavigation && chrome.webNavigation.onCommitted && chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!state.recording || state.tabId == null) return;
  if (details.tabId !== state.tabId || details.frameId !== 0) return;
  // Record the navigation as an event
  state.events.push({ type: 'navigate', url: details.url, at: Date.now() });
  await persist();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await hydrate();
    if (msg.type === 'uxinspect:get-state') {
      sendResponse({ recording: state.recording, count: state.events.length, tabId: state.tabId, startedAt: state.startedAt });
      return;
    }
    if (msg.type === 'uxinspect:start') {
      const tab = msg.tabId != null ? { id: msg.tabId, url: msg.url } : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || tab.id == null) { sendResponse({ ok: false, error: 'no-tab' }); return; }
      state.recording = true;
      state.tabId = tab.id;
      state.events = [];
      state.startedAt = Date.now();
      if (tab.url && /^https?:/.test(tab.url)) {
        state.events.push({ type: 'navigate', url: tab.url, at: state.startedAt });
      }
      await persist();
      await setBadge(tab.id, 'REC', '#EF4444');
      await broadcastRecording(true);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'uxinspect:stop') {
      state.recording = false;
      await persist();
      if (state.tabId != null) await setBadge(state.tabId, '', '#10B981');
      await broadcastRecording(false);
      sendResponse({ ok: true, events: state.events });
      return;
    }
    if (msg.type === 'uxinspect:reset') {
      state.events = [];
      state.startedAt = 0;
      await persist();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'uxinspect:event' && sender.tab && sender.tab.id === state.tabId && state.recording) {
      state.events.push(msg.event);
      await persist();
      await setBadge(state.tabId, String(state.events.length), '#EF4444');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'uxinspect:get-events') {
      sendResponse({ events: state.events });
      return;
    }
    if (msg.type === 'uxinspect:download') {
      const { content, filename } = msg;
      const url = 'data:text/typescript;charset=utf-8,' + encodeURIComponent(content);
      chrome.downloads.download({ url, filename: filename || 'uxinspect.config.ts', saveAs: true }, (id) => {
        sendResponse({ ok: !!id, id });
      });
      return true; // keep channel open for async sendResponse
    }
    sendResponse({ ok: false, error: 'unknown-message' });
  })();
  return true;
});
