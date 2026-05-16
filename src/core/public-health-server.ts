import { IncomingMessage, Server as HttpServer, ServerResponse, createServer } from 'http';
import { getDefaultSecretManager } from './security.js';

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
}

export interface ReadinessCheckResult extends HealthCheckResult {
  dependencies: Record<string, 'ok' | 'error'>;
}

interface RateWindow {
  count: number;
  startedAt: number;
}

export class SecureHealthServer {
  private server?: HttpServer;
  private isShuttingDown = false;
  private shutdownHandlers: Array<() => Promise<void>> = [];
  private windows = new Map<string, RateWindow>();
  private limit = Number(process.env.GAGENT_HEALTH_RATE_LIMIT_RPM || '120');
  private shutdownToken = getDefaultSecretManager().get('health_shutdown_token');

  constructor(
    private livenessCheck: () => Promise<HealthCheckResult>,
    private readinessCheck: () => Promise<ReadinessCheckResult>,
    private port = 8080,
    private shutdownTimeout = 30000,
  ) {}

  addShutdownHandler(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Health server already running');
    this.server = createServer((req, res) => void this.handleRequest(req, res));
    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => resolve());
      this.server!.on('error', reject);
    });
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    for (const handler of this.shutdownHandlers) await handler();
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
      setTimeout(resolve, this.shutdownTimeout);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return this.json(res, 204, {});

    const rate = this.checkRate(req.socket.remoteAddress || 'unknown');
    if (!rate.allowed) return this.json(res, 429, { error: 'rate_limited', reset_at: rate.resetAt });

    try {
      if (req.url === '/health/live' && req.method === 'GET') {
        const result = this.isShuttingDown ? { status: 'unhealthy' as const, timestamp: new Date().toISOString() } : await this.livenessCheck();
        return this.json(res, result.status === 'healthy' ? 200 : 503, result);
      }
      if (req.url === '/health/ready' && req.method === 'GET') {
        const result = this.isShuttingDown
          ? { status: 'unhealthy' as const, timestamp: new Date().toISOString(), dependencies: {} }
          : await this.readinessCheck();
        return this.json(res, result.status === 'healthy' ? 200 : 503, result);
      }
      if (req.url === '/health/shutdown' && req.method === 'POST') {
        if (!this.authorizeShutdown(req.headers.authorization)) return this.json(res, 403, { error: 'shutdown token required' });
        this.json(res, 202, { status: 'shutdown_initiated' });
        void this.shutdown();
        return;
      }
      return this.json(res, 404, { error: 'not_found' });
    } catch {
      return this.json(res, 500, { error: 'internal_server_error' });
    }
  }

  private authorizeShutdown(header?: string): boolean {
    if (!this.shutdownToken) return false;
    return header?.replace(/^Bearer\s+/i, '') === this.shutdownToken;
  }

  private checkRate(key: string): { allowed: boolean; resetAt: string } {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      window = { count: 0, startedAt: now };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) return { allowed: false, resetAt: new Date(window.startedAt + 60_000).toISOString() };
    window.count++;
    return { allowed: true, resetAt: new Date(window.startedAt + 60_000).toISOString() };
  }

  private json(res: ServerResponse, statusCode: number, body: object): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
