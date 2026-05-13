import { ReceiptRegistry } from './receipt-registry.js';

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

  constructor(project: string, rubricVersion: string) {
    this.project = project;
    this.rubricVersion = rubricVersion;
    this.registry = new ReceiptRegistry(project);
    this.startTime = Date.now();
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
      drift_status: {
        has_drift: false, // TODO: Implement drift detection
        detected_at: null,
      },
      metrics: {
        uptime_ms: uptime,
        memory_usage_mb: memoryUsage.heapUsed / 1024 / 1024,
        recent_errors: 0, // TODO: Track recent errors
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
      const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return { available: false, error: 'No API key configured' };
      }

      const startTime = Date.now();
      
      // Try a cheap API call (use Haiku for minimal cost)
      if (process.env.ANTHROPIC_API_KEY) {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }],
        });
        const latency = Date.now() - startTime;
        return { available: response.id ? true : false, latency_ms: latency };
      } else if (process.env.OPENAI_API_KEY) {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({ apiKey });
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
        timeout: 5000,
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
