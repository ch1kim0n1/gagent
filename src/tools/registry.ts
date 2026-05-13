import { spawn } from 'child_process';
import { promisify } from 'util';
import { GAgentConfig } from '../config/manager.js';

const execAsync = promisify(require('child_process').exec);

interface ToolInfo {
  installed: boolean;
  path?: string;
  version?: string;
  healthy?: boolean;
  message?: string;
}

interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RegisteredToolInfo {
  name: string;
  description: string;
  enabled: boolean;
  endpoint: string;
}

export class ToolRegistry {
  private config: GAgentConfig;
  private registeredTools: Map<string, RegisteredToolInfo> = new Map();

  constructor(config: GAgentConfig) {
    this.config = config;
  }

  register(id: string, info: RegisteredToolInfo): void {
    this.registeredTools.set(id, info);
  }

  listTools(): RegisteredToolInfo[] {
    return Array.from(this.registeredTools.values());
  }

  isAvailable(id: string): boolean {
    return this.registeredTools.get(id)?.enabled === true;
  }

  getRegisteredInfo(id: string): RegisteredToolInfo | undefined {
    return this.registeredTools.get(id);
  }

  async detectAll(): Promise<Record<string, ToolInfo>> {
    return {
      gbrain: await this.detectGBrain(),
      gstack: await this.detectGStack(),
      gorchestrator: await this.detectGeneric('gorchestrator'),
      gmirror: await this.detectGeneric('gmirror'),
      gtom: await this.detectGeneric('gtom'),
      glearn: await this.detectGeneric('glearn')
    };
  }

  private async detectGBrain(): Promise<ToolInfo> {
    try {
      const { stdout } = await execAsync('gbrain --version 2>/dev/null || echo "not found"');
      if (stdout.includes('not found')) {
        return { installed: false };
      }
      return {
        installed: true,
        version: stdout.trim(),
        path: '~/.gbrain',
        healthy: true
      };
    } catch {
      return { installed: false };
    }
  }

  private async detectGStack(): Promise<ToolInfo> {
    const home = process.env.HOME || process.env.USERPROFILE;
    const gstackPath = `${home}/.claude/skills/gstack`;
    
    try {
      const { existsSync } = await import('fs');
      if (existsSync(gstackPath)) {
        return {
          installed: true,
          path: gstackPath,
          version: 'detected',
          healthy: true
        };
      }
      return { installed: false };
    } catch {
      return { installed: false };
    }
  }

  private async detectGeneric(name: string): Promise<ToolInfo> {
    const home = process.env.HOME || process.env.USERPROFILE;
    const toolPath = `${home}/.${name}`;
    
    try {
      const { existsSync } = await import('fs');
      const { stdout } = await execAsync(`${name} --version 2>/dev/null || echo "not found"`);
      
      if (stdout.includes('not found') && !existsSync(toolPath)) {
        return { 
          installed: false,
          message: 'Not yet built (see architecture docs)'
        };
      }
      
      return {
        installed: existsSync(toolPath),
        path: toolPath,
        version: stdout.trim().includes('not found') ? undefined : stdout.trim(),
        healthy: !stdout.includes('not found'),
        message: existsSync(toolPath) && stdout.includes('not found') 
          ? 'Directory exists but binary not linked' 
          : undefined
      };
    } catch {
      return { 
        installed: false,
        message: 'Not yet built (see architecture docs)'
      };
    }
  }

  async healthCheck(): Promise<Record<string, ToolInfo>> {
    const detected = await this.detectAll();
    
    // Deep health check for installed tools
    for (const [name, info] of Object.entries(detected)) {
      if (info.installed && name === 'gbrain') {
        try {
          const { stdout } = await execAsync('gbrain doctor --json 2>/dev/null || echo "{}"');
          const doctor = JSON.parse(stdout);
          info.healthy = doctor.status === 'ok';
          info.message = doctor.status === 'ok' ? undefined : doctor.checks?.find((c: any) => !c.ok)?.message;
        } catch {
          info.healthy = false;
          info.message = 'Doctor check failed';
        }
      }
    }
    
    return detected;
  }

  async runTool(name: string, args: string[], rawArgs: string[]): Promise<ToolResult> {
    const binary = name === 'gstack' ? 'gstack' : name;
    
    return new Promise((resolve) => {
      const proc = spawn(binary, [...args, ...rawArgs], {
        stdio: 'inherit',
        shell: false
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (exitCode) => {
        resolve({ exitCode: exitCode || 0, stdout, stderr });
      });
    });
  }

  async syncAll(): Promise<void> {
    // Sync GBrain (central memory)
    if (this.config.isToolEnabled('gbrain')) {
      try {
        await execAsync('gbrain sync');
      } catch {
        // Ignore errors
      }
    }
    
    // Sync GStack learnings to GBrain
    if (this.config.isToolEnabled('gstack') && this.config.isToolEnabled('gbrain')) {
      try {
        await execAsync('gbrain sources add ~/.gstack --strategy memory');
      } catch {
        // May already be added
      }
    }
    
    // Future: sync other tools
  }

  getEnabledTools(): string[] {
    return Object.entries(this.config.getRaw().tools)
      .filter(([_, info]) => info.enabled)
      .map(([name, _]) => name);
  }
}
