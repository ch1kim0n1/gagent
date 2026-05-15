/**
 * Agent Registry for GAgent
 * Manages available agents
 */

import { logger } from './logger.js';

export interface Agent {
  id: string;
  name: string;
  description: string;
  skills: string[];
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export class AgentRegistry {
  private agents: Map<string, Agent> = new Map();

  register(agent: Agent): void {
    this.agents.set(agent.id, agent);
    logger.info('Agent registered', { id: agent.id, name: agent.name });
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
    logger.info('Agent unregistered', { id: agentId });
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  list(): Agent[] {
    return Array.from(this.agents.values());
  }

  findByName(name: string): Agent[] {
    return this.list().filter(a => a.name === name);
  }

  update(agentId: string, updates: Partial<Agent>): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      const updated = { ...agent, ...updates, updatedAt: new Date() };
      this.agents.set(agentId, updated);
      logger.info('Agent updated', { id: agentId });
    }
  }

  clear(): void {
    this.agents.clear();
    logger.info('AgentRegistry cleared');
  }

  count(): number {
    return this.agents.size;
  }
}
