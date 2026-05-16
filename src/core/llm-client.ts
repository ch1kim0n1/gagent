/**
 * LLM Client for G-Stack Tools
 *
 * Provides:
 * - Model pricing tables (Anthropic, OpenAI)
 * - Token counting and cost tracking
 * - Standardized LLM call interface
 * - Multi-tier model selection
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { encoding_for_model, get_encoding } from 'tiktoken';
import * as fs from 'fs';
import * as path from 'path';
import { coreLogger, LocalLogger, type LogLevel } from './observability.js';

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** Average latency in ms. */
  avg_latency_ms: number;
}

export interface LLMCallResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
  model_id: string;
  cost_usd: number;
  latency_ms: number;
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
  model_id: string;
}

export interface LLMClientConfig {
  /** Anthropic API key(s) - single string or array for rotation */
  anthropicApiKey?: string | string[];
  /** OpenAI API key(s) - single string or array for rotation */
  openaiApiKey?: string | string[];
  /** Default model to use */
  defaultModel?: string;
  /** Maximum tokens for output */
  maxTokens?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds */
  retryBaseDelayMs?: number;
  /** API key rotation strategy */
  keyRotationStrategy?: 'round-robin' | 'random' | 'usage-based';
  /** Hook called when a key fails (for external key management) */
  onKeyFailure?: (provider: 'anthropic' | 'openai', key: string, error: any) => void;
  /** Hook called to get a fresh key (for external key management) */
  onGetFreshKey?: (provider: 'anthropic' | 'openai') => string | null;
  /** Fallback models to try if primary model fails */
  modelFallbackChain?: string[];
  /** Enable model fallback */
  enableModelFallback?: boolean;
  /** Hook called after each LLM call with cost info (for BudgetLedger integration) */
  onSpend?: (modelId: string, inputTokens: number, outputTokens: number, costUsd: number) => Promise<void>;
  /** Optional path for persisted aggregate cost/token/call metrics. */
  metricsPersistencePath?: string;
}

/** Anthropic model pricing (as of 2026-05-01) */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7': { input: 5.00, output: 25.00, avg_latency_ms: 5000 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, avg_latency_ms: 2000 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, avg_latency_ms: 500 },
  'claude-opus-4-6': { input: 5.00, output: 25.00, avg_latency_ms: 5000 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, avg_latency_ms: 2000 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, avg_latency_ms: 500 },
};

/** OpenAI model pricing (as of 2026-05-01) */
export const OPENAI_PRICING: Record<string, ModelPricing> = {
  'gpt-4o': { input: 2.50, output: 10.00, avg_latency_ms: 1500 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, avg_latency_ms: 300 },
  'gpt-4-turbo': { input: 10.00, output: 30.00, avg_latency_ms: 3000 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50, avg_latency_ms: 800 },
};

/** Combined pricing map */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  ...ANTHROPIC_PRICING,
  ...OPENAI_PRICING,
};

/** Model tier configurations */
export const MODEL_TIERS = {
  tier1: 'claude-haiku-4-5-20251001',
  tier2: 'claude-sonnet-4-6',
  tier3: 'claude-opus-4-7',
};

export const MODEL_RESOLUTION_CHAIN = [
  { tier: 'tier1', source: 'explicit_task_model', model: undefined },
  { tier: 'tier1', source: 'winning_gbrain_config', model: undefined },
  { tier: 'tier1', source: 'task_type_default', model: MODEL_TIERS.tier1 },
  { tier: 'tier1', source: 'low_cost_fast_path', model: 'gpt-4o-mini' },
  { tier: 'tier2', source: 'quality_escalation', model: MODEL_TIERS.tier2 },
  { tier: 'tier2', source: 'cross_vendor_consensus', model: 'gpt-4o' },
  { tier: 'tier3', source: 'critical_decision', model: MODEL_TIERS.tier3 },
  { tier: 'tier1', source: 'safe_fallback', model: MODEL_TIERS.tier1 },
] as const;

/**
 * Estimate cost for a model call
 */
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) {
    coreLogger.warn('No pricing for model', { model_id: modelId });
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

/**
 * Get pricing for a model
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  return MODEL_PRICING[modelId] || null;
}

/**
 * Token counter using tiktoken for accurate token counting
 * Falls back to approximation if tiktoken fails
 */
export function estimateTokens(text: string, model: string = 'gpt-4o'): number {
  try {
    const encoding = encoding_for_model(model as any);
    const tokens = encoding.encode(text);
    encoding.free();
    return tokens.length;
  } catch (error) {
    // Fallback to a general-purpose tokenizer rather than a length heuristic.
    coreLogger.warn('tiktoken failed, falling back to cl100k_base', { error: error instanceof Error ? error.message : String(error) });
    const fallback = get_encoding('cl100k_base');
    const tokens = fallback.encode(text);
    fallback.free();
    return tokens.length;
  }
}

/**
 * LLM Client class
 */
export class LLMClient {
  private config: LLMClientConfig;
  private totalCostUsd: number = 0;
  private totalTokens: number = 0;
  private callCount: number = 0;
  private anthropicClient: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;
  private anthropicKeys: string[] = [];
  private openaiKeys: string[] = [];
  private anthropicKeyIndex: number = 0;
  private openaiKeyIndex: number = 0;
  private keyUsageCount: Map<string, number> = new Map();
  private currentAnthropicKey: string | null = null;
  private currentOpenAIKey: string | null = null;
  private logger = new LocalLogger('gagent-llm-client', (process.env.GAGENT_LOG_LEVEL as LogLevel) || 'DEBUG');
  private metricsPersistencePath?: string;

  constructor(config: LLMClientConfig = {}) {
    this.config = {
      defaultModel: 'claude-sonnet-4-6',
      maxTokens: 4096,
      timeoutMs: 30000,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      keyRotationStrategy: 'round-robin',
      enableModelFallback: true,
      modelFallbackChain: ['claude-haiku-4-5-20251001', 'gpt-4o-mini'],
      ...config,
    };
    this.metricsPersistencePath = this.config.metricsPersistencePath;
    this.loadPersistedMetrics();

    // Normalize API keys to arrays
    this.anthropicKeys = Array.isArray(this.config.anthropicApiKey)
      ? this.config.anthropicApiKey
      : this.config.anthropicApiKey
      ? [this.config.anthropicApiKey]
      : [];

    this.openaiKeys = Array.isArray(this.config.openaiApiKey)
      ? this.config.openaiApiKey
      : this.config.openaiApiKey
      ? [this.config.openaiApiKey]
      : [];

    // Initialize Anthropic client if API key is provided
    if (this.anthropicKeys.length > 0) {
      const key = this.getNextAnthropicKey();
      this.currentAnthropicKey = key;
      this.anthropicClient = new Anthropic({
        apiKey: key,
        timeout: this.config.timeoutMs,
      });
    }

    // Initialize OpenAI client if API key is provided
    if (this.openaiKeys.length > 0) {
      const key = this.getNextOpenAIKey();
      this.currentOpenAIKey = key;
      this.openaiClient = new OpenAI({
        apiKey: key,
        timeout: this.config.timeoutMs,
      });
    }
  }

  /**
   * Get next Anthropic API key based on rotation strategy
   */
  private getNextAnthropicKey(): string {
    if (this.anthropicKeys.length === 0) {
      throw new Error('No Anthropic API keys available');
    }

    const strategy = this.config.keyRotationStrategy || 'round-robin';
    let key: string;

    switch (strategy) {
      case 'random':
        key = this.anthropicKeys[Math.floor(Math.random() * this.anthropicKeys.length)];
        break;
      case 'usage-based':
        key = this.getLeastUsedKey(this.anthropicKeys);
        break;
      case 'round-robin':
      default:
        key = this.anthropicKeys[this.anthropicKeyIndex];
        this.anthropicKeyIndex = (this.anthropicKeyIndex + 1) % this.anthropicKeys.length;
        break;
    }

    this.trackKeyUsage(key);
    return key;
  }

  /**
   * Get next OpenAI API key based on rotation strategy
   */
  private getNextOpenAIKey(): string {
    if (this.openaiKeys.length === 0) {
      throw new Error('No OpenAI API keys available');
    }

    const strategy = this.config.keyRotationStrategy || 'round-robin';
    let key: string;

    switch (strategy) {
      case 'random':
        key = this.openaiKeys[Math.floor(Math.random() * this.openaiKeys.length)];
        break;
      case 'usage-based':
        key = this.getLeastUsedKey(this.openaiKeys);
        break;
      case 'round-robin':
      default:
        key = this.openaiKeys[this.openaiKeyIndex];
        this.openaiKeyIndex = (this.openaiKeyIndex + 1) % this.openaiKeys.length;
        break;
    }

    this.trackKeyUsage(key);
    return key;
  }

  /**
   * Get least used key for usage-based rotation
   */
  private getLeastUsedKey(keys: string[]): string {
    let minUsage = Infinity;
    let leastUsedKey = keys[0];

    for (const key of keys) {
      const usage = this.keyUsageCount.get(key) || 0;
      if (usage < minUsage) {
        minUsage = usage;
        leastUsedKey = key;
      }
    }

    return leastUsedKey;
  }

  /**
   * Track key usage for usage-based rotation
   */
  private trackKeyUsage(key: string): void {
    this.keyUsageCount.set(key, (this.keyUsageCount.get(key) || 0) + 1);
  }

  /**
   * Rotate to next API key for a provider
   */
  private rotateKey(provider: 'anthropic' | 'openai'): void {
    if (provider === 'anthropic') {
      const key = this.getNextAnthropicKey();
      this.currentAnthropicKey = key;
      this.anthropicClient = new Anthropic({
        apiKey: key,
        timeout: this.config.timeoutMs,
      });
    } else {
      const key = this.getNextOpenAIKey();
      this.currentOpenAIKey = key;
      this.openaiClient = new OpenAI({
        apiKey: key,
        timeout: this.config.timeoutMs,
      });
    }
  }

  /**
   * Handle key failure and attempt rotation
   */
  private async handleKeyFailure(
    provider: 'anthropic' | 'openai',
    key: string,
    error: any
  ): Promise<boolean> {
    this.logger.warn('LLM key failed', { provider, error: error instanceof Error ? error.message : String(error) });

    // Call failure hook if provided
    if (this.config.onKeyFailure) {
      this.config.onKeyFailure(provider, key, error);
    }

    // Try to get a fresh key from hook
    if (this.config.onGetFreshKey) {
      const freshKey = this.config.onGetFreshKey(provider);
      if (freshKey) {
        if (provider === 'anthropic') {
          this.anthropicKeys = [freshKey, ...this.anthropicKeys];
        } else {
          this.openaiKeys = [freshKey, ...this.openaiKeys];
        }
      }
    }

    // Rotate to next key
    try {
      this.rotateKey(provider);
      return true;
    } catch (rotateError) {
      this.logger.error('LLM key rotation failed', {
        provider,
        error: rotateError instanceof Error ? rotateError.message : String(rotateError),
      });
      return false;
    }
  }

  /**
   * Call an LLM with the given prompt
   */
  async call(
    prompt: string,
    options: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
    } = {}
  ): Promise<LLMCallResult> {
    const primaryModel = options.model || this.config.defaultModel || 'claude-sonnet-4-6';
    const maxTokens = options.maxTokens || this.config.maxTokens || 4096;
    const temperature = options.temperature ?? 0.7;
    const startTime = Date.now();

    this.logger.debug('LLM call started', {
      model: primaryModel,
      maxTokens,
      temperature,
      promptLength: prompt.length,
    });

    // Build model chain: primary model + fallback models
    const modelsToTry = [primaryModel];
    if (this.config.enableModelFallback && this.config.modelFallbackChain) {
      modelsToTry.push(...this.config.modelFallbackChain);
    }

    // Try each model in the chain
    let lastError: any = null;
    for (const model of modelsToTry) {
      try {
        let content: string;
        let inputTokens: number;
        let outputTokens: number;

        if (this.anthropicClient && this.isAnthropicModel(model)) {
          this.logger.debug('Calling Anthropic API', { model });
          const result = await this.callAnthropic(prompt, model, maxTokens, temperature);
          content = result.content;
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
        } else if (this.openaiClient && this.isOpenAIModel(model)) {
          this.logger.debug('Calling OpenAI API', { model });
          const result = await this.callOpenAI(prompt, model, maxTokens, temperature);
          content = result.content;
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
        } else {
          throw new Error(`No API client available for model: ${model}`);
        }

        if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
          inputTokens = estimateTokens(prompt, model);
          outputTokens = estimateTokens(content, model);
        }

        const latency = Date.now() - startTime;
        const cost = estimateCostUsd(model, inputTokens, outputTokens);

        // Track metrics
        this.totalCostUsd += cost;
        this.totalTokens += inputTokens + outputTokens;
        this.callCount++;
        this.persistMetrics();

        // Call spend hook if provided (for BudgetLedger integration)
        if (this.config.onSpend) {
          await this.config.onSpend(model, inputTokens, outputTokens, cost);
        }

        this.logger.info('LLM call succeeded', {
          model,
          inputTokens,
          outputTokens,
          costUsd: cost,
          latencyMs: latency,
        });

        return {
          content,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          model_id: model,
          cost_usd: cost,
          latency_ms: latency,
        };
      } catch (error) {
        this.logger.warn(`Model ${model} failed`, { error: (error as Error).message });
        lastError = error;
        continue;
      }
    }

    // All models failed
    this.logger.error('All models failed', lastError as Error);
    throw new Error(`All models in fallback chain failed. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Call an LLM with streaming response
   */
  async *stream(
    prompt: string,
    options: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
    } = {}
  ): AsyncGenerator<LLMStreamChunk> {
    const primaryModel = options.model || this.config.defaultModel || 'claude-sonnet-4-6';
    const maxTokens = options.maxTokens || this.config.maxTokens || 4096;
    const temperature = options.temperature ?? 0.7;

    // Build model chain: primary model + fallback models
    const modelsToTry = [primaryModel];
    if (this.config.enableModelFallback && this.config.modelFallbackChain) {
      modelsToTry.push(...this.config.modelFallbackChain);
    }

    // Try each model in the chain
    for (const model of modelsToTry) {
      try {
        if (this.anthropicClient && this.isAnthropicModel(model)) {
          yield* this.streamAnthropic(prompt, model, maxTokens, temperature);
          return;
        } else if (this.openaiClient && this.isOpenAIModel(model)) {
          yield* this.streamOpenAI(prompt, model, maxTokens, temperature);
          return;
        } else {
          throw new Error(`No API client available for model: ${model}`);
        }
      } catch (error) {
        this.logger.warn('Streaming model failed, trying next in chain', { model, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    throw new Error('All models in fallback chain for streaming failed');
  }

  /**
   * Stream from Anthropic API
   */
  private async *streamAnthropic(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number
  ): AsyncGenerator<LLMStreamChunk> {
    const stream = await this.retryWithBackoff(
      async () =>
        this.anthropicClient!.messages.stream({
          model: model as any,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
          temperature,
        }),
      `Anthropic streaming call (model: ${model})`,
      { provider: 'anthropic' }
    );

    for await (const chunk of stream as any) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        yield {
          content: chunk.delta.text,
          done: false,
          model_id: model,
        };
      }
    }

    yield {
      content: '',
      done: true,
      model_id: model,
    };
  }

  /**
   * Stream from OpenAI API
   */
  private async *streamOpenAI(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number
  ): AsyncGenerator<LLMStreamChunk> {
    const stream = await this.retryWithBackoff(
      () =>
        this.openaiClient!.chat.completions.create({
          model: model as any,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature,
          stream: true,
        }),
      `OpenAI streaming call (model: ${model})`,
      { provider: 'openai' }
    );

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        yield {
          content,
          done: false,
          model_id: model,
        };
      }
    }

    yield {
      content: '',
      done: true,
      model_id: model,
    };
  }

  /**
   * Simulate streaming (fallback for when SDK not available)
   */
  /**
   * Check if a model is an Anthropic model
   */
  private isAnthropicModel(model: string): boolean {
    return model.startsWith('claude-');
  }

  /**
   * Check if a model is an OpenAI model
   */
  private isOpenAIModel(model: string): boolean {
    return model.startsWith('gpt-') || model.startsWith('o1-');
  }

  /**
   * Retry a function with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    operationName: string,
    options: { provider?: 'anthropic' | 'openai' } = {}
  ): Promise<T> {
    const maxRetries = this.config.maxRetries || 3;
    const baseDelay = this.config.retryBaseDelayMs || 1000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        const authFailure = error instanceof Error && this.isAuthError(error);
        if (authFailure && options.provider) {
          const currentKey =
            options.provider === 'anthropic' ? this.currentAnthropicKey : this.currentOpenAIKey;
          if (currentKey) {
            const rotated = await this.handleKeyFailure(options.provider, currentKey, error);
            if (!rotated) {
              throw error;
            }
          }
        }

        // Don't retry on certain errors (e.g., invalid requests)
        if (error instanceof Error && this.isNonRetryableError(error)) {
          throw error;
        }

        // Don't retry after the last attempt
        if (attempt === maxRetries) {
          break;
        }

        // Check if this is a rate limit error
        let delay: number;
        const rateLimitDelay = this.getRateLimitRetryDelay(error as Error);
        
        if (rateLimitDelay !== null) {
          delay = rateLimitDelay;
          this.logger.warn('LLM call hit rate limit; retrying after Retry-After delay', {
            operation: operationName,
            attempt: attempt + 1,
            max_attempts: maxRetries + 1,
            delay_ms: delay,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          // Calculate exponential backoff delay
          delay = baseDelay * Math.pow(2, attempt);
          this.logger.warn('LLM call failed; retrying with exponential backoff', {
            operation: operationName,
            attempt: attempt + 1,
            max_attempts: maxRetries + 1,
            delay_ms: delay,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        
        await this.sleep(delay);
      }
    }

    throw new Error(
      `${operationName} failed after ${maxRetries + 1} attempts. Last error: ${lastError?.message}`
    );
  }

  /**
   * Check if an error is non-retryable (e.g., authentication errors)
   */
  private isNonRetryableError(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();
    
    // Invalid request errors (but not rate limit errors)
    if (errorMessage.includes('invalid') && errorMessage.includes('request') && !errorMessage.includes('429')) {
      return true;
    }
    
    return false;
  }

  private isAuthError(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();
    return errorMessage.includes('unauthorized') || errorMessage.includes('401') || errorMessage.includes('invalid api key');
  }

  /**
   * Check if an error is a rate limit error and extract retry delay
   */
  private getRateLimitRetryDelay(error: Error): number | null {
    const errorMessage = error.message.toLowerCase();

    const status = (error as any).status || (error as any).statusCode || (error as any).response?.status;
    const headers = (error as any).headers || (error as any).response?.headers || {};
    const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];

    // Check for 429 status code
    if (status === 429 || errorMessage.includes('429') || errorMessage.includes('rate limit')) {
      // Try to extract Retry-After header
      const retryAfterRaw = Array.isArray(retryAfterHeader)
        ? retryAfterHeader[0]
        : retryAfterHeader;
      if (retryAfterRaw) {
        const retryAfterSeconds = parseInt(String(retryAfterRaw), 10);
        if (!isNaN(retryAfterSeconds)) {
          return retryAfterSeconds * 1000; // Convert to milliseconds
        }
      }

      // Try to extract Retry-After from error message
      const retryAfterMatch = errorMessage.match(/retry-after[:\s]+(\d+)/i);
      if (retryAfterMatch) {
        const retryAfterSeconds = parseInt(retryAfterMatch[1], 10);
        if (!isNaN(retryAfterSeconds)) {
          return retryAfterSeconds * 1000;
        }
      }

      return 5000; // 5 seconds default
    }

    return null;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Call Anthropic API
   */
  private async callAnthropic(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number
  ): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic client not initialized');
    }

    return this.retryWithBackoff(async () => {
      const message = await this.anthropicClient!.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Extract text content from response
      const textContent = message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      return {
        content: textContent,
        inputTokens: message.usage?.input_tokens ?? Number.NaN,
        outputTokens: message.usage?.output_tokens ?? Number.NaN,
      };
    }, `Anthropic API call (model: ${model})`, { provider: 'anthropic' });
  }

  /**
   * Call OpenAI API
   */
  private async callOpenAI(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number
  ): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    return this.retryWithBackoff(async () => {
      const completion = await this.openaiClient!.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: maxTokens,
        temperature,
      });

      return {
        content: completion.choices[0]?.message?.content || '',
        inputTokens: completion.usage?.prompt_tokens ?? Number.NaN,
        outputTokens: completion.usage?.completion_tokens ?? Number.NaN,
      };
    }, `OpenAI API call (model: ${model})`, { provider: 'openai' });
  }

  /**
   * Get total cost incurred
   */
  getTotalCostUsd(): number {
    return this.totalCostUsd;
  }

  /**
   * Get total tokens used
   */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /**
   * Get call count
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.totalCostUsd = 0;
    this.totalTokens = 0;
    this.callCount = 0;
    this.persistMetrics();
  }

  /**
   * Get model by tier
   */
  getModelByTier(tier: 'tier1' | 'tier2' | 'tier3', preferredModel?: string): string {
    if (preferredModel && MODEL_PRICING[preferredModel]) return preferredModel;
    const resolved = MODEL_RESOLUTION_CHAIN.find(entry => entry.tier === tier && entry.model);
    return resolved?.model || MODEL_TIERS[tier];
  }

  getModelResolutionChain(): typeof MODEL_RESOLUTION_CHAIN {
    return MODEL_RESOLUTION_CHAIN;
  }

  private loadPersistedMetrics(): void {
    if (!this.metricsPersistencePath || !fs.existsSync(this.metricsPersistencePath)) {
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.metricsPersistencePath, 'utf8'));
      this.totalCostUsd = typeof parsed.totalCostUsd === 'number' ? parsed.totalCostUsd : 0;
      this.totalTokens = typeof parsed.totalTokens === 'number' ? parsed.totalTokens : 0;
      this.callCount = typeof parsed.callCount === 'number' ? parsed.callCount : 0;
    } catch (error) {
      this.logger.warn('Failed to load persisted LLM metrics', { error: String(error) });
    }
  }

  private persistMetrics(): void {
    if (!this.metricsPersistencePath) {
      return;
    }

    try {
      const dir = path.dirname(this.metricsPersistencePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.metricsPersistencePath, JSON.stringify({
        totalCostUsd: this.totalCostUsd,
        totalTokens: this.totalTokens,
        callCount: this.callCount,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch (error) {
      this.logger.warn('Failed to persist LLM metrics', { error: String(error) });
    }
  }
}
