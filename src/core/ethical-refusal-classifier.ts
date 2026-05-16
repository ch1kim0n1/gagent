import {
  RedactedMessage,
  RefusalClassifierResult,
  RefusalReason,
  RefusalClassifierResultSchema,
} from '../types/index.js';
import { LLMClient } from './llm-client.js';

export interface EthicalRefusalClassifierInput {
  message_window: RedactedMessage[];
  proposed_insight: string;
  insight_type: string;
}

export class EthicalRefusalClassifier {
  constructor(private readonly llmClient: Pick<LLMClient, 'call'>) {}

  async classify(input: EthicalRefusalClassifierInput): Promise<RefusalClassifierResult> {
    const heuristic = this.heuristic(input);
    const prompt = this.buildPrompt(input);

    try {
      const response = await this.llmClient.call(prompt, {
        temperature: 0,
        maxTokens: 500,
      });
      const parsed = RefusalClassifierResultSchema.parse(JSON.parse(response.content));
      return parsed.should_refuse || !heuristic.should_refuse
        ? parsed
        : heuristic;
    } catch {
      return heuristic;
    }
  }

  private heuristic(input: EthicalRefusalClassifierInput): RefusalClassifierResult {
    const joined = [
      input.proposed_insight,
      ...input.message_window.map(message => message.text),
    ].join('\n').toLowerCase();

    const rules: Array<[RegExp, RefusalReason, string]> = [
      [/\b(under\s*18|i'?m\s*(1[0-7])\b|high school|my parents|minor)\b/i, 'minor_detected', 'The message window may include a minor.'],
      [/\b(always|never|fault|responsible for|to blame)\b/i, 'blame_assignment', 'The proposed insight uses one-sided blaming language.'],
      [/\b(leave (him|her|them)|break up|diagnos|medical|therapy prescription)\b/i, 'out_of_scope', 'The proposed insight moves into advice or clinical diagnosis.'],
      [/\b(must|have to|only choice|make them|force)\b/i, 'coercive_framing', 'The proposed insight could pressure the user into a specific action.'],
    ];

    if (input.message_window.length < 10) {
      return {
        should_refuse: true,
        reason: 'insufficient_data',
        confidence: 0.9,
        explanation: 'Fewer than 10 messages were provided, so the relationship pattern is underdetermined.',
      };
    }

    for (const [pattern, reason, explanation] of rules) {
      if (pattern.test(joined)) {
        return { should_refuse: true, reason, confidence: 0.85, explanation };
      }
    }

    return {
      should_refuse: false,
      confidence: 0.7,
      explanation: 'No ethical refusal rule matched the redacted message window or proposed insight.',
    };
  }

  private buildPrompt(input: EthicalRefusalClassifierInput): string {
    return `You are the final safety classifier for relationship-analysis insights.
Return strict JSON only with fields: should_refuse, reason, confidence, explanation.
Reasons allowed: minor_detected, blame_assignment, out_of_scope, insufficient_data, coercive_framing.

Refuse when:
1. Any participant may be under 18.
2. The insight pathologizes normal behavior or assigns blame to one party.
3. The insight recommends leaving the relationship, makes medical claims, or diagnoses a person.
4. There is insufficient evidence to surface the insight.
5. The framing could coerce the user into a specific action.

Insight type: ${input.insight_type}
Proposed insight: ${input.proposed_insight}
Redacted messages:
${JSON.stringify(input.message_window, null, 2)}`;
  }
}

