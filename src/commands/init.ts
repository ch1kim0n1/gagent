/**
 * Init command for GAgent
 * Initializes GAgent configuration and state
 */

import { Command } from './command-registry.js';

export const initCommand: Command = {
  name: 'init',
  description: 'Initialize GAgent configuration and state',
  handler: async (args: string[]) => {
    console.log('Initializing GAgent...');
    console.log('GAgent initialized successfully.');
  },
  aliases: ['initialize'],
  subcommands: [
    {
      name: 'config',
      description: 'Initialize configuration only',
      handler: async () => {
        console.log('Initializing configuration...');
      },
    },
    {
      name: 'state',
      description: 'Initialize state storage only',
      handler: async () => {
        console.log('Initializing state storage...');
      },
    },
  ],
};
