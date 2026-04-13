import type { Page } from 'playwright';

export interface AIHelperOptions {
  apiKey?: string;
  model?: string;
  headless?: boolean;
}

export class AIHelper {
  private stagehand: any | null = null;
  private opts: AIHelperOptions;

  constructor(opts: AIHelperOptions = {}) {
    this.opts = opts;
  }

  async init(): Promise<Page | null> {
    if (!this.opts.apiKey) return null;
    const mod = await import('@browserbasehq/stagehand');
    const Stagehand = (mod as any).Stagehand;
    this.stagehand = new Stagehand({
      env: 'LOCAL',
      modelName: this.opts.model ?? 'claude-sonnet-4-6',
      modelClientOptions: { apiKey: this.opts.apiKey },
      localBrowserLaunchOptions: { headless: this.opts.headless ?? true },
      verbose: 0,
      disablePino: true,
    });
    await this.stagehand.init();
    return this.stagehand.page as Page;
  }

  get page(): Page | null {
    return this.stagehand?.page ?? null;
  }

  async act(instruction: string): Promise<boolean> {
    if (!this.stagehand) return false;
    try {
      await this.stagehand.page.act(instruction);
      return true;
    } catch {
      return false;
    }
  }

  async extract<T = unknown>(instruction: string, schema?: unknown): Promise<T | null> {
    if (!this.stagehand) return null;
    try {
      return await this.stagehand.page.extract({ instruction, schema });
    } catch {
      return null;
    }
  }

  async observe(instruction: string): Promise<string[]> {
    if (!this.stagehand) return [];
    try {
      const obs = await this.stagehand.page.observe(instruction);
      return obs.map((o: any) => o.description ?? o.selector ?? '');
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.stagehand) {
      await this.stagehand.close().catch(() => {});
      this.stagehand = null;
    }
  }

  isAvailable(): boolean {
    return this.stagehand !== null;
  }
}
