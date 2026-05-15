import { ToolRegistry } from './tools/registry.js';
import { GAgentConfig } from './config/manager.js';
import { startMcpServer } from './mcp/server.js';
import { HealthServer, type HealthCheckResult, type ReadinessCheckResult } from '../../shared/src/core/health-server.js';
import { StructuredLogger } from '../../shared/src/observability/structured-logger.js';

const HEALTH_PORT = process.env.HEALTH_PORT ? parseInt(process.env.HEALTH_PORT, 10) : 8080;
const logger = new StructuredLogger('gagent-serve');

async function main() {
  const config = new GAgentConfig();
  const registry = new ToolRegistry(config);

  // Create health server
  const healthServer = new HealthServer(
    async (): Promise<HealthCheckResult> => ({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    }),
    async (): Promise<ReadinessCheckResult> => ({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      dependencies: {},
    }),
    HEALTH_PORT
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    await healthServer.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  healthServer.addShutdownHandler(async () => {
    logger.info('Cleanup complete');
  });

  try {
    await healthServer.start();
    await startMcpServer(registry, config);
  } catch (error) {
    logger.error('Failed to start GAgent', error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  }
}

main().catch((error) => logger.error('Main function error', error instanceof Error ? error : new Error(String(error))));
