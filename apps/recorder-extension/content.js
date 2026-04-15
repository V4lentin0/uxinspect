// content.js - injected into the target page
// Captures user interactions and forwards them as uxinspect flow Steps.
//
// Strategy:
//   click      -> { click: <selector> }
//   input/change on text-ish inputs -> { fill: { selector, text } }
//   change on select -> { select: { selector, value } }
//   change on checkbox -> { check | uncheck: <selector> }
//   file input change -> { upload: { selector, files } } (names only)
//   submit    -> no-op (the click that triggered it is already captured)
//   keydown Enter/Tab/Escape on non-editables -> { key: 'Enter' }
//   scroll of a scrollable element -> { scroll: { selector, x, y } } (debounced)
//
// Selector priority (first that uniquely resolves):
//   1. [data-testid="..."]
//   2. #id (if id is unique & stable-looking)
//   3. [aria-label="..."]
//   4. [name="..."] for form controls
//   5. role + accessible name  -> we approximate with `[role="..."]:has-text` is
//      not valid CSS; we fall back to aria-label / text match via nth-of-type
//   6. tag + class chain CSS path

(() => {
  if (window.__uxinspectRecorderAttached) return;
  window.__uxinspectRecorderAttached = true;

  const SCROLL_DEBOUNCE_MS = 350;
  const TYPING_FLUSH_MS = 400;

  let typingTimer = null;
  let typingSelector = null;
  let scrollTimer = null;
  let lastScrollTarget = null;

  function send(step) {
    try {
      chrome.runtime.sendMessage({ type: 'STEP', step });
    } catch (_) {
      /* extension context invalidated */
    }
  }

  // ---------- Selector generation ----------

  function cssEscape(str) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str);
    return String(str).replace(/["\\\]]/g, '\\$&');
  }

  function uniqueInDocument(selector) {
    try {
      const list = document.querySelectorAll(selector);
      return list.length === 1 ? list[0] : null;
    } catch {
      return null;
    }
  }

  function isStableId(id) {
    if (!id) return false;
    // Discard common auto-gen ids: uuid-ish, emotion/styled hashes, radix-, :r1:, etc.
    if (/^:?r[0-9]+:?$/.test(id)) return false;
    if (/^[0-9a-f]{8,}$/i.test(id)) return false;
    if (/^(emotion|css|mui|chakra|radix|headlessui)-/.test(id)) return false;
    if (id.length > 40) return false;
    return true;
  }

  function isStableClass(cls) {
    if (!cls) return false;
    // Filter out CSS-in-JS hashes and tailwind arbitrary values
    if (/^(css|emotion|sc|jsx|mui|chakra)-/.test(cls)) return false;
    if (/^[a-z]{1,3}-[0-9a-f]{4,}$/i.test(cls)) return false;
    if (/^\[/.test(cls)) return false;
    if (cls.length > 30) return false;
    return true;
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';

    // 1. data-testid
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (testid) {
      const sel = `[data-testid="${cssEscape(testid)}"]`;
      if (uniqueInDocument(sel) === el) return sel;
    }

    // 2. id
    if (el.id && isStableId(el.id)) {
      const sel = `#${cssEscape(el.id)}`;
      if (uniqueInDocument(sel) === el) return sel;
    }

    // 3. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const sel = `[aria-label="${cssEscape(ariaLabel)}"]`;
      if (uniqueInDocument(sel) === el) return sel;
    }

    // 4. name= (for form controls)
    const name = el.getAttribute('name');
    if (name) {
      const tag = el.tagName.toLowerCase();
      const sel = `${tag}[name="${cssEscape(name)}"]`;
      if (uniqueInDocument(sel) === el) return sel;
    }

    // 5. role + text (approximate)
    const role = el.getAttribute('role') || implicitRole(el);
    if (role) {
      const sel = `[role="${cssEscape(role)}"]`;
      if (uniqueInDocument(sel) === el) return sel;
    }

    // 6. Visible text for links/buttons (short, unique, no special chars)
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length > 0 && text.length < 40 && !/[\n\t"]/.test(text)) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link') {
        // text-based selectors aren't standard CSS; fall through to path
      }
    }

    // 7. CSS path fallback
    return cssPath(el);
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    return '';
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    const maxDepth = 6;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < maxDepth) {
      let part = cur.tagName.toLowerCase();
      // add useful classes
      if (cur.classList && cur.classList.length) {
        const stable = Array.from(cur.classList).filter(isStableClass).slice(0, 2);
        if (stable.length) part += '.' + stable.map(cssEscape).join('.');
      }
      // nth-of-type if ambiguous among siblings
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(
          (c) => c.tagName === cur.tagName,
        );
        if (same.length > 1) {
          const idx = same.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      // If the partial path already unique, stop
      const trySel = parts.join(' > ');
      if (uniqueInDocument(trySel) === el) return trySel;
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  // ---------- Event handlers ----------

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'email', 'password', 'search', 'tel', 'url', 'number', ''].includes(t);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function flushTyping() {
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
    typingSelector = null;
  }

  function onClick(ev) {
    const el = ev.target.closest('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick], label, summary, [data-testid]') || ev.target;
    if (!el || el.nodeType !== 1) return;

    // Ignore clicks that will be handled as `check`/`uncheck`
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return;

    flushTyping();
    const selector = buildSelector(el);
    if (!selector) return;
    send({ click: selector });
  }

  function onInput(ev) {
    const el = ev.target;
    if (!isEditable(el)) return;
    const selector = buildSelector(el);
    if (!selector) return;

    if (typingSelector !== selector) flushTyping();
    typingSelector = selector;

    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      send({ fill: { selector, text: el.value ?? el.innerText ?? '' } });
      typingSelector = null;
      typingTimer = null;
    }, TYPING_FLUSH_MS);
  }

  function onChange(ev) {
    const el = ev.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    const selector = buildSelector(el);
    if (!selector) return;

    if (tag === 'select') {
      flushTyping();
      const value =
        el.multiple
          ? Array.from(el.selectedOptions).map((o) => o.value)
          : el.value;
      send({ select: { selector, value } });
      return;
    }

    if (tag === 'input' && type === 'checkbox') {
      flushTyping();
      send(el.checked ? { check: selector } : { uncheck: selector });
      return;
    }

    if (tag === 'input' && type === 'radio') {
      flushTyping();
      if (el.checked) send({ check: selector });
      return;
    }

    if (tag === 'input' && type === 'file') {
      flushTyping();
      const files = Array.from(el.files || []).map((f) => f.name);
      if (files.length === 0) return;
      send({ upload: { selector, files: files.length === 1 ? files[0] : files } });
      return;
    }

    // For text inputs, `input` handler already captured it; nothing extra needed.
  }

  function onKeyDown(ev) {
    const key = ev.key;
    // Capture special keys even inside editables (Enter submits, Escape closes, Tab moves)
    const special = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (!special.includes(key)) return;
    if (key === 'Tab') return; // Tab navigation is noisy — skip
    // Flush any pending typing so the fill lands before the key step
    if (typingTimer) {
      const el = ev.target;
      const selector = typingSelector;
      clearTimeout(typingTimer);
      typingTimer = null;
      typingSelector = null;
      if (selector && el && 'value' in el) {
        send({ fill: { selector, text: el.value ?? '' } });
      }
    }
    send({ key });
  }

  function onScroll(ev) {
    const el = ev.target === document ? document.scrollingElement : ev.target;
    if (!el) return;
    lastScrollTarget = el;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const target = lastScrollTarget;
      if (!target) return;
      if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
        send({ scroll: { y: window.scrollY, x: window.scrollX } });
      } else {
        const selector = buildSelector(target);
        if (selector) send({ scroll: { selector, y: target.scrollTop, x: target.scrollLeft } });
      }
      scrollTimer = null;
      lastScrollTarget = null;
    }, SCROLL_DEBOUNCE_MS);
  }

  function onBeforeUnload() {
    flushTyping();
  }

  function attach() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('beforeunload', onBeforeUnload, true);
  }

  function detach() {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('beforeunload', onBeforeUnload, true);
    flushTyping();
    window.__uxinspectRecorderAttached = false;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'STOP_RECORDING') {
      detach();
      sendResponse({ ok: true });
    }
    return true;
  });

  attach();
})();
