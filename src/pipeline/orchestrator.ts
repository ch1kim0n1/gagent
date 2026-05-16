import * as crypto from 'crypto';
import { BudgetExceededError } from '../core/errors.js';
import * as os from 'os';
import * as path from 'path';
const uuidv4 = (): string => crypto.randomUUID();
import { ToolRegistry } from '../tools/registry.js';
import { GAgentConfig } from '../config/manager.js';
import { ReceiptRegistry } from '../core/receipt-registry.js';
import { GAgentPersistenceManager } from '../core/gagent-persistence.js';
import { ExecutionReceipt } from '../types/quality-rubric.js';
import {
  MultiModelConfig,
  EscalationMetrics,
  TierConfig,
  ModelTier,
  DyadAnalysisTask,
  DyadAnalysisTaskSchema,
  DyadAnalysisResult,
} from '../types/index.js';
import {
  LLMClient,
  LLMClientConfig,
  LLMCallResult,
} from '../core/llm-client.js';
import { BudgetLedger } from '../core/budget-ledger.js';
import {
  GBrainIntegrationClient,
  GBrainIntegrationConfig,
} from '../core/gbrain-integration.js';
import { DriftDetector } from '@gstack/shared/core';
import { LatencyTracker } from '@gstack/shared/core';
import { HealthCheckResult } from '@gstack/shared/health';
import { GAgentObservability, LocalAuditLogger, LocalLogger, coreLogger } from '../core/observability.js';
import { ProgressEvent, TaskBackpressureLimiter, TTLCache } from '../core/performance.js';
import { DyadAnalysisHandler } from '../handlers/dyad-analysis-handler.js';
import { PIIRedactor } from '../core/pii-redactor.js';
import { EthicalRefusalClassifier } from '../core/ethical-refusal-classifier.js';

const logger = coreLogger;

interface PipelineOptions {
  task: string;
  parallel: number;
  verify: boolean;
  cognitiveCheck: boolean;
  learn: boolean;
  dryRun: boolean;
  budgetUsd?: number;
  cycles?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

interface AttemptResult {
  id: string;
  output: string;
  score?: number;
  verification?: {
    passed: boolean;
    score: number;
    issues: string[];
  };
  cognitiveCheck?: {
    authentic: boolean;
    score: number;
    concerns: string[];
  };
}

interface PipelineResult {
  success: boolean;
  winner?: AttemptResult;
  attempts?: AttemptResult[];
  error?: string;
  dyad_result?: DyadAnalysisResult;
  partial_result?: unknown[];
  cost_usd?: number;
}

interface ConsensusVote {
  tier: ModelTier;
  model_id: string;
  winnerIndex?: number;
  confidence?: number;
  dimensions: Record<string, number>;
  reasoning?: string;
  disqualified: boolean;
  disqualification_reason?: string;
}

interface DimensionAgreement {
  participating_models: number;
  agreement: number;
  wilson_95_ci: { lower: number; upper: number };
  small_sample_note: boolean;
  values: Record<string, number>;
}

interface ConsensusSummary {
  winnerIndex?: number;
  agreed: boolean;
  agreement_ratio: number;
  consensus_threshold: number;
  votes_required: number;
  valid_votes: number;
  tier3_invoked: boolean;
  early_stopped: boolean;
  small_sample_note: boolean;
  per_dimension_agreement: Record<string, DimensionAgreement>;
  votes: ConsensusVote[];
}

const CONSENSUS_DIMENSIONS = ['correctness', 'completeness', 'reliability', 'safety'];

export class Pipeline {
  private registry: ToolRegistry;
  private config: GAgentConfig;
  private receiptRegistry: ReceiptRegistry;
  private persistenceManager: GAgentPersistenceManager;
  private multiModelConfig: MultiModelConfig;
  private tierConfigs: Map<string, TierConfig>;
  private escalationMetrics: EscalationMetrics;
  private llmClient: LLMClient;
  private gbrainClient: GBrainIntegrationClient;
  private driftDetector: DriftDetector;
  private budgetLedger: BudgetLedger;
  private budgetLedgerReady: Promise<void>;
  private latencyTracker: LatencyTracker;
  private auditLogger: LocalAuditLogger;
  private logger: LocalLogger;
  private observability: GAgentObservability;
  private gbrainEndpoint: string;
  private gstackEndpoint: string;
  private gorchestratorEndpoint: string;
  private gmirrorEndpoint: string;
  private gtomEndpoint: string;
  private glearnEndpoint: string;
  private lastConsensusSummary?: ConsensusSummary;
  private taskLimiter: TaskBackpressureLimiter;
  private contextCache: TTLCache<string, any>;
  private maxConcurrency: number;
  private activeRunBudget?: { maxCostUsd: number; startCostUsd: number; partialResults: unknown[] };
  private warnedMissingBudget = false;
  private gorchestratorAvailable: boolean = true;
  private offlineMode: boolean = false;

  constructor(registry: ToolRegistry, config: GAgentConfig, multiModelConfig?: MultiModelConfig, llmConfig?: LLMClientConfig, gbrainConfig?: GBrainIntegrationConfig) {
    this.registry = registry;
    this.config = config;
    this.receiptRegistry = new ReceiptRegistry('gagent');
    this.persistenceManager = new GAgentPersistenceManager();
    
    this.gbrainEndpoint = process.env.GBRAIN_ENDPOINT || 'http://localhost:3000';
    this.gstackEndpoint = process.env.GSTACK_ENDPOINT || 'http://localhost:3001';
    this.gorchestratorEndpoint = process.env.GORCHESTRATOR_ENDPOINT || 'http://localhost:3002';
    this.gmirrorEndpoint = process.env.GMIRROR_ENDPOINT || 'http://localhost:3003';
    this.gtomEndpoint = process.env.GTOM_ENDPOINT || 'http://localhost:3004';
    this.glearnEndpoint = process.env.GLEARN_ENDPOINT || 'http://localhost:3005';
    this.maxConcurrency = Number(process.env.GAGENT_MAX_CONCURRENCY || '5');
    this.taskLimiter = new TaskBackpressureLimiter(this.maxConcurrency, Number(process.env.GAGENT_MAX_QUEUE_DEPTH || this.maxConcurrency * 4));
    this.contextCache = new TTLCache<string, any>(256, Number(process.env.GAGENT_CONTEXT_CACHE_TTL_MS || 5 * 60 * 1000));
    
    // Offline mode: bypass all service health checks and force direct LLM execution
    this.offlineMode = process.env.GAGENT_OFFLINE_MODE === 'true';
    if (!this.offlineMode) {
      // Initialize health check asynchronously
      this.checkGorchestratorHealth().then((available: boolean) => {
        this.gorchestratorAvailable = available;
        logger.info('GOrchestrator health check completed', { available });
      }).catch((error: unknown) => {
        logger.warn('GOrchestrator health check failed', { error: String(error) });
        this.gorchestratorAvailable = false;
      });
    }
    
    this.gbrainClient = new GBrainIntegrationClient({
      endpoint: this.gbrainEndpoint,
      ...gbrainConfig,
    });

    // Multi-model configuration with defaults
    this.multiModelConfig = multiModelConfig || {
      default_tier: 'tier1',
      escalation_enabled: true,
      escalation_triggers: {
        min_confidence: 0.7,
        min_quality_score: 0.5,
        max_ambiguity: 0.5,
      },
      consensus_threshold: 0.8,
      cost_budget_usd_per_hour: 20.0,
      allow_tier3: true,
    };

    // Tier configurations
    this.tierConfigs = new Map([
      ['tier1', { name: 'claude-haiku-4-5', model_id: 'anthropic/claude-haiku-4-5', cost_per_1k_tokens_usd: 0.001, avg_latency_ms: 500, use_case: 'Tool selection' }],
      ['tier2', { name: 'claude-sonnet-4-6', model_id: 'anthropic/claude-sonnet-4-6', cost_per_1k_tokens_usd: 0.003, avg_latency_ms: 2000, use_case: 'Execution planning when error rate high' }],
      ['tier3', { name: 'claude-opus-4-6', model_id: 'anthropic/claude-opus-4-6', cost_per_1k_tokens_usd: 0.015, avg_latency_ms: 5000, use_case: 'Critical execution planning' }],
    ]);

    this.driftDetector = new DriftDetector({
      window_size: 100,
      drift_threshold: 0.2,
      alert_threshold: 0.3,
    });
    this.observability = new GAgentObservability('gagent');
    this.auditLogger = this.observability.audit;
    this.logger = this.observability.logger;
    this.budgetLedger = new BudgetLedger({
      max_budget_usd: this.multiModelConfig.cost_budget_usd_per_hour,
      default_ttl_ms: 5 * 60 * 1000,
      scope_caps_usd: {
        pipeline: this.multiModelConfig.cost_budget_usd_per_hour,
      },
    }, 'gagent');
    this.budgetLedgerReady = this.budgetLedger.init().catch(error => {
      this.logger.warn('Budget ledger initialization failed', { error: String(error) });
    });
    this.llmClient = new LLMClient({
      ...llmConfig,
      metricsPersistencePath: llmConfig?.metricsPersistencePath
        || path.join(os.homedir(), '.gagent', 'audit', 'llm-metrics.json'),
    });
    this.latencyTracker = new LatencyTracker(1000);

    // Initialize escalation metrics
    this.escalationMetrics = {
      total_tasks: 0,
      escalated_tasks: 0,
      tier1_success_rate: 1,
      tier2_success_rate: 0,
      tier3_success_rate: 0,
      tier1_count: 0,
      tier2_count: 0,
      tier3_count: 0,
      avg_cost_per_task_usd: 0,
      avg_latency_ms: 0,
      tier1_avg_latency_ms: 0,
      tier2_avg_latency_ms: 0,
      tier3_avg_latency_ms: 0,
      consensus_agreement_rate: 0,
      budget_remaining_usd: this.multiModelConfig.cost_budget_usd_per_hour,
    };
    const persistedEscalationMetrics = this.persistenceManager.loadEscalationMetrics<EscalationMetrics>();
    if (persistedEscalationMetrics) {
      this.escalationMetrics = {
        ...this.escalationMetrics,
        ...persistedEscalationMetrics,
      };
    }
  }

  /**
   * Check if GOrchestrator is available
   */
  private async checkGorchestratorHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.gorchestratorEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Execute task directly via LLM (graceful degradation fallback)
   * Applies PII redaction and ethical refusal, returns receipt without external services
   */
  private async executeDirectly(task: string): Promise<AttemptResult[]> {
    this.logger.info('Executing task directly via LLM (graceful degradation)', { task });
    
    try {
      // Apply PII redaction before passing task to LLM
      const redactor = new PIIRedactor({
        redact_phone_numbers: true,
        redact_names: false,
        redact_locations: false,
        hash_contact_ids: false,
      });
      const sanitizedTask = redactor.redactText(task);

      // Call LLM directly
      const llmResult = await this.callBudgetedLLM('direct_execution', sanitizedTask, {
        model: this.llmClient.getModelByTier('tier2'),
        temperature: 0.7,
      });
      
      // Apply ethical refusal check on the sanitized task before executing
      const ethicsClassifier = new EthicalRefusalClassifier(this.llmClient);
      const refusal = await ethicsClassifier.classify({
        message_window: [{
          rowid: 0,
          text: sanitizedTask,
          participant_id: 'user',
          timestamp: new Date().toISOString(),
        }],
        proposed_insight: sanitizedTask,
        insight_type: 'direct_execution',
      });
      if (refusal.should_refuse) {
        throw new Error(`Ethical refusal (${refusal.reason}): ${refusal.explanation}`);
      }

      const attempt: AttemptResult = {
        id: `direct-${Date.now()}`,
        output: llmResult.content,
      };
      
      return [attempt];
    } catch (error) {
      this.logger.error('Direct LLM execution failed', { error: String(error) });
      throw new Error(`Direct execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  describe(options: PipelineOptions): string {
    const stages: string[] = [];
    
    stages.push(`1. Prime GBrain with context for: "${options.task}"`);
    
    if (options.parallel > 1) {
      stages.push(`2. GOrchestrator: Dispatch ${options.parallel} parallel attempts`);
    } else {
      stages.push(`2. GStack: Execute single attempt`);
    }
    
    if (options.verify) {
      stages.push(`3. GMirror: Test outputs against synthetic users`);
    }
    
    if (options.cognitiveCheck) {
      stages.push(`4. GToM: Validate decision authenticity`);
    }
    
    stages.push(`5. Select winner, write to GBrain`);
    
    if (options.learn) {
      stages.push(`6. GLearn: Capture pattern for future optimization`);
    }
    
    return stages.join('\n');
  }

  exportPrometheusMetrics(): string {
    return this.observability.metrics.prometheus();
  }

  exportOpenTelemetryMetrics(): Record<string, unknown> {
    return this.observability.metrics.openTelemetry();
  }

  getObservabilitySnapshot(): Record<string, unknown> {
    return this.observability.snapshot();
  }

  logShellJob(entry: {
    command: string;
    cwd?: string;
    exit_code?: number;
    duration_ms?: number;
    correlation_id?: string;
    trace_id?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  }): void {
    this.auditLogger.logShellJob(entry);
  }

  async execute(options: PipelineOptions): Promise<PipelineResult> {
    const start = performance.now();
    const span = this.observability.tracer.startSpan('GAgent.execute', {
      task: options.task,
      parallel: options.parallel,
      verify: options.verify,
      cognitive_check: options.cognitiveCheck,
      learn: options.learn,
    });
    const tier1StartTime = Date.now();
    const runStartCostUsd = this.llmClient.getTotalCostUsd();
    const releaseProcessingSlot = await this.taskLimiter.acquire(options.signal);
    const previousRunBudget = this.activeRunBudget;
    if (options.budgetUsd !== undefined) {
      this.activeRunBudget = {
        maxCostUsd: options.budgetUsd,
        startCostUsd: runStartCostUsd,
        partialResults: [],
      };
    } else {
      this.activeRunBudget = undefined;
      if (!this.warnedMissingBudget) {
        this.logger.warn('No per-run budget was supplied; cost hard gate enforcement is disabled for this run');
        this.warnedMissingBudget = true;
      }
    }
    this.emitProgress(options.onProgress, {
      phase: 'queued',
      message: 'Pipeline accepted by processing limiter',
      progress: 0.02,
      metadata: this.taskLimiter.getStats(),
    });
    try {
      this.throwIfCancelled(options.signal);
      // Check budget before execution
      if (options.budgetUsd !== undefined && this.escalationMetrics.budget_remaining_usd < options.budgetUsd) {
        const latencyMs = performance.now() - start;
        this.observability.metrics.recordPublicMethod('execute', latencyMs, 'error');
        this.auditLogger.logDecision({
          operation: 'execute',
          decision: 'budget_exceeded',
          trace_id: span.trace_id,
          success: false,
          latency_ms: latencyMs,
          error: `Budget exceeded: remaining $${this.escalationMetrics.budget_remaining_usd.toFixed(2)}, requested $${options.budgetUsd.toFixed(2)}`,
          metadata: {
            budget_remaining: this.escalationMetrics.budget_remaining_usd,
            requested_budget: options.budgetUsd,
          },
        });
        this.observability.tracer.endSpan(span, new Error('Budget exceeded before execution'));
        this.logger.error('Budget exceeded before execution', {
          budget_remaining: this.escalationMetrics.budget_remaining_usd,
          requested_budget: options.budgetUsd,
        });
        return {
          success: false,
          error: `Budget exceeded: remaining $${this.escalationMetrics.budget_remaining_usd.toFixed(2)}, requested $${options.budgetUsd.toFixed(2)}`,
        };
      }

      const dyadTask = this.tryParseDyadTask(options.task, options.budgetUsd);
      if (dyadTask) {
        const dyadResult = await new DyadAnalysisHandler(this.llmClient).execute(dyadTask);
        const output = JSON.stringify(dyadResult, null, 2);
        const runId = uuidv4();
        this.persistenceManager.addAgentRun({
          run_id: runId,
          task: options.task,
          output,
          exit_code: dyadResult.partial_result || dyadResult.ethical_refusal?.should_refuse ? 1 : 0,
          cost_usd: dyadResult.cost_usd,
          dyad_id: dyadTask.parameters.dyad_id,
          message_count: dyadTask.parameters.message_window.length,
        });
        const attempt = {
          id: 'dyad-analysis',
          output,
          score: dyadResult.partial_result || dyadResult.ethical_refusal?.should_refuse ? 0 : 1,
        };
        this.observability.tracer.endSpan(span, dyadResult.partial_result ? new Error('DYAD partial result') : undefined);
        return {
          success: !dyadResult.partial_result && !dyadResult.ethical_refusal?.should_refuse,
          winner: attempt,
          attempts: [attempt],
          dyad_result: dyadResult,
          cost_usd: dyadResult.cost_usd,
        };
      }

      // Stage 1: Prime
      this.emitProgress(options.onProgress, { phase: 'prime', message: 'Loading GBrain context', progress: 0.12 });
      const context = await this.primeBrain(options.task);
      this.throwIfCancelled(options.signal);

      // LLM-driven decision: Select execution strategy
      this.emitProgress(options.onProgress, { phase: 'plan', message: 'Selecting execution strategy', progress: 0.24 });
      const executionDecision = await this.llmDecisionExecutionStrategy(options.task, context);
      this.throwIfCancelled(options.signal);
      
      // Stage 2: Execute (Tier 1)
      this.emitProgress(options.onProgress, { phase: 'execute', message: 'Executing selected tool path', progress: 0.42, metadata: { maxConcurrency: this.maxConcurrency } });
      let attempts: AttemptResult[];
      if (executionDecision.parallel > 1) {
        attempts = await this.runParallel(options.task, executionDecision.parallel, context);
      } else {
        attempts = await this.runSingle(options.task, context);
      }

      // Track Tier 1 metrics
      this.escalationMetrics.total_tasks++;
      this.escalationMetrics.tier1_count++;
      const tier1Latency = Date.now() - tier1StartTime;
      this.escalationMetrics.tier1_avg_latency_ms = this.updateAverage(
        this.escalationMetrics.tier1_avg_latency_ms,
        this.escalationMetrics.tier1_count,
        tier1Latency
      );

      // Calculate error rate
      const errorRate = this.calculateErrorRate(attempts);

      // LLM-driven decision: Escalate to Tier 2
      if (
        this.multiModelConfig.escalation_enabled &&
        await this.llmDecisionEscalate(errorRate, attempts)
      ) {
        const tier2Config = this.tierConfigs.get('tier2');
        if (tier2Config && this.escalationMetrics.budget_remaining_usd > tier2Config.cost_per_1k_tokens_usd) {
          const tier2StartTime = Date.now();
          this.escalationMetrics.escalated_tasks++;
          this.escalationMetrics.tier2_count++;

          this.logger.info('Escalating to Tier 2 for execution planning', { tier: 'tier2' });

          // Re-run with improved planning
          if (executionDecision.parallel > 1) {
            attempts = await this.runParallel(options.task, executionDecision.parallel, context);
          } else {
            attempts = await this.runSingle(options.task, context);
          }

          const tier2Latency = Date.now() - tier2StartTime;
          this.escalationMetrics.tier2_avg_latency_ms = this.updateAverage(
            this.escalationMetrics.tier2_avg_latency_ms,
            this.escalationMetrics.tier2_count,
            tier2Latency
          );

          this.escalationMetrics.tier2_success_rate = this.escalationMetrics.tier2_count / this.escalationMetrics.escalated_tasks;
          this.escalationMetrics.budget_remaining_usd -= tier2Config.cost_per_1k_tokens_usd;

          // Check if Tier 3 escalation is needed after Tier 2
          const needsTier3Escalation = this.multiModelConfig.allow_tier3 &&
                                       this.escalationMetrics.budget_remaining_usd > this.tierConfigs.get('tier3')!.cost_per_1k_tokens_usd &&
                                       errorRate > 0.5; // High error rate persists after Tier 2

          if (needsTier3Escalation) {
            const tier3Config = this.tierConfigs.get('tier3');
            if (tier3Config) {
              const tier3StartTime = Date.now();
              this.escalationMetrics.tier3_count++;

              this.logger.info('Escalating to Tier 3 for critical execution planning', { tier: 'tier3' });

              // Re-run with Tier 3 premium model
              if (executionDecision.parallel > 1) {
                attempts = await this.runParallel(options.task, executionDecision.parallel, context);
              } else {
                attempts = await this.runSingle(options.task, context);
              }

              const tier3Latency = Date.now() - tier3StartTime;
              this.escalationMetrics.tier3_avg_latency_ms = this.updateAverage(
                this.escalationMetrics.tier3_avg_latency_ms,
                this.escalationMetrics.tier3_count,
                tier3Latency
              );

              this.escalationMetrics.tier3_success_rate = this.escalationMetrics.tier3_count / this.escalationMetrics.escalated_tasks;
              this.escalationMetrics.budget_remaining_usd -= tier3Config.cost_per_1k_tokens_usd;
            }
          }
        }
      } else {
        this.escalationMetrics.tier1_success_rate = this.escalationMetrics.tier1_count / this.escalationMetrics.total_tasks;
      }

      // LLM-driven decision: Verify
      const shouldVerify = await this.llmDecisionVerify(attempts);
      if (shouldVerify && options.verify) {
        this.emitProgress(options.onProgress, { phase: 'verify', message: 'Verifying attempts with GMirror', progress: 0.64 });
        for (const attempt of attempts) {
          this.throwIfCancelled(options.signal);
          attempt.verification = await this.verifyWithMirror(attempt);
        }
      }

      // LLM-driven decision: Cognitive check
      const shouldCheck = await this.llmDecisionCognitiveCheck(attempts);
      if (shouldCheck && options.cognitiveCheck) {
        this.emitProgress(options.onProgress, { phase: 'cognitive_check', message: 'Running GToM cognitive check', progress: 0.72 });
        for (const attempt of attempts) {
          this.throwIfCancelled(options.signal);
          attempt.cognitiveCheck = await this.checkWithToM(attempt);
        }
      }

      // Stage 5: Select winner
      this.emitProgress(options.onProgress, { phase: 'select', message: 'Selecting winning attempt', progress: 0.82 });
      const winner = await this.selectWinner(attempts, options);

      // Write to GBrain
      this.emitProgress(options.onProgress, { phase: 'persist', message: 'Persisting run evidence', progress: 0.9 });
      await this.recordToBrain(options.task, winner, attempts);

      // Stage 6: Learn (if enabled)
      if (options.learn) {
        this.emitProgress(options.onProgress, { phase: 'learn', message: 'Capturing learning signal', progress: 0.94 });
        await this.captureToLearn(options.task, winner, attempts);
      }

      // Generate and emit receipt
      const runCostUsd = Math.max(0, this.llmClient.getTotalCostUsd() - runStartCostUsd);
      const receipt = await this.generateReceipt(options, winner, attempts, runCostUsd);
      await this.receiptRegistry.append(receipt);

      // Store receipt in gbrain for quality control
      await this.storeReceiptInGBrain(receipt);

      // Persist agent run to SQLite
      const runId = receipt.receipt_id;
      const costUsd = receipt.cost_usd || 0;
      const exitCode = receipt.verdict === 'pass' ? 0 : 1;
      const output = winner?.output || '';
      this.persistenceManager.transaction(() => {
        this.persistenceManager.addAgentRun({
          run_id: runId,
          task: options.task,
          output: output,
          exit_code: exitCode,
          cost_usd: costUsd,
        });
        this.persistenceManager.saveEscalationMetrics(this.escalationMetrics);
      });

      const latencyMs = performance.now() - start;
      this.latencyTracker.record(latencyMs);
      this.observability.metrics.recordPublicMethod('execute', latencyMs, 'ok');
      this.auditLogger.logDecision({
        operation: 'execute',
        decision: 'success',
        correlation_id: runId,
        trace_id: span.trace_id,
        success: true,
        latency_ms: latencyMs,
        cost_usd: costUsd,
        metadata: {
          attempts: attempts.length,
          winner: winner?.id,
        },
      });
      this.observability.tracer.endSpan(span);
      this.emitProgress(options.onProgress, { phase: 'complete', message: 'Pipeline execution complete', progress: 1 });
      return {
        success: true,
        winner,
        attempts
      };

    } catch (error) {
      const latencyMs = performance.now() - start;
      this.latencyTracker.record(latencyMs);
      this.observability.metrics.recordPublicMethod('execute', latencyMs, 'error');
      this.auditLogger.logDecision({
        operation: 'execute',
        decision: 'error',
        trace_id: span.trace_id,
        success: false,
        latency_ms: latencyMs,
        cost_usd: Math.max(0, this.llmClient.getTotalCostUsd() - runStartCostUsd),
        error: error instanceof Error ? error.message : String(error),
      });
      this.observability.tracer.endSpan(span, error instanceof Error ? error : new Error(String(error)));
      this.persistenceManager.saveEscalationMetrics(this.escalationMetrics);
      if (options.signal?.aborted) {
        this.emitProgress(options.onProgress, { phase: 'cancelled', message: 'Pipeline execution cancelled', progress: 1 });
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        partial_result: (error as any)?.partialResults,
        cost_usd: (error as any)?.actualCostUsd,
      };
    } finally {
      this.activeRunBudget = previousRunBudget;
      releaseProcessingSlot();
    }
  }

  async *executeStream(options: PipelineOptions): AsyncGenerator<ProgressEvent | { phase: 'result'; result: PipelineResult }, void, unknown> {
    const events: ProgressEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    const resultPromise = this.execute({
      ...options,
      onProgress: (event) => {
        options.onProgress?.(event);
        events.push(event);
        notify?.();
      },
    }).then((result) => {
      done = true;
      notify?.();
      return result;
    }).catch((error) => {
      done = true;
      notify?.();
      throw error;
    });

    while (!done || events.length > 0) {
      if (events.length === 0) {
        await new Promise<void>(resolve => { notify = resolve; });
        notify = undefined;
        continue;
      }
      yield events.shift()!;
    }
    yield { phase: 'result', result: await resultPromise };
  }

  getTaskProcessingStats(): { active: number; queued: number; maxConcurrency: number; maxQueueDepth: number } {
    return this.taskLimiter.getStats();
  }

  private emitProgress(
    callback: ((event: ProgressEvent) => void) | undefined,
    event: Omit<ProgressEvent, 'timestamp'>,
  ): void {
    callback?.({ ...event, timestamp: new Date().toISOString() });
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Pipeline execution cancelled');
  }

  /**
   * LLM-driven decision: Select execution strategy
   */
  private async callBudgetedLLM(
    operation: string,
    prompt: string,
    options: { model: string; temperature?: number; maxTokens?: number },
  ): Promise<LLMCallResult> {
    await this.budgetLedgerReady;
    const budgetStatus = this.budgetLedger.getStatus();
    if (budgetStatus.remaining_budget <= 0) {
      throw new BudgetExceededError(`Cost hard gate: budget exceeded. Aborting task. Spent: $${budgetStatus.total_committed.toFixed(4)}, Max: $${budgetStatus.max_budget_usd.toFixed(4)}`);
    }
    const reserveUsd = Number(process.env.GAGENT_LLM_CALL_RESERVE_USD || '0.05');
    const ttlMs = Number(process.env.GAGENT_BUDGET_RESERVATION_TTL_MS || String(5 * 60 * 1000));
    const reservation = this.budgetLedger.reserve(operation, reserveUsd, ttlMs, {
      scope: 'pipeline',
      resolver: operation,
      model: options.model,
    });

    try {
      const result = await this.llmClient.call(prompt, options);
      await this.budgetLedger.commit(reservation.id, result.cost_usd, {
        model_id: result.model_id,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        operation,
        metadata: {
          scope: 'pipeline',
          resolver: operation,
        },
      });
      this.persistenceManager.transaction(() => {
        this.persistenceManager.addLlmCall({
          id: reservation.id,
          model_id: result.model_id,
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          cost_usd: result.cost_usd,
          operation,
          metadata: {
            scope: 'pipeline',
            resolver: operation,
          },
        });
        this.persistenceManager.addCostEntry({
          id: reservation.id,
          operation,
          model_id: result.model_id,
          cost_usd: result.cost_usd,
          metadata: {
            scope: 'pipeline',
            resolver: operation,
          },
        });
      });
      this.enforceActiveRunBudget(operation);
      return result;
    } catch (error) {
      this.budgetLedger.release(reservation.id);
      throw error;
    }
  }

  private enforceActiveRunBudget(operation: string): void {
    if (!this.activeRunBudget) {
      return;
    }
    const actualCostUsd = this.llmClient.getTotalCostUsd() - this.activeRunBudget.startCostUsd;
    this.activeRunBudget.partialResults.push({ operation, actual_cost_usd: actualCostUsd });
    if (actualCostUsd > this.activeRunBudget.maxCostUsd) {
      const error = new Error(
        `Cost hard gate: $${actualCostUsd.toFixed(4)} exceeds budget $${this.activeRunBudget.maxCostUsd.toFixed(4)}`,
      ) as Error & { actualCostUsd: number; maxCostUsd: number; partialResults: unknown[] };
      error.actualCostUsd = actualCostUsd;
      error.maxCostUsd = this.activeRunBudget.maxCostUsd;
      error.partialResults = [...this.activeRunBudget.partialResults];
      throw error;
    }
  }

  private tryParseDyadTask(taskText: string, budgetUsd?: number): DyadAnalysisTask | null {
    try {
      const parsed = JSON.parse(taskText);
      const task = DyadAnalysisTaskSchema.parse(parsed);
      if (!task.budget && budgetUsd !== undefined) {
        return {
          ...task,
          budget: {
            max_cost_usd: budgetUsd,
            max_latency_ms: 60_000,
          },
        };
      }
      return task;
    } catch {
      return null;
    }
  }

  private async llmDecisionExecutionStrategy(task: string, context: any): Promise<{ parallel: number; tool: string }> {
    const prompt = this.buildExecutionStrategyPrompt(task, context);
    const model = this.llmClient.getModelByTier('tier1');
    
    const llmResult = await this.callBudgetedLLM('execution_strategy', prompt, { model, temperature: 0.7 });
    
    try {
      const parsed = JSON.parse(llmResult.content);
      return {
        parallel: parsed.parallel || 1,
        tool: parsed.tool || 'gstack',
      };
    } catch {
      return { parallel: 1, tool: 'gstack' };
    }
  }

  /**
   * Build prompt for execution strategy decision
   */
  private buildExecutionStrategyPrompt(task: string, context: any): string {
    return `You are an AI execution planner. Given the following task, decide on the execution strategy.

Task: ${task}
Context: ${JSON.stringify(context).substring(0, 500)}

Return a JSON object with the execution strategy, e.g.:
{"tool": "gstack", "parallel": 1} or {"tool": "gorchestrator", "parallel": 3}`;
  }

  /**
   * LLM-driven decision: Escalate to Tier 2
   */
  private async llmDecisionEscalate(errorRate: number, attempts: AttemptResult[]): Promise<boolean> {
    const prompt = this.buildEscalationPrompt(errorRate, attempts);
    const model = this.llmClient.getModelByTier('tier1');
    
    const llmResult = await this.callBudgetedLLM('escalation_decision', prompt, { model, temperature: 0.5 });
    
    try {
      const parsed = JSON.parse(llmResult.content);
      return parsed.escalate || false;
    } catch {
      return errorRate > 0.5;
    }
  }

  /**
   * Build prompt for escalation decision
   */
  private buildEscalationPrompt(errorRate: number, attempts: AttemptResult[]): string {
    return `You are an AI escalation controller. Given the current error rate and attempt results, decide whether to escalate to a higher-tier model.

Error Rate: ${errorRate.toFixed(3)}
Attempt Count: ${attempts.length}

Return a JSON object with the decision, e.g.:
{"escalate": true, "tier": "tier2", "reasoning": "High error rate detected"} or {"escalate": false, "reasoning": "Error rate acceptable"}`;
  }

  /**
   * LLM-driven decision: Verify
   */
  private async llmDecisionVerify(attempts: AttemptResult[]): Promise<boolean> {
    const prompt = this.buildVerifyPrompt(attempts);
    const model = this.llmClient.getModelByTier('tier1');
    
    const llmResult = await this.callBudgetedLLM('verification_decision', prompt, { model, temperature: 0.5 });
    
    try {
      const parsed = JSON.parse(llmResult.content);
      return parsed.verify || false;
    } catch {
      return true;
    }
  }

  /**
   * Build prompt for verification decision
   */
  private buildVerifyPrompt(attempts: AttemptResult[]): string {
    return `You are an AI verification controller. Given the attempt results, decide whether to verify the outputs.

Attempt Count: ${attempts.length}

Return a JSON object with the decision, e.g.:
{"verify": true, "reasoning": "Verification recommended for critical output"} or {"verify": false, "reasoning": "Outputs look reliable"}`;
  }

  /**
   * LLM-driven decision: Cognitive check
   */
  private async llmDecisionCognitiveCheck(attempts: AttemptResult[]): Promise<boolean> {
    const prompt = this.buildCognitiveCheckPrompt(attempts);
    const model = this.llmClient.getModelByTier('tier1');
    
    const llmResult = await this.callBudgetedLLM('cognitive_check_decision', prompt, { model, temperature: 0.5 });
    
    try {
      const parsed = JSON.parse(llmResult.content);
      return parsed.check || false;
    } catch {
      return true;
    }
  }

  /**
   * Build prompt for cognitive check decision
   */
  private buildCognitiveCheckPrompt(attempts: AttemptResult[]): string {
    return `You are an AI cognitive controller. Given the attempt results, decide whether to perform cognitive checks.

Attempt Count: ${attempts.length}

Return a JSON object with the decision, e.g.:
{"check": true, "reasoning": "Cognitive check recommended for decision validation"} or {"check": false, "reasoning": "Cognitive check not necessary"}`;
  }

  private async primeBrain(task: string): Promise<any> {
    if (!this.config.isToolEnabled('gbrain')) {
      return null;
    }

    const cached = this.contextCache.get(task);
    if (cached !== undefined) return cached;

    try {
      const context = await this.gbrainClient.searchContext(task);
      this.contextCache.set(task, context);
      return context;
    } catch (error) {
      logger.warn('GBrain context lookup unavailable; continuing without primed context', {
        error: error instanceof Error ? error.message : String(error),
        circuit: this.gbrainClient.getCircuitState(),
      });
      this.contextCache.set(task, null);
      return null;
    }
  }

  private async runSingle(task: string, context: any): Promise<AttemptResult[]> {
    // If offline mode or GStack not available, fall back to direct execution
    if (this.offlineMode || !this.config.isToolEnabled('gstack')) {
      if (this.offlineMode) {
        this.logger.info('Offline mode: using direct LLM execution');
      } else {
        this.logger.warn('GStack not enabled or unavailable, falling back to direct execution');
      }
      return await this.executeDirectly(task);
    }
    
    // Delegate to GStack
    const { execAsync } = this.getExec();
    const { stdout } = await execAsync(`echo "${task}" | gstack run`);
    
    return [{
      id: `single-${Date.now()}`,
      output: stdout
    }];
  }

  private async runParallel(task: string, n: number, context: any): Promise<AttemptResult[]> {
    // If offline mode or GOrchestrator not available, fall back to direct execution
    if (this.offlineMode || !this.gorchestratorAvailable || !this.config.isToolEnabled('gorchestrator')) {
      if (this.offlineMode) {
        this.logger.info('Offline mode: using direct LLM execution instead of parallel');
      } else {
        this.logger.warn('GOrchestrator not available, falling back to direct execution');
      }
      return await this.executeDirectly(task);
    }
    
    const { execAsync } = this.getExec();
    const attempts = Math.max(1, Math.min(n, this.maxConcurrency));
    const { stdout } = await execAsync(
      `gorchestrator dispatch --task "${task}" --attempts ${attempts} --json`
    );
    
    return JSON.parse(stdout);
  }

  private async verifyWithMirror(attempt: AttemptResult): Promise<AttemptResult['verification']> {
    if (!this.config.isToolEnabled('gmirror')) {
      return { passed: true, score: 0.5, issues: ['GMirror not enabled'] };
    }
    
    try {
      const { execAsync } = this.getExec();
      const { stdout } = await execAsync(
        `gmirror test --input "${attempt.output}" --json`
      );
      return JSON.parse(stdout);
    } catch {
      return { passed: false, score: 0, issues: ['Verification failed'] };
    }
  }

  private async checkWithToM(attempt: AttemptResult): Promise<AttemptResult['cognitiveCheck']> {
    if (!this.config.isToolEnabled('gtom')) {
      return { authentic: true, score: 0.5, concerns: ['GToM not enabled'] };
    }
    
    try {
      const { execAsync } = this.getExec();
      const { stdout } = await execAsync(
        `gtom assess --decision "${attempt.output}" --json`
      );
      return JSON.parse(stdout);
    } catch {
      return { authentic: false, score: 0, concerns: ['Assessment failed'] };
    }
  }

  private async selectWinner(attempts: AttemptResult[], options: PipelineOptions): Promise<AttemptResult> {
    try {
      const winnerIndex = await this.judgeWinnerWithLLM(attempts, options);
      return attempts[winnerIndex];
    } catch (error) {
      logger.warn('LLM winner selection failed, using score-based fallback', { error: String(error) });
      this.lastConsensusSummary = undefined;
      return this.selectWinnerByScore(attempts, options);
    }
  }

  private selectWinnerByScore(attempts: AttemptResult[], options: PipelineOptions): AttemptResult {
    let scored = attempts.map(a => ({
      ...a,
      finalScore: this.computeScore(a, options)
    }));

    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored[0];
  }

  private computeScore(attempt: AttemptResult, options: PipelineOptions): number {
    let score = 0.5; // Base score

    if (options.verify && attempt.verification) {
      score += attempt.verification.score * 0.3;
    }

    if (options.cognitiveCheck && attempt.cognitiveCheck) {
      score += attempt.cognitiveCheck.score * 0.2;
    }

    return score;
  }

  /**
   * Judge winner using multi-model consensus.
   */
  private async judgeWinnerWithLLM(attempts: AttemptResult[], options: PipelineOptions): Promise<number> {
    const prompt = this.buildWinnerJudgmentPrompt(attempts, options);
    const votes: ConsensusVote[] = [];
    let tier3Invoked = false;
    let earlyStopped = false;

    for (const tier of ['tier1', 'tier2'] as ModelTier[]) {
      votes.push(await this.collectConsensusVote(tier, prompt, attempts.length));
    }

    let consensus = this.evaluateConsensus(votes, attempts.length, false, false);
    if (consensus.agreed && consensus.winnerIndex !== undefined) {
      earlyStopped = true;
    } else if (this.multiModelConfig.allow_tier3) {
      tier3Invoked = true;
      this.escalationMetrics.tier3_count++;
      logger.info('Invoking Tier 3 model for winner consensus', {
        reason: 'tier1_tier2_consensus_failed',
        consensus_threshold: this.multiModelConfig.consensus_threshold,
      });
      votes.push(await this.collectConsensusVote('tier3', prompt, attempts.length));
    }

    consensus = this.evaluateConsensus(votes, attempts.length, tier3Invoked, earlyStopped);
    this.lastConsensusSummary = consensus;
    this.escalationMetrics.consensus_agreement_rate = this.updateAverage(
      this.escalationMetrics.consensus_agreement_rate,
      Math.max(1, this.escalationMetrics.total_tasks),
      consensus.agreement_ratio
    );

    if (!consensus.agreed || consensus.winnerIndex === undefined) {
      throw new Error('Winner consensus failed');
    }

    return consensus.winnerIndex;
  }

  private async collectConsensusVote(
    tier: ModelTier,
    prompt: string,
    attemptCount: number,
  ): Promise<ConsensusVote> {
    const model = this.llmClient.getModelByTier(tier);

    try {
      const llmResult = await this.callBudgetedLLM(`winner_judgment_${tier}`, prompt, {
        model,
        temperature: 0.2,
      });
      const parsed = this.parseJsonObject(llmResult.content);
      return this.normalizeConsensusVote(tier, llmResult.model_id || model, parsed, attemptCount);
    } catch (error) {
      return {
        tier,
        model_id: model,
        dimensions: {},
        disqualified: true,
        disqualification_reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private normalizeConsensusVote(
    tier: ModelTier,
    modelId: string,
    parsed: any,
    attemptCount: number,
  ): ConsensusVote {
    const dimensions = this.normalizeDimensions(parsed?.dimensions);
    const winnerIndex = Number(parsed?.winnerIndex);
    const confidence = this.clamp01(Number(parsed?.confidence ?? 0));
    const missingDimensions = CONSENSUS_DIMENSIONS.filter(dim => dimensions[dim] === undefined);
    const disqualificationReasons: string[] = [];

    if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex >= attemptCount) {
      disqualificationReasons.push('winnerIndex is missing or out of range');
    }
    if (missingDimensions.length > 0) {
      disqualificationReasons.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    }

    return {
      tier,
      model_id: modelId,
      winnerIndex: Number.isInteger(winnerIndex) ? winnerIndex : undefined,
      confidence,
      dimensions,
      reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : undefined,
      disqualified: disqualificationReasons.length > 0,
      disqualification_reason: disqualificationReasons.join('; ') || undefined,
    };
  }

  private normalizeDimensions(value: any): Record<string, number> {
    const dimensions: Record<string, number> = {};
    if (!value || typeof value !== 'object') {
      return dimensions;
    }

    for (const dimension of CONSENSUS_DIMENSIONS) {
      const raw = Number(value[dimension]);
      if (Number.isFinite(raw)) {
        dimensions[dimension] = this.clamp01(raw);
      }
    }

    return dimensions;
  }

  private parseJsonObject(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error('LLM response did not contain JSON');
      }
      return JSON.parse(match[0]);
    }
  }

  private evaluateConsensus(
    votes: ConsensusVote[],
    attemptCount: number,
    tier3Invoked: boolean,
    earlyStopped: boolean,
  ): ConsensusSummary {
    const validVotes = votes.filter(v => !v.disqualified && v.winnerIndex !== undefined);
    const counts = new Map<number, number>();
    for (const vote of validVotes) {
      counts.set(vote.winnerIndex!, (counts.get(vote.winnerIndex!) || 0) + 1);
    }

    let winnerIndex: number | undefined;
    let winningVotes = 0;
    for (const [index, count] of counts.entries()) {
      if (count > winningVotes) {
        winnerIndex = index;
        winningVotes = count;
      }
    }

    const agreementRatio = validVotes.length > 0 ? winningVotes / validVotes.length : 0;
    const threshold = this.multiModelConfig.consensus_threshold;
    const votesRequired = validVotes.length >= 3
      ? Math.max(2, Math.ceil(validVotes.length * Math.min(threshold, 2 / 3)))
      : 2;
    const agreed = winningVotes >= votesRequired && winnerIndex !== undefined;

    return {
      winnerIndex,
      agreed,
      agreement_ratio: agreementRatio,
      consensus_threshold: threshold,
      votes_required: votesRequired,
      valid_votes: validVotes.length,
      tier3_invoked: tier3Invoked,
      early_stopped: earlyStopped,
      small_sample_note: attemptCount < 30,
      per_dimension_agreement: this.calculateDimensionAgreement(validVotes),
      votes,
    };
  }

  private calculateDimensionAgreement(votes: ConsensusVote[]): Record<string, DimensionAgreement> {
    const agreements: Record<string, DimensionAgreement> = {};
    const tolerance = 1 - this.multiModelConfig.consensus_threshold;

    for (const dimension of CONSENSUS_DIMENSIONS) {
      const valuesByModel: Record<string, number> = {};
      const values: number[] = [];
      for (const vote of votes) {
        const value = vote.dimensions[dimension];
        if (value !== undefined) {
          valuesByModel[vote.model_id] = value;
          values.push(value);
        }
      }

      if (values.length === 0) {
        agreements[dimension] = {
          participating_models: 0,
          agreement: 0,
          wilson_95_ci: this.wilson95(0, 0),
          small_sample_note: true,
          values: valuesByModel,
        };
        continue;
      }

      const sorted = [...values].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const agreeing = values.filter(value => Math.abs(value - median) <= tolerance).length;

      agreements[dimension] = {
        participating_models: values.length,
        agreement: agreeing / values.length,
        wilson_95_ci: this.wilson95(agreeing, values.length),
        small_sample_note: values.length < 30,
        values: valuesByModel,
      };
    }

    return agreements;
  }

  private wilson95(successes: number, total: number): { lower: number; upper: number } {
    if (total <= 0) {
      return { lower: 0, upper: 0 };
    }

    const z = 1.96;
    const phat = successes / total;
    const denominator = 1 + (z * z) / total;
    const center = phat + (z * z) / (2 * total);
    const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);

    return {
      lower: this.clamp01((center - margin) / denominator),
      upper: this.clamp01((center + margin) / denominator),
    };
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  /**
   * Build prompt for winner judgment
   */
  private buildWinnerJudgmentPrompt(attempts: AttemptResult[], options: PipelineOptions): string {
    const attemptsDescription = attempts.map((a, i) => {
      let desc = `Attempt ${i}:\n`;
      desc += `Output: ${a.output.substring(0, 200)}...\n`;
      if (a.verification) {
        desc += `Verification Score: ${a.verification.score}\n`;
      }
      if (a.cognitiveCheck) {
        desc += `Cognitive Check Score: ${a.cognitiveCheck.score}\n`;
      }
      return desc;
    }).join('\n');

    return `Select the best attempt from the following options based on quality, correctness, reliability, and safety.
You are one voter in a multi-model consensus. Return strict JSON only.
The dimensions object is required. Use scores from 0 to 1 for:
- correctness
- completeness
- reliability
- safety

${attemptsDescription}

Return this JSON shape:
{"winnerIndex": <0 to ${attempts.length - 1}>, "confidence": <0 to 1>, "dimensions": {"correctness": <0 to 1>, "completeness": <0 to 1>, "reliability": <0 to 1>, "safety": <0 to 1>}, "reasoning": "brief reason"}`;
  }

  private async recordToBrain(task: string, winner: AttemptResult, attempts: AttemptResult[]): Promise<void> {
    if (!this.config.isToolEnabled('gbrain')) {
      return;
    }

    try {
      const record = {
        task,
        winner,
        attempts,
        timestamp: new Date().toISOString()
      };
      
      await this.gbrainClient.createPage({
        title: `Pipeline: ${task}`,
        content: JSON.stringify(record, null, 2),
        tags: ['gagent', 'pipeline'],
      });
    } catch (error) {
      logger.warn('Failed to write pipeline record to GBrain; continuing without remote memory write', {
        error: error instanceof Error ? error.message : String(error),
        circuit: this.gbrainClient.getCircuitState(),
      });
    }
  }

  private async captureToLearn(task: string, winner: AttemptResult, attempts: AttemptResult[]): Promise<void> {
    if (!this.config.isToolEnabled('glearn')) {
      return;
    }
    
    const { execAsync } = this.getExec();
    await execAsync(
      `glearn capture --task "${task}" --winner "${winner.id}" --json '${JSON.stringify(attempts)}'`
    );
  }

  private getExec() {
    const { promisify } = require('util');
    const { exec } = require('child_process');
    return { execAsync: promisify(exec) };
  }

  /**
   * Generate execution receipt for quality tracking
   */
  private async generateReceipt(
    options: PipelineOptions,
    winner: AttemptResult | undefined,
    attempts: AttemptResult[],
    costUsd: number = 0,
  ): Promise<ExecutionReceipt> {
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex');
    const configHash = crypto.createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
    
    const overallScore = winner ? this.computeScore(winner, options) : 0;
    const passed = overallScore > 0.5;
    const passCount = attempts.filter(attempt => this.computeScore(attempt, options) > 0.5).length;
    const scoreInterval = this.wilson95(passCount, attempts.length);
    const consensusModels = this.lastConsensusSummary?.votes.map(vote => vote.model_id) || [];
    const modelList = consensusModels.length > 0 ? Array.from(new Set(consensusModels)) : ['claude-sonnet-4-6'];
    const consensusConfidence = this.lastConsensusSummary?.agreement_ratio ?? 0.7;

    return {
      receipt_id: uuidv4(),
      schema_version: 1,
      timestamp: new Date().toISOString(),
      project: 'gagent' as const,
      rubric_name: 'gagent_v1',
      rubric_sha8: inputHash.substring(0, 8),
      input_hash: inputHash,
      models_used: modelList,
      config_hash: configHash,
      verdict: passed ? 'pass' : 'fail',
      scores: {
        overall_score: { score: overallScore, confidence: consensusConfidence, weight: 1.0 },
      },
      overall_score: overallScore,
      hard_gates_passed: passed,
      cost_usd: costUsd,
      errors: [],
      metadata: {
        task: options.task,
        parallel: options.parallel,
        verify: options.verify,
        cognitive_check: options.cognitiveCheck,
        attempts_count: attempts.length,
        winner_id: winner?.id,
        consensus: this.lastConsensusSummary,
        score_wilson_95_ci: scoreInterval,
        small_sample_note: attempts.length < 30,
        llm_total_cost_usd: this.llmClient.getTotalCostUsd(),
        budget_status: this.budgetLedger.getStatus(),
      },
    };
  }

  /**
   * Store receipt in gbrain quality control database
   */
  private async storeReceiptInGBrain(receipt: ExecutionReceipt): Promise<void> {
    if (!this.config.isToolEnabled('gbrain')) {
      return;
    }

    try {
      await this.gbrainClient.createPage({
        title: `Receipt: ${receipt.receipt_id}`,
        content: JSON.stringify(receipt, null, 2),
        tags: ['gagent', 'receipt', receipt.verdict],
      });
    } catch (error) {
      logger.warn('Failed to store receipt in GBrain; continuing without remote receipt mirror', {
        error: error instanceof Error ? error.message : String(error),
        circuit: this.gbrainClient.getCircuitState(),
      });
    }
  }

  /**
   * Update running average
   */
  private updateAverage(currentAvg: number, count: number, newValue: number): number {
    if (count === 0) return newValue;
    return currentAvg + (newValue - currentAvg) / count;
  }

  /**
   * Calculate error rate from attempts
   */
  private calculateErrorRate(attempts: AttemptResult[]): number {
    if (attempts.length === 0) return 0;
    const failedAttempts = attempts.filter(a => !a.output || a.output.trim() === '').length;
    return failedAttempts / attempts.length;
  }

  /**
   * Get escalation metrics
   */
  getEscalationMetrics(): EscalationMetrics {
    return { ...this.escalationMetrics };
  }

  /**
   * Get multi-model configuration
   */
  getMultiModelConfig(): MultiModelConfig {
    return { ...this.multiModelConfig };
  }

  /**
   * Update multi-model configuration
   */
  updateMultiModelConfig(config: Partial<MultiModelConfig>): void {
    this.multiModelConfig = { ...this.multiModelConfig, ...config };
  }

  /**
   * Health check for escalation system and all tools
   */
  async healthCheck(): Promise<HealthCheckResult[]> {
    const start = performance.now();
    const span = this.observability.tracer.startSpan('GAgent.healthCheck');
    const results: HealthCheckResult[] = [];
    try {

    // Check gbrain
    const gbrainStart = performance.now();
    try {
      const response = await this.gbrainClient.healthCheck();
      const healthy = response.ok === true || response.status === 'healthy' || response.status === 'ok';
      results.push({
        service: 'gbrain',
        healthy,
        latency_ms: performance.now() - gbrainStart,
        error: healthy ? undefined : `status=${response.status ?? 'unknown'}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const circuit = this.gbrainClient.getCircuitState();
      results.push({
        service: 'gbrain',
        healthy: false,
        latency_ms: performance.now() - gbrainStart,
        error: `${error instanceof Error ? error.message : 'Unknown error'} circuit_open=${circuit.open}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Check gstack
    const gstackStart = performance.now();
    try {
      const response = await fetch(`${this.gstackEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        service: 'gstack',
        healthy: response.ok,
        latency_ms: performance.now() - gstackStart,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      results.push({
        service: 'gstack',
        healthy: false,
        latency_ms: performance.now() - gstackStart,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    // Check gorchestrator
    const gorchestratorStart = performance.now();
    try {
      const response = await fetch(`${this.gorchestratorEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        service: 'gorchestrator',
        healthy: response.ok,
        latency_ms: performance.now() - gorchestratorStart,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      results.push({
        service: 'gorchestrator',
        healthy: false,
        latency_ms: performance.now() - gorchestratorStart,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    // Check gmirror
    const gmirrorStart = performance.now();
    try {
      const response = await fetch(`${this.gmirrorEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        service: 'gmirror',
        healthy: response.ok,
        latency_ms: performance.now() - gmirrorStart,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      results.push({
        service: 'gmirror',
        healthy: false,
        latency_ms: performance.now() - gmirrorStart,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    // Check gtom
    const gtomStart = performance.now();
    try {
      const response = await fetch(`${this.gtomEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        service: 'gtom',
        healthy: response.ok,
        latency_ms: performance.now() - gtomStart,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      results.push({
        service: 'gtom',
        healthy: false,
        latency_ms: performance.now() - gtomStart,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    // Check glearn
    const glearnStart = performance.now();
    try {
      const response = await fetch(`${this.glearnEndpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        service: 'glearn',
        healthy: response.ok,
        latency_ms: performance.now() - glearnStart,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      results.push({
        service: 'glearn',
        healthy: false,
        latency_ms: performance.now() - glearnStart,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    // Check internal escalation metrics
    const escalationStart = performance.now();
    const issues: string[] = [];
    if (this.escalationMetrics.budget_remaining_usd < 0) {
      issues.push('Budget exceeded');
    }
    if (this.escalationMetrics.tier2_success_rate < 0.5 && this.escalationMetrics.tier2_count > 10) {
      issues.push('Tier 2 success rate below 50%');
    }
    results.push({
      service: 'gagent_escalation',
      healthy: issues.length === 0,
      latency_ms: performance.now() - escalationStart,
      error: issues.length > 0 ? issues.join(', ') : undefined,
      timestamp: new Date().toISOString(),
    });

    const healthScore = this.calculateHealthScore(results);
    results.push({
      service: 'health_score',
      healthy: healthScore >= 80,
      latency_ms: performance.now() - start,
      error: healthScore >= 80 ? undefined : `score=${healthScore}`,
      timestamp: new Date().toISOString(),
    });

    const latencyMs = performance.now() - start;
    this.latencyTracker.record(latencyMs);
    this.observability.metrics.recordPublicMethod('healthCheck', latencyMs, 'ok');
    for (const result of results) {
      this.observability.metrics.observe('gagent_health_check_latency_ms', result.latency_ms, { service: result.service });
      if (!result.healthy) this.observability.metrics.increment('gagent_health_check_errors_total', { service: result.service });
    }
    await this.publishDailyToolStatus(results);
    await this.observability.alertOnHealthDrop(healthScore, results);
    this.observability.tracer.endSpan(span);
    return results;
    } catch (error) {
      const latencyMs = performance.now() - start;
      this.latencyTracker.record(latencyMs);
      this.observability.metrics.recordPublicMethod('healthCheck', latencyMs, 'error');
      this.observability.tracer.endSpan(span, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private calculateHealthScore(results: HealthCheckResult[]): number {
    if (results.length === 0) return 0;
    const healthy = results.filter(result => result.healthy).length;
    return Math.round((healthy / results.length) * 100);
  }

  private async publishDailyToolStatus(results: HealthCheckResult[]): Promise<void> {
    if (!this.config.isToolEnabled('gbrain')) {
      return;
    }

    try {
      await this.gbrainClient.publishDailyToolStatus({
        status: Object.fromEntries(results.map(result => [
          result.service,
          {
            installed: true,
            healthy: result.healthy,
            latency_ms: result.latency_ms,
            message: result.error,
            score: result.healthy ? 100 : 0,
          },
        ])),
      });
    } catch (error) {
      logger.warn('Failed to publish daily tool status to GBrain', {
        error: error instanceof Error ? error.message : String(error),
        circuit: this.gbrainClient.getCircuitState(),
      });
    }
  }

  /**
   * Get receipts
   */
  async getReceipts(options?: {
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<any[]> {
    const start = performance.now();
    const span = this.observability.tracer.startSpan('GAgent.getReceipts', {
      has_date_range: Boolean(options?.startDate && options?.endDate),
      limit: options?.limit,
      offset: options?.offset,
    });
    try {
      let result;
      if (options?.startDate && options?.endDate) {
        const startDate = new Date(options.startDate);
        const end = new Date(options.endDate);
        const receipts = await this.receiptRegistry.getAllBetween(startDate, end);

        // Apply limit and offset
        result = receipts;
        if (options.offset) {
          result = result.slice(options.offset);
        }
        if (options.limit) {
          result = result.slice(0, options.limit);
        }
      } else {
        // If no date range, get latest
        const latest = await this.receiptRegistry.getLatest();
        result = latest ? [latest] : [];
      }
      const latencyMs = performance.now() - start;
      this.latencyTracker.record(latencyMs);
      this.observability.metrics.recordPublicMethod('getReceipts', latencyMs, 'ok');
      this.observability.tracer.endSpan(span);
      return result;
    } catch (error) {
      const latencyMs = performance.now() - start;
      this.latencyTracker.record(latencyMs);
      this.observability.metrics.recordPublicMethod('getReceipts', latencyMs, 'error');
      this.observability.tracer.endSpan(span, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Get drift statistics
   */
  async getDrift(metricName?: string): Promise<any[]> {
    const start = performance.now();
    const span = this.observability.tracer.startSpan('GAgent.getDrift', { metric_name: metricName });
    try {
      let result;
      if (metricName) {
        const driftResult = this.driftDetector.detectDrift(metricName);
        result = driftResult ? [driftResult] : [];
      } else {
        // If no metric specified, return all available metrics
        result = this.driftDetector.detectAllDrift();
      }
      const latencyMs = performance.now() - start;
      this.latencyTracker.record(latencyMs);
      this.observability.metrics.recordPublicMethod('getDrift', latencyMs, 'ok');
      this.observability.tracer.endSpan(span);
      return result;
    } catch (error) {
      const latencyMs = performance.now() - start;
      this.latencyTracker.record(latencyMs);
      this.observability.metrics.recordPublicMethod('getDrift', latencyMs, 'error');
      this.observability.tracer.endSpan(span, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Get cost statistics
   */
  getCostStats() {
    const start = performance.now();
    try {
      const result = this.budgetLedger.getStats();
      this.observability.metrics.recordPublicMethod('getCostStats', performance.now() - start, 'ok');
      return result;
    } catch (error) {
      this.observability.metrics.recordPublicMethod('getCostStats', performance.now() - start, 'error');
      throw error;
    }
  }

  /**
   * Get available models
   */
  getModels() {
    return Array.from(this.tierConfigs.entries()).map(([tier, config]) => ({
      tier,
      ...config,
    }));
  }

  /**
   * Get tier configuration
   */
  getTierConfig() {
    return this.multiModelConfig;
  }

  /**
   * Get tier runtime metrics for MCP and CLI parity.
   */
  getTierMetrics() {
    return {
      config: this.multiModelConfig,
      models: this.getModels(),
      escalation_metrics: this.escalationMetrics,
      cost_stats: this.getCostStats(),
    };
  }

  /**
   * Get registry information
   */
  getRegistryInfo() {
    return this.registry.listTools();
  }
}
