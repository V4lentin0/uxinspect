import type { Page, CDPSession, BrowserContext } from 'playwright';

export type CpuPreset = 'none' | 'mid-tier' | 'low-tier' | 'slow-4g-device' | 'fast-4g-device';

export interface CpuThrottleResult {
  page: string;
  rate: number;
  preset?: CpuPreset;
  before: { cpuTime: number; tasks: number };
  after: { cpuTime: number; tasks: number };
  passed: boolean;
}

interface NetworkConditions {
  downloadThroughput: number;
  uploadThroughput: number;
  latency: number;
}

interface PresetSpec {
  rate: number;
  network?: NetworkConditions;
}

const PRESETS: Record<CpuPreset, PresetSpec> = {
  'none': { rate: 1 },
  'mid-tier': { rate: 4 },
  'low-tier': { rate: 6 },
  'slow-4g-device': {
    rate: 4,
    network: {
      latency: 150,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
    },
  },
  'fast-4g-device': {
    rate: 2,
    network: {
      latency: 50,
      downloadThroughput: (9 * 1024 * 1024) / 8,
      uploadThroughput: (9 * 1024 * 1024) / 8,
    },
  },
};

async function openSession(page: Page): Promise<CDPSession> {
  const ctx: BrowserContext = page.context();
  return ctx.newCDPSession(page);
}

async function safeDetach(client: CDPSession): Promise<void> {
  try {
    await client.detach();
  } catch {
    /* ignore */
  }
}

export async function setCpuThrottling(page: Page, rate: number): Promise<void> {
  if (!Number.isFinite(rate) || rate < 1) {
    throw new Error(`cpu throttle rate must be >= 1, got ${rate}`);
  }
  const client = await openSession(page);
  try {
    await client.send('Emulation.setCPUThrottlingRate', { rate });
  } finally {
    await safeDetach(client);
  }
}

export async function clearCpuThrottling(page: Page): Promise<void> {
  const client = await openSession(page);
  try {
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  } finally {
    await safeDetach(client);
  }
}

export async function applyCpuPreset(
  page: Page,
  preset: CpuPreset
): Promise<{ rate: number; network?: NetworkConditions }> {
  const spec = PRESETS[preset];
  if (!spec) throw new Error(`unknown cpu preset: ${preset}`);
  const client = await openSession(page);
  try {
    await client.send('Emulation.setCPUThrottlingRate', { rate: spec.rate });
    if (spec.network) {
      await client.send('Network.enable');
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: spec.network.latency,
        downloadThroughput: spec.network.downloadThroughput,
        uploadThroughput: spec.network.uploadThroughput,
      });
    }
  } finally {
    await safeDetach(client);
  }
  const result: { rate: number; network?: NetworkConditions } = { rate: spec.rate };
  if (spec.network) result.network = spec.network;
  return result;
}

interface LongTaskWindow {
  __uxi_longTasks: number;
  __uxi_longTaskObserver?: PerformanceObserver;
}

async function installLongTaskCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as LongTaskWindow;
    w.__uxi_longTasks = 0;
    try {
      const po = new PerformanceObserver((list) => {
        w.__uxi_longTasks += list.getEntries().length;
      });
      po.observe({ type: 'longtask', buffered: true });
      w.__uxi_longTaskObserver = po;
    } catch {
      /* longtask unsupported */
    }
  });
}

async function readLongTaskCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as LongTaskWindow;
    try {
      w.__uxi_longTaskObserver?.disconnect();
    } catch {
      /* ignore */
    }
    return typeof w.__uxi_longTasks === 'number' ? w.__uxi_longTasks : 0;
  });
}

async function readPerfNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

export async function measureUnderThrottle<T>(
  page: Page,
  rate: number,
  fn: () => Promise<T>
): Promise<{ result: T; cpuTimeMs: number; longTasks: number }> {
  if (!Number.isFinite(rate) || rate < 1) {
    throw new Error(`cpu throttle rate must be >= 1, got ${rate}`);
  }

  await installLongTaskCounter(page);
  const beforeNow = await readPerfNow(page);

  const client = await openSession(page);
  let throttled = false;
  try {
    await client.send('Emulation.setCPUThrottlingRate', { rate });
    throttled = true;
  } catch {
    /* throttle unsupported — continue without it */
  }

  let result: T;
  try {
    result = await fn();
  } finally {
    if (throttled) {
      try {
        await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      } catch {
        /* ignore */
      }
    }
    await safeDetach(client);
  }

  const afterNow = await readPerfNow(page);
  const longTasks = await readLongTaskCount(page);

  return {
    result,
    cpuTimeMs: Math.max(0, afterNow - beforeNow),
    longTasks,
  };
}
