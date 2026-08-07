// ============================================================
// Evolution API — typed fetch wrapper.
//
// Two-tier `apikey` header auth (Evolution's own convention, not
// Bearer):
//   - "admin" key — the operator's Evolution API key, scoped to
//     instance lifecycle: /instance/create, /instance/connect/{name},
//     /instance/connectionState/{name}, /instance/logout/{name},
//     /instance/delete/{name}, /instance/fetchInstances.
//   - "instance" token — the `hash` Evolution returns from
//     POST /instance/create for THIS instance, scoped to messaging:
//     /webhook/set/{name}, /message/sendText|sendMedia/{name},
//     /chat/markMessageAsRead|sendPresence|getBase64FromMediaMessage/{name}.
//
// Base URL: the config row's `base_url`, falling back to the
// `EVOLUTION_API_URL` env var (mirrors every other provider client
// reading its connection details from either the row or an env
// fallback — useful before a row exists, e.g. a health-check ping).
//
// This file does NOT run the SSRF guard itself (`@/lib/http/ssrf-guard`)
// — that validates the operator-supplied `base_url` once, at the point
// it's accepted from the client (the evolution connect route / the
// config route's evolution branch), not on every call here.
// ============================================================

export interface EvolutionConnectionConfig {
  /** Operator's server URL for their Evolution instance, e.g.
   *  `https://evolution.example.com`. Falls back to `EVOLUTION_API_URL`. */
  baseUrl?: string | null;
  /** Admin apikey — required for instance-lifecycle calls. */
  adminApiKey: string;
  /** Per-instance token ("hash" from /instance/create) — required for
   *  messaging/webhook calls. Omit for admin-only calls
   *  (create/connect/connectionState/logout/delete/fetchInstances). */
  instanceToken?: string | null;
}

export class EvolutionApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'EvolutionApiError';
  }
}

function resolveBaseUrl(config: EvolutionConnectionConfig): string {
  const base = config.baseUrl?.trim() || process.env.EVOLUTION_API_URL?.trim();
  if (!base) {
    throw new Error(
      'Evolution API base_url is not configured (neither the config row nor EVOLUTION_API_URL is set)'
    );
  }
  return base.replace(/\/+$/, '');
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Which apikey tier this endpoint requires. */
  auth: 'admin' | 'instance';
}

async function evolutionRequest<T>(
  config: EvolutionConnectionConfig,
  path: string,
  opts: RequestOptions
): Promise<T> {
  const baseUrl = resolveBaseUrl(config);
  const apikey = opts.auth === 'admin' ? config.adminApiKey : config.instanceToken;
  if (!apikey) {
    throw new Error(
      `Evolution API call to ${path} requires a ${opts.auth} apikey, but none is configured`
    );
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      apikey,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const rawText = await response.text();
  let data: unknown = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = rawText;
    }
  }

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : `Evolution API error: ${response.status}`;
    throw new EvolutionApiError(response.status, message);
  }

  return data as T;
}

// ------------------------------------------------------------
// Instance lifecycle (admin apikey)
// ------------------------------------------------------------

export interface EvolutionCreateInstanceResult {
  instance: { instanceName: string; [key: string]: unknown };
  /** The per-instance token — persist this encrypted as
   *  `whatsapp_unofficial_config.instance_token`. */
  hash: string;
  qrcode?: { base64?: string; code?: string };
}

export async function createInstance(
  config: EvolutionConnectionConfig,
  instanceName: string
): Promise<EvolutionCreateInstanceResult> {
  return evolutionRequest<EvolutionCreateInstanceResult>(config, '/instance/create', {
    method: 'POST',
    auth: 'admin',
    body: { instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
  });
}

export interface EvolutionConnectResult {
  base64?: string;
  code?: string;
  pairingCode?: string;
}

/** GET /instance/connect/{name} — fetches a fresh QR when the one
 *  returned by create has expired (Evolution's QR codes are short-lived). */
export async function fetchConnectQr(
  config: EvolutionConnectionConfig,
  instanceName: string
): Promise<EvolutionConnectResult> {
  return evolutionRequest<EvolutionConnectResult>(
    config,
    `/instance/connect/${encodeURIComponent(instanceName)}`,
    { method: 'GET', auth: 'admin' }
  );
}

export interface EvolutionConnectionStateResult {
  instance: { instanceName: string; state: 'open' | 'connecting' | 'close' | string };
}

export async function getConnectionState(
  config: EvolutionConnectionConfig,
  instanceName: string
): Promise<EvolutionConnectionStateResult> {
  return evolutionRequest<EvolutionConnectionStateResult>(
    config,
    `/instance/connectionState/${encodeURIComponent(instanceName)}`,
    { method: 'GET', auth: 'admin' }
  );
}

export async function logoutInstance(
  config: EvolutionConnectionConfig,
  instanceName: string
): Promise<void> {
  await evolutionRequest(config, `/instance/logout/${encodeURIComponent(instanceName)}`, {
    method: 'DELETE',
    auth: 'admin',
  });
}

export async function deleteInstance(
  config: EvolutionConnectionConfig,
  instanceName: string
): Promise<void> {
  await evolutionRequest(config, `/instance/delete/${encodeURIComponent(instanceName)}`, {
    method: 'DELETE',
    auth: 'admin',
  });
}

export interface EvolutionInstanceInfo {
  instanceName?: string;
  name?: string;
  ownerJid?: string;
  profileName?: string;
  connectionStatus?: string;
  number?: string;
  [key: string]: unknown;
}

/** GET /instance/fetchInstances — used at `status` poll time to stamp
 *  `phone_number` once the instance flips to `open` (Evolution's
 *  connectionState response doesn't include the phone number itself). */
export async function fetchInstances(
  config: EvolutionConnectionConfig,
  instanceName?: string
): Promise<EvolutionInstanceInfo[]> {
  const query = instanceName ? `?instanceName=${encodeURIComponent(instanceName)}` : '';
  const result = await evolutionRequest<EvolutionInstanceInfo[] | EvolutionInstanceInfo>(
    config,
    `/instance/fetchInstances${query}`,
    { method: 'GET', auth: 'admin' }
  );
  return Array.isArray(result) ? result : [result];
}

// ------------------------------------------------------------
// Webhook registration (instance token)
// ------------------------------------------------------------

const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'SEND_MESSAGE',
] as const;

export async function setWebhook(
  config: EvolutionConnectionConfig,
  instanceName: string,
  args: { url: string; secret: string }
): Promise<void> {
  await evolutionRequest(config, `/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    auth: 'instance',
    body: {
      webhook: {
        enabled: true,
        url: args.url,
        events: EVOLUTION_WEBHOOK_EVENTS,
        byEvents: false,
        base64: false,
        headers: { 'X-Webhook-Secret': args.secret },
      },
    },
  });
}

// ------------------------------------------------------------
// Messaging (instance token)
// ------------------------------------------------------------

export interface EvolutionSendResult {
  key: { id: string; remoteJid?: string; fromMe?: boolean };
  [key: string]: unknown;
}

export async function sendText(
  config: EvolutionConnectionConfig,
  instanceName: string,
  args: { to: string; text: string; contextMessageId?: string }
): Promise<EvolutionSendResult> {
  return evolutionRequest<EvolutionSendResult>(
    config,
    `/message/sendText/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      auth: 'instance',
      body: {
        number: args.to,
        text: args.text,
        ...(args.contextMessageId
          ? { quoted: { key: { id: args.contextMessageId } } }
          : {}),
      },
    }
  );
}

export type EvolutionMediaType = 'image' | 'video' | 'document' | 'audio';

export async function sendMedia(
  config: EvolutionConnectionConfig,
  instanceName: string,
  args: {
    to: string;
    mediatype: EvolutionMediaType;
    /** Publicly-fetchable URL Evolution downloads at send time. */
    media: string;
    caption?: string;
    fileName?: string;
    contextMessageId?: string;
  }
): Promise<EvolutionSendResult> {
  return evolutionRequest<EvolutionSendResult>(
    config,
    `/message/sendMedia/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      auth: 'instance',
      body: {
        number: args.to,
        mediatype: args.mediatype,
        media: args.media,
        caption: args.caption,
        fileName: args.fileName,
        ...(args.contextMessageId
          ? { quoted: { key: { id: args.contextMessageId } } }
          : {}),
      },
    }
  );
}

export async function markMessageAsRead(
  config: EvolutionConnectionConfig,
  instanceName: string,
  args: { remoteJid: string; messageId: string; fromMe?: boolean }
): Promise<void> {
  await evolutionRequest(
    config,
    `/chat/markMessageAsRead/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      auth: 'instance',
      body: {
        readMessages: [
          { remoteJid: args.remoteJid, id: args.messageId, fromMe: args.fromMe ?? false },
        ],
      },
    }
  );
}

export type EvolutionPresence = 'composing' | 'recording' | 'paused' | 'available' | 'unavailable';

const DEFAULT_PRESENCE_DELAY_MS = 1200;

/** POST /chat/sendPresence/{name} — `delay` is REQUIRED by Evolution's
 *  API (how long the presence shows before auto-clearing); default
 *  1200ms per the plan. */
export async function sendPresence(
  config: EvolutionConnectionConfig,
  instanceName: string,
  args: { to: string; presence: EvolutionPresence; delayMs?: number }
): Promise<void> {
  await evolutionRequest(config, `/chat/sendPresence/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    auth: 'instance',
    body: {
      number: args.to,
      presence: args.presence,
      delay: args.delayMs ?? DEFAULT_PRESENCE_DELAY_MS,
    },
  });
}

export interface EvolutionMediaBase64Result {
  base64: string;
  mimetype?: string;
  [key: string]: unknown;
}

/** POST /chat/getBase64FromMediaMessage/{name} — Evolution's inbound
 *  media resolution: given the message key from the webhook payload,
 *  returns the media inline as base64 (unlike WaSenderAPI's raw
 *  Baileys envelope, which needs client-side HKDF+AES decrypt). */
export async function getBase64FromMediaMessage(
  config: EvolutionConnectionConfig,
  instanceName: string,
  args: { messageKeyId: string }
): Promise<EvolutionMediaBase64Result> {
  return evolutionRequest<EvolutionMediaBase64Result>(
    config,
    `/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`,
    {
      method: 'POST',
      auth: 'instance',
      body: { message: { key: { id: args.messageKeyId } }, convertToMp4: false },
    }
  );
}
