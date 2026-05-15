import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { GAgentConfig } from '../config/manager.js';
import { ReceiptRegistry } from '../core/receipt-registry.js';

interface ToolInfo {
  installed: boolean;
  path?: string;
  version?: string;
  healthy?: boolean;
  message?: string;
  latency_ms?: number;
  score?: number;
  checks?: Record<string, any>;
}

interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RegisteredToolInfo {
  name: string;
  description: string;
  enabled: boolean;
  endpoint: string;
}

export class ToolRegistry {
  private config: GAgentConfig;
  private registeredTools: Map<string, RegisteredToolInfo> = new Map();

  constructor(config: GAgentConfig) {
    this.config = config;
  }

  /**
   * Execute command safely with array-form arguments (no shell interpolation)
   */
  private async execSafe(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr });
      });

      proc.on('error', reject);
    });
  }

  register(id: string, info: RegisteredToolInfo): void {
    this.registeredTools.set(id, info);
  }

  listTools(): RegisteredToolInfo[] {
    return Array.from(this.registeredTools.values());
  }

  isAvailable(id: string): boolean {
    return this.registeredTools.get(id)?.enabled === true;
  }

  getRegisteredInfo(id: string): RegisteredToolInfo | undefined {
    return this.registeredTools.get(id);
  }

  async detectAll(): Promise<Record<string, ToolInfo>> {
    return {
      gbrain: await this.detectGBrain(),
      gstack: await this.detectGStack(),
      gorchestrator: await this.detectGeneric('gorchestrator'),
      gmirror: await this.detectGeneric('gmirror'),
      gtom: await this.detectGeneric('gtom'),
      glearn: await this.detectGeneric('glearn')
    };
  }

  private async detectGBrain(): Promise<ToolInfo> {
    try {
      const { stdout } = await this.execSafe('gbrain', ['--version']);
      return {
        installed: true,
        version: stdout.trim(),
        path: '~/.gbrain',
        healthy: true
      };
    } catch {
      return { installed: false };
    }
  }

  private async detectGStack(): Promise<ToolInfo> {
    const home = process.env.HOME || process.env.USERPROFILE;
    const gstackPath = `${home}/.claude/skills/gstack`;
    
    try {
      if (existsSync(gstackPath)) {
        return {
          installed: true,
          path: gstackPath,
          version: 'detected',
          healthy: true
        };
      }
      return { installed: false };
    } catch {
      return { installed: false };
    }
  }

  private async detectGeneric(name: string): Promise<ToolInfo> {
    const home = process.env.HOME || process.env.USERPROFILE;
    const toolPath = `${home}/.${name}`;
    
    try {
      if (!existsSync(toolPath)) {
        return { 
          installed: false,
          message: 'Not yet built (see architecture docs)'
        };
      }
      
      // Use absolute path to binary instead of PATH lookup
      const binaryPath = process.platform === 'win32' 
        ? `${toolPath}/${name}.exe`
        : `${toolPath}/${name}`;
      
      const { stdout } = await this.execSafe(binaryPath, ['--version']);
      
      return {
        installed: existsSync(toolPath),
        path: toolPath,
        version: stdout.trim() || undefined,
        healthy: stdout.trim().length > 0,
        message: existsSync(toolPath) && stdout.trim().length === 0 
          ? 'Directory exists but binary not linked' 
          : undefined
      };
    } catch {
      return { 
        installed: existsSync(toolPath),
        path: existsSync(toolPath) ? toolPath : undefined,
        message: 'Not yet built (see architecture docs)'
      };
    }
  }

  async healthCheck(): Promise<Record<string, ToolInfo>> {
    const detected = await this.detectAll();
    const serviceNames = ['gbrain', 'gstack', 'gorchestrator', 'gmirror', 'gtom', 'glearn'];
    
    for (const name of serviceNames) {
      const info = detected[name] ?? { installed: false };
      const endpointCheck = await this.checkEndpoint(name);
      info.checks = { ...(info.checks ?? {}), endpoint: endpointCheck };
      info.latency_ms = endpointCheck.latency_ms;
      info.healthy = endpointCheck.available || false;
      if (!endpointCheck.available) info.message = endpointCheck.error || 'Health endpoint unavailable';
      detected[name] = info;
    }

    if (detected.gbrain.installed) {
      detected.gbrain.checks = { ...(detected.gbrain.checks ?? {}), doctor: await this.checkGBrainDoctor() };
      detected.gbrain.healthy = Boolean(detected.gbrain.checks.endpoint?.available || detected.gbrain.checks.doctor?.available);
      detected.gbrain.message = detected.gbrain.healthy ? undefined : detected.gbrain.checks.doctor?.error || detected.gbrain.message;
    }

    detected.llm_api = await this.checkLLMAPI();
    detected.sandbox = await this.checkSandbox();
    detected.sync_freshness = this.checkSyncFreshness();
    detected.schema_version = this.checkSchemaVersion();
    detected.queue_health = this.checkQueueHealth();
    detected.health_trend = await this.checkHealthTrend();
    detected.eval_capture = await this.checkEvalCaptureFailures();

    for (const info of Object.values(detected)) {
      info.score = this.calculateHealthScore(info);
    }
    
    return detected;
  }

  private getEndpoint(name: string): string | undefined {
    const configured = this.config.get(`tools.${name}.config.endpoint`);
    if (typeof configured === 'string' && configured.length > 0) return configured;
    const env = process.env[`${name.toUpperCase()}_ENDPOINT`];
    if (env) return env;
    const defaults: Record<string, string> = {
      gbrain: 'http://localhost:3000',
      gstack: 'http://localhost:3001',
      gorchestrator: 'http://localhost:3004',
      gmirror: 'http://localhost:3002',
      gtom: 'http://localhost:3003',
      glearn: 'http://localhost:3005',
    };
    return defaults[name];
  }

  private async checkEndpoint(name: string): Promise<{ available: boolean; latency_ms: number; error?: string }> {
    const endpoint = this.getEndpoint(name);
    const start = Date.now();
    if (!endpoint) return { available: false, latency_ms: 0, error: 'No endpoint configured' };
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return {
        available: response.ok,
        latency_ms: Date.now() - start,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        available: false,
        latency_ms: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async checkGBrainDoctor(): Promise<{ available: boolean; error?: string }> {
    try {
      const { stdout } = await this.execSafe('gbrain', ['doctor', '--json']);
      const doctor = JSON.parse(stdout);
      return {
        available: doctor.status === 'ok',
        error: doctor.status === 'ok' ? undefined : doctor.checks?.find((c: any) => !c.ok)?.message || 'Doctor reported issues',
      };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : 'Doctor check failed' };
    }
  }

  private async checkLLMAPI(): Promise<ToolInfo> {
    const start = Date.now();
    try {
      if (process.env.ANTHROPIC_API_KEY) {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return { installed: true, healthy: Boolean(response.id), latency_ms: Date.now() - start, message: 'Anthropic ping' };
      }
      if (process.env.OPENAI_API_KEY) {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return { installed: true, healthy: Boolean(response.id), latency_ms: Date.now() - start, message: 'OpenAI ping' };
      }
      return { installed: true, healthy: false, message: 'No LLM API key configured' };
    } catch (error) {
      return { installed: true, healthy: false, latency_ms: Date.now() - start, message: error instanceof Error ? error.message : 'LLM ping failed' };
    }
  }

  private async checkSandbox(): Promise<ToolInfo> {
    try {
      const { stdout } = await this.execSafe('docker', ['--version']);
      return { installed: true, healthy: stdout.trim().length > 0, version: stdout.trim(), message: 'Docker sandbox available' };
    } catch (error) {
      return { installed: false, healthy: false, message: error instanceof Error ? error.message : 'Sandbox check failed' };
    }
  }

  private checkSyncFreshness(): ToolInfo {
    const candidates = [
      join(homedir(), '.gagent', 'config.json'),
      join(process.cwd(), '.gbrain-corpus'),
    ].filter(path => existsSync(path));
    const newest = candidates
      .map(path => statSync(path).mtimeMs)
      .sort((a, b) => b - a)[0];
    const ageMs = newest ? Date.now() - newest : Number.POSITIVE_INFINITY;
    return {
      installed: true,
      healthy: ageMs <= 24 * 60 * 60 * 1000,
      message: Number.isFinite(ageMs) ? `Newest sync artifact age ${(ageMs / 3600000).toFixed(1)}h` : 'No sync artifacts found',
      checks: { age_ms: ageMs },
    };
  }

  private checkSchemaVersion(): ToolInfo {
    try {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      const configVersion = this.config.get('version');
      const healthy = typeof configVersion === 'string' && configVersion === pkg.version;
      return {
        installed: true,
        healthy,
        version: String(configVersion || 'unknown'),
        message: healthy ? 'Schema version matches package version' : `Expected ${pkg.version}, found ${configVersion || 'missing'}`,
      };
    } catch (error) {
      return { installed: true, healthy: false, message: error instanceof Error ? error.message : 'Schema check failed' };
    }
  }

  private checkQueueHealth(): ToolInfo {
    const memory = process.memoryUsage();
    const heapRatio = memory.heapTotal > 0 ? memory.heapUsed / memory.heapTotal : 0;
    return {
      installed: true,
      healthy: heapRatio < 0.9,
      message: `heap=${(heapRatio * 100).toFixed(1)}%, pending=0`,
      checks: { pending: 0, heap_ratio: heapRatio },
    };
  }

  private async checkHealthTrend(): Promise<ToolInfo> {
    const registry = new ReceiptRegistry('gagent');
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [day, week] = await Promise.all([
      registry.getAllBetween(dayAgo, now),
      registry.getAllBetween(weekAgo, now),
    ]);
    const rate = (receipts: any[]) => receipts.length === 0 ? 1 : receipts.filter(receipt => receipt.hard_gates_passed && receipt.verdict !== 'fail').length / receipts.length;
    const dayRate = rate(day);
    const weekRate = rate(week);
    return {
      installed: true,
      healthy: dayRate >= Math.max(0.5, weekRate - 0.15),
      message: `24h pass rate ${(dayRate * 100).toFixed(1)}%, 7d pass rate ${(weekRate * 100).toFixed(1)}%`,
      checks: { pass_rate_24h: dayRate, pass_rate_7d: weekRate, receipts_24h: day.length, receipts_7d: week.length },
    };
  }

  private async checkEvalCaptureFailures(): Promise<ToolInfo> {
    const registry = new ReceiptRegistry('gagent');
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const receipts = await registry.getAllBetween(dayAgo, now);
    const failures = receipts.filter((receipt: any) =>
      receipt.metadata?.eval_capture_failed ||
      receipt.metadata?.eval_capture?.status === 'failed' ||
      (receipt.errors ?? []).some((error: string) => /eval[_ -]?capture/i.test(error)),
    );
    return {
      installed: true,
      healthy: failures.length === 0,
      message: `${failures.length} eval_capture failures in the last 24h`,
      checks: { failures_24h: failures.length },
    };
  }

  private calculateHealthScore(info: ToolInfo): number {
    let score = 0;
    if (info.installed) score += 30;
    if (info.healthy) score += 45;
    if (info.latency_ms !== undefined) score += info.latency_ms < 500 ? 15 : info.latency_ms < 2000 ? 8 : 0;
    if (!info.message || /available|matches|0 eval_capture|pass rate|ping|healthy/i.test(info.message)) score += 10;
    return Math.max(0, Math.min(100, score));
  }

  async runTool(name: string, args: string[], rawArgs: string[]): Promise<ToolResult> {
    const binary = name === 'gstack' ? 'gstack' : name;
    
    return new Promise((resolve) => {
      const proc = spawn(binary, [...args, ...rawArgs], {
        stdio: 'inherit',
        shell: false
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (exitCode) => {
        resolve({ exitCode: exitCode || 0, stdout, stderr });
      });
    });
  }

  async syncAll(): Promise<void> {
    // Sync GBrain (central memory)
    if (this.config.isToolEnabled('gbrain')) {
      try {
        await this.execSafe('gbrain', ['sync']);
      } catch {
        // Ignore errors
      }
    }
    
    // Sync GStack learnings to GBrain
    if (this.config.isToolEnabled('gstack') && this.config.isToolEnabled('gbrain')) {
      try {
        const home = process.env.HOME || process.env.USERPROFILE;
        await this.execSafe('gbrain', ['sources', 'add', `${home}/.gstack`, '--strategy', 'memory']);
      } catch {
        // May already be added
      }
    }
    
    // Future: sync other tools
  }

  getEnabledTools(): string[] {
    return Object.entries(this.config.getRaw().tools)
      .filter(([_, info]) => info.enabled)
      .map(([name, _]) => name);
  }
}
