/**
 * Skillpack Registry for GAgent
 * Manages skillpacks (collections of skills)
 */

import { logger } from './logger.js';

export interface Skillpack {
  id: string;
  name: string;
  description: string;
  skills: string[];
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

export class SkillpackRegistry {
  private skillpacks: Map<string, Skillpack> = new Map();

  register(skillpack: Skillpack): void {
    this.skillpacks.set(skillpack.id, skillpack);
    logger.info('Skillpack registered', { id: skillpack.id, name: skillpack.name });
  }

  unregister(skillpackId: string): void {
    this.skillpacks.delete(skillpackId);
    logger.info('Skillpack unregistered', { id: skillpackId });
  }

  get(skillpackId: string): Skillpack | undefined {
    return this.skillpacks.get(skillpackId);
  }

  list(): Skillpack[] {
    return Array.from(this.skillpacks.values());
  }

  findByName(name: string): Skillpack[] {
    return this.list().filter(s => s.name === name);
  }

  update(skillpackId: string, updates: Partial<Skillpack>): void {
    const skillpack = this.skillpacks.get(skillpackId);
    if (skillpack) {
      const updated = { ...skillpack, ...updates, updatedAt: new Date() };
      this.skillpacks.set(skillpackId, updated);
      logger.info('Skillpack updated', { id: skillpackId });
    }
  }

  clear(): void {
    this.skillpacks.clear();
    logger.info('SkillpackRegistry cleared');
  }

  count(): number {
    return this.skillpacks.size;
  }
}
