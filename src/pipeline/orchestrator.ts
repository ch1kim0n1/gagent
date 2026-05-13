import { ToolRegistry } from '../tools/registry.js';
import { GAgentConfig } from '../config/manager.js';

interface PipelineOptions {
  task: string;
  parallel: number;
  verify: boolean;
  cognitiveCheck: boolean;
  learn: boolean;
  dryRun: boolean;
}

interface AttemptResult {
  id: string;
  output: string;
  score?: number;
  verification?: {
    passed: boolean;
    score: number;
    issues: string[];
  };
  cognitiveCheck?: {
    authentic: boolean;
    score: number;
    concerns: string[];
  };
}

interface PipelineResult {
  success: boolean;
  winner?: AttemptResult;
  attempts?: AttemptResult[];
  error?: string;
}

export class Pipeline {
  private registry: ToolRegistry;
  private config: GAgentConfig;

  constructor(registry: ToolRegistry, config: GAgentConfig) {
    this.registry = registry;
    this.config = config;
  }

  describe(options: PipelineOptions): string {
    const stages: string[] = [];
    
    stages.push(`1. Prime GBrain with context for: "${options.task}"`);
    
    if (options.parallel > 1) {
      stages.push(`2. GOrchestrator: Dispatch ${options.parallel} parallel attempts`);
    } else {
      stages.push(`2. GStack: Execute single attempt`);
    }
    
    if (options.verify) {
      stages.push(`3. GMirror: Test outputs against synthetic users`);
    }
    
    if (options.cognitiveCheck) {
      stages.push(`4. GToM: Validate decision authenticity`);
    }
    
    stages.push(`5. Select winner, write to GBrain`);
    
    if (options.learn) {
      stages.push(`6. GLearn: Capture pattern for future optimization`);
    }
    
    return stages.join('\n');
  }

  async execute(options: PipelineOptions): Promise<PipelineResult> {
    try {
      // Stage 1: Prime
      const context = await this.primeBrain(options.task);
      
      // Stage 2: Execute
      let attempts: AttemptResult[];
      if (options.parallel > 1) {
        attempts = await this.runParallel(options.task, options.parallel, context);
      } else {
        attempts = await this.runSingle(options.task, context);
      }
      
      // Stage 3: Verify (if enabled)
      if (options.verify) {
        for (const attempt of attempts) {
          attempt.verification = await this.verifyWithMirror(attempt);
        }
      }
      
      // Stage 4: Cognitive check (if enabled)
      if (options.cognitiveCheck) {
        for (const attempt of attempts) {
          attempt.cognitiveCheck = await this.checkWithToM(attempt);
        }
      }
      
      // Stage 5: Select winner
      const winner = this.selectWinner(attempts, options);
      
      // Write to GBrain
      await this.recordToBrain(options.task, winner, attempts);
      
      // Stage 6: Learn (if enabled)
      if (options.learn) {
        await this.captureToLearn(options.task, winner, attempts);
      }
      
      return {
        success: true,
        winner,
        attempts
      };
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async primeBrain(task: string): Promise<any> {
    if (!this.config.isToolEnabled('gbrain')) {
      return null;
    }
    
    try {
      const { execAsync } = this.getExec();
      const { stdout } = await execAsync(`gbrain query "${task}" --json`);
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }

  private async runSingle(task: string, context: any): Promise<AttemptResult[]> {
    if (!this.config.isToolEnabled('gstack')) {
      throw new Error('GStack not enabled');
    }
    
    // Delegate to GStack
    const { execAsync } = this.getExec();
    const { stdout } = await execAsync(`echo "${task}" | gstack run`);
    
    return [{
      id: `single-${Date.now()}`,
      output: stdout
    }];
  }

  private async runParallel(task: string, n: number, context: any): Promise<AttemptResult[]> {
    if (!this.config.isToolEnabled('gorchestrator')) {
      // Fall back to single if GOrchestrator not available
      console.log('GOrchestrator not available, falling back to single execution');
      return this.runSingle(task, context);
    }
    
    const { execAsync } = this.getExec();
    const { stdout } = await execAsync(
      `gorchestrator dispatch --task "${task}" --attempts ${n} --json`
    );
    
    return JSON.parse(stdout);
  }

  private async verifyWithMirror(attempt: AttemptResult): Promise<AttemptResult['verification']> {
    if (!this.config.isToolEnabled('gmirror')) {
      return { passed: true, score: 0.5, issues: ['GMirror not enabled'] };
    }
    
    try {
      const { execAsync } = this.getExec();
      const { stdout } = await execAsync(
        `gmirror test --input "${attempt.output}" --json`
      );
      return JSON.parse(stdout);
    } catch {
      return { passed: false, score: 0, issues: ['Verification failed'] };
    }
  }

  private async checkWithToM(attempt: AttemptResult): Promise<AttemptResult['cognitiveCheck']> {
    if (!this.config.isToolEnabled('gtom')) {
      return { authentic: true, score: 0.5, concerns: ['GToM not enabled'] };
    }
    
    try {
      const { execAsync } = this.getExec();
      const { stdout } = await execAsync(
        `gtom assess --decision "${attempt.output}" --json`
      );
      return JSON.parse(stdout);
    } catch {
      return { authentic: false, score: 0, concerns: ['Assessment failed'] };
    }
  }

  private selectWinner(attempts: AttemptResult[], options: PipelineOptions): AttemptResult {
    let scored = attempts.map(a => ({
      ...a,
      finalScore: this.computeScore(a, options)
    }));
    
    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored[0];
  }

  private computeScore(attempt: AttemptResult, options: PipelineOptions): number {
    let score = 0.5; // Base score
    
    if (options.verify && attempt.verification) {
      score += attempt.verification.score * 0.3;
    }
    
    if (options.cognitiveCheck && attempt.cognitiveCheck) {
      score += attempt.cognitiveCheck.score * 0.2;
    }
    
    return score;
  }

  private async recordToBrain(task: string, winner: AttemptResult, attempts: AttemptResult[]): Promise<void> {
    if (!this.config.isToolEnabled('gbrain')) {
      return;
    }
    
    const { execAsync } = this.getExec();
    const record = {
      task,
      winner,
      attempts,
      timestamp: new Date().toISOString()
    };
    
    await execAsync(
      `gbrain put_page --title "Pipeline: ${task}" --tags "gagent,pipeline" <<< '${JSON.stringify(record)}'`
    );
  }

  private async captureToLearn(task: string, winner: AttemptResult, attempts: AttemptResult[]): Promise<void> {
    if (!this.config.isToolEnabled('glearn')) {
      return;
    }
    
    const { execAsync } = this.getExec();
    await execAsync(
      `glearn capture --task "${task}" --winner "${winner.id}" --json '${JSON.stringify(attempts)}'`
    );
  }

  private getExec() {
    const { promisify } = require('util');
    const { exec } = require('child_process');
    return { execAsync: promisify(exec) };
  }
}
