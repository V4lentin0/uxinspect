export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  links: string[];
  verificationCode?: string;
  receivedAt: string;
}

export type MailboxConfig =
  | { provider: 'maildev'; baseUrl: string }
  | { provider: 'mailpit'; baseUrl: string }
  | { provider: 'generic-http'; baseUrl: string; authToken?: string; listPath: string; itemPath: string };

export interface WaitForEmailOptions {
  subjectContains?: string;
  bodyContains?: string;
  to?: string;
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 1000;
const LINK_RE = /https?:\/\/[^\s"'<>)]+/g;

export function extractLinks(body: string): string[] {
  if (!body) return [];
  const matches = body.match(LINK_RE);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

export function extractCode(body: string, digits = 6): string | undefined {
  if (!body) return undefined;
  const re = new RegExp(`\\b\\d{${digits}}\\b`);
  const m = body.match(re);
  return m ? m[0] : undefined;
}

export async function waitForEmail(
  config: MailboxConfig,
  opts: WaitForEmailOptions,
): Promise<EmailMessage | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);

  while (Date.now() < deadline) {
    try {
      const messages = await listMessages(config, signal);
      const match = findMatch(messages, opts);
      if (match) {
        return await hydrate(config, match, signal);
      }
    } catch (e: any) {
      if (signal.aborted) return null;
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return null;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining), signal);
  }
  return null;
}

function findMatch(messages: EmailMessage[], opts: WaitForEmailOptions): EmailMessage | undefined {
  return messages.find((m) => {
    if (opts.to && !m.to.some((t) => t.toLowerCase().includes(opts.to!.toLowerCase()))) return false;
    if (opts.subjectContains && !m.subject.includes(opts.subjectContains)) return false;
    if (opts.bodyContains) {
      const text = (m.textBody ?? '') + '\n' + (m.htmlBody ?? '');
      if (!text.includes(opts.bodyContains)) return false;
    }
    return true;
  });
}

async function listMessages(config: MailboxConfig, signal: AbortSignal): Promise<EmailMessage[]> {
  if (config.provider === 'maildev') {
    const url = joinUrl(config.baseUrl, '/email');
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`mailbox API list failed: ${res.status}`);
    const arr = (await res.json()) as any[];
    return arr.map(parseMaildev);
  }
  if (config.provider === 'mailpit') {
    const url = joinUrl(config.baseUrl, '/api/v1/messages');
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`mailbox API list failed: ${res.status}`);
    const body = (await res.json()) as any;
    const list = Array.isArray(body?.messages) ? body.messages : [];
    return list.map(parseMailpitSummary);
  }
  const url = joinUrl(config.baseUrl, config.listPath);
  const res = await fetch(url, { signal, headers: authHeaders(config.authToken) });
  if (!res.ok) throw new Error(`mailbox API list failed: ${res.status}`);
  const body = (await res.json()) as any;
  const list = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
  return list.map(parseGeneric);
}

async function hydrate(
  config: MailboxConfig,
  msg: EmailMessage,
  signal: AbortSignal,
): Promise<EmailMessage> {
  if (config.provider === 'mailpit') {
    const url = joinUrl(config.baseUrl, `/api/v1/message/${encodeURIComponent(msg.id)}`);
    const res = await fetch(url, { signal });
    if (!res.ok) return finalize(msg);
    const full = (await res.json()) as any;
    const hydrated: EmailMessage = {
      ...msg,
      textBody: typeof full?.Text === 'string' ? full.Text : msg.textBody,
      htmlBody: typeof full?.HTML === 'string' ? full.HTML : msg.htmlBody,
    };
    return finalize(hydrated);
  }
  if (config.provider === 'generic-http') {
    const path = config.itemPath.replace('{id}', encodeURIComponent(msg.id));
    const url = joinUrl(config.baseUrl, path);
    const res = await fetch(url, { signal, headers: authHeaders(config.authToken) });
    if (res.ok) {
      const full = (await res.json()) as any;
      return finalize(parseGeneric({ ...full, id: full?.id ?? msg.id }));
    }
  }
  return finalize(msg);
}

function finalize(msg: EmailMessage): EmailMessage {
  const combined = `${msg.textBody ?? ''}\n${msg.htmlBody ?? ''}`;
  const links = extractLinks(combined);
  const verificationCode = extractCode(msg.textBody ?? msg.htmlBody ?? '');
  return { ...msg, links, verificationCode };
}

function parseMaildev(raw: any): EmailMessage {
  const from = Array.isArray(raw?.from) && raw.from[0]
    ? addrString(raw.from[0])
    : typeof raw?.from === 'string' ? raw.from : '';
  const to = Array.isArray(raw?.to)
    ? raw.to.map(addrString).filter(Boolean)
    : typeof raw?.to === 'string' ? [raw.to] : [];
  return {
    id: String(raw?.id ?? raw?._id ?? ''),
    from,
    to,
    subject: String(raw?.subject ?? ''),
    textBody: typeof raw?.text === 'string' ? raw.text : undefined,
    htmlBody: typeof raw?.html === 'string' ? raw.html : undefined,
    links: [],
    receivedAt: String(raw?.date ?? raw?.time ?? new Date().toISOString()),
  };
}

function parseMailpitSummary(raw: any): EmailMessage {
  const from = raw?.From ? addrString(raw.From) : '';
  const to = Array.isArray(raw?.To) ? raw.To.map(addrString).filter(Boolean) : [];
  return {
    id: String(raw?.ID ?? ''),
    from,
    to,
    subject: String(raw?.Subject ?? ''),
    textBody: typeof raw?.Snippet === 'string' ? raw.Snippet : undefined,
    htmlBody: undefined,
    links: [],
    receivedAt: String(raw?.Created ?? new Date().toISOString()),
  };
}

function parseGeneric(raw: any): EmailMessage {
  const from = typeof raw?.from === 'string' ? raw.from : addrString(raw?.from);
  const toRaw = raw?.to;
  const to = Array.isArray(toRaw)
    ? toRaw.map((t: any) => (typeof t === 'string' ? t : addrString(t))).filter(Boolean)
    : typeof toRaw === 'string' ? [toRaw] : toRaw ? [addrString(toRaw)].filter(Boolean) : [];
  return {
    id: String(raw?.id ?? raw?._id ?? raw?.ID ?? ''),
    from: from ?? '',
    to,
    subject: String(raw?.subject ?? raw?.Subject ?? ''),
    textBody: typeof raw?.text === 'string' ? raw.text : typeof raw?.Text === 'string' ? raw.Text : undefined,
    htmlBody: typeof raw?.html === 'string' ? raw.html : typeof raw?.HTML === 'string' ? raw.HTML : undefined,
    links: [],
    receivedAt: String(raw?.receivedAt ?? raw?.date ?? raw?.Created ?? new Date().toISOString()),
  };
}

function addrString(a: any): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  const addr = a.address ?? a.Address ?? '';
  const name = a.name ?? a.Name ?? '';
  if (addr && name) return `${name} <${addr}>`;
  return addr || name || '';
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
