import type { Page } from 'playwright';

export interface AIHelperOptions {
  apiKey?: string;
  model?: string;
}

export class AIHelper {
  private stagehand: any | null = null;
  private opts: AIHelperOptions;

  constructor(opts: AIHelperOptions = {}) {
    this.opts = opts;
  }

  async init(page: Page): Promise<void> {
    if (!this.opts.apiKey) return;
    try {
      const mod = await import('@browserbasehq/stagehand');
      const Stagehand = (mod as any).Stagehand;
      this.stagehand = new Stagehand({
        env: 'LOCAL',
        modelName: this.opts.model ?? 'claude-sonnet-4-6',
        modelClientOptions: { apiKey: this.opts.apiKey },
      });
      await this.stagehand.init({ page });
    } catch {
      this.stagehand = null;
    }
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

  isAvailable(): boolean {
    return this.stagehand !== null;
  }
}
