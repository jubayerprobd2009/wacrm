import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/crypto/encryption';
import { normalizePhone, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { verifyTwilioWebhookSignature } from '@/lib/sms/webhook-signature';
import { updateLeadStatus } from '@/lib/contacts/lead-status';

// ============================================================
// POST /api/sms/webhook — inbound Twilio SMS delivery.
//
// Twilio POSTs `application/x-www-form-urlencoded`, one message per
// request (no batching, unlike Meta). Response body is TwiML (or
// empty 200) — Twilio doesn't care about JSON here, it only cares
// about the 2xx status.
//
// Flow, in order:
//   1. verify the Twilio signature (fail closed);
//   2. find-or-create the contact + conversation for the sender;
//   3. STOP/opt-out keyword check — set do_not_contact BEFORE
//      persisting the message, so even if something downstream throws,
//      the suppression flag is already durable;
//   4. persist the inbound message;
//   5. hand off to the AI outreach/qualification dispatcher (Phase 4)
//      in `after()`, so Twilio gets its 200 immediately and slow LLM
//      calls never risk a webhook timeout/retry storm.
//
// Multi-tenant note: unlike the WhatsApp webhook (one shared Meta App
// routes by phone_number_id in the payload), each account's Twilio
// number webhook URL is configured with an account-identifying query
// param (`?account=<uuid>`) at setup time in Twilio's console — Twilio
// has no equivalent of Meta's payload-embedded routing key.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const accountId = url.searchParams.get('account');
  if (!accountId) {
    return NextResponse.json({ error: 'Missing account query param' }, { status: 400 });
  }

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));

  const admin = supabaseAdmin();

  const { data: config } = await admin
    .from('sms_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!config) {
    // No config → we can't verify the signature (no auth token to
    // check against) → fail closed rather than trust an unverifiable
    // payload.
    return NextResponse.json({ error: 'SMS not configured for this account' }, { status: 404 });
  }

  const authToken = decrypt(config.twilio_auth_token);
  const signature = request.headers.get('x-twilio-signature');

  // Twilio signs the exact public URL it was configured to POST to —
  // reconstruct it from the request rather than trusting a header a
  // proxy could have altered, matching the Meta webhook's posture of
  // never trusting client-supplied routing hints for the crypto check.
  const publicUrl = `${url.origin}${url.pathname}${url.search}`;

  if (!verifyTwilioWebhookSignature(authToken, publicUrl, params, signature)) {
    console.error('[sms webhook] signature verification failed for account', accountId);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const from = params.From;
  const body = params.Body ?? '';
  const twilioMessageId = params.MessageSid ?? params.SmsSid ?? '';

  if (!from) {
    return NextResponse.json({ error: 'Missing From' }, { status: 400 });
  }

  const sanitizedPhone = sanitizePhoneForMeta(from);
  const normalized = normalizePhone(from);

  // ---- find-or-create contact -----------------------------------
  let contact = await findExistingContact(admin, accountId, normalized);
  if (!contact) {
    const { data: created, error: createErr } = await admin
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: config.user_id ?? (await resolveAccountOwner(admin, accountId)),
        phone: sanitizedPhone,
        name: sanitizedPhone,
        lead_source: 'sms_inbound',
      })
      .select('*')
      .single();

    if (createErr || !created) {
      if (isUniqueViolation(createErr)) {
        contact = await findExistingContact(admin, accountId, normalized);
      }
      if (!contact) {
        console.error('[sms webhook] contact create error:', createErr);
        return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 });
      }
    } else {
      contact = created;
    }
  }

  // Every branch above either returns early or assigns `contact` — this
  // guard just makes that explicit for TypeScript's control-flow
  // analysis, which can't see through the nested reassignment.
  if (!contact) {
    return NextResponse.json({ error: 'Failed to resolve contact' }, { status: 500 });
  }

  // ---- STOP / opt-out — before anything else persists ------------
  if (STOP_KEYWORDS.test(body)) {
    const { error: optOutErr } = await admin
      .from('contacts')
      .update({
        do_not_contact: true,
        do_not_contact_at: new Date().toISOString(),
      })
      .eq('id', contact.id);
    if (optOutErr) {
      console.error('[sms webhook] failed to record opt-out:', optOutErr);
    }
    await updateLeadStatus(admin, accountId, contact.id, 'do_not_contact');

    await admin
      .from('lead_outreach_state')
      .update({ stage: 'opted_out' })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id);
    // If no lead_outreach_state row exists yet (this contact was never
    // in the outreach flow), there's nothing to update — fine, the
    // do_not_contact flag on the contact is the authoritative gate.
  }

  // ---- conversation (one per account+contact, channel='sms') -----
  const { data: existingConv } = await admin
    .from('conversations')
    .select('id, status, unread_count')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  let conversationId: string;
  if (existingConv) {
    conversationId = existingConv.id;
    await reopenClosedConversation(admin, existingConv);
  } else {
    const { data: newConv, error: convErr } = await admin
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: contact.user_id,
        contact_id: contact.id,
        channel: 'sms',
      })
      .select('id')
      .single();
    if (convErr || !newConv) {
      console.error('[sms webhook] conversation create error:', convErr);
      return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
    }
    conversationId = newConv.id;
  }

  // ---- persist inbound message ------------------------------------
  const { error: msgErr } = await admin.from('messages').insert({
    conversation_id: conversationId,
    channel: 'sms',
    sender_type: 'customer',
    content_type: 'text',
    content_text: body,
    message_id: twilioMessageId || null,
    status: 'delivered',
  });
  if (msgErr) {
    console.error('[sms webhook] message insert error:', msgErr);
  } else {
    await admin
      .from('conversations')
      .update({
        last_message_text: body,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        unread_count: (existingConv?.unread_count || 0) + 1,
      })
      .eq('id', conversationId);
  }

  // ---- AI outreach/qualification dispatch (Phase 4) ---------------
  // Deferred to `after()` so Twilio's webhook gets its 200 immediately
  // and a slow LLM call can't turn into a Twilio retry storm. The
  // dispatcher itself checks `do_not_contact` first and no-ops for
  // opted-out contacts, so it's safe to always schedule this call.
  after(async () => {
    try {
      const { dispatchInboundToLeadOutreach } = await import('@/lib/ai/lead-outreach-dispatch');
      await dispatchInboundToLeadOutreach(admin, accountId, contact.id, conversationId);
    } catch (err) {
      console.error('[sms webhook] outreach dispatch failed:', err instanceof Error ? err.message : err);
    }
  });

  return NextResponse.json({ ok: true });
}

async function resolveAccountOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  accountId: string,
): Promise<string> {
  const { data } = await admin.from('accounts').select('owner_user_id').eq('id', accountId).single();
  return data.owner_user_id;
}
