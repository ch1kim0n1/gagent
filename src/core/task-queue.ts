/**
 * Task Queue for GAgent
 * Manages task execution queue
 */

import { logger } from './logger.js';

export interface Task {
  id: string;
  agentId: string;
  input: unknown;
  priority: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export class TaskQueue {
  private queue: Task[] = [];
  private running: Map<string, Task> = new Map();
  private completed: Map<string, Task> = new Map();

  enqueue(task: Omit<Task, 'status' | 'createdAt'>): void {
    const fullTask: Task = {
      ...task,
      status: 'pending',
      createdAt: new Date(),
    };
    
    this.queue.push(fullTask);
    this.queue.sort((a, b) => b.priority - a.priority);
    
    logger.info('Task enqueued', { id: task.id, priority: task.priority });
  }

  dequeue(): Task | null {
    if (this.queue.length === 0) {
      return null;
    }

    const task = this.queue.shift()!;
    task.status = 'running';
    task.startedAt = new Date();
    this.running.set(task.id, task);
    
    logger.info('Task dequeued', { id: task.id });
    return task;
  }

  complete(taskId: string, result?: unknown): void {
    const task = this.running.get(taskId);
    if (task) {
      task.status = 'completed';
      task.completedAt = new Date();
      this.running.delete(taskId);
      this.completed.set(taskId, task);
      logger.info('Task completed', { id: taskId });
    }
  }

  fail(taskId: string, error?: string): void {
    const task = this.running.get(taskId);
    if (task) {
      task.status = 'failed';
      task.completedAt = new Date();
      this.running.delete(taskId);
      this.completed.set(taskId, task);
      logger.error('Task failed', { id: taskId, error });
    }
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getCompletedCount(): number {
    return this.completed.size;
  }

  clear(): void {
    this.queue = [];
    this.running.clear();
    this.completed.clear();
    logger.info('TaskQueue cleared');
  }
}
