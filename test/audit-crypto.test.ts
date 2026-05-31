import { describe, it, expect } from '@jest/globals';
import { constantTimeEqual, verifyHash, hashWithSalt, generateSalt } from '../src/security/crypto';

// Regression for #60: secret/token comparisons must be constant-time and correct.
describe('constant-time comparison', () => {
  it('returns true for equal strings and false otherwise', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for differing lengths without throwing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });

  it('verifyHash validates salted hashes correctly', () => {
    const salt = generateSalt();
    const h = hashWithSalt('secret', salt);
    expect(verifyHash('secret', h, salt)).toBe(true);
    expect(verifyHash('wrong', h, salt)).toBe(false);
  });
});
