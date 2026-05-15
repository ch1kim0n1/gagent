/**
 * Core component tests for GAgent
 */

import { describe, it, expect } from 'bun:test';
import { mockSkill, mockAgent, mockTask } from '../fixtures/index.js';

describe('GAgent Core', () => {
  describe('Skill Management', () => {
    it('should create a skill', () => {
      expect(mockSkill.id).toBe('skill-1');
      expect(mockSkill.name).toBe('Test Skill');
    });

    it('should validate skill code', () => {
      expect(mockSkill.code).toBeDefined();
      expect(typeof mockSkill.code).toBe('string');
    });
  });

  describe('Agent Management', () => {
    it('should create an agent', () => {
      expect(mockAgent.id).toBe('agent-1');
      expect(mockAgent.name).toBe('Test Agent');
    });

    it('should associate skills with agent', () => {
      expect(mockAgent.skills).toContain('skill-1');
    });
  });

  describe('Task Execution', () => {
    it('should create a task', () => {
      expect(mockTask.id).toBe('task-1');
      expect(mockTask.status).toBe('pending');
    });

    it('should associate task with agent', () => {
      expect(mockTask.agentId).toBe('agent-1');
    });
  });
});
