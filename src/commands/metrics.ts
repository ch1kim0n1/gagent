/**
 * Metrics command for GAgent
 * View and export metrics
 */

import { Command } from './command-registry.js';
import { GAgentConfig } from '../config/manager.js';
import { ToolRegistry } from '../tools/registry.js';
import { Pipeline } from '../pipeline/orchestrator.js';

export const metricsCommand: Command = {
  name: 'metrics',
  description: 'View and export metrics',
  handler: async (args: string[]) => {
    const format = valueAfter(args, '--format') || (args.includes('--prometheus') ? 'prometheus' : args.includes('--otel') ? 'otel' : 'json');
    const pipeline = createPipeline();
    if (format === 'prometheus') {
      console.log(pipeline.exportPrometheusMetrics());
      return;
    }
    if (format === 'otel') {
      console.log(JSON.stringify(pipeline.exportOpenTelemetryMetrics(), null, 2));
      return;
    }
    console.log(JSON.stringify(pipeline.getObservabilitySnapshot(), null, 2));
  },
  subcommands: [
    {
      name: 'export',
      description: 'Export metrics',
      handler: async (args: string[]) => {
        const format = args[0] || 'json';
        const pipeline = createPipeline();
        if (format === 'prometheus') {
          console.log(pipeline.exportPrometheusMetrics());
          return;
        }
        if (format === 'otel') {
          console.log(JSON.stringify(pipeline.exportOpenTelemetryMetrics(), null, 2));
          return;
        }
        console.log(JSON.stringify(pipeline.getObservabilitySnapshot(), null, 2));
      },
    },
    {
      name: 'reset',
      description: 'Reset metrics',
      handler: async () => {
        console.log('Resetting metrics...');
      },
    },
  ],
};

function createPipeline(): Pipeline {
  const config = new GAgentConfig();
  return new Pipeline(new ToolRegistry(config), config);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
