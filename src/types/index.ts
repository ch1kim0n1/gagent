import { z } from 'zod';

// ============================================================================
// Agent Execution Verdict
// ============================================================================

export const AgentExecutionVerdictSchema = z.object({
  verdict_id: z.string().uuid(),
  execution_id: z.string().uuid(),
  overall: z.enum(['success', 'success_with_warnings', 'failure', 'timeout']),
  tool_calls_made: z.number().int().nonnegative(),
  tool_calls_successful: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  created_at: z.string().datetime(),
  execution_receipt: z.any().optional(), // ExecutionReceipt from quality-rubric
});

export type AgentExecutionVerdict = z.infer<typeof AgentExecutionVerdictSchema>;

// ============================================================================
// Multi-Model Consensus Types
// ============================================================================

export const MultiModelConfigSchema = z.object({
  default_tier: z.enum(['tier1', 'tier2', 'tier3']),
  escalation_enabled: z.boolean(),
  escalation_triggers: z.object({
    min_confidence: z.number().min(0).max(1),
    min_quality_score: z.number().min(0).max(1),
    max_ambiguity: z.number().min(0).max(1),
  }),
  consensus_threshold: z.number().min(0).max(1),
  cost_budget_usd_per_hour: z.number().positive(),
  allow_tier3: z.boolean(),
});

export type MultiModelConfig = z.infer<typeof MultiModelConfigSchema>;

export const ModelTierSchema = z.enum(['tier1', 'tier2', 'tier3']);

export type ModelTier = z.infer<typeof ModelTierSchema>;

export const TierConfigSchema = z.object({
  name: z.string(),
  model_id: z.string(),
  cost_per_1k_tokens_usd: z.number(),
  avg_latency_ms: z.number(),
  use_case: z.string(),
});

export type TierConfig = z.infer<typeof TierConfigSchema>;

export const EscalationMetricsSchema = z.object({
  total_tasks: z.number().int(),
  escalated_tasks: z.number().int(),
  tier1_success_rate: z.number().min(0).max(1),
  tier2_success_rate: z.number().min(0).max(1),
  tier3_success_rate: z.number().min(0).max(1),
  tier1_count: z.number().int(),
  tier2_count: z.number().int(),
  tier3_count: z.number().int(),
  avg_cost_per_task_usd: z.number(),
  avg_latency_ms: z.number(),
  tier1_avg_latency_ms: z.number(),
  tier2_avg_latency_ms: z.number(),
  tier3_avg_latency_ms: z.number(),
  consensus_agreement_rate: z.number().min(0).max(1),
  budget_remaining_usd: z.number(),
});

export type EscalationMetrics = z.infer<typeof EscalationMetricsSchema>;

// ============================================================================
// DYAD Relationship Analysis Types
// ============================================================================

export const BudgetSchema = z.object({
  max_cost_usd: z.number().nonnegative(),
  max_latency_ms: z.number().int().positive(),
});

export type Budget = z.infer<typeof BudgetSchema>;

export const RawMessageSchema = z.object({
  rowid: z.number().int().nonnegative(),
  text: z.string(),
  handle_id: z.string(),
  date: z.number(),
});

export type RawMessage = z.infer<typeof RawMessageSchema>;

export const RedactedMessageSchema = z.object({
  rowid: z.number().int().nonnegative(),
  text: z.string(),
  participant_id: z.string(),
  timestamp: z.string().datetime(),
});

export type RedactedMessage = z.infer<typeof RedactedMessageSchema>;

export const DetectorNameSchema = z.enum([
  'emotion_labeling',
  'bid_classification',
  'repair_detection',
  'labor_asymmetry',
  'phantom_third_party',
  'predictive_divergence',
]);

export type DetectorName = z.infer<typeof DetectorNameSchema>;

export const RefusalReasonSchema = z.enum([
  'minor_detected',
  'blame_assignment',
  'out_of_scope',
  'insufficient_data',
  'coercive_framing',
]);

export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

export const RefusalClassifierResultSchema = z.object({
  should_refuse: z.boolean(),
  reason: RefusalReasonSchema.optional(),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});

export type RefusalClassifierResult = z.infer<typeof RefusalClassifierResultSchema>;

export const DyadAnalysisTaskSchema = z.object({
  task: z.literal('analyze_relationship_window'),
  parameters: z.object({
    dyad_id: z.string().regex(/^[a-f0-9]{16,64}$/i),
    message_window: z.array(RedactedMessageSchema),
    detectors: z.array(DetectorNameSchema).min(1),
    time_range: z.object({
      start: z.string().datetime(),
      end: z.string().datetime(),
    }),
  }),
  budget: BudgetSchema.optional(),
});

export type DyadAnalysisTask = z.infer<typeof DyadAnalysisTaskSchema>;

export interface DetectorOutput {
  detector: DetectorName;
  dyad_id: string;
  result: Record<string, unknown>;
  confidence: number;
  model_used: string;
  cost_usd: number;
  latency_ms: number;
}

export interface DyadAnalysisResult {
  dyad_id: string;
  detector_results: DetectorOutput[];
  ethical_refusal?: RefusalClassifierResult;
  cost_usd: number;
  latency_ms: number;
  partial_result?: boolean;
  budget_error?: {
    message: string;
    actual_cost_usd: number;
    max_cost_usd: number;
  };
}

// ============================================================================
// Shared Quality Rubric Types (for regression gating and receipts)
// ============================================================================
export * from './quality-rubric.js';
