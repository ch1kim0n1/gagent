// Re-exports from @gstack/shared/core — all tools use the same logger implementation
export { createLogger, StructuredLogger, LogLevel, type LogEntry } from '@gstack/shared/core';

// Compatibility shim: Logger alias and singleton instance
import { StructuredLogger, createLogger } from '@gstack/shared/core';
export { StructuredLogger as Logger };
export const logger = createLogger('gagent');
