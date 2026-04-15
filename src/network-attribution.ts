import type { Page, Response } from 'playwright';

export interface NetworkFailure {
  url: string;
  status: number;
  method: string;
  timestamp: number;
  requestId?: string;
}

export interface NetworkAttributionCapture {
  /**
   * Begin a new step window. Failures arriving from this point onward
   * (until endStep) are attributed to this step.
   */
  beginStep: (name: string) => void;
  /**
   * Close the current step window and return all failures attributed to it.
   * Drains any pending response promises that were observed during this step
   * so async-arriving 4xx/5xx responses are not lost.
   */
  endStep: () => Promise<NetworkFailure[]>;
  /**
   * Detach all listeners. Idempotent.
   */
  stopCapture: () => void;
}

/**
 * Attach per-step network-failure attribution to a Playwright page.
 *
 * Pattern matches console-errors.ts: the capture is attached once per page,
 * the buffer is owned by the capture, and `beginStep` / `endStep` carve the
 * timeline into per-step windows. Responses arriving asynchronously while a
 * step is open are attributed to that step at *arrival time*, so a request
 * fired by step N whose response lands during step N+1 is correctly
 * attributed to step N+1's window — which matches user-perceived attribution
 * (the failure is what the user sees during that step).
 *
 * If you need request-issue-time attribution instead, switch the tagging
 * point from the `response` handler to `request` handler and look up by
 * request reference in the `response` handler.
 */
export function startCapture(page: Page): NetworkAttributionCapture {
  let currentStepIndex = -1;
  let stepActive = false;
  const buffer = new Map<number, NetworkFailure[]>();
  // Track pending response handlers so endStep can await any in-flight ones
  // that started during the step but have not yet resolved.
  const inFlight = new Set<Promise<void>>();
  let requestCounter = 0;
  let detached = false;

  const onResponse = (res: Response): void => {
    if (!stepActive) return; // outside any open step window
    const stepIndex = currentStepIndex;
    const requestId = `req-${++requestCounter}`;

    const work = (async (): Promise<void> => {
      let status: number;
      let url: string;
      let method: string;
      try {
        status = res.status();
        if (status < 400) return;
        url = res.url();
        method = res.request().method();
      } catch {
        // Page navigated / closed mid-read — drop silently.
        return;
      }
      const failure: NetworkFailure = {
        url,
        status,
        method,
        timestamp: Date.now(),
        requestId,
      };
      const list = buffer.get(stepIndex);
      if (list) list.push(failure);
      else buffer.set(stepIndex, [failure]);
    })();

    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  page.on('response', onResponse);

  return {
    beginStep: (_name: string): void => {
      if (detached) return;
      currentStepIndex += 1;
      stepActive = true;
      buffer.set(currentStepIndex, []);
    },
    endStep: async (): Promise<NetworkFailure[]> => {
      if (!stepActive) return [];
      const stepIndex = currentStepIndex;
      stepActive = false;
      // Drain anything started during this window so async-arriving
      // failures are not dropped by an immediate endStep call.
      if (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
      const failures = buffer.get(stepIndex) ?? [];
      buffer.delete(stepIndex);
      return failures;
    },
    stopCapture: (): void => {
      if (detached) return;
      detached = true;
      stepActive = false;
      page.off('response', onResponse);
      buffer.clear();
      inFlight.clear();
    },
  };
}
