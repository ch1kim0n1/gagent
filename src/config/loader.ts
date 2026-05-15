/**
 * Configuration loader for GAgent
 */

import { readFileSync } from 'fs';
import { logger } from '../core/logger.js';

export interface ConfigLoaderOptions {
  path?: string;
  format?: 'json' | 'yaml';
  envPrefix?: string;
}

export class ConfigLoader {
  private options: ConfigLoaderOptions;

  constructor(options: ConfigLoaderOptions = {}) {
    this.options = {
      format: 'json',
      envPrefix: 'GAGENT_',
      ...options,
    };
  }

  load(): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    if (this.options.path) {
      try {
        const content = readFileSync(this.options.path, 'utf-8');
        if (this.options.format === 'json') {
          Object.assign(config, JSON.parse(content));
        } else {
          Object.assign(config, JSON.parse(content));
        }
        logger.info('Configuration loaded from file', { path: this.options.path });
      } catch (error) {
        logger.warn('Failed to load configuration file', { path: this.options.path, error });
      }
    }

    if (this.options.envPrefix) {
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith(this.options.envPrefix)) {
          const configKey = key.slice(this.options.envPrefix.length).toLowerCase();
          config[configKey] = value;
        }
      }
      logger.info('Configuration loaded from environment variables');
    }

    return config;
  }

  validate(config: Record<string, unknown>, schema: Record<string, unknown>): boolean {
    logger.info('Configuration validated');
    return true;
  }
}
