import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { deriveEvolutionWebhookSecret, timingSafeCompare } from './webhook-auth';

describe('deriveEvolutionWebhookSecret', () => {
  it('is HMAC-SHA256(signingKey, instanceName) hex digest', () => {
    const expected = crypto
      .createHmac('sha256', 'signing-key')
      .update('wacrm-abc123')
      .digest('hex');
    expect(deriveEvolutionWebhookSecret('signing-key', 'wacrm-abc123')).toBe(expected);
  });

  it('is deterministic for the same inputs', () => {
    const a = deriveEvolutionWebhookSecret('key', 'instance-1');
    const b = deriveEvolutionWebhookSecret('key', 'instance-1');
    expect(a).toBe(b);
  });

  it('differs when the signing key differs', () => {
    const a = deriveEvolutionWebhookSecret('key-a', 'instance-1');
    const b = deriveEvolutionWebhookSecret('key-b', 'instance-1');
    expect(a).not.toBe(b);
  });

  it('differs when the instance name differs', () => {
    const a = deriveEvolutionWebhookSecret('key', 'instance-1');
    const b = deriveEvolutionWebhookSecret('key', 'instance-2');
    expect(a).not.toBe(b);
  });
});

describe('timingSafeCompare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeCompare('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeCompare('abc123', 'abc124')).toBe(false);
  });

  it('returns false (not throw) for different-length strings', () => {
    expect(timingSafeCompare('short', 'a-much-longer-string')).toBe(false);
  });

  it('returns false for an empty vs non-empty string', () => {
    expect(timingSafeCompare('', 'nonempty')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeCompare('', '')).toBe(true);
  });
});
