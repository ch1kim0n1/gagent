/**
 * GAgent HTTP client
 *
 * GAgent primarily exposes an MCP server and health server (port 8080).
 * This client targets the health endpoint and task execution endpoint.
 */

export interface TaskExecutionInput {
  task: string;
  parameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ExecutionReceipt {
  receipt_id: string;
  task: string;
  parameters: Record<string, unknown>;
  output: string;
  exit_code: number;
  timestamp: string;
  signature?: string;
}

export interface HealthResult {
  status: string;
  timestamp: string;
  [key: string]: unknown;
}

export class GAgentClient {
  private baseUrl: string;
  private healthBaseUrl: string;
  private token?: string;

  constructor(options: { baseUrl?: string; healthBaseUrl?: string; token?: string } = {}) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:3004';
    this.healthBaseUrl = options.healthBaseUrl ?? 'http://localhost:8080';
    this.token = options.token;
  }

  /** POST to execute a task */
  async executeTask(task: string, params?: Record<string, unknown>): Promise<ExecutionReceipt> {
    return this.request<ExecutionReceipt>('POST', '/execute', { task, parameters: params ?? {} }, this.baseUrl);
  }

  /** GET /health/live */
  async health(): Promise<HealthResult> {
    return this.request<HealthResult>('GET', '/health/live', undefined, this.healthBaseUrl);
  }

  private async request<T>(method: string, path: string, body?: unknown, base?: string): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${base ?? this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }
}
