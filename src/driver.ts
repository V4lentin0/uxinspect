import {
  chromium,
  firefox,
  webkit,
  devices,
  type Browser,
  type BrowserContext,
  type Page,
  type BrowserContextOptions,
} from 'playwright';
import { createServer } from 'node:net';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface DriverOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  cdpPort?: number;
  storageState?: string;
  browser?: BrowserName;
  device?: string;
  locale?: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number };
  throttle?: { downloadBps?: number; uploadBps?: number; latencyMs?: number };
  recordVideo?: string;
  recordHar?: string;
  trace?: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function browserType(name: BrowserName) {
  if (name === 'firefox') return firefox;
  if (name === 'webkit') return webkit;
  return chromium;
}

export class Driver {
  private browser?: Browser;
  private context?: BrowserContext;
  private port?: number;
  private opts: DriverOptions = {};

  async launch(opts: DriverOptions = {}): Promise<void> {
    this.opts = opts;
    const name = opts.browser ?? 'chromium';
    this.port = opts.cdpPort ?? (await freePort());
    const launchArgs = name === 'chromium' ? [`--remote-debugging-port=${this.port}`] : undefined;
    this.browser = await browserType(name).launch({
      headless: opts.headless ?? true,
      ...(launchArgs ? { args: launchArgs } : {}),
    });

    const ctxOpts: BrowserContextOptions = {
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      userAgent: opts.userAgent,
      storageState: opts.storageState,
      locale: opts.locale,
      timezoneId: opts.timezoneId,
      geolocation: opts.geolocation,
      ...(opts.recordVideo ? { recordVideo: { dir: opts.recordVideo } } : {}),
      ...(opts.recordHar ? { recordHar: { path: opts.recordHar, content: 'embed' } } : {}),
    };
    if (opts.device && (devices as any)[opts.device]) {
      Object.assign(ctxOpts, (devices as any)[opts.device]);
    }
    this.context = await this.browser.newContext(ctxOpts);

    if (opts.trace) {
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    }

    if (opts.throttle && name === 'chromium') {
      const cdp = await this.context.newCDPSession(await this.context.newPage());
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: opts.throttle.latencyMs ?? 0,
        downloadThroughput: opts.throttle.downloadBps ?? -1,
        uploadThroughput: opts.throttle.uploadBps ?? -1,
      });
    }
  }

  async saveStorageState(path: string): Promise<void> {
    if (!this.context) throw new Error('Driver not launched');
    await this.context.storageState({ path });
  }

  get cdpPort(): number | undefined {
    return this.port;
  }

  async newPage(): Promise<Page> {
    if (!this.context) throw new Error('Driver not launched. Call launch() first.');
    return this.context.newPage();
  }

  async close(): Promise<void> {
    if (this.opts.trace && this.context) {
      await this.context.tracing.stop({ path: this.opts.trace }).catch(() => {});
    }
    await this.context?.close();
    await this.browser?.close();
    this.context = undefined;
    this.browser = undefined;
    this.port = undefined;
    this.opts = {};
  }

  get raw(): { browser?: Browser; context?: BrowserContext } {
    return { browser: this.browser, context: this.context };
  }
}

export const networkPresets = {
  'slow-3g': { downloadBps: 50 * 1024, uploadBps: 50 * 1024, latencyMs: 400 },
  'fast-3g': { downloadBps: 180 * 1024, uploadBps: 84 * 1024, latencyMs: 150 },
  '4g': { downloadBps: 1.6 * 1024 * 1024, uploadBps: 750 * 1024, latencyMs: 20 },
  wifi: { downloadBps: 30 * 1024 * 1024, uploadBps: 15 * 1024 * 1024, latencyMs: 2 },
};
