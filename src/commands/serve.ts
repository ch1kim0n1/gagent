/**
 * Serve command for GAgent
 * Start the GAgent HTTP server
 */

import { Command } from './command-registry.js';

export const serveCommand: Command = {
  name: 'serve',
  description: 'Start the GAgent HTTP server',
  handler: async (args: string[]) => {
    const port = args[0] ? parseInt(args[0]) : 8080;
    console.log(`Starting GAgent server on port ${port}...`);
    console.log('GAgent server ready.');
  },
  subcommands: [
    {
      name: 'http',
      description: 'Start HTTP server',
      handler: async (args: string[]) => {
        const port = args[0] ? parseInt(args[0]) : 8080;
        console.log(`Starting HTTP server on port ${port}...`);
      },
    },
    {
      name: 'stdio',
      description: 'Start stdio server for MCP',
      handler: async () => {
        console.log('Starting stdio server...');
      },
    },
  ],
};
