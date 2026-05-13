import { z } from 'zod';

export const RubricDimensionSchema = z.object({
  name: z.string(),  // e.g., 'correctness', 'safety', 'latency'
  description: z.string(),
  min: z.number(),   // 1 or 0
  max: z.number(),   // 5 or 10 or 1.0
  weight: z.number().min(0).max(1),
  pass_floor: z.number(),  // Minimum acceptable score
});

export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export const RubricFrameworkSchema = z.object({
  name: z.string(),  // 'gmirror_v1', 'gtom_v1', etc.
  version: z.string(),
  dimensions: z.array(RubricDimensionSchema),
  overall_pass_criteria: z.object({
    all_above_floor: z.boolean(),  // true = all dims must meet floor
    weighted_mean_floor: z.number().optional(),
  }),
});

export type RubricFramework = z.infer<typeof RubricFrameworkSchema>;

export const ExecutionReceiptSchema = z.object({
  receipt_id: z.string().uuid(),
  schema_version: z.literal(1),
  timestamp: z.string().datetime(),
  project: z.enum(['gmirror', 'gorchestrator', 'gtom', 'gagent', 'glearn']),
  rubric_name: z.string(),  // e.g., 'gmirror_v1'
  rubric_sha8: z.string(),  // First 8 chars of SHA-256(rubric JSON)
  
  // Corpus fingerprinting
  input_hash: z.string(),   // SHA-256 of input corpus (scenarios, users, etc.)
  
  // Models/configuration
  models_used: z.array(z.string()),  // ['claude-sonnet-4-6', ...]
  config_hash: z.string(),   // SHA-256 of configuration JSON
  
  // Results
  verdict: z.string(),  // 'pass', 'pass_with_warnings', 'risky', 'fail'
  scores: z.record(z.object({
    score: z.number(),
    confidence: z.number(),
    weight: z.number(),
  })),
  overall_score: z.number(),
  hard_gates_passed: z.boolean(),
  
  // Cost tracking
  cost_usd: z.number(),
  
  // Evidence
  improvements: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  
  metadata: z.record(z.any()).optional(),
});

export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
