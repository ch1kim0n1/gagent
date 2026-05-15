/**
 * Test fixtures for GAgent
 */

export const mockSkill = {
  id: 'skill-1',
  name: 'Test Skill',
  description: 'A test skill',
  version: '1.0.0',
  code: 'function execute() { return "test"; }',
  metadata: {},
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

export const mockAgent = {
  id: 'agent-1',
  name: 'Test Agent',
  description: 'A test agent',
  skills: ['skill-1'],
  config: {},
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

export const mockTask = {
  id: 'task-1',
  agentId: 'agent-1',
  status: 'pending',
  input: {},
  output: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

export const mockSkillpack = {
  id: 'skillpack-1',
  name: 'Test Skillpack',
  description: 'A test skillpack',
  skills: ['skill-1'],
  version: '1.0.0',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};
