/**
 * Custom error classes for GAgent
 */

export class GAgentError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'GAgentError';
  }
}

export class DatabaseError extends GAgentError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR');
    this.name = 'DatabaseError';
  }
}

export class ValidationError extends GAgentError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class SkillError extends GAgentError {
  constructor(message: string) {
    super(message, 'SKILL_ERROR');
    this.name = 'SkillError';
  }
}

export class AgentError extends GAgentError {
  constructor(message: string) {
    super(message, 'AGENT_ERROR');
    this.name = 'AgentError';
  }
}

export class TaskError extends GAgentError {
  constructor(message: string) {
    super(message, 'TASK_ERROR');
    this.name = 'TaskError';
  }
}

export class BudgetExceededError extends GAgentError {
  constructor(message: string) {
    super(message, 'BUDGET_EXCEEDED');
    this.name = 'BudgetExceededError';
  }
}
