import { NextResponse } from 'next/server';
import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { encrypt, decrypt } from '@/lib/crypto/encryption';
import {
  WaSenderClient,
  WaSenderApiError,
} from '@/lib/whatsapp/providers/wasender/client';
import { assertSafeOperatorUrl, SsrfGuardError } from '@/lib/http/ssrf-guard';

// ============================================================
// /api/whatsapp/unofficial/config — CRUD for `whatsapp_unofficial_config`
// (047_whatsapp_unofficial_config.sql). Admin-gated writes, never
// returns decrypted secrets (mirrors `/api/sms/config`'s `has_token`
// pattern).
//
// Phase 4/5 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// CO-EDIT NOTICE: this file is shared with a parallel Evolution-API
// agent. Only the `wasender`-provider branches below are this task's
// scope — the Evolution branch in POST is an explicit, clearly marked
// gap for that agent to fill in. Do not remove or restructure the
// wasender logic when extending this file.
// ============================================================

const SELECT_COLUMNS =
  'id, provider, status, is_primary, inbound_token, phone_number, connected_at, ' +
  'last_inbound_at, last_status_error, api_key, webhook_secret, base_url, ' +
  'admin_api_key, instance_name, instance_token, display_name';

interface WhatsAppUnofficialConfigRow {
  id: string;
  provider: 'wasender' | 'evolution';
  status: 'connected' | 'disconnected' | 'pending';
  is_primary: boolean;
  inbound_token: string;
  phone_number: string | null;
  connected_at: string | null;
  last_inbound_at: string | null;
  last_status_error: string | null;
  api_key: string | null;
  webhook_secret: string | null;
  base_url: string | null;
  admin_api_key: string | null;
  instance_name: string | null;
  instance_token: string | null;
  display_name: string | null;
}

/**
 * Redact every encrypted secret column down to a `has_*` boolean —
 * the wire response never carries ciphertext, let alone plaintext.
 */
function redact(row: WhatsAppUnofficialConfigRow) {
  const {
    api_key,
    webhook_secret,
    admin_api_key,
    instance_token,
    ...safe
  } = row;
  return {
    ...safe,
    has_api_key: !!api_key,
    has_webhook_secret: !!webhook_secret,
    has_admin_api_key: !!admin_api_key,
    has_instance_token: !!instance_token,
  };
}

/**
 * GET /api/whatsapp/unofficial/config
 *
 * Any member may read connection state — provider-agnostic (works the
 * same whether the saved row is `wasender` or `evolution`), so no
 * branching needed here.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const { data, error } = await supabase
      .from('whatsapp_unofficial_config')
      .select(SELECT_COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[whatsapp/unofficial/config GET] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load WhatsApp Unofficial configuration' },
        { status: 500 }
      );
    }

    if (!data) return NextResponse.json({ configured: false });

    return NextResponse.json({
      configured: true,
      ...redact(data as unknown as WhatsAppUnofficialConfigRow),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/whatsapp/unofficial/config  (admin+)
 *
 * Body: `{ provider: 'wasender' | 'evolution', ... }`.
 *
 * wasender: `{ provider: 'wasender', api_key: string }` — validated
 * live via `GET /status` before the row is upserted; the API key is
 * stored AES-256-GCM-encrypted. `status` mirrors WaSenderAPI's own
 * reported session status (it may come back already `connected` if
 * the number was linked outside this flow, or `pending` otherwise —
 * WaSenderAPI has no webhook-registration API, so the two-step UI
 * (Phase 5) still needs the operator to paste back a Webhook Secret
 * via PATCH before inbound events will verify).
 *
 * evolution: `{ provider: 'evolution', base_url: string, admin_api_key?: string }`
 * — only persists these two fields (encrypted at rest); instance
 * creation/QR/connect happens via the dedicated
 * `.../unofficial/evolution/connect` route, not here.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(`whatsapp-unofficial-config:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { provider } = body as Record<string, unknown>;

    if (provider === 'wasender') {
      return handleWaSenderConnect(supabase, accountId, body as Record<string, unknown>);
    }

    if (provider === 'evolution') {
      return handleEvolutionConnect(supabase, accountId, body as Record<string, unknown>);
    }

    return NextResponse.json(
      { error: 'provider must be "wasender" or "evolution"' },
      { status: 400 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function handleWaSenderConnect(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  body: Record<string, unknown>
): Promise<NextResponse> {
  const { api_key } = body;

  let apiKeyPlain: string;
  if (typeof api_key === 'string' && api_key.trim()) {
    apiKeyPlain = api_key.trim();
  } else {
    const { data: existing } = await supabase
      .from('whatsapp_unofficial_config')
      .select('api_key')
      .eq('account_id', accountId)
      .eq('provider', 'wasender')
      .maybeSingle();
    if (!existing?.api_key) {
      return NextResponse.json({ error: 'api_key is required' }, { status: 400 });
    }
    apiKeyPlain = decrypt(existing.api_key);
  }

  const client = new WaSenderClient({ apiKey: apiKeyPlain });

  let sessionStatus: 'connected' | 'disconnected' | 'pending' = 'pending';
  let phoneNumber: string | null = null;
  try {
    const statusResult = await client.getStatus();
    const normalized = String(statusResult.status ?? '').toLowerCase();
    if (normalized.includes('connect') && !normalized.includes('disconnect')) {
      sessionStatus = 'connected';
    } else if (normalized.includes('disconnect') || normalized.includes('logout')) {
      sessionStatus = 'disconnected';
    }
    if (typeof statusResult.phone_number === 'string') phoneNumber = statusResult.phone_number;
    else if (typeof statusResult.phoneNumber === 'string') phoneNumber = statusResult.phoneNumber;
  } catch (err) {
    const message =
      err instanceof WaSenderApiError ? err.message : 'Could not verify WaSenderAPI credentials';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('whatsapp_unofficial_config')
    .upsert(
      {
        account_id: accountId,
        provider: 'wasender',
        api_key: encrypt(apiKeyPlain),
        status: sessionStatus,
        phone_number: phoneNumber,
        ...(sessionStatus === 'connected' ? { connected_at: new Date().toISOString() } : {}),
      },
      { onConflict: 'account_id' }
    )
    .select(SELECT_COLUMNS)
    .single();

  if (error) {
    console.error('[whatsapp/unofficial/config POST] upsert error:', error);
    return NextResponse.json(
      { error: 'Failed to save WhatsApp Unofficial configuration' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    configured: true,
    ...redact(data as unknown as WhatsAppUnofficialConfigRow),
  });
}

/**
 * evolution branch of POST — persists `base_url`/`admin_api_key` only.
 * Instance lifecycle (create/QR/poll/teardown) is deliberately NOT
 * done here — it lives in the dedicated
 * `.../unofficial/evolution/{connect,qr,status,disconnect}` routes
 * (Phase 4/5 of the plan), which is what actually calls
 * `POST /instance/create` and registers the webhook. This endpoint
 * just gives the settings form somewhere to save the two fields
 * before the user clicks "Connect", and lets an admin update them
 * later without re-running the instance-creation flow.
 */
async function handleEvolutionConnect(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  body: Record<string, unknown>
): Promise<NextResponse> {
  const { base_url, admin_api_key } = body;

  if (typeof base_url !== 'string' || !base_url.trim()) {
    return NextResponse.json({ error: 'base_url is required' }, { status: 400 });
  }

  try {
    await assertSafeOperatorUrl(base_url.trim(), 'base_url');
  } catch (err) {
    if (err instanceof SsrfGuardError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  let adminApiKeyPlain: string | undefined;
  if (typeof admin_api_key === 'string' && admin_api_key.trim()) {
    adminApiKeyPlain = admin_api_key.trim();
  } else {
    const { data: existing } = await supabase
      .from('whatsapp_unofficial_config')
      .select('admin_api_key')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle();
    if (existing?.admin_api_key) {
      adminApiKeyPlain = decrypt(existing.admin_api_key);
    }
  }
  if (!adminApiKeyPlain) {
    adminApiKeyPlain = process.env.EVOLUTION_API_KEY?.trim();
  }
  if (!adminApiKeyPlain) {
    return NextResponse.json({ error: 'admin_api_key is required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('whatsapp_unofficial_config')
    .upsert(
      {
        account_id: accountId,
        provider: 'evolution',
        status: 'pending',
        base_url: base_url.trim(),
        admin_api_key: encrypt(adminApiKeyPlain),
      },
      { onConflict: 'account_id' }
    )
    .select(SELECT_COLUMNS)
    .single();

  if (error) {
    console.error('[whatsapp/unofficial/config POST evolution] upsert error:', error);
    return NextResponse.json(
      { error: 'Failed to save Evolution configuration' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    configured: true,
    ...redact(data as unknown as WhatsAppUnofficialConfigRow),
  });
}

/**
 * PATCH /api/whatsapp/unofficial/config  (admin+)
 *
 * Body: `{ webhook_secret: string }` — the Webhook Secret the operator
 * copies back from WaSenderAPI's own dashboard after pasting our
 * webhook URL in (WaSenderAPI has no webhook-registration API, so this
 * round-trip can't be automated away — see the plan's risk list).
 * wasender-only: Evolution auto-registers its webhook and never needs
 * this endpoint.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(`whatsapp-unofficial-config:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { webhook_secret } = body as Record<string, unknown>;
    if (typeof webhook_secret !== 'string' || !webhook_secret.trim()) {
      return NextResponse.json({ error: 'webhook_secret is required' }, { status: 400 });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('whatsapp_unofficial_config')
      .select('id, provider')
      .eq('account_id', accountId)
      .maybeSingle();

    if (fetchError) {
      console.error('[whatsapp/unofficial/config PATCH] fetch error:', fetchError);
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json(
        { error: 'No WhatsApp Unofficial connection to update — connect a provider first' },
        { status: 404 }
      );
    }
    if (existing.provider !== 'wasender') {
      return NextResponse.json(
        { error: 'webhook_secret only applies to the WaSenderAPI connection' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('whatsapp_unofficial_config')
      .update({ webhook_secret: encrypt(webhook_secret.trim()) })
      .eq('id', existing.id)
      .select(SELECT_COLUMNS)
      .single();

    if (error) {
      console.error('[whatsapp/unofficial/config PATCH] update error:', error);
      return NextResponse.json({ error: 'Failed to save webhook secret' }, { status: 500 });
    }

    return NextResponse.json({
      configured: true,
      ...redact(data as unknown as WhatsAppUnofficialConfigRow),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/whatsapp/unofficial/config  (admin+) — disconnect,
 * regardless of which provider is saved.
 *
 * The dedicated `.../evolution/disconnect` route is what the Settings
 * UI actually calls for Evolution, and does the same Evolution-side
 * logout+delete this branch does. This generic endpoint still needs to
 * do it too: it's directly reachable (API client, admin scripting, a
 * future UI change) for an Evolution-provider account, and deleting
 * only the DB row would leave the remote Evolution instance running
 * and unreachable forever with no error surfaced anywhere.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const { data: existing } = await supabase
      .from('whatsapp_unofficial_config')
      .select('id, provider, base_url, admin_api_key, instance_name')
      .eq('account_id', accountId)
      .maybeSingle();

    if (existing?.provider === 'evolution' && existing.instance_name && existing.admin_api_key) {
      const { logoutInstance, deleteInstance } = await import(
        '@/lib/whatsapp/providers/evolution/client'
      );
      const clientConfig = {
        baseUrl: existing.base_url,
        adminApiKey: decrypt(existing.admin_api_key),
      };
      try {
        await logoutInstance(clientConfig, existing.instance_name);
      } catch (err) {
        console.warn('[whatsapp/unofficial/config DELETE] evolution logout failed (continuing):', err);
      }
      try {
        await deleteInstance(clientConfig, existing.instance_name);
      } catch (err) {
        console.warn('[whatsapp/unofficial/config DELETE] evolution instance delete failed (continuing):', err);
      }
    }

    const { error } = await supabase
      .from('whatsapp_unofficial_config')
      .delete()
      .eq('account_id', accountId);

    if (error) {
      console.error('[whatsapp/unofficial/config DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to disconnect WhatsApp Unofficial' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
