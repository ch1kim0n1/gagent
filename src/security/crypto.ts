/**
 * Cryptographic utilities for GAgent
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Constant-time comparison of two strings (length-guarded). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Keep timing roughly constant before failing on length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

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
  return constantTimeEqual(hashWithSalt(data, salt), hash);
}
