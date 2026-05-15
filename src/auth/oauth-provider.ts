/**
 * OAuth Provider for GAgent
 */

import { logger } from '../core/logger.js';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

export class OAuthProvider {
  private config: OAuthConfig;
  private tokens: Map<string, OAuthToken> = new Map();

  constructor(config: OAuthConfig) {
    this.config = config;
    logger.info('OAuthProvider initialized');
  }

  getAuthorizationUrl(state: string): string {
    return `https://auth.example.com/authorize?client_id=${this.config.clientId}&redirect_uri=${this.config.redirectUri}&state=${state}`;
  }

  async exchangeCodeForToken(code: string): Promise<OAuthToken> {
    logger.info('Exchanging code for token');
    const token: OAuthToken = {
      accessToken: `token-${Date.now()}`,
      refreshToken: `refresh-${Date.now()}`,
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
    this.tokens.set(token.accessToken, token);
    return token;
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthToken> {
    logger.info('Refreshing access token');
    const token: OAuthToken = {
      accessToken: `token-${Date.now()}`,
      refreshToken,
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
    this.tokens.set(token.accessToken, token);
    return token;
  }

  validateToken(accessToken: string): boolean {
    return this.tokens.has(accessToken);
  }

  revokeToken(accessToken: string): void {
    this.tokens.delete(accessToken);
    logger.info('Token revoked');
  }
}
