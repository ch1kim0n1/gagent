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
// Shared Quality Rubric Types (for regression gating and receipts)
// ============================================================================
export * from './quality-rubric.js';
