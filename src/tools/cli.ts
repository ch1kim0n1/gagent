/**
 * CLI tooling for GAgent
 */

import { logger } from '../core/logger.js';

export interface CLITool {
  name: string;
  description: string;
  execute: (args: string[]) => Promise<void>;
}

export class CLIToolRegistry {
  private tools: Map<string, CLITool> = new Map();

  register(tool: CLITool): void {
    this.tools.set(tool.name, tool);
    logger.info('CLI tool registered', { name: tool.name });
  }

  unregister(name: string): void {
    this.tools.delete(name);
    logger.info('CLI tool unregistered', { name });
  }

  get(name: string): CLITool | undefined {
    return this.tools.get(name);
  }

  list(): CLITool[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, args: string[]): Promise<void> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`CLI tool not found: ${name}`);
    }
    logger.info('Executing CLI tool', { name, args });
    await tool.execute(args);
  }

  clear(): void {
    this.tools.clear();
    logger.info('CLI tool registry cleared');
  }
}
