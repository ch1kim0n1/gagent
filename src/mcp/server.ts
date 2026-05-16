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
import { GBrainIntegrationClient } from '../core/gbrain-integration.js';
import { createAuthMiddleware } from '@gstack/shared/core';
import { LocalAuditLogger, LocalLogger, type LogLevel } from '../core/observability.js';
import { getDefaultSecretManager, PermissionModel } from '../core/security.js';

const logger = new LocalLogger('gagent-mcp-server', (process.env.GAGENT_LOG_LEVEL as LogLevel) || 'INFO');

type McpScope = 'read' | 'write';

interface RateWindow {
  minuteCount: number;
  minuteStart: number;
  hourCount: number;
  hourStart: number;
}

export async function startMcpServer(
  registry: ToolRegistry,
  config: GAgentConfig,
  port?: string
): Promise<void> {
  const pipeline = new Pipeline(registry, config);
  const secrets = getDefaultSecretManager();
  const permissions = PermissionModel.loadDefault();
  const securityAudit = new LocalAuditLogger('gagent');
  
  const gbrainEndpoint = process.env.GBRAIN_ENDPOINT || 'http://localhost:3000';
  const gbrainClient = new GBrainIntegrationClient({
    endpoint: gbrainEndpoint,
  });

  // Initialize authentication middleware
  const authMiddleware = createAuthMiddleware({
    secret: secrets.get('gagent_auth_secret') || 'dev-secret-key',
    tool: 'gagent',
    defaultRoles: parseScopes(process.env.GAGENT_MCP_DEFAULT_SCOPES || 'read,write'),
  });
  const requireAuth = process.env.GAGENT_REQUIRE_AUTH === 'true';
  const allowAnonymousRead = process.env.GAGENT_ALLOW_ANONYMOUS_READ !== 'false';
  const bootstrapToken = secrets.get('gagent_mcp_token');
  const bootstrapScopes = parseScopes(process.env.GAGENT_MCP_TOKEN_SCOPES || 'read,write');
  const rateLimitRpm = parseLimit(process.env.GAGENT_RATE_LIMIT_RPM, 60);
  const rateLimitRph = parseLimit(process.env.GAGENT_RATE_LIMIT_RPH, 1000);
  const rateWindows = new Map<string, RateWindow>();

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
            description: 'Configuration value',
          },
        },
        required: ['key', 'value'],
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
      name: 'gagent_get_models',
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
      name: 'gagent_get_tier_metrics',
      description: 'Get tier configuration, model mapping, and escalation metrics',
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
    const requiredScope = requiredScopeForTool(name);
    const auth = authorize(request.params._meta, requiredScope);
    if (!auth.ok) {
      securityAudit.logSecurityEvent({
        event: 'mcp_auth_denied',
        target: name,
        scope: requiredScope,
        success: false,
        error: auth.error,
      });
      return errorResponse(auth.error);
    }

    const rateLimit = checkRateLimit(auth.token);
    if (!rateLimit.allowed) {
      securityAudit.logSecurityEvent({
        event: 'mcp_rate_limited',
        actor: tokenLabel(auth.token),
        target: name,
        scope: requiredScope,
        success: false,
        metadata: { reset_at: rateLimit.resetAt },
      });
      return errorResponse(`Rate limit exceeded. Reset at ${rateLimit.resetAt}`);
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
            const response = await gbrainClient.searchContext(args.query as string);
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
          await config.set(args.key as string, args.value);
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

        case 'gagent_get_models': {
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

        case 'gagent_get_tier_metrics': {
          const tierMetrics = pipeline.getTierMetrics();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(tierMetrics, null, 2),
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
      return errorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  function authorize(meta: Record<string, unknown> | undefined, requiredScope: McpScope) {
    const authHeaderRaw = meta?.authorization;
    const authHeader = typeof authHeaderRaw === 'string' ? authHeaderRaw : '';

    if (!authHeader) {
      if (!requireAuth && requiredScope === 'read' && allowAnonymousRead) {
        return { ok: true as const, token: 'anonymous-read' };
      }
      return { ok: false as const, error: `Authentication failed: missing bearer token for ${requiredScope} scope` };
    }

    const auth = authMiddleware.authenticate(authHeader);
    if (!auth.success) {
      return { ok: false as const, error: `Authentication failed: ${auth.error}` };
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');
    const scopes = scopesForToken(token, auth.token?.roles || []);
    if (!scopes.includes(requiredScope)) {
      return { ok: false as const, error: `Insufficient permissions: requires ${requiredScope} scope` };
    }

    return { ok: true as const, token };
  }

  function scopesForToken(token: string, fallbackRoles: string[]): McpScope[] {
    if (bootstrapToken && token === bootstrapToken) {
      return permissions.scopesForToken(token, bootstrapScopes).filter((scope): scope is McpScope => scope === 'read' || scope === 'write');
    }
    if (bootstrapToken) {
      return [];
    }
    const fallback = parseScopes(fallbackRoles.join(','));
    return permissions.scopesForToken(token, fallback).filter((scope): scope is McpScope => scope === 'read' || scope === 'write');
  }

  function requiredScopeForTool(name: string): McpScope {
    const writeTools = new Set(['gagent_run', 'gagent_config_set']);
    return writeTools.has(name) ? 'write' : 'read';
  }

  function checkRateLimit(token: string) {
    const now = Date.now();
    const minuteMs = 60 * 1000;
    const hourMs = 60 * 60 * 1000;
    let window = rateWindows.get(token);
    if (!window) {
      window = { minuteCount: 0, minuteStart: now, hourCount: 0, hourStart: now };
      rateWindows.set(token, window);
    }
    if (now - window.minuteStart >= minuteMs) {
      window.minuteStart = now;
      window.minuteCount = 0;
    }
    if (now - window.hourStart >= hourMs) {
      window.hourStart = now;
      window.hourCount = 0;
    }
    if (window.minuteCount >= rateLimitRpm || window.hourCount >= rateLimitRph) {
      const resetAt = new Date(Math.min(window.minuteStart + minuteMs, window.hourStart + hourMs)).toISOString();
      return { allowed: false, resetAt };
    }
    window.minuteCount++;
    window.hourCount++;
    return { allowed: true, resetAt: new Date(window.minuteStart + minuteMs).toISOString() };
  }

  function errorResponse(text: string) {
    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
      isError: true,
    };
  }

  function tokenLabel(token: string): string {
    return token === 'anonymous-read' ? token : `token:${authMiddleware.getAuth().hashToken(token)}`;
  }

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

function parseScopes(value: string): McpScope[] {
  const scopes = value
    .split(',')
    .map(scope => scope.trim())
    .filter((scope): scope is McpScope => scope === 'read' || scope === 'write');
  return scopes.length > 0 ? scopes : ['read'];
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
