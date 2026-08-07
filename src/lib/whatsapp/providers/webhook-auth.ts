// ============================================================
// Shared webhook-auth helpers for the unofficial WhatsApp providers.
//
// Evolution API has no per-webhook-registration secret of its own —
// we derive one deterministically from an operator-set signing key +
// the instance name, so the same secret can be recomputed at verify
// time without a DB round trip for it specifically (the instance name
// itself IS looked up from `inbound_token`, see the evolution webhook
// route). WaSenderAPI, by contrast, has no webhook-registration API at
// all — the operator pastes a secret generated in WaSenderAPI's own
// dashboard, so that route does a plain stored-secret compare instead
// of a derivation. `timingSafeCompare` below is intentionally generic
// so both routes share it.
// ============================================================

import crypto from 'node:crypto';

/**
 * HMAC-SHA256(signingKey, instanceName) hex digest — the Evolution
 * webhook secret both `POST /webhook/set/{name}` (at connect time) and
 * the webhook route (at verify time) derive independently, so nothing
 * provider-specific needs to be persisted for it.
 */
export function deriveEvolutionWebhookSecret(
  signingKey: string,
  instanceName: string
): string {
  return crypto.createHmac('sha256', signingKey).update(instanceName).digest('hex');
}

/**
 * Constant-time string compare. Wraps `crypto.timingSafeEqual` with a
 * length guard (which itself throws on mismatched-length buffers
 * rather than returning false) — used by both the Evolution webhook
 * route (comparing against a derived secret) and the WaSenderAPI
 * webhook route (comparing against a stored secret), so neither route
 * leaks timing information about how much of the header matched.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
