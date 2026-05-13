import * as crypto from 'crypto';
import { RubricFramework } from '../types/quality-rubric.js';

export const GAGENT_RUBRIC_V1: RubricFramework = {
  name: 'gagent_v1',
  version: '1.0',
  dimensions: [
    {
      name: 'task_completion',
      description: 'Successfully completes the requested task',
      min: 0,
      max: 1,
      weight: 0.35,
      pass_floor: 0.5,
    },
    {
      name: 'tool_efficiency',
      description: 'Uses appropriate tools efficiently',
      min: 0,
      max: 1,
      weight: 0.25,
      pass_floor: 0.4,
    },
    {
      name: 'reasoning_quality',
      description: 'Demonstrates sound reasoning and planning',
      min: 0,
      max: 1,
      weight: 0.2,
      pass_floor: 0.4,
    },
    {
      name: 'error_handling',
      description: 'Handles errors gracefully',
      min: 0,
      max: 1,
      weight: 0.1,
      pass_floor: 0.3,
    },
    {
      name: 'cost_effectiveness',
      description: 'Minimizes unnecessary tool calls',
      min: 0,
      max: 1,
      weight: 0.1,
      pass_floor: 0.3,
    },
  ],
  overall_pass_criteria: {
    all_above_floor: true,
    weighted_mean_floor: 0.5,
  },
};

export function getRubricHash(rubric: RubricFramework): string {
  const str = JSON.stringify(rubric);
  const hash = crypto.createHash('sha256').update(str).digest('hex');
  return hash.substring(0, 8);
}
