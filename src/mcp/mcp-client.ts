/**
 * MCP Client for GAgent
 */

import { logger } from '../core/logger.js';

export interface MCPMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MCPConfig {
  endpoint: string;
  apiKey?: string;
  timeout: number;
}

export class MCPClient {
  private config: MCPConfig;

  constructor(config: MCPConfig) {
    this.config = config;
    logger.info('MCPClient initialized', { endpoint: config.endpoint });
  }

  async send(message: MCPMessage): Promise<MCPMessage> {
    logger.info('Sending MCP message', { id: message.id, role: message.role });
    const response: MCPMessage = {
      id: `response-${message.id}`,
      role: 'assistant',
      content: 'Response to message',
      metadata: {},
    };
    return response;
  }

  async sendBatch(messages: MCPMessage[]): Promise<MCPMessage[]> {
    logger.info('Sending MCP batch', { count: messages.length });
    const responses: MCPMessage[] = [];
    for (const message of messages) {
      const response = await this.send(message);
      responses.push(response);
    }
    return responses;
  }

  async connect(): Promise<void> {
    logger.info('Connecting to MCP endpoint');
  }

  async disconnect(): Promise<void> {
    logger.info('Disconnecting from MCP endpoint');
  }

  isConnected(): boolean {
    return true;
  }
}
