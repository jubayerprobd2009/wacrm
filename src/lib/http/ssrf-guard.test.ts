import { describe, it, expect, afterEach } from 'vitest';
import { assertSafeOperatorUrl, checkSafeOperatorUrl, SsrfGuardError } from './ssrf-guard';

describe('assertSafeOperatorUrl', () => {
  afterEach(() => {
    delete process.env.EVOLUTION_ALLOW_PRIVATE_URL;
  });

  it('rejects a malformed URL', async () => {
    await expect(assertSafeOperatorUrl('not a url')).rejects.toThrow(SsrfGuardError);
  });

  it('rejects http (requires https)', async () => {
    await expect(assertSafeOperatorUrl('http://8.8.8.8')).rejects.toThrow(/https/);
  });

  it('rejects literal private/loopback IPs even over https', async () => {
    await expect(assertSafeOperatorUrl('https://127.0.0.1')).rejects.toThrow(SsrfGuardError);
    await expect(assertSafeOperatorUrl('https://10.0.0.5')).rejects.toThrow(SsrfGuardError);
    await expect(assertSafeOperatorUrl('https://169.254.169.254')).rejects.toThrow(SsrfGuardError);
  });

  it('rejects localhost / .local / .internal hostnames', async () => {
    await expect(assertSafeOperatorUrl('https://localhost')).rejects.toThrow(SsrfGuardError);
    await expect(assertSafeOperatorUrl('https://foo.local')).rejects.toThrow(SsrfGuardError);
    await expect(assertSafeOperatorUrl('https://foo.internal')).rejects.toThrow(SsrfGuardError);
  });

  it('allows a literal public https IP', async () => {
    await expect(assertSafeOperatorUrl('https://8.8.8.8')).resolves.toBeUndefined();
  });

  it('EVOLUTION_ALLOW_PRIVATE_URL=true skips both the https and private-IP checks', async () => {
    process.env.EVOLUTION_ALLOW_PRIVATE_URL = 'true';
    await expect(assertSafeOperatorUrl('http://localhost:8080')).resolves.toBeUndefined();
    await expect(assertSafeOperatorUrl('http://127.0.0.1:8080')).resolves.toBeUndefined();
  });

  it('still rejects a malformed URL even with the override set', async () => {
    process.env.EVOLUTION_ALLOW_PRIVATE_URL = 'true';
    await expect(assertSafeOperatorUrl('not a url')).rejects.toThrow(SsrfGuardError);
  });
});

describe('checkSafeOperatorUrl', () => {
  it('returns { ok: true } for a safe URL', async () => {
    expect(await checkSafeOperatorUrl('https://8.8.8.8')).toEqual({ ok: true });
  });

  it('returns { ok: false, reason } instead of throwing', async () => {
    const result = await checkSafeOperatorUrl('https://127.0.0.1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/private|reserved/i);
    }
  });
});

// DNS-dependent resolution path (hostname -> lookup()) is exercised by
// src/lib/webhooks/ssrf.test.ts against the shared isPrivateOrReservedIp
// table this module reuses; not re-tested here to avoid a live-DNS
// dependency in this file's suite.
