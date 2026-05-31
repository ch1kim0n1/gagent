import { describe, it, expect } from '@jest/globals';
import { AgentSDK } from '../src/sdk';

// Regression for #50: SDK.execute must NOT report safe:true when the LLM call fails.
describe('AgentSDK.execute error handling', () => {
  it('surfaces LLM failures as safe:false with an error, not a silent empty success', async () => {
    const sdk = new AgentSDK({
      apiKey: 'sk-invalid-key-for-test',
      piiProtection: false,
      ethicsGuard: false,
    });

    // Force the underlying client to fail deterministically.
    (sdk as any).llmClient = {
      call: async () => {
        throw new Error('simulated provider outage');
      },
    };

    const result = await sdk.execute('hello');
    expect(result.safe).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toContain('simulated provider outage');
  });

  it('reports safe:true only when the call actually succeeds', async () => {
    const sdk = new AgentSDK({ apiKey: 'sk-test', piiProtection: false, ethicsGuard: false });
    (sdk as any).llmClient = {
      call: async () => ({ content: 'ok', cost_usd: 0.01 }),
    };
    const result = await sdk.execute('hello');
    expect(result.safe).toBe(true);
    expect(result.output).toBe('ok');
    expect(result.error).toBeUndefined();
  });
});
