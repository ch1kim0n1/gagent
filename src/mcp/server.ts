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

export async function startMcpServer(
  registry: ToolRegistry,
  config: GAgentConfig,
  port?: string
): Promise<void> {
  const pipeline = new Pipeline(registry, config);

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
      name: 'gagent_config_set',
      description: 'Set GAgent configuration value',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Configuration key (dot notation)',
          },
          value: {
            type: 'any',
            description: 'Value to set',
          },
        },
        required: ['key', 'value'],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

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

          const { promisify } = await import('util');
          const { exec } = await import('child_process');
          const execAsync = promisify(exec);

          const { stdout } = await execAsync(`gbrain query "${args.query}" --json`);
          return {
            content: [
              {
                type: 'text',
                text: stdout,
              },
            ],
          };
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
    console.log(`Starting HTTP MCP server on port ${port}...`);
    // HTTP transport would be implemented here
    throw new Error('HTTP mode not yet implemented');
  } else {
    // Stdio server mode (for Claude Code)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log('GAgent MCP server running on stdio');
  }
}
