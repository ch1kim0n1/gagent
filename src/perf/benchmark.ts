/**
 * Benchmark utilities for GAgent
 */

import { logger } from '../core/logger.js';

export interface BenchmarkResult {
  name: string;
  duration: number;
  iterations: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
}

export class Benchmark {
  private results: BenchmarkResult[] = [];

  async run(name: string, fn: () => Promise<void>, iterations: number = 100): Promise<BenchmarkResult> {
    logger.info(`Running benchmark: ${name}`, { iterations });
    
    const durations: number[] = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await fn();
      const duration = Date.now() - start;
      durations.push(duration);
    }
    
    const result: BenchmarkResult = {
      name,
      duration: durations.reduce((a, b) => a + b, 0),
      iterations,
      avgDuration: durations.reduce((a, b) => a + b, 0) / iterations,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
    };
    
    this.results.push(result);
    logger.info(`Benchmark completed: ${name}`, { ...result });
    
    return result;
  }

  getResults(): BenchmarkResult[] {
    return [...this.results];
  }

  clear(): void {
    this.results = [];
  }

  printReport(): void {
    console.log('\n=== Benchmark Report ===');
    for (const result of this.results) {
      console.log(`\n${result.name}:`);
      console.log(`  Total: ${result.duration}ms`);
      console.log(`  Avg: ${result.avgDuration.toFixed(2)}ms`);
      console.log(`  Min: ${result.minDuration}ms`);
      console.log(`  Max: ${result.maxDuration}ms`);
    }
    console.log('\n========================\n');
  }
}
