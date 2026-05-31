import { describe, it, expect } from '@jest/globals';
import { PIIRedactor } from '../src/core/pii-redactor';

// Regression for #52: phone regex must not match generic 7-digit IDs.
describe('PIIRedactor phone matching', () => {
  const redactor = new PIIRedactor({
    redact_phone_numbers: true,
    redact_names: false,
    redact_locations: false,
    hash_contact_ids: false,
  });

  it('does NOT redact bare 7-digit identifiers / order numbers', () => {
    expect(redactor.redactText('Order 555-1234 shipped')).toBe('Order 555-1234 shipped');
    expect(redactor.redactText('ref 1234567 done')).toBe('ref 1234567 done');
  });

  it('redacts real phone numbers (international, parenthesized, full national)', () => {
    expect(redactor.redactText('call +1 (312) 555-0100 now')).toContain('[PHONE]');
    expect(redactor.redactText('(312) 555-0100')).toContain('[PHONE]');
    expect(redactor.redactText('312-555-0100')).toContain('[PHONE]');
    expect(redactor.redactText('+44 20 7946 0958')).toContain('[PHONE]');
  });

  it('redacts email addresses', () => {
    expect(redactor.redactText('mail me at a@b.com')).toContain('[EMAIL]');
  });
});
