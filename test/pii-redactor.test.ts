import { PIIRedactor } from '../src/core/pii-redactor';

describe('PIIRedactor', () => {
  const redactor = new PIIRedactor({
    redact_phone_numbers: true,
    redact_names: true,
    redact_locations: true,
    hash_contact_ids: true,
    knownNames: ['Alice'],
  });

  it('redacts phone, name, location, and hashes contact identifiers deterministically', () => {
    const result = redactor.redact({
      rowid: 7,
      text: 'Alice, call me at +1 (312) 555-0100 from 123 Main St 60601.',
      handle_id: 'alice@example.com',
      date: 0,
    });

    expect(result.text).toContain('[NAME]');
    expect(result.text).toContain('[PHONE]');
    expect(result.text).toContain('[LOCATION]');
    expect(result.text).not.toContain('Alice');
    expect(result.participant_id).toBe(redactor.hashContactId('alice@example.com').slice(0, 16));
    expect(redactor.hashContactId('alice@example.com')).toBe(redactor.hashContactId('ALICE@example.com'));
  });
});

