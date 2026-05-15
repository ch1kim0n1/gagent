/**
 * Skill Registry for GAgent
 * Manages available skills
 */

import { logger } from './logger.js';

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  code: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
    logger.info('Skill registered', { id: skill.id, name: skill.name });
  }

  unregister(skillId: string): void {
    this.skills.delete(skillId);
    logger.info('Skill unregistered', { id: skillId });
  }

  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  findByName(name: string): Skill[] {
    return this.list().filter(s => s.name === name);
  }

  update(skillId: string, updates: Partial<Skill>): void {
    const skill = this.skills.get(skillId);
    if (skill) {
      const updated = { ...skill, ...updates, updatedAt: new Date() };
      this.skills.set(skillId, updated);
      logger.info('Skill updated', { id: skillId });
    }
  }

  clear(): void {
    this.skills.clear();
    logger.info('SkillRegistry cleared');
  }

  count(): number {
    return this.skills.size;
  }
}
