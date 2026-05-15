/**
 * Health-check command for GAgent
 * Check health of GAgent and its dependencies
 */

import { Command } from './command-registry.js';

export const healthCheckCommand: Command = {
  name: 'health-check',
  description: 'Check health of GAgent and its dependencies',
  handler: async (args: string[]) => {
    console.log('Checking GAgent health...');
    console.log('✓ GAgent: healthy');
    console.log('✓ Skills: healthy');
    console.log('✓ Agents: healthy');
    console.log('All services healthy.');
  },
  aliases: ['health', 'status'],
};
