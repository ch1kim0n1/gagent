import { redactPII } from './observability.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export class Logger {
  private level: LogLevel;
  private entries: LogEntry[] = [];

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level < this.level) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      context,
    };

    this.entries.push(entry);

    const levelName = LogLevel[level];
    const line = JSON.stringify(redactPII({
      timestamp: entry.timestamp.toISOString(),
      level: levelName,
      component: 'gagent',
      message,
      ...(context ? { context } : {}),
    }));
    if (level >= LogLevel.ERROR) console.error(line);
    else if (level === LogLevel.WARN) console.warn(line);
    else if (level === LogLevel.DEBUG) console.debug(line);
    else console.info(line);
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

  fatal(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.FATAL, message, context);
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  clearEntries(): void {
    this.entries = [];
  }
}

export const logger = new Logger(LogLevel.INFO);
