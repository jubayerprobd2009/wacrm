// ============================================================
// SSRF guard for operator-supplied base URLs.
//
// Unlike src/lib/webhooks/ssrf.ts (which guards outbound *webhook
// delivery* URLs), this guards a URL an account admin pastes into
// settings that the server will then repeatedly call as an API base —
// today: Evolution API's `base_url`. Same threat model as the webhook
// guard (an admin-controlled URL, server-side fetch = SSRF primitive
// against the app's own network / cloud metadata endpoint), so this
// reuses `isPrivateOrReservedIp` from that file rather than
// reimplementing the private-range table.
//
// Requirements (per the WhatsApp Unofficial plan): the URL must be
// https and must not resolve to a private/loopback/reserved address.
// `EVOLUTION_ALLOW_PRIVATE_URL=true` disables BOTH checks for local
// dev, where the operator's Evolution instance is typically
// `http://localhost:8080` or similar.
//
// NOT a defense against DNS rebinding (same residual-risk note as
// ssrf.ts) — the resolved IP isn't pinned into the eventual fetch
// socket.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateOrReservedIp } from '@/lib/webhooks/ssrf';

export class SsrfGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfGuardError';
  }
}

function allowPrivateUrls(): boolean {
  return process.env.EVOLUTION_ALLOW_PRIVATE_URL === 'true';
}

/**
 * Throws `SsrfGuardError` if `rawUrl` is not an https URL resolving
 * only to publicly-routable addresses. `label` is folded into the
 * error message so callers can identify which field failed (e.g.
 * `"base_url"`).
 *
 * No-op (never throws) when `EVOLUTION_ALLOW_PRIVATE_URL=true`.
 */
export async function assertSafeOperatorUrl(
  rawUrl: string,
  label = 'base_url'
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfGuardError(`${label} is not a valid URL`);
  }

  if (allowPrivateUrls()) return;

  if (url.protocol !== 'https:') {
    throw new SsrfGuardError(`${label} must use https`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    throw new SsrfGuardError(`${label} points at a local/internal host`);
  }

  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new SsrfGuardError(`${label} points at a private/reserved address`);
    }
    return;
  }

  let results: Array<{ address: string }>;
  try {
    results = await lookup(host, { all: true });
  } catch {
    throw new SsrfGuardError(`${label} host could not be resolved`);
  }
  if (results.length === 0 || results.some((r) => isPrivateOrReservedIp(r.address))) {
    throw new SsrfGuardError(`${label} resolves to a private/reserved address`);
  }
}

/** Non-throwing wrapper — returns `{ ok, reason }` for call sites that
 *  want to surface a 400 without a try/catch. */
export async function checkSafeOperatorUrl(
  rawUrl: string,
  label = 'base_url'
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await assertSafeOperatorUrl(rawUrl, label);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
