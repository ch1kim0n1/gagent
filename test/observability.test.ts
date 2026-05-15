import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GAgentObservability, redactPII } from '../src/core/observability';
import { GAgentConfig } from '../src/config/manager';
import { ToolRegistry } from '../src/tools/registry';
import { Pipeline } from '../src/pipeline/orchestrator';

describe('GAgent observability', () => {
  const originalAuditDir = process.env.GAGENT_AUDIT_DIR;
  const endpointKeys = ['GBRAIN_ENDPOINT', 'GSTACK_ENDPOINT', 'GORCHESTRATOR_ENDPOINT', 'GMIRROR_ENDPOINT', 'GTOM_ENDPOINT', 'GLEARN_ENDPOINT'];
  const originalEndpoints = Object.fromEntries(endpointKeys.map(key => [key, process.env[key]]));

  afterEach(() => {
    if (originalAuditDir === undefined) delete process.env.GAGENT_AUDIT_DIR;
    else process.env.GAGENT_AUDIT_DIR = originalAuditDir;
    for (const key of endpointKeys) {
      const value = originalEndpoints[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('redacts PII from structured payloads', () => {
    expect(redactPII({
      user_email: 'person@example.com',
      nested: { api_key: 'test-key' },
      message: 'contact person@example.com',
    })).toEqual({
      user_email: '[REDACTED]',
      nested: { api_key: '[REDACTED]' },
      message: 'contact [REDACTED_EMAIL]',
    });
  });

  it('exports Prometheus and OpenTelemetry metrics with latency quantiles', () => {
    const observability = new GAgentObservability('gagent');
    observability.metrics.recordPublicMethod('execute', 10, 'ok');
    observability.metrics.recordPublicMethod('execute', 20, 'ok');
    observability.metrics.recordPublicMethod('execute', 30, 'error');

    const prometheus = observability.metrics.prometheus();
    expect(prometheus).toContain('gagent_public_method_throughput_total{method="execute",status="ok"} 2');
    expect(prometheus).toContain('gagent_public_method_errors_total{method="execute"} 1');
    expect(prometheus).toContain('quantile="0.95"');

    const otel = observability.metrics.openTelemetry();
    expect(JSON.stringify(otel)).toContain('service.name');
  });

  it('writes decision and shell-job audit JSONL files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-audit-'));
    process.env.GAGENT_AUDIT_DIR = dir;
    const observability = new GAgentObservability('gagent');

    observability.audit.logDecision({
      operation: 'execute',
      decision: 'success',
      success: true,
      metadata: { email: 'person@example.com' },
    });
    observability.audit.logShellJob({
      command: 'npm test',
      exit_code: 0,
      metadata: { token: 'test-token' },
    });

    const files = fs.readdirSync(dir);
    expect(files.some(file => file.startsWith('decisions-'))).toBe(true);
    expect(files.some(file => file.startsWith('shell-jobs-'))).toBe(true);
    const content = files.map(file => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('person@example.com');
    expect(content).not.toContain('test-token');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes metrics and trace snapshots from Pipeline public methods', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-audit-'));
    process.env.GAGENT_AUDIT_DIR = dir;
    for (const key of endpointKeys) {
      process.env[key] = 'http://127.0.0.1:1';
    }

    const config = new GAgentConfig();
    const pipeline = new Pipeline(new ToolRegistry(config), config);

    await pipeline.healthCheck();

    expect(pipeline.exportPrometheusMetrics()).toContain('gagent_public_method_throughput_total');
    expect(JSON.stringify(pipeline.exportOpenTelemetryMetrics())).toContain('resourceMetrics');
    expect(JSON.stringify(pipeline.getObservabilitySnapshot())).toContain('GAgent.healthCheck');

    (pipeline as any).persistenceManager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
