import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTwilioWebhookSignature } from './webhook-signature';

const TOKEN = 'test-auth-token';
const URL = 'https://example.com/api/sms/webhook?account=acc-1';
const PARAMS = { From: '+15551234567', Body: 'Hello', MessageSid: 'SM123' };

function signedHeader(
  url: string,
  params: Record<string, string>,
  token: string = TOKEN,
): string {
  const sorted = Object.keys(params).sort();
  const data = sorted.reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

describe('verifyTwilioWebhookSignature', () => {
  it('accepts a request signed with the correct token', () => {
    expect(verifyTwilioWebhookSignature(TOKEN, URL, PARAMS, signedHeader(URL, PARAMS))).toBe(true);
  });

  it('rejects a signature computed with a different token', () => {
    expect(
      verifyTwilioWebhookSignature(TOKEN, URL, PARAMS, signedHeader(URL, PARAMS, 'wrong-token')),
    ).toBe(false);
  });

  it('rejects when the URL does not match exactly', () => {
    const header = signedHeader(URL, PARAMS);
    expect(
      verifyTwilioWebhookSignature(TOKEN, 'https://example.com/api/sms/webhook?account=acc-2', PARAMS, header),
    ).toBe(false);
  });

  it('rejects when a param is tampered with', () => {
    const header = signedHeader(URL, PARAMS);
    const tampered = { ...PARAMS, Body: 'Tampered' };
    expect(verifyTwilioWebhookSignature(TOKEN, URL, tampered, header)).toBe(false);
  });

  it('fails closed when the auth token is missing', () => {
    expect(verifyTwilioWebhookSignature(undefined, URL, PARAMS, signedHeader(URL, PARAMS))).toBe(false);
  });

  it('fails closed when the signature header is missing', () => {
    expect(verifyTwilioWebhookSignature(TOKEN, URL, PARAMS, null)).toBe(false);
  });

  it('is order-independent for params (sorts before signing)', () => {
    const header = signedHeader(URL, PARAMS);
    const reordered = { Body: PARAMS.Body, MessageSid: PARAMS.MessageSid, From: PARAMS.From };
    expect(verifyTwilioWebhookSignature(TOKEN, URL, reordered, header)).toBe(true);
  });
});
