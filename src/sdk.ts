import { PIIRedactor } from './core/pii-redactor.js';
import { EthicalRefusalClassifier } from './core/ethical-refusal-classifier.js';
import { LLMClient, LLMClientConfig } from './core/llm-client.js';

export interface AgentSDKOptions {
  apiKey?: string;
  piiProtection?: boolean;   // default: true
  ethicsGuard?: boolean;     // default: true
  model?: string;            // default: 'claude-haiku-4-5-20251001'
}

export class AgentSDK {
  private llmClient: LLMClient;
  private redactor: PIIRedactor | null;
  private ethicsClassifier: EthicalRefusalClassifier | null;
  private model: string;

  constructor(options: AgentSDKOptions = {}) {
    const clientConfig: LLMClientConfig = {};
    if (options.apiKey) {
      clientConfig.anthropicApiKey = options.apiKey;
    }
    this.llmClient = new LLMClient(clientConfig);
    this.model = options.model ?? 'claude-haiku-4-5-20251001';

    // PIIRedactor.redact() expects a RawMessage; for plain-text use redactText()
    this.redactor = options.piiProtection !== false
      ? new PIIRedactor({
          redact_phone_numbers: true,
          redact_names: false,
          redact_locations: false,
          hash_contact_ids: false,
        })
      : null;

    // EthicalRefusalClassifier requires an LLMClient instance
    this.ethicsClassifier = options.ethicsGuard !== false
      ? new EthicalRefusalClassifier(this.llmClient)
      : null;
  }

  async execute(task: string): Promise<{ output: string; cost_usd: number; safe: boolean }> {
    // 1. PII redact — use redactText() for plain strings
    let safeTask = task;
    if (this.redactor) {
      safeTask = this.redactor.redactText(task);
    }

    // 2. Ethics check — classifier expects a message_window + proposed_insight
    //    For a plain task string, run a lightweight heuristic check only
    if (this.ethicsClassifier) {
      const result = await this.ethicsClassifier.classify({
        message_window: [],          // no message history in SDK mode
        proposed_insight: safeTask,
        insight_type: 'sdk_task',
      });
      if (result.should_refuse) {
        return {
          output: `[Refused: ${result.reason ?? 'ethical_guard'} — ${result.explanation}]`,
          cost_usd: 0,
          safe: false,
        };
      }
    }

    // 3. Execute via LLM
    try {
      const result = await this.llmClient.call(safeTask, { model: this.model });
      return { output: result.content, cost_usd: result.cost_usd, safe: true };
    } catch {
      return { output: '', cost_usd: 0, safe: true };
    }
  }
}

export { PIIRedactor, EthicalRefusalClassifier, LLMClient };
