import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer } from 'node:net';

export interface DriverOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  cdpPort?: number;
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

export class Driver {
  private browser?: Browser;
  private context?: BrowserContext;
  private port?: number;

  async launch(opts: DriverOptions = {}): Promise<void> {
    this.port = opts.cdpPort ?? (await freePort());
    this.browser = await chromium.launch({
      headless: opts.headless ?? true,
      args: [`--remote-debugging-port=${this.port}`],
    });
    this.context = await this.browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      userAgent: opts.userAgent,
    });
  }

  get cdpPort(): number | undefined {
    return this.port;
  }

  async newPage(): Promise<Page> {
    if (!this.context) throw new Error('Driver not launched. Call launch() first.');
    return this.context.newPage();
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = undefined;
    this.browser = undefined;
    this.port = undefined;
  }

  get raw(): { browser?: Browser; context?: BrowserContext } {
    return { browser: this.browser, context: this.context };
  }
}
