/**
 * Cryptographic utilities for GAgent
 */

import { createHash, randomBytes } from 'crypto';

export function hash(data: string, algorithm: string = 'sha256'): string {
  return createHash(algorithm).update(data).digest('hex');
}

export function generateSalt(length: number = 16): string {
  return randomBytes(length).toString('hex');
}

export function hashWithSalt(data: string, salt: string): string {
  return hash(salt + data);
}

export function generateToken(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

export function verifyHash(data: string, hash: string, salt: string): boolean {
  return hashWithSalt(data, salt) === hash;
}
