// uxinspect Recorder — content script
// Captures clicks + input events via capture-phase, passive listeners.
// Selector logic kept inline (no module imports — content scripts aren't modules).

(function () {
  if (window.__uxinspectRecorderInstalled) return;
  window.__uxinspectRecorderInstalled = true;

  let recording = false;

  function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
  function escapeQuotes(s) { return String(s).replace(/"/g, '\\"'); }

  function ariaRole(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    const map = {
      a: 'link', button: 'button', nav: 'navigation', header: 'banner',
      footer: 'contentinfo', main: 'main', aside: 'complementary', form: 'form',
      section: 'region', h1: 'heading', h2: 'heading', h3: 'heading',
      h4: 'heading', h5: 'heading', h6: 'heading', img: 'img',
      select: 'combobox', textarea: 'textbox',
    };
    if (tag === 'input') {
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (['text', 'email', 'password', 'search', 'tel', 'url', 'number', ''].includes(type)) return 'textbox';
    }
    return map[tag] || null;
  }

  function accessibleName(el) {
    if (!el.getAttribute) return '';
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean)
        .map(n => (n.innerText || n.textContent || '').trim());
      const j = parts.join(' ').trim(); if (j) return j;
    }
    const lab = el.getAttribute('aria-label'); if (lab) return lab.trim();
    const t = el.getAttribute('title'); if (t) return t.trim();
    const alt = el.getAttribute('alt'); if (alt) return alt.trim();
    const ph = el.getAttribute('placeholder'); if (ph) return ph.trim();
    const id = el.getAttribute('id');
    if (id) {
      const l = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (l) return (l.innerText || l.textContent || '').trim();
    }
    const tag = (el.tagName || '').toLowerCase();
    if (['button', 'a'].includes(tag)) return (el.innerText || el.textContent || '').trim();
    return '';
  }

  function nthPath(el) {
    const parts = []; let cur = el; let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      let sel = cur.tagName.toLowerCase();
      const p = cur.parentNode;
      if (p && p.children) {
        const sibs = Array.from(p.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      if (p && p.tagName && p.tagName.toLowerCase() !== 'html') { cur = p; depth++; } else break;
    }
    return parts.join(' > ');
  }

  function cssSelector(el) {
    if (!el || !el.tagName) return '';
    const id = el.getAttribute && el.getAttribute('id');
    if (id && !/\s/.test(id) && !/^\d/.test(id)) return `#${cssEscape(id)}`;
    const tag = el.tagName.toLowerCase();
    const cls = (el.className || '').toString().split(/\s+/)
      .filter(c => c && !/^(is-|has-|ng-|css-|sc-|_)/.test(c) && !/^\d/.test(c))
      .slice(0, 2);
    if (cls.length > 0) return `${tag}.${cls.join('.')}`;
    const name = el.getAttribute && el.getAttribute('name');
    if (name) return `${tag}[name="${cssEscape(name)}"]`;
    const type = el.getAttribute && el.getAttribute('type');
    if (type && tag === 'input') return `input[type="${cssEscape(type)}"]`;
    return nthPath(el);
  }

  function bestSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const testAttrs = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];
    for (const attr of testAttrs) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) return `[${attr}="${cssEscape(v)}"]`;
    }
    const role = ariaRole(el);
    const name = accessibleName(el);
    if (role && name && name.length <= 50) return `role=${role}[name="${escapeQuotes(name)}"]`;
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length > 0 && text.length <= 40 && !text.includes('\n')) {
      return `text="${escapeQuotes(text)}"`;
    }
    return cssSelector(el);
  }

  function targetElement(ev) {
    // For composed events (shadow DOM, labels), prefer the actual interactive ancestor
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      const tag = (node.tagName || '').toLowerCase();
      if (['button', 'a', 'input', 'textarea', 'select', 'label'].includes(tag)) return node;
      if (node.getAttribute && (node.getAttribute('role') || node.getAttribute('onclick') || node.getAttribute('data-testid'))) return node;
    }
    return ev.target;
  }

  function send(event) {
    try {
      chrome.runtime.sendMessage({ type: 'uxinspect:event', event });
    } catch (_) { /* extension reloaded, ignore */ }
  }

  function onClick(ev) {
    if (!recording) return;
    const el = targetElement(ev);
    if (!el) return;
    const selector = bestSelector(el);
    if (!selector) return;
    send({ type: 'click', selector, at: Date.now() });
  }

  function onInput(ev) {
    if (!recording) return;
    const el = ev.target;
    if (!el || !('value' in el)) return;
    const tag = (el.tagName || '').toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag)) return;
    const type = (el.type || '').toLowerCase();
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(type)) return;
    const selector = bestSelector(el);
    if (!selector) return;
    send({ type: 'input', selector, text: String(el.value || ''), at: Date.now() });
  }

  document.addEventListener('click', onClick, { capture: true, passive: true });
  document.addEventListener('input', onInput, { capture: true, passive: true });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'uxinspect:set-recording') {
      recording = !!msg.recording;
      sendResponse({ ok: true, recording });
    }
    if (msg && msg.type === 'uxinspect:ping') {
      sendResponse({ ok: true, installed: true, recording });
    }
  });

  // Hydrate state on load (e.g., after navigation)
  try {
    chrome.runtime.sendMessage({ type: 'uxinspect:get-state' }, (resp) => {
      if (resp && resp.recording) recording = true;
    });
  } catch (_) {}
})();
