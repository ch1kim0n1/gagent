import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

const ConfigSchema = z.object({
  version: z.string(),
  tools: z.record(z.object({
    enabled: z.boolean(),
    path: z.string().optional(),
    version: z.string().optional(),
    config: z.record(z.any()).optional()
  })),
  integration: z.object({
    event_bus: z.enum(['gbrain', 'memory', 'file']).default('gbrain'),
    shared_memory: z.boolean().default(true),
    cross_tool_sync: z.boolean().default(true)
  }),
  pipeline: z.object({
    default_parallel: z.number().default(3),
    max_parallel: z.number().default(10),
    verification_threshold: z.number().default(0.7),
    cognitive_check_threshold: z.number().default(0.6)
  })
});

export type GAgentConfigType = z.infer<typeof ConfigSchema>;

export class GAgentConfig {
  private configPath: string;
  private config: GAgentConfigType;

  constructor(options: { configPath?: string } = {}) {
    this.configPath = options.configPath ?? join(homedir(), '.gagent', 'config.json');
    this.config = this.load();
  }

  private load(): GAgentConfigType {
    if (existsSync(this.configPath)) {
      try {
        const data = JSON.parse(readFileSync(this.configPath, 'utf-8'));
        return ConfigSchema.parse(data);
      } catch {
        // Fall through to default
      }
    }
    return this.defaultConfig();
  }

  private defaultConfig(): GAgentConfigType {
    return {
      version: '0.1.0',
      tools: {
        gbrain: { enabled: false },
        gstack: { enabled: false },
        gorchestrator: { enabled: false },
        gmirror: { enabled: false },
        gtom: { enabled: false },
        glearn: { enabled: false }
      },
      integration: {
        event_bus: 'gbrain',
        shared_memory: true,
        cross_tool_sync: true
      },
      pipeline: {
        default_parallel: 3,
        max_parallel: 10,
        verification_threshold: 0.7,
        cognitive_check_threshold: 0.6
      }
    };
  }

  async initialize(detected: Record<string, { installed: boolean; path?: string; version?: string }>) {
    for (const [name, info] of Object.entries(detected)) {
      if (this.config.tools[name]) {
        this.config.tools[name].enabled = info.installed;
        if (info.path) this.config.tools[name].path = info.path;
        if (info.version) this.config.tools[name].version = info.version;
      }
    }
    await this.save();
  }

  async save(): Promise<void> {
    const dir = join(homedir(), '.gagent');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  get(path: string): any {
    const parts = path.split('.');
    let current: any = this.config;
    for (const part of parts) {
      current = current?.[part];
    }
    return current;
  }

  set(path: string, value: any): void {
    const parts = path.split('.');
    let current: any = this.config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  view(): string {
    return JSON.stringify(this.config, null, 2);
  }

  getRaw(): GAgentConfigType {
    return this.config;
  }

  isToolEnabled(name: string): boolean {
    return this.config.tools[name]?.enabled ?? false;
  }

  getToolPath(name: string): string | undefined {
    return this.config.tools[name]?.path;
  }
}
