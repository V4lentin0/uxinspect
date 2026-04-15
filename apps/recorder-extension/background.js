// background.js - MV3 service worker
// Aggregates recorded events from content scripts and exposes them to the popup.
//
// State lives in chrome.storage.session (cleared when browser closes) so that the
// service worker waking up mid-recording does not lose events.

const DEFAULT_STATE = {
  recording: false,
  startedAt: null,
  tabId: null,
  origin: null,
  flowName: 'Recorded flow',
  steps: [],
};

async function readState() {
  const res = await chrome.storage.session.get('state');
  return res.state || { ...DEFAULT_STATE };
}

async function writeState(state) {
  await chrome.storage.session.set({ state });
}

async function updateBadge(state) {
  if (state.recording) {
    const count = state.steps.length;
    await chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: '#10B981' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function injectRecorder(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js'],
    });
  } catch (err) {
    // Injection can fail on chrome:// or extension:// pages — surface to popup
    throw new Error('Cannot record on this page (restricted URL). ' + err.message);
  }
}

async function broadcast(message) {
  // Fire and forget — popup may be closed
  try {
    await chrome.runtime.sendMessage(message);
  } catch (_) {
    /* no receivers */
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await readState();

    if (msg.type === 'GET_STATE') {
      sendResponse(state);
      return;
    }

    if (msg.type === 'START') {
      const tab = msg.tabId
        ? await chrome.tabs.get(msg.tabId)
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || !tab.id) {
        sendResponse({ ok: false, error: 'No active tab.' });
        return;
      }
      const next = {
        ...DEFAULT_STATE,
        recording: true,
        startedAt: Date.now(),
        tabId: tab.id,
        origin: tab.url ? new URL(tab.url).origin : null,
        flowName: msg.flowName || 'Recorded flow',
        steps: tab.url ? [{ goto: tab.url }] : [],
      };
      await writeState(next);
      await updateBadge(next);
      try {
        await injectRecorder(tab.id);
      } catch (err) {
        await writeState(DEFAULT_STATE);
        await updateBadge(DEFAULT_STATE);
        sendResponse({ ok: false, error: err.message });
        return;
      }
      sendResponse({ ok: true, state: next });
      broadcast({ type: 'STATE_CHANGED', state: next });
      return;
    }

    if (msg.type === 'STOP') {
      const next = { ...state, recording: false };
      await writeState(next);
      await updateBadge(next);
      // Tell content script to detach listeners
      if (state.tabId) {
        try {
          await chrome.tabs.sendMessage(state.tabId, { type: 'STOP_RECORDING' });
        } catch (_) {
          /* tab may be closed */
        }
      }
      sendResponse({ ok: true, state: next });
      broadcast({ type: 'STATE_CHANGED', state: next });
      return;
    }

    if (msg.type === 'CLEAR') {
      const next = { ...DEFAULT_STATE };
      await writeState(next);
      await updateBadge(next);
      sendResponse({ ok: true, state: next });
      broadcast({ type: 'STATE_CHANGED', state: next });
      return;
    }

    if (msg.type === 'RENAME') {
      const next = { ...state, flowName: msg.flowName || 'Recorded flow' };
      await writeState(next);
      sendResponse({ ok: true, state: next });
      broadcast({ type: 'STATE_CHANGED', state: next });
      return;
    }

    if (msg.type === 'STEP') {
      // Incoming step from content script
      if (!state.recording) {
        sendResponse({ ok: false, error: 'Not recording' });
        return;
      }
      // Only accept from the recording tab
      if (sender.tab && sender.tab.id !== state.tabId) {
        sendResponse({ ok: false });
        return;
      }
      const merged = mergeStep(state.steps, msg.step);
      const next = { ...state, steps: merged };
      await writeState(next);
      await updateBadge(next);
      sendResponse({ ok: true });
      broadcast({ type: 'STATE_CHANGED', state: next });
      return;
    }
  })();
  return true; // keep sendResponse alive across async
});

/**
 * Merge a newly recorded step into the existing list, combining consecutive
 * keystrokes on the same selector into a single `fill` step and dropping
 * duplicate `goto`s.
 */
function mergeStep(steps, step) {
  const out = steps.slice();
  const last = out[out.length - 1];

  // De-dupe goto -> goto same URL
  if (step.goto && last && last.goto === step.goto) {
    return out;
  }

  // Merge consecutive `fill` on same selector (replace text)
  if (step.fill && last && last.fill && last.fill.selector === step.fill.selector) {
    out[out.length - 1] = { fill: { selector: step.fill.selector, text: step.fill.text } };
    return out;
  }

  // Merge consecutive `type` on same selector — accumulate text
  if (step.type && last && last.type && last.type.selector === step.type.selector) {
    out[out.length - 1] = {
      type: { selector: step.type.selector, text: (last.type.text || '') + step.type.text },
    };
    return out;
  }

  out.push(step);
  return out;
}

// Navigation tracking: emit `goto` steps when the recording tab navigates.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const state = await readState();
  if (!state.recording || state.tabId !== details.tabId) return;
  if (details.transitionType === 'auto_subframe' || details.transitionType === 'manual_subframe') return;

  const last = state.steps[state.steps.length - 1];
  if (last && last.goto === details.url) return;

  const merged = mergeStep(state.steps, { goto: details.url });
  const next = { ...state, steps: merged };
  await writeState(next);
  await updateBadge(next);
  broadcast({ type: 'STATE_CHANGED', state: next });

  // Re-inject content script on navigation (same tab, new document).
  try {
    await injectRecorder(details.tabId);
  } catch (_) {
    /* restricted URL */
  }
});

// Reset state when extension starts fresh
chrome.runtime.onInstalled.addListener(async () => {
  await writeState(DEFAULT_STATE);
  await updateBadge(DEFAULT_STATE);
});

chrome.runtime.onStartup.addListener(async () => {
  await writeState(DEFAULT_STATE);
  await updateBadge(DEFAULT_STATE);
});
