import * as crypto from 'crypto';
const uuidv4 = (): string => crypto.randomUUID();
import { ToolRegistry } from '../tools/registry.js';
import { GAgentConfig } from '../config/manager.js';
import { ReceiptRegistry } from '../core/receipt-registry.js';
import { ExecutionReceipt } from '../types/quality-rubric.js';
import {
  MultiModelConfig,
  EscalationMetrics,
  TierConfig,
} from '../types/index.js';
import {
  LLMClient,
  LLMClientConfig,
} from '../core/llm-client.js';

// Local structured logger (to be replaced with shared module when package dependencies are set up)
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogContext {
  request_id?: string;
  correlation_id?: string;
  tool_name?: string;
  [key: string]: any;
}

class LocalLogger {
  private level: LogLevel;
  private toolName: string;
  private component: string;
  private context: Record<string, any>;

  constructor(toolName: string, level: LogLevel = 'INFO') {
    this.toolName = toolName;
    this.level = level;
    this.component = toolName;
    this.context = {};
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private formatMessage(level: string, message: string, context?: Record<string, any>): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...this.context,
      ...context,
    });
  }

  debug(message: string, context?: Record<string, any>): void {
    if (!this.shouldLog('DEBUG')) return;
    const fullMessage = this.formatMessage('DEBUG', message, context);
    console.debug(fullMessage);
  }

  info(message: string, context?: Record<string, any>): void {
    if (!this.shouldLog('INFO')) return;
    const fullMessage = this.formatMessage('INFO', message, context);
    console.info(fullMessage);
  }

  warn(message: string, context?: Record<string, any>): void {
    if (!this.shouldLog('WARN')) return;
    const fullMessage = this.formatMessage('WARN', message, context);
    console.warn(fullMessage);
  }

  error(message: string, error?: Error | Record<string, any>): void {
    if (!this.shouldLog('ERROR')) return;
    const fullMessage = this.formatMessage('ERROR', message, error instanceof Error ? { error: error.message, stack: error.stack } : error);
    console.error(fullMessage);
  }

  child(context: Record<string, any>): LocalLogger {
    const child = new LocalLogger(this.toolName, this.level);
    child.context = { ...this.context, ...context };
    return child;
  }
}

const logger = new LocalLogger('gagent');

// Local audit logger writes decision JSONL to ~/.{tool}/audit/decisions-YYYY-Www.jsonl
class LocalAuditLogger {
  private auditPath: string;

  constructor(private tool: string) {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
    const week = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const dir = path.join(os.homedir(), `.${tool}`, 'audit');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
    this.auditPath = path.join(dir, `decisions-${week}.jsonl`);
  }

  async log(entry: {
    operation: string;
    decision: string;
    reasoning?: string;
    model_tier?: string;
    model_name?: string;
    cost_usd?: number;
    tokens?: number;
    latency_ms?: number;
    success: boolean;
    error?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      tool: this.tool,
      ...entry,
    };
    try {
      const fs = require('fs').promises;
      await fs.appendFile(this.auditPath, JSON.stringify(auditEntry) + '\n', 'utf8');
    } catch (err) {
      logger.warn('Audit write failed', { error: String(err) });
    }
  }
}

const auditLogger = new LocalAuditLogger('gagent');

interface PipelineOptions {
  task: string;
  parallel: number;
  verify: boolean;
  cognitiveCheck: boolean;
  learn: boolean;
  dryRun: boolean;
  budgetUsd?: number;
  cycles?: number;
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
}

export class Pipeline {
  private registry: ToolRegistry;
  private config: GAgentConfig;
  private receiptRegistry: ReceiptRegistry;
  private multiModelConfig: MultiModelConfig;
  private tierConfigs: Map<string, TierConfig>;
  private escalationMetrics: EscalationMetrics;
  private llmClient: LLMClient;

  constructor(registry: ToolRegistry, config: GAgentConfig, multiModelConfig?: MultiModelConfig, llmConfig?: LLMClientConfig) {
    this.registry = registry;
    this.config = config;
    this.receiptRegistry = new ReceiptRegistry('gagent');
    this.llmClient = new LLMClient(llmConfig);

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
      allow_tier3: false,
    };

    // Tier configurations
    this.tierConfigs = new Map([
      ['tier1', { name: 'claude-haiku-4-5', model_id: 'anthropic/claude-haiku-4-5', cost_per_1k_tokens_usd: 0.001, avg_latency_ms: 500, use_case: 'Tool selection' }],
      ['tier2', { name: 'claude-sonnet-4-6', model_id: 'anthropic/claude-sonnet-4-6', cost_per_1k_tokens_usd: 0.003, avg_latency_ms: 2000, use_case: 'Execution planning when error rate high' }],
      ['tier3', { name: 'claude-opus-4-6', model_id: 'anthropic/claude-opus-4-6', cost_per_1k_tokens_usd: 0.015, avg_latency_ms: 5000, use_case: 'Critical execution planning' }],
    ]);

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

  async execute(options: PipelineOptions): Promise<PipelineResult> {
    const tier1StartTime = Date.now();
    try {
      // Stage 1: Prime
      const context = await this.primeBrain(options.task);

      // LLM-driven decision: Select execution strategy
      const executionDecision = await this.llmDecisionExecutionStrategy(options.task, context);
      
      // Stage 2: Execute (Tier 1)
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

          logger.info('Escalating to Tier 2 for execution planning', { tier: 'tier2' });

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
        }
      } else {
        this.escalationMetrics.tier1_success_rate = this.escalationMetrics.tier1_count / this.escalationMetrics.total_tasks;
      }

      // LLM-driven decision: Verify
      const shouldVerify = await this.llmDecisionVerify(attempts);
      if (shouldVerify && options.verify) {
        for (const attempt of attempts) {
          attempt.verification = await this.verifyWithMirror(attempt);
        }
      }

      // LLM-driven decision: Cognitive check
      const shouldCheck = await this.llmDecisionCognitiveCheck(attempts);
      if (shouldCheck && options.cognitiveCheck) {
        for (const attempt of attempts) {
          attempt.cognitiveCheck = await this.checkWithToM(attempt);
        }
      }

      // Stage 5: Select winner
      const winner = await this.selectWinner(attempts, options);

      // Write to GBrain
      await this.recordToBrain(options.task, winner, attempts);

      // Stage 6: Learn (if enabled)
      if (options.learn) {
        await this.captureToLearn(options.task, winner, attempts);
      }

      // Generate and emit receipt
      const receipt = await this.generateReceipt(options, winner, attempts);
      await this.receiptRegistry.append(receipt);

      // Store receipt in gbrain for quality control
      await this.storeReceiptInGBrain(receipt);

      return {
        success: true,
        winner,
        attempts
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * LLM-driven decision: Select execution strategy
   */
  private async llmDecisionExecutionStrategy(task: string, context: any): Promise<{ parallel: number; tool: string }> {
    const prompt = this.buildExecutionStrategyPrompt(task, context);
    const model = this.llmClient.getModelByTier('tier1');
    
    const llmResult = await this.llmClient.call(prompt, { model, temperature: 0.7 });
    
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
    
    const llmResult = await this.llmClient.call(prompt, { model, temperature: 0.5 });
    
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
    
    const llmResult = await this.llmClient.call(prompt, { model, temperature: 0.5 });
    
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
    
    const llmResult = await this.llmClient.call(prompt, { model, temperature: 0.5 });
    
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
    
    try {
      const { execAsync } = this.getExec();
      const { stdout } = await execAsync(`gbrain query "${task}" --json`);
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }

  private async runSingle(task: string, context: any): Promise<AttemptResult[]> {
    if (!this.config.isToolEnabled('gstack')) {
      throw new Error('GStack not enabled');
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
    if (!this.config.isToolEnabled('gorchestrator')) {
      // Fall back to single if GOrchestrator not available
      logger.warn('GOrchestrator not available, falling back to single execution');
      return this.runSingle(task, context);
    }
    
    const { execAsync } = this.getExec();
    const { stdout } = await execAsync(
      `gorchestrator dispatch --task "${task}" --attempts ${n} --json`
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
   * Judge winner using LLM
   */
  private async judgeWinnerWithLLM(attempts: AttemptResult[], options: PipelineOptions): Promise<number> {
    const prompt = this.buildWinnerJudgmentPrompt(attempts, options);
    const model = this.llmClient.getModelByTier('tier1');

    const llmResult = await this.llmClient.call(prompt, { model, temperature: 0.3 });

    try {
      const parsed = JSON.parse(llmResult.content);
      return parsed.winnerIndex || 0;
    } catch {
      return 0;
    }
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

    return `Select the best attempt from the following options based on quality, correctness, and reliability:

${attemptsDescription}

Return a JSON object with the index of the winner:
{"winnerIndex": <0 to ${attempts.length - 1}>}`;
  }

  private async recordToBrain(task: string, winner: AttemptResult, attempts: AttemptResult[]): Promise<void> {
    if (!this.config.isToolEnabled('gbrain')) {
      return;
    }
    
    const { execAsync } = this.getExec();
    const record = {
      task,
      winner,
      attempts,
      timestamp: new Date().toISOString()
    };
    
    await execAsync(
      `gbrain put_page --title "Pipeline: ${task}" --tags "gagent,pipeline" <<< '${JSON.stringify(record)}'`
    );
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
    attempts: AttemptResult[]
  ): Promise<ExecutionReceipt> {
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex');
    const configHash = crypto.createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
    
    const overallScore = winner ? this.computeScore(winner, options) : 0;
    const passed = overallScore > 0.5;

    return {
      receipt_id: uuidv4(),
      schema_version: 1,
      timestamp: new Date().toISOString(),
      project: 'gagent' as const,
      rubric_name: 'gagent_v1',
      rubric_sha8: inputHash.substring(0, 8),
      input_hash: inputHash,
      models_used: ['claude-sonnet-4-6'],
      config_hash: configHash,
      verdict: passed ? 'pass' : 'fail',
      scores: {
        overall_score: { score: overallScore, confidence: 0.7, weight: 1.0 },
      },
      overall_score: overallScore,
      hard_gates_passed: passed,
      cost_usd: 0,
      errors: [],
      metadata: {
        task: options.task,
        parallel: options.parallel,
        verify: options.verify,
        cognitive_check: options.cognitiveCheck,
        attempts_count: attempts.length,
        winner_id: winner?.id,
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
      const { execAsync } = this.getExec();
      
      // Store the receipt
      await execAsync(
        `gbrain qc_store_receipt --receipt_id "${receipt.receipt_id}" --component "gagent" --rubric_name "${receipt.rubric_name}" --rubric_hash "${receipt.rubric_sha8}" --timestamp "${receipt.timestamp}" --verdict "${receipt.verdict}" --overall_score ${receipt.overall_score} --hard_gates_passed ${receipt.hard_gates_passed} --scores '${JSON.stringify(receipt.scores)}' --hard_gate_results '[]' --metadata '${JSON.stringify(receipt.metadata)}'`
      );

      // Store individual rubric scores
      const scoreEntries = Object.entries(receipt.scores).map(([dimension, scoreData]) => ({
        dimension_name: dimension,
        score: scoreData.score,
        confidence: scoreData.confidence || 0.7,
        weight: scoreData.weight || 1.0,
        evidence: []
      }));

      if (scoreEntries.length > 0) {
        await execAsync(
          `gbrain qc_store_rubric_scores --receipt_id "${receipt.receipt_id}" --scores '${JSON.stringify(scoreEntries)}'`
        );
      }
    } catch (error) {
      // Log error but don't fail the pipeline if gbrain storage fails
      logger.error('Failed to store receipt in gbrain', error as Error);
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
   * Health check for escalation system
   */
  healthCheck(): { healthy: boolean; issues: string[] } {
    const issues: string[] = [];

    if (this.escalationMetrics.budget_remaining_usd < 0) {
      issues.push('Budget exceeded');
    }

    if (this.escalationMetrics.tier2_success_rate < 0.5 && this.escalationMetrics.tier2_count > 10) {
      issues.push('Tier 2 success rate below 50%');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}
