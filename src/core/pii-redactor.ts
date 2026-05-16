import * as crypto from 'crypto';
import {
  RawMessage,
  RedactedMessage,
} from '../types/index.js';

export interface PIIRedactionConfig {
  redact_phone_numbers: boolean;
  redact_names: boolean;
  redact_locations: boolean;
  hash_contact_ids: boolean;
  knownNames?: string[];
}

const PHONE_PATTERN = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}/g;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const STREET_PATTERN = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Court|Ct)\b/gi;
const ZIP_PATTERN = /\b\d{5}(?:-\d{4})?\b/g;

export class PIIRedactor {
  constructor(private readonly config: PIIRedactionConfig) {}

  redact(message: RawMessage): RedactedMessage {
    return {
      rowid: message.rowid,
      text: this.redactText(message.text),
      participant_id: this.config.hash_contact_ids ? this.hashContactId(message.handle_id).slice(0, 16) : message.handle_id,
      timestamp: this.appleEpochToIso(message.date),
    };
  }

  redactText(text: string): string {
    let redacted = text;
    if (this.config.redact_phone_numbers) {
      redacted = redacted.replace(PHONE_PATTERN, '[PHONE]').replace(EMAIL_PATTERN, '[EMAIL]');
    }
    if (this.config.redact_names) {
      for (const name of this.config.knownNames || []) {
        if (!name.trim()) continue;
        redacted = redacted.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), '[NAME]');
      }
    }
    if (this.config.redact_locations) {
      redacted = redacted.replace(STREET_PATTERN, '[LOCATION]').replace(ZIP_PATTERN, '[LOCATION]');
    }
    return redacted;
  }

  hashContactId(handleId: string): string {
    return crypto.createHash('sha256').update(handleId.trim().toLowerCase()).digest('hex');
  }

  redactUnknown(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map(item => this.redactUnknown(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (key === 'handle_id') return [key, this.hashContactId(String(entry)).slice(0, 16)];
        return [key, this.redactUnknown(entry)];
      }),
    );
  }

  private appleEpochToIso(value: number): string {
    const appleEpochMs = Date.UTC(2001, 0, 1);
    const millis = value > 10_000_000_000 ? value / 1_000_000 : value * 1000;
    return new Date(appleEpochMs + millis).toISOString();
  }
}

export function defaultDyadRedactor(): PIIRedactor {
  return new PIIRedactor({
    redact_phone_numbers: true,
    redact_names: true,
    redact_locations: true,
    hash_contact_ids: true,
    knownNames: (process.env.DYAD_KNOWN_NAMES || '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

