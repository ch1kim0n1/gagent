import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LLMClient } from '../src/core/llm-client';

describe('LLMClient cost persistence', () => {
  it('persists aggregate cost, token, and call metrics across instances', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gagent-llm-metrics-'));
    const metricsPath = path.join(dir, 'llm-metrics.json');
    const client = new LLMClient({
      openaiApiKey: 'test-key',
      defaultModel: 'gpt-4o-mini',
      enableModelFallback: false,
      metricsPersistencePath: metricsPath,
    });

    (client as any).openaiClient = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          } as never),
        },
      },
    };

    await client.call('Return JSON');
    const reloaded = new LLMClient({ metricsPersistencePath: metricsPath });

    expect(reloaded.getCallCount()).toBe(1);
    expect(reloaded.getTotalTokens()).toBe(120);
    expect(reloaded.getTotalCostUsd()).toBeGreaterThan(0);
  });
});
