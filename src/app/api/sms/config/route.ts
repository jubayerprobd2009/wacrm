import { NextResponse } from 'next/server';
import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { encrypt, decrypt } from '@/lib/crypto/encryption';
import { verifyTwilioAccount, TwilioApiError } from '@/lib/sms/twilio-api';

/**
 * GET /api/sms/config
 *
 * Any member may read whether SMS is configured — the encrypted auth
 * token is never returned, only a `has_token` flag (mirrors
 * `/api/ai/config`'s `has_key`).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const { data, error } = await supabase
      .from('sms_config')
      .select('twilio_account_sid, twilio_phone_number, messaging_service_sid, support_contact, is_active, twilio_auth_token')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[sms/config GET] fetch error:', error);
      return NextResponse.json({ error: 'Failed to load SMS configuration' }, { status: 500 });
    }

    if (!data) return NextResponse.json({ configured: false });

    const { twilio_auth_token, ...safe } = data;
    return NextResponse.json({
      configured: true,
      has_token: !!twilio_auth_token,
      ...safe,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/sms/config  (admin+)
 *
 * Upsert the account's Twilio config. Verifies the Account SID + Auth
 * Token against Twilio before persisting (mirrors the WhatsApp config
 * verifying with Meta first), then stores the token AES-256-GCM
 * encrypted. When `twilio_auth_token` is omitted, the existing stored
 * token is reused — the settings form only sends it when re-entered.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(`sms-config:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const {
      twilio_account_sid,
      twilio_auth_token,
      twilio_phone_number,
      messaging_service_sid,
      support_contact,
    } = body as Record<string, unknown>;

    if (typeof twilio_account_sid !== 'string' || !twilio_account_sid.trim()) {
      return NextResponse.json({ error: 'twilio_account_sid is required' }, { status: 400 });
    }
    if (typeof twilio_phone_number !== 'string' || !twilio_phone_number.trim()) {
      return NextResponse.json({ error: 'twilio_phone_number is required' }, { status: 400 });
    }

    let authTokenPlain: string;
    if (typeof twilio_auth_token === 'string' && twilio_auth_token.trim()) {
      authTokenPlain = twilio_auth_token.trim();
    } else {
      const { data: existing } = await supabase
        .from('sms_config')
        .select('twilio_auth_token')
        .eq('account_id', accountId)
        .maybeSingle();
      if (!existing?.twilio_auth_token) {
        return NextResponse.json({ error: 'twilio_auth_token is required' }, { status: 400 });
      }
      authTokenPlain = decrypt(existing.twilio_auth_token);
    }

    try {
      await verifyTwilioAccount(twilio_account_sid.trim(), authTokenPlain);
    } catch (err) {
      const message = err instanceof TwilioApiError ? err.message : 'Could not verify Twilio credentials';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('sms_config')
      .upsert(
        {
          account_id: accountId,
          twilio_account_sid: twilio_account_sid.trim(),
          twilio_auth_token: encrypt(authTokenPlain),
          twilio_phone_number: twilio_phone_number.trim(),
          messaging_service_sid:
            typeof messaging_service_sid === 'string' && messaging_service_sid.trim()
              ? messaging_service_sid.trim()
              : null,
          support_contact:
            typeof support_contact === 'string' && support_contact.trim() ? support_contact.trim() : null,
          is_active: true,
        },
        { onConflict: 'account_id' },
      )
      .select('twilio_account_sid, twilio_phone_number, messaging_service_sid, support_contact, is_active')
      .single();

    if (error) {
      console.error('[sms/config POST] upsert error:', error);
      return NextResponse.json({ error: 'Failed to save SMS configuration' }, { status: 500 });
    }

    return NextResponse.json({ configured: true, ...data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/sms/config  (admin+) — disconnect Twilio.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const { error } = await supabase.from('sms_config').delete().eq('account_id', accountId);
    if (error) {
      console.error('[sms/config DELETE] error:', error);
      return NextResponse.json({ error: 'Failed to disconnect SMS' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
