import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

import { decrypt } from '@/lib/crypto/encryption';
import { processInboundMessage } from '@/lib/whatsapp/inbound/process-inbound';
import { handleStatusUpdate } from '@/lib/whatsapp/inbound/status-updates';
import {
  normalizeWaSenderInboundMessage,
  type WaSenderWebhookPayload,
} from '@/lib/whatsapp/providers/wasender/normalize-inbound';

// Mirrors src/app/api/whatsapp/webhook/route.ts (the Official webhook
// route) — inbound processing can fan out into Flows/Automations/AI
// auto-reply dispatch, so give it headroom beyond the platform default.
export const maxDuration = 60;

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

interface WhatsAppUnofficialConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  provider: string;
  webhook_secret: string | null;
}

/**
 * Verify `X-Webhook-Signature` against the account's stored
 * `webhook_secret` (decrypted). Unlike Meta's HMAC-over-body scheme,
 * WaSenderAPI has no webhook-registration API to negotiate a signing
 * key at request time — the client pastes back a Webhook Secret from
 * WaSenderAPI's own dashboard (Phase 5 UI), which is compared directly
 * against the header value. `timingSafeEqual` requires equal-length
 * buffers, so lengths are guarded first — a mismatched length is just
 * "not equal", not a crash.
 */
function verifyWebhookSignature(secret: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * `messages.update` payload shape — WaSenderAPI relays Baileys' own
 * ack-status updates. Baileys' numeric `status` codes:
 *   0 ERROR, 1 PENDING, 2 SERVER_ACK (sent), 3 DELIVERY_ACK (delivered),
 *   4 READ, 5 PLAYED (treated as read).
 * Mapped onto the app's own status ladder (see
 * `src/lib/whatsapp/inbound/status-updates.ts`) so the same
 * `handleStatusUpdate` helper Meta's webhook uses drives message /
 * broadcast-recipient status mirroring here too.
 */
const BAILEYS_ACK_STATUS: Record<number, string> = {
  0: 'failed',
  1: 'pending',
  2: 'sent',
  3: 'delivered',
  4: 'read',
  5: 'read',
};

interface WaSenderMessagesUpdatePayload {
  event: 'messages.update';
  data?: {
    updates?: Array<{
      key?: { id?: string; remoteJid?: string };
      update?: { status?: number | string };
    }>;
  };
}

interface WaSenderSessionStatusPayload {
  event: 'session.status';
  data?: { status?: string };
}

type WaSenderWebhookEvent =
  | WaSenderWebhookPayload
  | WaSenderMessagesUpdatePayload
  | WaSenderSessionStatusPayload;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const rawBody = await request.text();
  let body: WaSenderWebhookEvent;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_unofficial_config')
    .select('id, account_id, user_id, provider, webhook_secret')
    .eq('inbound_token', token)
    .eq('provider', 'wasender')
    .maybeSingle();

  if (configError) {
    console.error('[wasender/webhook] config lookup failed:', configError);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  const configRow = config as WhatsAppUnofficialConfigRow | null;
  if (!configRow) {
    // No account maps to this token — respond 401 same as a bad
    // signature so an attacker probing tokens can't distinguish
    // "wrong token" from "right token, wrong secret".
    console.warn('[wasender/webhook] no config found for inbound_token');
    return NextResponse.json({ error: 'Not found' }, { status: 401 });
  }

  if (!configRow.webhook_secret) {
    console.warn(
      `[wasender/webhook] account ${configRow.account_id} has no webhook_secret saved yet — rejecting`
    );
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 401 });
  }

  let secret: string;
  try {
    secret = decrypt(configRow.webhook_secret);
  } catch (err) {
    console.error('[wasender/webhook] webhook_secret decryption failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  const signature = request.headers.get('x-webhook-signature');
  if (!verifyWebhookSignature(secret, signature)) {
    // 401 (not 200) so a misconfigured secret is loud, not silently
    // swallowed — mirrors the Official webhook's signature-failure
    // handling.
    console.warn('[wasender/webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  after(async () => {
    try {
      await processWebhookEvent(body, configRow);
    } catch (error) {
      console.error('[wasender/webhook] error processing webhook:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhookEvent(
  body: WaSenderWebhookEvent,
  config: WhatsAppUnofficialConfigRow
) {
  switch (body.event) {
    case 'session.status': {
      const rawStatus = (body as WaSenderSessionStatusPayload).data?.status;
      const status = mapSessionStatus(rawStatus);
      if (!status) {
        console.warn('[wasender/webhook] unrecognized session.status value:', rawStatus);
        return;
      }
      const { error } = await supabaseAdmin()
        .from('whatsapp_unofficial_config')
        .update({
          status,
          ...(status === 'connected' ? { connected_at: new Date().toISOString() } : {}),
        })
        .eq('id', config.id);
      if (error) {
        console.error('[wasender/webhook] failed to update session status:', error);
      }
      return;
    }

    case 'messages.update': {
      const updates = (body as WaSenderMessagesUpdatePayload).data?.updates ?? [];
      for (const update of updates) {
        const id = update.key?.id;
        const rawStatus = update.update?.status;
        if (!id || rawStatus === undefined) continue;
        const status =
          typeof rawStatus === 'number' ? BAILEYS_ACK_STATUS[rawStatus] : rawStatus;
        if (!status) continue;
        await handleStatusUpdate({
          id,
          status,
          timestamp: String(Math.floor(Date.now() / 1000)),
          recipient_id: update.key?.remoteJid ?? '',
        });
      }
      return;
    }

    default: {
      // Inbound message events (messages.upsert / messages.received, or
      // any event WaSenderAPI sends that carries `data.messages`).
      const normalized = normalizeWaSenderInboundMessage(body as WaSenderWebhookPayload);
      if (!normalized) return;

      // Drives the "webhook verified" checkmark in Settings (Phase 5
      // UI) — best-effort, not awaited-critical to the inbound path.
      void supabaseAdmin()
        .from('whatsapp_unofficial_config')
        .update({ last_inbound_at: new Date().toISOString() })
        .eq('id', config.id)
        .then(({ error }: { error: { message: string } | null }) => {
          if (error) {
            console.warn('[wasender/webhook] last_inbound_at update failed:', error.message);
          }
        });

      await processInboundMessage({
        connection: {
          accountId: config.account_id,
          userId: config.user_id,
        },
        message: normalized,
      });
    }
  }
}

function mapSessionStatus(raw: unknown): 'connected' | 'disconnected' | 'pending' | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.toLowerCase();
  if (normalized.includes('connect') && !normalized.includes('disconnect')) return 'connected';
  if (normalized.includes('disconnect') || normalized.includes('logout')) return 'disconnected';
  if (normalized.includes('pending') || normalized.includes('qr') || normalized.includes('connecting')) {
    return 'pending';
  }
  return null;
}
