import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { GAgentConfig } from '../config/manager.js';
import { Pipeline } from '../pipeline/orchestrator.js';
import {
  GBrainClient,
  GBrainClientConfig,
  GBrainClientError,
} from '../../../shared/src/core/gbrain-client.js';
import { createAuthMiddleware } from '../../../shared/src/core/token-auth.js';
import { StructuredLogger } from '../../../shared/src/observability/structured-logger.js';

const logger = new StructuredLogger('gagent-mcp-server');

export async function startMcpServer(
  registry: ToolRegistry,
  config: GAgentConfig,
  port?: string
): Promise<void> {
  const pipeline = new Pipeline(registry, config);
  
  const gbrainEndpoint = process.env.GBRAIN_ENDPOINT || 'http://localhost:3000';
  const gbrainClient = new GBrainClient({
    baseUrl: gbrainEndpoint,
    timeoutMs: 30000,
    maxRetries: 3,
  });

  // Initialize authentication middleware
  const authSecret = process.env.GAGENT_AUTH_SECRET || 'dev-secret-key';
  const authMiddleware = createAuthMiddleware({
    secret: authSecret,
    tool: 'gagent',
    defaultRoles: ['read', 'write'],
  });

  const server = new Server(
    {
      name: 'gagent',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define available tools
  const tools: Tool[] = [
    {
      name: 'gagent_run',
      description: 'Execute a task through the GAgent pipeline',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task to execute',
          },
          parallel: {
            type: 'number',
            description: 'Number of parallel attempts (default: 1)',
            default: 1,
          },
          verify: {
            type: 'boolean',
            description: 'Run GMirror verification',
            default: false,
          },
          cognitive_check: {
            type: 'boolean',
            description: 'Run GToM authenticity check',
            default: false,
          },
          learn: {
            type: 'boolean',
            description: 'Capture to GLearn',
            default: false,
          },
          full: {
            type: 'boolean',
            description: 'Run full pipeline (parallel + verify + check + learn)',
            default: false,
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'gagent_health',
      description: 'Check health of all tools in the stack',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'gagent_brain_search',
      description: 'Search GBrain memory',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'gagent_stack_review',
      description: 'Run GStack code review',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to review',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'gagent_config_get',
      description: 'Get GAgent configuration value',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Configuration key (dot notation)',
          },
        },
        required: ['key'],
      },
    },
    {
      name: 'gagent_get_receipts',
      description: 'Get execution receipts from the receipt registry',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of receipts to return',
          },
          offset: {
            type: 'number',
            description: 'Offset for pagination',
          },
          startDate: {
            type: 'string',
            description: 'Start date for filtering (ISO 8601)',
          },
          endDate: {
            type: 'string',
            description: 'End date for filtering (ISO 8601)',
          },
        },
      },
    },
    {
      name: 'gagent_get_drift',
      description: 'Get drift statistics for metrics',
      inputSchema: {
        type: 'object',
        properties: {
          metricName: {
            type: 'string',
            description: 'Specific metric name to check (optional)',
          },
        },
      },
    },
    {
      name: 'gagent_get_cost_stats',
      description: 'Get cost statistics from the cost ledger',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'gagent_models',
      description: 'List available models in the registry',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'gagent_tier',
      description: 'Get tier configuration',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'gagent_registry',
      description: 'Get tool registry information',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Authentication check (for MVP, this is a no-op since stdio servers authenticate at process level)
    // In production with HTTP transport, this would validate the Authorization header
    const authHeaderRaw = request.params._meta?.authorization;
      const authHeader = typeof authHeaderRaw === "string" ? authHeaderRaw : "";
    if (authHeader) {
      const auth = authMiddleware.authenticate(authHeader);
      if (!auth.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Authentication failed: ${auth.error}`,
            },
          ],
          isError: true,
        };
      }
    }

    try {
      switch (name) {
        case 'gagent_run': {
          const result = await pipeline.execute({
            task: args.task as string,
            parallel: (args.parallel as number) || 1,
            verify: (args.verify as boolean) || (args.full as boolean) || false,
            cognitiveCheck: (args.cognitive_check as boolean) || (args.full as boolean) || false,
            learn: (args.learn as boolean) || (args.full as boolean) || false,
            dryRun: false,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'gagent_health': {
          const health = await registry.healthCheck();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(health, null, 2),
              },
            ],
          };
        }

        case 'gagent_brain_search': {
          if (!config.isToolEnabled('gbrain')) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'GBrain not enabled',
                },
              ],
              isError: true,
            };
          }

          try {
            const response = await gbrainClient.restClient.searchPages(args.query as string);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(response, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `GBrain search failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'gagent_stack_review': {
          if (!config.isToolEnabled('gstack')) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'GStack not enabled',
                },
              ],
              isError: true,
            };
          }

          // Delegate to gstack
          return {
            content: [
              {
                type: 'text',
                text: `Run /review on ${args.path} in Claude Code with GStack loaded`,
              },
            ],
          };
        }

        case 'gagent_config_get': {
          const value = config.get(args.key as string);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(value, null, 2),
              },
            ],
          };
        }

        case 'gagent_config_set': {
          config.set(args.key as string, args.value);
          await config.save();
          return {
            content: [
              {
                type: 'text',
                text: `Set ${args.key} = ${JSON.stringify(args.value)}`,
              },
            ],
          };
        }

        case 'gagent_get_receipts': {
          const receipts = await pipeline.getReceipts(args as any);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(receipts, null, 2),
              },
            ],
          };
        }

        case 'gagent_get_drift': {
          const drift = await pipeline.getDrift(args.metricName as string);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(drift, null, 2),
              },
            ],
          };
        }

        case 'gagent_get_cost_stats': {
          const stats = pipeline.getCostStats();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        }

        case 'gagent_models': {
          const models = pipeline.getModels();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(models, null, 2),
              },
            ],
          };
        }

        case 'gagent_tier': {
          const tier = pipeline.getTierConfig();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(tier, null, 2),
              },
            ],
          };
        }

        case 'gagent_registry': {
          const registry = pipeline.getRegistryInfo();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(registry, null, 2),
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  if (port) {
    // HTTP server mode
    logger.info(`Starting HTTP MCP server on port ${port}`);
    // HTTP transport would be implemented here
    throw new Error('HTTP mode not yet implemented');
  } else {
    // Stdio server mode (for Claude Code)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('GAgent MCP server running on stdio');
  }
}
