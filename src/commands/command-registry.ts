/**
 * Command Registry for GAgent CLI
 * Provides command registration, discovery, and dispatch
 */

export interface Command {
  name: string;
  description: string;
  handler: (args: string[]) => Promise<void>;
  aliases?: string[];
  hidden?: boolean;
  subcommands?: Command[];
}

export interface CommandContext {
  command: string;
  args: string[];
  globalFlags: {
    quiet?: boolean;
    progressJson?: boolean;
    progressInterval?: number;
  };
}

class CommandRegistry {
  private commands: Map<string, Command> = new Map();
  private aliases: Map<string, string> = new Map();

  register(command: Command): void {
    this.commands.set(command.name, command);
    
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.set(alias, command.name);
      }
    }
  }

  registerAll(commands: Command[]): void {
    for (const command of commands) {
      this.register(command);
    }
  }

  get(name: string): Command | undefined {
    const realName = this.aliases.get(name);
    if (realName) {
      return this.commands.get(realName);
    }
    return this.commands.get(name);
  }

  getAll(): Command[] {
    return Array.from(this.commands.values()).filter(cmd => !cmd.hidden);
  }

  has(name: string): boolean {
    return this.commands.has(name) || this.aliases.has(name);
  }

  resolveAlias(name: string): string {
    return this.aliases.get(name) || name;
  }
}

export const registry = new CommandRegistry();

export function registerCommand(command: Command): void {
  registry.register(command);
}

export function registerCommands(commands: Command[]): void {
  registry.registerAll(commands);
}

export function getCommand(name: string): Command | undefined {
  return registry.get(name);
}

export function getAllCommands(): Command[] {
  return registry.getAll();
}
