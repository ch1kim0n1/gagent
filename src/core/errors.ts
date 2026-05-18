/**
 * Custom error classes for GAgent
 */

export type ErrorSeverity = 'recoverable' | 'fatal' | 'transient';

export interface ErrorResponse {
  error: string;
  code: string;
  message: string;
  severity: ErrorSeverity;
  requestId?: string;
  timestamp: string;
}

export class GAgentError extends Error {
  constructor(
    message: string,
    public code: string = 'INTERNAL_ERROR',
    public statusCode: number = 500,
    public severity: ErrorSeverity = 'fatal'
  ) {
    super(message);
    this.name = 'GAgentError';
  }

  toJSON(): ErrorResponse {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      timestamp: new Date().toISOString(),
    };
  }
}

export class ValidationError extends GAgentError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400, 'recoverable');
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends GAgentError {
  constructor(message: string) {
    super(message, 'AUTHENTICATION_ERROR', 401, 'recoverable');
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends GAgentError {
  constructor(message: string) {
    super(message, 'AUTHORIZATION_ERROR', 403, 'fatal');
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends GAgentError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404, 'recoverable');
    this.name = 'NotFoundError';
  }
}

export class DatabaseError extends GAgentError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR', 500, 'fatal');
    this.name = 'DatabaseError';
  }
}

export class SkillError extends GAgentError {
  constructor(message: string) {
    super(message, 'SKILL_ERROR', 500, 'fatal');
    this.name = 'SkillError';
  }
}

export class AgentError extends GAgentError {
  constructor(message: string) {
    super(message, 'AGENT_ERROR', 500, 'fatal');
    this.name = 'AgentError';
  }
}

export class TaskError extends GAgentError {
  constructor(message: string) {
    super(message, 'TASK_ERROR', 500, 'fatal');
    this.name = 'TaskError';
  }
}

export class BudgetExceededError extends GAgentError {
  constructor(message: string) {
    super(message, 'BUDGET_EXCEEDED', 429, 'fatal');
    this.name = 'BudgetExceededError';
  }
}

export class RateLimitError extends GAgentError {
  constructor(message: string) {
    super(message, 'RATE_LIMIT', 429, 'transient');
    this.name = 'RateLimitError';
  }
}

export class TimeoutError extends GAgentError {
  constructor(message: string) {
    super(message, 'TIMEOUT', 504, 'transient');
    this.name = 'TimeoutError';
  }
}
