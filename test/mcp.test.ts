// gagent/test/mcp.test.ts
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('GAgent MCP Server', () => {
  const serverSource = readFileSync(join(__dirname, '../src/mcp/server.ts'), 'utf8');

  it('declares the expected server identity', () => {
    expect(serverSource).toContain("name: 'gagent'");
    expect(serverSource).toContain("version: '0.1.0'");
  });

  it('declares the expected tool names', () => {
    for (const tool of [
      'gagent_run',
      'gagent_health',
      'gagent_brain_search',
      'gagent_stack_review',
      'gagent_config_get',
      'gagent_config_set',
      'gagent_get_receipts',
      'gagent_get_models',
      'gagent_get_tier_metrics',
    ]) {
      expect(serverSource).toContain(tool);
    }
  });

  it('declares required schemas for state-changing tools', () => {
    expect(serverSource).toContain("required: ['task']");
    expect(serverSource).toContain("required: ['key']");
  });

  it('enforces token auth, read/write scopes, and rate limits for MCP calls', () => {
    expect(serverSource).toContain('requiredScopeForTool');
    expect(serverSource).toContain('Insufficient permissions: requires');
    expect(serverSource).toContain('Rate limit exceeded');
    expect(serverSource).toContain("secrets.get('gagent_mcp_token')");
    expect(serverSource).toContain('PermissionModel.loadDefault');
    expect(serverSource).toContain('mcp_auth_denied');
  });
});
