export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export class StructuredLogger {
  constructor(private readonly source: string) {}

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
    };
    const levelName = LogLevel[level];
    const prefix = `[${this.source}] [${levelName}]`;
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    console.log(`${prefix} ${message}${contextStr}`);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, context);
  }
}

export function createLogger(source: string): StructuredLogger {
  return new StructuredLogger(source);
}

export { StructuredLogger as Logger };
export const logger = createLogger('gagent');
