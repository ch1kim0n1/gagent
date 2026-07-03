/**
 * Version command for GAgent
 * Display version information
 */

import { Command } from './command-registry.js';
import { VERSION } from '../version.js';

export const versionCommand: Command = {
  name: 'version',
  description: 'Display version information',
  handler: async () => {
    console.log(`GAgent version ${VERSION}`);
  },
  aliases: ['--version', '-v'],
};
