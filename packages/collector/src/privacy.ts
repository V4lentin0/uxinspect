import type { PrivacyConfig } from "./types.js";

// Regex patterns chosen to be conservative; we never reconstruct the original,
// we just replace with a short token so downstream storage sees no PII.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// International phone: +? country, 7-15 digits with common separators.
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){1,4}\d{2,4}/g;
// Credit card: 13-19 digits with optional space/dash separators.
// Anchors with a digit at the end so a trailing separator isn't swallowed.
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

const EMAIL_TOKEN = "[email]";
const PHONE_TOKEN = "[phone]";
const CARD_TOKEN = "[card]";

const DEFAULT_PRIVATE_SELECTORS = [
  "[data-private]",
  "[data-uxi-private]",
  "input",
  "textarea",
  "[type='password']",
];

// Redact emails, phones and credit cards from a string. Cards first so their
// digits aren't mis-matched as phone numbers.
export function redact(s: string, disable = false): string {
  if (!s) return s;
  if (disable) return s;
  return s
    .replace(CARD_RE, CARD_TOKEN)
    .replace(EMAIL_RE, EMAIL_TOKEN)
    .replace(PHONE_RE, PHONE_TOKEN);
}

// Returns true if the element (or any ancestor) is marked private by either
// default rules or user-configured selectors.
export function isPrivate(el: Element | null, cfg: PrivacyConfig): boolean {
  if (!el) return false;
  const selectors = [...DEFAULT_PRIVATE_SELECTORS, ...(cfg.mask ?? [])];
  const joined = selectors.join(",");
  try {
    if (el.matches(joined)) return true;
    return !!el.closest(joined);
  } catch {
    return false;
  }
}

// Produce a safe-to-send version of visible text: truncate, strip whitespace,
// run regex redaction unless disabled.
export function safeText(raw: string | null | undefined, cfg: PrivacyConfig): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  const clipped = trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed;
  return redact(clipped, cfg.disableRegex ?? false);
}

// Compute a short stable selector path (up to 4 levels) for an element.
// Prefers id, then data-testid, then nth-of-type.
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.nodeType === 1 && depth < 4) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id ? "#" + cur.id : "";
    const testid = cur.getAttribute("data-testid");
    if (id) {
      parts.unshift(tag + id);
      break;
    }
    if (testid) {
      parts.unshift(tag + "[data-testid='" + testid + "']");
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const ref: Element = cur;
      const siblings: Element[] = Array.from(parent.children).filter(
        (c: Element) => c.tagName === ref.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(ref) + 1;
        parts.unshift(tag + ":nth-of-type(" + idx + ")");
      } else {
        parts.unshift(tag);
      }
    } else {
      parts.unshift(tag);
    }
    cur = parent;
    depth++;
  }
  return parts.join(">");
}
