import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { GAgentConfig } from '../config/manager.js';
import { ReceiptRegistry } from '../core/receipt-registry.js';
import { GBrainIntegrationClient } from '../core/gbrain-integration.js';
import { getDefaultSecretManager } from '../core/security.js';

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

export type SyncMode = 'incremental' | 'full';

export interface SyncOptions {
  mode?: SyncMode;
  dryRun?: boolean;
  lockTimeoutMs?: number;
}

export interface SyncStageResult {
  stage: string;
  status: 'ok' | 'skipped' | 'error';
  mode: SyncMode;
  dry_run: boolean;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  items_total: number;
  items_changed: number;
  details?: Record<string, any>;
  error?: string;
}

export interface SyncResult {
  status: 'ok' | 'partial' | 'error';
  mode: SyncMode;
  dry_run: boolean;
  stages: SyncStageResult[];
  state_path: string;
  lock_path: string;
  timestamp: string;
}

interface GStackGBrainSource {
  tool: string;
  id: string;
  path: string;
  pathhash8: string;
  federated: boolean;
  dotfile_path: string;
  updated_at: string;
}

interface GStackGBrainSyncState {
  version: 1;
  updated_at: string;
  mode: SyncMode;
  sources: Record<string, GStackGBrainSource>;
}

const TOOL_SOURCE_NAMES = ['gbrain', 'gstack', 'gorchestrator', 'gmirror', 'gtom', 'glearn'] as const;
const DEFAULT_TOOL_PATHS: Record<string, string> = {
  gbrain: join(homedir(), '.gbrain'),
  gstack: join(homedir(), '.claude', 'skills', 'gstack'),
  gorchestrator: join(homedir(), '.gorchestrator'),
  gmirror: join(homedir(), '.gmirror'),
  gtom: join(homedir(), '.gtom'),
  glearn: join(homedir(), '.glearn'),
};
const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

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
    const toolPath = join(homedir(), `.${name}`);
    const binaryName = process.platform === 'win32' ? `${name}.exe` : name;
    const binaryPath = join(toolPath, binaryName);
    
    try {
      if (!existsSync(toolPath)) {
        return { 
          installed: false,
          message: 'Not yet built (see architecture docs)'
        };
      }

      if (!existsSync(binaryPath)) {
        return {
          installed: true,
          path: toolPath,
          healthy: false,
          message: `Directory exists but binary not found at ${binaryPath}`,
        };
      }
      
      const { stdout } = await this.execSafe(binaryPath, ['--version']);
      
      return {
        installed: true,
        path: toolPath,
        version: stdout.trim() || undefined,
        healthy: stdout.trim().length > 0,
        message: stdout.trim().length === 0
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

    await this.publishDailyToolStatus(detected);
    
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
    const secrets = getDefaultSecretManager();
    const anthropicApiKey = secrets.get('anthropic_api_key');
    const openaiApiKey = secrets.get('openai_api_key');
    try {
      if (anthropicApiKey) {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const client = new Anthropic({ apiKey: anthropicApiKey });
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return { installed: true, healthy: Boolean(response.id), latency_ms: Date.now() - start, message: 'Anthropic ping' };
      }
      if (openaiApiKey) {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({ apiKey: openaiApiKey });
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

  private async publishDailyToolStatus(detected: Record<string, ToolInfo>): Promise<void> {
    if (!this.config.isToolEnabled('gbrain')) {
      return;
    }

    try {
      const client = new GBrainIntegrationClient({
        endpoint: this.getEndpoint('gbrain'),
      });
      await client.publishDailyToolStatus({ status: detected });
    } catch {
      // GBrain status publication is best-effort and must not fail health checks.
    }
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

  async syncAll(options: SyncOptions = {}): Promise<SyncResult> {
    return this.runGStackGBrainSync(options);
  }

  async runGStackGBrainSync(options: SyncOptions = {}): Promise<SyncResult> {
    const mode = options.mode ?? 'incremental';
    const dryRun = options.dryRun ?? false;
    const syncRoot = this.getSyncRoot();
    const statePath = join(syncRoot, 'gstack-gbrain-sync-state.json');
    const lockPath = join(syncRoot, 'gstack-gbrain-sync.lock');
    const stages: SyncStageResult[] = [];

    if (!dryRun) {
      try {
        this.acquireSyncLock(lockPath, options.lockTimeoutMs ?? SYNC_LOCK_STALE_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to acquire sync lock';
        stages.push(this.makeStageResult('lock', mode, dryRun, Date.now(), 0, 0, 'error', undefined, message));
        return {
          status: 'error',
          mode,
          dry_run: dryRun,
          stages,
          state_path: statePath,
          lock_path: lockPath,
          timestamp: new Date().toISOString(),
        };
      }
    }

    try {
      const previousState = this.readSyncState(statePath);
      stages.push(await this.syncGBrainStage(mode, dryRun));
      const toolsStage = await this.syncToolsStage(mode, dryRun, statePath, previousState);
      stages.push(toolsStage);

      if (!dryRun && toolsStage.status !== 'error') {
        this.writeSyncStateAtomic(statePath, {
          version: 1,
          updated_at: new Date().toISOString(),
          mode,
          sources: Object.fromEntries((toolsStage.details?.sources ?? []).map((source: GStackGBrainSource) => [source.tool, source])),
        });
      }

      const status = stages.some(stage => stage.status === 'error')
        ? stages.some(stage => stage.status === 'ok') ? 'partial' : 'error'
        : 'ok';
      return {
        status,
        mode,
        dry_run: dryRun,
        stages,
        state_path: statePath,
        lock_path: lockPath,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (!dryRun) {
        this.releaseSyncLock(lockPath);
      }
    }
  }

  private async syncGBrainStage(mode: SyncMode, dryRun: boolean): Promise<SyncStageResult> {
    const started = Date.now();
    if (!this.config.isToolEnabled('gbrain')) {
      return this.makeStageResult('gbrain', mode, dryRun, started, 0, 0, 'skipped', { reason: 'gbrain disabled' });
    }

    if (dryRun) {
      return this.makeStageResult('gbrain', mode, dryRun, started, 1, 1, 'ok', {
        planned_command: ['gbrain', 'sync'],
      });
    }

    try {
      await this.execSafe('gbrain', ['sync']);
      return this.makeStageResult('gbrain', mode, dryRun, started, 1, 1, 'ok');
    } catch (error) {
      return this.makeStageResult('gbrain', mode, dryRun, started, 1, 0, 'error', undefined, error instanceof Error ? error.message : 'gbrain sync failed');
    }
  }

  private async syncToolsStage(
    mode: SyncMode,
    dryRun: boolean,
    statePath: string,
    previousState?: GStackGBrainSyncState,
  ): Promise<SyncStageResult> {
    const started = Date.now();
    if (!this.config.isToolEnabled('gbrain')) {
      return this.makeStageResult('tools', mode, dryRun, started, 0, 0, 'skipped', { reason: 'gbrain disabled' });
    }

    const enabledSources = TOOL_SOURCE_NAMES
      .filter(tool => this.config.isToolEnabled(tool))
      .map(tool => this.buildGBrainSource(tool));
    const previousSources = Object.values(previousState?.sources ?? {});
    const currentIds = new Set(enabledSources.map(source => source.id));
    const legacySources = mode === 'full'
      ? previousSources.filter(source => !currentIds.has(source.id) || !this.isPathHashSourceId(source.id))
      : [];
    const changedSources = enabledSources.filter(source => {
      const previous = previousState?.sources[source.tool];
      return mode === 'full' || !previous || previous.id !== source.id || previous.path !== source.path;
    });
    let changed = 0;
    const errors: string[] = [];

    for (const source of enabledSources) {
      const shouldWrite = mode === 'full' || changedSources.some(changedSource => changedSource.tool === source.tool);
      if (!shouldWrite) continue;
      changed += 1;

      if (dryRun) continue;

      try {
        this.attachGBrainSourceDotfile(source);
        await this.execSafe('gbrain', ['sources', 'add', source.id, '--federated']);
      } catch (error) {
        errors.push(`${source.tool}: ${error instanceof Error ? error.message : 'source registration failed'}`);
      }
    }

    for (const legacy of legacySources) {
      changed += 1;
      if (dryRun) continue;
      try {
        await this.execSafe('gbrain', ['sources', 'remove', legacy.id]);
      } catch (error) {
        errors.push(`${legacy.id}: ${error instanceof Error ? error.message : 'legacy source cleanup failed'}`);
      }
    }

    return this.makeStageResult(
      'tools',
      mode,
      dryRun,
      started,
      enabledSources.length + legacySources.length,
      changed,
      errors.length > 0 ? 'error' : 'ok',
      {
        state_path: statePath,
        sources: enabledSources,
        legacy_cleanup: legacySources.map(source => source.id),
        commands: [
          ...enabledSources.map(source => ['gbrain', 'sources', 'add', source.id, '--federated']),
          ...legacySources.map(source => ['gbrain', 'sources', 'remove', source.id]),
        ],
      },
      errors.length > 0 ? errors.join('; ') : undefined,
    );
  }

  private buildGBrainSource(tool: string): GStackGBrainSource {
    const sourcePath = this.config.getToolPath(tool) ?? DEFAULT_TOOL_PATHS[tool] ?? join(homedir(), `.${tool}`);
    const pathhash8 = createHash('sha256').update(sourcePath).digest('hex').slice(0, 8);
    const id = `gagent-${tool}-${pathhash8}`;
    return {
      tool,
      id,
      path: sourcePath,
      pathhash8,
      federated: true,
      dotfile_path: join(sourcePath, '.gbrain-source'),
      updated_at: new Date().toISOString(),
    };
  }

  private getSyncRoot(): string {
    const configured = this.config.get('integration.gstack_gbrain_sync_root');
    if (typeof configured === 'string' && configured.length > 0) return configured;
    if (process.env.GAGENT_SYNC_ROOT) return process.env.GAGENT_SYNC_ROOT;
    return join(homedir(), '.gagent', 'sync');
  }

  private attachGBrainSourceDotfile(source: GStackGBrainSource): void {
    mkdirSync(source.path, { recursive: true });
    writeFileSync(source.dotfile_path, JSON.stringify(source, null, 2));
  }

  private isPathHashSourceId(id: string): boolean {
    return /^gagent-[a-z0-9-]+-[a-f0-9]{8}$/.test(id);
  }

  private readSyncState(statePath: string): GStackGBrainSyncState | undefined {
    try {
      if (!existsSync(statePath)) return undefined;
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      if (parsed?.version !== 1 || typeof parsed?.sources !== 'object') return undefined;
      return parsed as GStackGBrainSyncState;
    } catch {
      return undefined;
    }
  }

  private writeSyncStateAtomic(statePath: string, state: GStackGBrainSyncState): void {
    const dir = dirname(statePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, statePath);
  }

  private acquireSyncLock(lockPath: string, staleMs: number): void {
    mkdirSync(dirname(lockPath), { recursive: true });
    if (existsSync(lockPath)) {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      if (staleMs > 0 && ageMs < staleMs) {
        throw new Error(`gstack-gbrain-sync lock is active (${Math.round(ageMs)}ms old)`);
      }
      unlinkSync(lockPath);
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2), { flag: 'wx' });
  }

  private releaseSyncLock(lockPath: string): void {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // Another process may have already recovered a stale lock.
    }
  }

  private makeStageResult(
    stage: string,
    mode: SyncMode,
    dryRun: boolean,
    startedMs: number,
    itemsTotal: number,
    itemsChanged: number,
    status: SyncStageResult['status'],
    details?: Record<string, any>,
    error?: string,
  ): SyncStageResult {
    const completedMs = Date.now();
    return {
      stage,
      status,
      mode,
      dry_run: dryRun,
      started_at: new Date(startedMs).toISOString(),
      completed_at: new Date(completedMs).toISOString(),
      duration_ms: completedMs - startedMs,
      items_total: itemsTotal,
      items_changed: itemsChanged,
      details,
      error,
    };
  }

  getEnabledTools(): string[] {
    return Object.entries(this.config.getRaw().tools)
      .filter(([_, info]) => info.enabled)
      .map(([name, _]) => name);
  }
}
