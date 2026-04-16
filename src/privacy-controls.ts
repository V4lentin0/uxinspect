/**
 * P7 #69 — Privacy controls for RUM collector.
 * Default-private inputs, selector-based redaction, GDPR consent integration.
 */

export interface PrivacyConfig {
  /** CSS selectors to always mask (e.g., '[data-private]'). */
  maskSelectors?: string[];
  /** Regex patterns for text redaction (email, phone, credit card). */
  redactPatterns?: Array<{ name: string; pattern: RegExp; replacement: string }>;
  /** Respect data-private and data-uxi-private attributes. Default true. */
  honorDataAttributes?: boolean;
  /** IP anonymization mode. Default 'last-octet'. */
  ipAnonymization?: 'last-octet' | 'full-hash' | 'none';
}

export const DEFAULT_REDACT_PATTERNS = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[email]' },
  { name: 'phone', pattern: /\+?[\d\s\-().]{7,20}/g, replacement: '[phone]' },
  { name: 'credit-card', pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,4}\b/g, replacement: '[card]' },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[ssn]' },
];

export function redactText(text: string, patterns?: PrivacyConfig['redactPatterns']): string {
  const ps = patterns ?? DEFAULT_REDACT_PATTERNS;
  let result = text;
  for (const p of ps) {
    result = result.replace(new RegExp(p.pattern.source, p.pattern.flags), p.replacement);
  }
  return result;
}

export function shouldMaskElement(selector: string, config: PrivacyConfig): boolean {
  const masks = config.maskSelectors ?? ['[data-private]', '[data-uxi-private]', 'input[type="password"]'];
  return masks.some((m) => selector.includes(m.replace(/[\[\]"]/g, '')));
}
