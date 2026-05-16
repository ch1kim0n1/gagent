import {
  DetectorName,
  DetectorOutput,
  DyadAnalysisResult,
  DyadAnalysisTask,
  RefusalClassifierResult,
} from '../types/index.js';
import { LLMClient } from '../core/llm-client.js';
import { EthicalRefusalClassifier } from '../core/ethical-refusal-classifier.js';

export class DyadCostHardGateError extends Error {
  constructor(
    message: string,
    readonly actualCostUsd: number,
    readonly maxCostUsd: number,
    readonly partialResults: DetectorOutput[],
  ) {
    super(message);
  }
}

const DETECTOR_PROMPTS: Record<DetectorName, string> = {
  emotion_labeling: 'Label participant emotions using cautious, non-diagnostic relationship-science language.',
  bid_classification: 'Classify bids for connection, attention, affection, support, and responses toward/away/against.',
  repair_detection: 'Detect repair attempts and likely repair windows without assigning blame.',
  labor_asymmetry: 'Estimate emotional labor balance while avoiding one-sided blame.',
  phantom_third_party: 'Detect absent third-party influence, comparison language, and triangulation signals.',
  predictive_divergence: 'Compare likely trajectories when bids are ignored versus acknowledged.',
};

export class DyadAnalysisHandler {
  private readonly refusalClassifier: EthicalRefusalClassifier;

  constructor(
    private readonly llmClient: Pick<LLMClient, 'call'>,
    refusalClassifier?: EthicalRefusalClassifier,
  ) {
    this.refusalClassifier = refusalClassifier || new EthicalRefusalClassifier(llmClient as LLMClient);
  }

  async execute(task: DyadAnalysisTask): Promise<DyadAnalysisResult> {
    const started = Date.now();
    const draftInsight = `Analyze ${task.parameters.detectors.join(', ')} for this redacted relationship window.`;
    const refusal = await this.refusalClassifier.classify({
      message_window: task.parameters.message_window,
      proposed_insight: draftInsight,
      insight_type: task.parameters.detectors[0],
    });

    if (refusal.should_refuse) {
      return this.buildRefusalResult(task, refusal, started);
    }

    const detectorResults: DetectorOutput[] = [];
    let totalCostUsd = 0;

    try {
      for (const detector of task.parameters.detectors) {
        const output = await this.runDetector(task, detector);
        detectorResults.push(output);
        totalCostUsd += output.cost_usd;
        this.enforceBudget(task, totalCostUsd, detectorResults);
      }
    } catch (error) {
      if (error instanceof DyadCostHardGateError) {
        return {
          dyad_id: task.parameters.dyad_id,
          detector_results: error.partialResults,
          cost_usd: error.actualCostUsd,
          latency_ms: Date.now() - started,
          partial_result: true,
          budget_error: {
            message: error.message,
            actual_cost_usd: error.actualCostUsd,
            max_cost_usd: error.maxCostUsd,
          },
        };
      }
      throw error;
    }

    return {
      dyad_id: task.parameters.dyad_id,
      detector_results: detectorResults,
      cost_usd: totalCostUsd,
      latency_ms: Date.now() - started,
    };
  }

  private async runDetector(task: DyadAnalysisTask, detector: DetectorName): Promise<DetectorOutput> {
    const prompt = `${DETECTOR_PROMPTS[detector]}
Return strict JSON with fields: result, confidence.
dyad_id: ${task.parameters.dyad_id}
time_range: ${JSON.stringify(task.parameters.time_range)}
messages: ${JSON.stringify(task.parameters.message_window)}`;

    const response = await this.llmClient.call(prompt, {
      temperature: 0.2,
      maxTokens: 1000,
    });

    let parsed: { result?: Record<string, unknown>; confidence?: number };
    try {
      parsed = JSON.parse(response.content);
    } catch {
      parsed = {
        result: { text: response.content },
        confidence: 0.5,
      };
    }

    return {
      detector,
      dyad_id: task.parameters.dyad_id,
      result: parsed.result || { text: response.content },
      confidence: clamp01(Number(parsed.confidence ?? 0.5)),
      model_used: response.model_id,
      cost_usd: response.cost_usd,
      latency_ms: response.latency_ms,
    };
  }

  private buildRefusalResult(
    task: DyadAnalysisTask,
    refusal: RefusalClassifierResult,
    started: number,
  ): DyadAnalysisResult {
    return {
      dyad_id: task.parameters.dyad_id,
      detector_results: [],
      ethical_refusal: refusal,
      cost_usd: 0,
      latency_ms: Date.now() - started,
    };
  }

  private enforceBudget(task: DyadAnalysisTask, totalCostUsd: number, partialResults: DetectorOutput[]): void {
    const maxCostUsd = task.budget?.max_cost_usd;
    if (maxCostUsd === undefined) {
      return;
    }
    if (totalCostUsd > maxCostUsd) {
      throw new DyadCostHardGateError(
        `Cost hard gate: $${totalCostUsd.toFixed(4)} exceeds budget $${maxCostUsd.toFixed(4)}`,
        totalCostUsd,
        maxCostUsd,
        partialResults,
      );
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

