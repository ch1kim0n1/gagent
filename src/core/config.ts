/**
 * Configuration management for GAgent
 */

export interface GAgentConfig {
  database: {
    type: 'sqlite' | 'postgres' | 'memory';
    dbPath?: string;
    connectionString?: string;
  };
  llm: {
    provider: string;
    apiKey?: string;
    model?: string;
  };
  skills: {
    enabled: boolean;
    skillPath: string;
  };
  server: {
    port: number;
    host: string;
  };
}

export const defaultConfig: GAgentConfig = {
  database: {
    type: 'sqlite',
    dbPath: './gagent.db',
  },
  llm: {
    provider: 'openai',
  },
  skills: {
    enabled: true,
    skillPath: './skills',
  },
  server: {
    port: 8081,
    host: 'localhost',
  },
};

export function loadConfig(configPath?: string): GAgentConfig {
  return defaultConfig;
}

export function mergeConfig(base: GAgentConfig, override: Partial<GAgentConfig>): GAgentConfig {
  return {
    ...base,
    ...override,
    database: { ...base.database, ...override.database },
    llm: { ...base.llm, ...override.llm },
    skills: { ...base.skills, ...override.skills },
    server: { ...base.server, ...override.server },
  };
}
