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

    // PIIRedactor.redact() expects a RawMessage; for plain-text use redactText().
    // Align defaults with the documented PII categories: phones/emails and
    // locations are redacted by default. Names are redacted when a known-names
    // list is supplied (regex-only redaction cannot reliably detect arbitrary
    // names without an NER model — see issue #52).
    const knownNames = (process.env.GAGENT_PII_KNOWN_NAMES || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    this.redactor = options.piiProtection !== false
      ? new PIIRedactor({
          redact_phone_numbers: true,
          redact_names: knownNames.length > 0,
          redact_locations: true,
          hash_contact_ids: false,
          knownNames,
        })
      : null;

    // EthicalRefusalClassifier requires an LLMClient instance
    this.ethicsClassifier = options.ethicsGuard !== false
      ? new EthicalRefusalClassifier(this.llmClient)
      : null;
  }

  async execute(task: string): Promise<{ output: string; cost_usd: number; safe: boolean; error?: string }> {
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

    // 3. Execute via LLM. Never assert safe:true when the call failed — a
    //    failure means no safe output was produced. Surface the cause so callers
    //    can distinguish a real empty answer from an outage/auth/budget error.
    try {
      const result = await this.llmClient.call(safeTask, { model: this.model });
      return { output: result.content, cost_usd: result.cost_usd, safe: true };
    } catch (error) {
      return {
        output: '',
        cost_usd: 0,
        safe: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export { PIIRedactor, EthicalRefusalClassifier, LLMClient };
