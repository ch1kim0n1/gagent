import { ReceiptRegistry } from './receipt-registry.js';
import { getDefaultSecretManager } from './security.js';

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  project: string;
  rubric_version: string;
  last_receipt_timestamp: string | null;
  drift_status: {
    has_drift: boolean;
    detected_at: string | null;
  };
  metrics: {
    uptime_ms: number;
    memory_usage_mb: number;
    recent_errors: number;
  };
  service_checks?: {
    llm_api?: { available: boolean; latency_ms?: number; error?: string };
    gbrain?: { available: boolean; latency_ms?: number; error?: string };
    sandbox?: { available: boolean; error?: string };
  };
}

export class HealthChecker {
  private project: string;
  private rubricVersion: string;
  private registry: ReceiptRegistry;
  private startTime: number;
  private baselineReceipt: any = null;
  private errorLog: Array<{ timestamp: string; error: string }> = [];
  private readonly ERROR_WINDOW_MS = 5 * 60 * 1000;

  constructor(project: string, rubricVersion: string) {
    this.project = project;
    this.rubricVersion = rubricVersion;
    this.registry = new ReceiptRegistry(project);
    this.startTime = Date.now();
  }

  recordError(error: string): void {
    this.errorLog.push({ timestamp: new Date().toISOString(), error });
    const cutoff = Date.now() - this.ERROR_WINDOW_MS;
    this.errorLog = this.errorLog.filter(e => new Date(e.timestamp).getTime() > cutoff);
  }

  private getRecentErrorCount(): number {
    const cutoff = Date.now() - this.ERROR_WINDOW_MS;
    return this.errorLog.filter(e => new Date(e.timestamp).getTime() > cutoff).length;
  }

  private detectDrift(currentReceipt: any): { has_drift: boolean; detected_at: string | null } {
    if (!currentReceipt) return { has_drift: false, detected_at: null };
    if (!this.baselineReceipt) {
      this.baselineReceipt = currentReceipt;
      return { has_drift: false, detected_at: null };
    }
    const baselineMetrics = this.baselineReceipt.metrics || {};
    const currentMetrics = currentReceipt.metrics || {};
    const driftThreshold = 0.1;
    let hasDrift = false;
    for (const key of Object.keys(baselineMetrics)) {
      const baselineValue = baselineMetrics[key];
      const currentValue = currentMetrics[key];
      if (typeof baselineValue === 'number' && typeof currentValue === 'number') {
        const change = Math.abs((currentValue - baselineValue) / baselineValue);
        if (change > driftThreshold && baselineValue !== 0) { hasDrift = true; break; }
      }
    }
    return { has_drift: hasDrift, detected_at: hasDrift ? new Date().toISOString() : null };
  }

  async check(): Promise<HealthCheckResult> {
    const latestReceipt = await this.registry.getLatest();
    const memoryUsage = process.memoryUsage();
    const uptime = Date.now() - this.startTime;

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (memoryUsage.heapUsed / memoryUsage.heapTotal > 0.9) {
      status = 'degraded';
    }
    if (memoryUsage.heapUsed / memoryUsage.heapTotal > 0.95) {
      status = 'unhealthy';
    }

    // Run service checks
    const serviceChecks = await this.checkServices();
    if (serviceChecks.llm_api?.available === false || serviceChecks.gbrain?.available === false) {
      if (status === 'healthy') status = 'degraded';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      project: this.project,
      rubric_version: this.rubricVersion,
      last_receipt_timestamp: latestReceipt?.timestamp || null,
      drift_status: this.detectDrift(latestReceipt),
      metrics: {
        uptime_ms: uptime,
        memory_usage_mb: memoryUsage.heapUsed / 1024 / 1024,
        recent_errors: this.getRecentErrorCount(),
      },
      service_checks: serviceChecks,
    };
  }

  /**
   * Check external services (LLM API, gbrain, sandbox)
   */
  private async checkServices(): Promise<any> {
    const checks: any = {};

    // Check LLM API availability
    checks.llm_api = await this.checkLLMAPI();

    // Check gbrain endpoint
    checks.gbrain = await this.checkGBrain();

    return checks;
  }

  /**
   * Check LLM API availability
   */
  private async checkLLMAPI(): Promise<{ available: boolean; latency_ms?: number; error?: string }> {
    try {
      const secrets = getDefaultSecretManager();
      const anthropicApiKey = secrets.get('anthropic_api_key');
      const openaiApiKey = secrets.get('openai_api_key');
      if (!anthropicApiKey && !openaiApiKey) {
        return { available: false, error: 'No API key configured' };
      }

      const startTime = Date.now();
      
      // Try a cheap API call (use Haiku for minimal cost)
      if (anthropicApiKey) {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const client = new Anthropic({ apiKey: anthropicApiKey });
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }],
        });
        const latency = Date.now() - startTime;
        return { available: response.id ? true : false, latency_ms: latency };
      } else if (openaiApiKey) {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({ apiKey: openaiApiKey });
        const response = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }],
        });
        const latency = Date.now() - startTime;
        return { available: response.id ? true : false, latency_ms: latency };
      }

      return { available: false, error: 'No supported LLM provider' };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check gbrain endpoint
   */
  private async checkGBrain(): Promise<{ available: boolean; latency_ms?: number; error?: string }> {
    try {
      const gbrainEndpoint = process.env.GBRAIN_ENDPOINT || 'http://localhost:3000';
      const startTime = Date.now();

      const response = await fetch(`${gbrainEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      const latency = Date.now() - startTime;
      return { available: response.ok, latency_ms: latency };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
