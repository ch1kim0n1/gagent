import { z } from 'zod';
import { getDefaultSecretManager } from './security.js';

export type GBrainIntegrationMode = 'http' | 'mcp';

export interface GBrainIntegrationConfig {
  endpoint?: string;
  mcpEndpoint?: string;
  mode?: GBrainIntegrationMode;
  authToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerCooldownMs?: number;
}

export class GBrainIntegrationError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'network' | 'auth' | 'server_error' | 'parse_error' | 'circuit_open',
    message: string,
    public readonly statusCode?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'GBrainIntegrationError';
  }
}

const HealthSchema = z.object({
  ok: z.boolean().optional(),
  status: z.string().optional(),
}).passthrough();

const PageSchema = z.object({
  page_id: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
}).passthrough();

const PageArraySchema = z.array(PageSchema);
const PageWriteAckSchema = z.object({
  page_id: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

const ToolStatusSchema = z.record(z.object({
  installed: z.boolean().optional(),
  healthy: z.boolean().optional(),
  path: z.string().optional(),
  version: z.string().optional(),
  message: z.string().optional(),
  latency_ms: z.number().optional(),
  score: z.number().optional(),
  checks: z.record(z.any()).optional(),
}).passthrough());

export type GBrainPage = z.infer<typeof PageSchema>;

/**
 * Typed GBrain client for GAgent context lookup, status publication, and receipt writes.
 */
export class GBrainIntegrationClient {
  private readonly endpoint: string;
  private readonly mcpEndpoint: string;
  private readonly mode: GBrainIntegrationMode;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly circuitBreakerFailureThreshold: number;
  private readonly circuitBreakerCooldownMs: number;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly enabled: boolean;

  constructor(config: GBrainIntegrationConfig = {}) {
    const secrets = getDefaultSecretManager();
    this.enabled = process.env.GBRAIN_ENABLED !== 'false';
    this.endpoint = trimTrailingSlash(config.endpoint || process.env.GBRAIN_ENDPOINT || 'http://localhost:3000');
    this.mcpEndpoint = trimTrailingSlash(config.mcpEndpoint || process.env.GBRAIN_MCP_ENDPOINT || `${this.endpoint}/mcp`);
    this.mode = config.mode || (process.env.GBRAIN_INTEGRATION_MODE as GBrainIntegrationMode | undefined) || 'http';
    this.authToken = config.authToken || secrets.get('gbrain_auth_token');
    this.timeoutMs = config.timeoutMs ?? Number(process.env.GBRAIN_TIMEOUT_MS ?? 30000);
    this.maxRetries = config.maxRetries ?? Number(process.env.GBRAIN_MAX_RETRIES ?? 3);
    this.initialBackoffMs = config.initialBackoffMs ?? Number(process.env.GBRAIN_BACKOFF_MS ?? 250);
    this.circuitBreakerFailureThreshold = config.circuitBreakerFailureThreshold ?? Number(process.env.GBRAIN_CIRCUIT_FAILURES ?? 3);
    this.circuitBreakerCooldownMs = config.circuitBreakerCooldownMs ?? Number(process.env.GBRAIN_CIRCUIT_COOLDOWN_MS ?? 60000);
  }

  async healthCheck(): Promise<{ ok?: boolean; status?: string }> {
    if (!this.enabled) return { healthy: true, latency_ms: 0 } as any;
    if (this.mode === 'mcp') {
      return this.callMcpTool('gbrain.health', {}, HealthSchema);
    }
    return this.requestJson('/health', { method: 'GET' }, HealthSchema);
  }

  async searchContext(query: string): Promise<GBrainPage[]> {
    if (!this.enabled) return [];
    if (this.mode === 'mcp') {
      return this.callMcpTool('gbrain.search_pages', { query, tags: ['gagent'] }, PageArraySchema);
    }
    const params = new URLSearchParams({ query, tags: 'gagent' });
    return this.requestJson(`/api/pages/search?${params.toString()}`, { method: 'GET' }, PageArraySchema);
  }

  async createPage(input: {
    title: string;
    content: string;
    tags?: string[];
  }): Promise<{ page_id?: string; id?: string }> {
    if (!this.enabled) return { page_id: 'disabled', id: 'disabled' };
    const payload = z.object({
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).optional(),
    }).parse(input);

    if (this.mode === 'mcp') {
      return this.callMcpTool('gbrain.put_page', payload, PageWriteAckSchema);
    }
    return this.requestJson('/api/pages', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, PageWriteAckSchema);
  }

  async publishDailyToolStatus(input: {
    date?: string;
    status: Record<string, unknown>;
  }): Promise<{ page_id?: string; id?: string }> {
    const date = input.date ?? new Date().toISOString().slice(0, 10);
    const status = ToolStatusSchema.parse(input.status);
    return this.createPage({
      title: `GAgent tool status ${date}`,
      content: JSON.stringify({
        date,
        generated_at: new Date().toISOString(),
        status,
      }, null, 2),
      tags: ['gagent', 'tool-status', date],
    });
  }

  getCircuitState(): { open: boolean; openUntil?: string; consecutiveFailures: number } {
    const open = this.isCircuitOpen();
    return {
      open,
      openUntil: open ? new Date(this.circuitOpenUntil).toISOString() : undefined,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async callMcpTool<T>(toolName: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const raw = await this.requestJson(`${this.mcpEndpoint}/tools/${encodeURIComponent(toolName)}`, {
      method: 'POST',
      body: JSON.stringify(args),
    }, z.unknown(), true);
    return schema.parse(normalizeMcpResponse(raw));
  }

  private async requestJson<T>(
    pathOrUrl: string,
    options: RequestInit,
    schema: z.ZodType<T>,
    absoluteUrl = false,
  ): Promise<T> {
    this.assertCircuitClosed();
    const url = absoluteUrl ? pathOrUrl : `${this.endpoint}${pathOrUrl}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, options);
        if (!response.ok) {
          throw this.errorFromResponse(response);
        }
        const parsed = schema.parse(await parseJson(response));
        this.resetCircuit();
        return parsed;
      } catch (error) {
        lastError = normalizeError(error, url, this.timeoutMs);
        this.recordFailure(lastError);
        const retryable = lastError instanceof GBrainIntegrationError && lastError.retryable;
        if (!retryable || attempt >= this.maxRetries) {
          throw lastError;
        }
        await delay(this.initialBackoffMs * Math.pow(2, attempt));
      }
    }

    throw normalizeError(lastError, url, this.timeoutMs);
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headersToRecord(options.headers),
    };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    try {
      return await fetch(url, { ...options, headers, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private errorFromResponse(response: Response): GBrainIntegrationError {
    if (response.status === 401 || response.status === 403) {
      return new GBrainIntegrationError('auth', `GBrain authentication failed with ${response.status}`, response.status, false);
    }
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    return new GBrainIntegrationError('server_error', `GBrain returned ${response.status}`, response.status, retryable);
  }

  private assertCircuitClosed(): void {
    if (!this.isCircuitOpen()) {
      return;
    }
    throw new GBrainIntegrationError('circuit_open', `GBrain circuit breaker is open until ${new Date(this.circuitOpenUntil).toISOString()}`, undefined, true);
  }

  private isCircuitOpen(): boolean {
    if (this.circuitOpenUntil === 0) {
      return false;
    }
    if (Date.now() >= this.circuitOpenUntil) {
      this.circuitOpenUntil = 0;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private recordFailure(error: unknown): void {
    if (!(error instanceof GBrainIntegrationError) || !error.retryable) {
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.circuitBreakerFailureThreshold) {
      this.circuitOpenUntil = Date.now() + this.circuitBreakerCooldownMs;
    }
  }

  private resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new GBrainIntegrationError('parse_error', `GBrain response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`, response.status, false);
  }
}

function normalizeError(error: unknown, url: string, timeoutMs: number): GBrainIntegrationError {
  if (error instanceof GBrainIntegrationError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new GBrainIntegrationError('parse_error', `GBrain response failed schema validation: ${error.message}`, undefined, false);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new GBrainIntegrationError('timeout', `GBrain request to ${url} timed out after ${timeoutMs}ms`, undefined, true);
  }
  return new GBrainIntegrationError('network', `GBrain request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
}

function normalizeMcpResponse(data: unknown): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }
  const value = data as Record<string, unknown>;
  if ('result' in value) {
    return value.result;
  }
  if ('data' in value) {
    return value.data;
  }
  if (Array.isArray(value.content)) {
    const text = value.content
      .map((item) => typeof item === 'object' && item !== null ? (item as Record<string, unknown>).text : undefined)
      .filter((item): item is string => typeof item === 'string')
      .join('\n');
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return data;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
