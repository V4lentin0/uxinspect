/**
 * Minimal subset of uxinspect Flow + Step types mirrored locally so the pack
 * typechecks without importing from the main build. Keep in sync with
 * uxinspect/src/types.ts when Flow shape changes.
 */

export interface AssertConfig {
  console?: 'clean';
  network?: 'no-4xx';
  dom?: 'no-error';
  visual?: 'matches';
}

export type StepAction =
  | { goto: string }
  | { click: string }
  | { type: { selector: string; text: string } }
  | { fill: { selector: string; text: string } }
  | { waitFor: string }
  | { screenshot: string }
  | { ai: string }
  | { drag: { from: string; to: string } }
  | { upload: { selector: string; files: string | string[] } }
  | { dialog: 'accept' | 'dismiss' | { accept?: boolean; text?: string } }
  | { scroll: { selector?: string; x?: number; y?: number } }
  | { select: { selector: string; value: string | string[] } }
  | { key: string }
  | { eval: string }
  | {
      waitForResponse:
        | string
        | { url: string; status?: number };
    }
  | { waitForRequest: string }
  | { hover: string }
  | { check: string }
  | { uncheck: string }
  | { focus: string }
  | { blur: string }
  | { reload: true }
  | { back: true }
  | { forward: true }
  | { newTab: string }
  | { switchTab: number | string }
  | { closeTab: true }
  | { iframe: { selector: string; steps: Step[] } }
  | { sleep: number }
  | { waitForDownload: { trigger: string; saveAs: string } }
  | { waitForPopup: { trigger: string; switchTo?: boolean } }
  | {
      cookie: {
        name: string;
        value: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'Strict' | 'Lax' | 'None';
      };
    }
  | { clearCookies: true };

export type Step = StepAction & {
  assert?: AssertConfig;
};

export interface Flow {
  name: string;
  steps: Step[];
}
