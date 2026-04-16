// Shared types. Kept in a separate file so test harnesses can import them
// without pulling in DOM-dependent modules.

export type EventType =
  | "pageview"
  | "click"
  | "vital"
  | "error"
  | "netfail";

export interface BaseEvent {
  t: EventType;
  ts: number; // epoch ms
  url: string;
  sid: string; // session id
}

export interface PageViewEvent extends BaseEvent {
  t: "pageview";
  ref?: string; // referrer or previous url (SPA)
  title?: string;
}

export interface ClickEvent extends BaseEvent {
  t: "click";
  sel: string; // css selector path
  txt?: string; // redacted text
  x: number; // viewport x
  y: number; // viewport y
}

export interface VitalEvent extends BaseEvent {
  t: "vital";
  name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB";
  value: number;
  rating?: "good" | "ni" | "poor";
}

export interface ErrorEvent extends BaseEvent {
  t: "error";
  msg: string;
  src?: string; // source file
  line?: number;
  col?: number;
  stack?: string;
  kind: "console" | "window" | "unhandledrejection";
}

export interface NetFailEvent extends BaseEvent {
  t: "netfail";
  method: string;
  ru: string; // request url
  status: number; // 0 = network error
  ms: number; // duration
  kind: "fetch" | "xhr";
}

export type CollectorEvent =
  | PageViewEvent
  | ClickEvent
  | VitalEvent
  | ErrorEvent
  | NetFailEvent;

export interface PrivacyConfig {
  // Extra CSS selectors to treat as private (text/value stripped).
  mask?: string[];
  // Disable built-in email/phone/card regex redaction. Default false.
  disableRegex?: boolean;
}

export interface InitOptions {
  siteId: string;
  endpoint?: string; // defaults to https://api.uxinspect.com/v1/ingest
  sampleRate?: number; // 0..1, defaults to 1
  privacy?: PrivacyConfig;
  debug?: boolean;
}

export interface ResolvedConfig {
  siteId: string;
  endpoint: string;
  sampleRate: number;
  privacy: Required<Pick<PrivacyConfig, "mask" | "disableRegex">>;
  debug: boolean;
  sid: string;
}
