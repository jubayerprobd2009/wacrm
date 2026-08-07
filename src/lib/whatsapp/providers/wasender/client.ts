// ============================================================
// WaSenderAPI client — typed fetch wrapper.
//
// Base: https://www.wasenderapi.com/api
// Auth: `Authorization: Bearer <api_key>` on every request.
//
// This is Phase 4 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md) — the
// WaSenderAPI branch of the unofficial-WhatsApp connection path.
//
// Endpoints used:
//   GET  /status                    -> { status: 'connected' | 'disconnected' | ... }
//   POST /send-message              -> { to, text } or
//                                       { to, imageUrl|videoUrl|audioUrl|documentUrl, text? }
//   POST /messages/read             -> { key: { id, remoteJid, fromMe } }
//   POST /send-presence-update      -> { jid, type, delayMs? }
//
// Errors are mapped to a small set of typed errors so `adapter.ts` (and
// anything above it) can react without re-parsing HTTP status codes:
//   401     -> WaSenderAuthError    ('provider_auth_error')
//   429     -> WaSenderRateLimitError ('provider_rate_limited')
//   5xx /
//   network -> WaSenderUnavailableError ('provider_unavailable')
//   other   -> WaSenderApiError (generic, carries the status + message)
// ============================================================

export const WASENDER_API_BASE = 'https://www.wasenderapi.com/api';

/** Base class for every typed WaSenderAPI error. */
export class WaSenderApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null) {
    super(message);
    this.name = 'WaSenderApiError';
    this.code = code;
    this.status = status;
  }
}

export class WaSenderAuthError extends WaSenderApiError {
  constructor(message = 'WaSenderAPI rejected the API key') {
    super('provider_auth_error', message, 401);
    this.name = 'WaSenderAuthError';
  }
}

export class WaSenderRateLimitError extends WaSenderApiError {
  constructor(message = 'WaSenderAPI rate limit exceeded') {
    super('provider_rate_limited', message, 429);
    this.name = 'WaSenderRateLimitError';
  }
}

export class WaSenderUnavailableError extends WaSenderApiError {
  constructor(message = 'WaSenderAPI is unavailable') {
    super('provider_unavailable', message, null);
    this.name = 'WaSenderUnavailableError';
  }
}

export interface WaSenderClientConfig {
  apiKey: string;
  /** Overridable for tests; defaults to the real WaSenderAPI host. */
  baseUrl?: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface WaSenderStatusResponse {
  status: string;
  [key: string]: unknown;
}

export interface WaSenderSendMessageArgs {
  to: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  documentUrl?: string;
}

export interface WaSenderSendMessageResult {
  /** WaSenderAPI's message id for the sent message, when present. */
  messageId: string;
  raw: unknown;
}

export interface WaSenderMessageKey {
  id: string;
  remoteJid: string;
  fromMe: boolean;
}

export interface WaSenderPresenceUpdateArgs {
  jid: string;
  type: string;
  delayMs?: number;
}

/**
 * Extract a message id from WaSenderAPI's send-message response.
 * The API's exact envelope isn't pinned down by the plan beyond
 * "typed fetch wrapper" — this defensively checks the shapes seen in
 * WaSenderAPI's docs/community examples (`data.msgId`, `data.key.id`,
 * top-level `msgId`) and falls back to an empty string rather than
 * throwing, since a missing id shouldn't fail an otherwise-successful
 * send (the caller still has the HTTP 200).
 */
function extractMessageId(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const data = (b.data ?? b) as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return '';
  if (typeof data.msgId === 'string') return data.msgId;
  if (typeof data.messageId === 'string') return data.messageId;
  const key = data.key as Record<string, unknown> | undefined;
  if (key && typeof key.id === 'string') return key.id;
  return '';
}

/**
 * Thin, typed fetch wrapper around WaSenderAPI's REST surface.
 * `adapter.ts` builds a `WhatsAppProvider` on top of this; this module
 * knows nothing about the shared provider interface, only WaSenderAPI's
 * own wire shapes.
 */
export class WaSenderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: WaSenderClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? WASENDER_API_BASE;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown }
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      // Network failure (DNS, timeout, connection refused, ...).
      throw new WaSenderUnavailableError(
        err instanceof Error ? err.message : 'WaSenderAPI request failed'
      );
    }

    if (response.status === 401) {
      throw new WaSenderAuthError();
    }
    if (response.status === 429) {
      throw new WaSenderRateLimitError();
    }
    if (response.status >= 500) {
      throw new WaSenderUnavailableError(
        `WaSenderAPI returned ${response.status}`
      );
    }

    let json: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON body — leave json as null, handled below.
      }
    }

    if (!response.ok) {
      let message = `WaSenderAPI error: ${response.status}`;
      if (json && typeof json === 'object') {
        const candidate = (json as Record<string, unknown>).message;
        if (typeof candidate === 'string' && candidate) message = candidate;
      }
      throw new WaSenderApiError('provider_error', message, response.status);
    }

    return json as T;
  }

  /** GET /status — used both to validate a freshly-pasted API key and
   *  to drive `getConnectionStatus()`. */
  async getStatus(): Promise<WaSenderStatusResponse> {
    return this.request<WaSenderStatusResponse>('/status', { method: 'GET' });
  }

  /** POST /send-message — text-only when no media URL is given, or
   *  media + optional caption when one of the `*Url` fields is set. */
  async sendMessage(
    args: WaSenderSendMessageArgs
  ): Promise<WaSenderSendMessageResult> {
    const body = await this.request<unknown>('/send-message', {
      method: 'POST',
      body: args,
    });
    return { messageId: extractMessageId(body), raw: body };
  }

  /** POST /messages/read — mark a single message read. */
  async markMessagesRead(key: WaSenderMessageKey): Promise<void> {
    await this.request('/messages/read', { method: 'POST', body: { key } });
  }

  /** POST /send-presence-update — typing/paused/online indicator. */
  async sendPresenceUpdate(args: WaSenderPresenceUpdateArgs): Promise<void> {
    await this.request('/send-presence-update', { method: 'POST', body: args });
  }
}
