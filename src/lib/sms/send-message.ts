// ============================================================
// Outbound SMS send — the core that `/api/sms/send` and the AI
// outreach/qualification dispatcher (Phase 4) both call.
//
// Mirrors `src/lib/whatsapp/send-message.ts` structurally (load
// conversation+contact+config, send, persist, pause any active flow)
// but is deliberately simpler: SMS has no templates, no media, no
// phone-variant sandbox retry — just text.
//
// The one non-negotiable step, ahead of everything else: the
// `do_not_contact` gate. A contact who has texted STOP must never
// receive another automation-originated SMS, regardless of what
// `lead_status` an in-flight automation step tries to set — this is
// why the check happens here, in the single chokepoint every send
// path funnels through, rather than trusting every call site to
// remember it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendSms } from '@/lib/sms/twilio-api';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/crypto/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
// Transport-agnostic despite the module name — see that file's header
// comment. Reused here rather than duplicated so both channels' route
// handlers can share one error-to-response mapping.
import { SendMessageError } from '@/lib/whatsapp/send-message';

export interface SendSmsParams {
  conversationId: string;
  body: string;
  /** Set true only for automation-originated sends (outreach,
   *  qualification follow-ups, reminders) — these are the ones
   *  `do_not_contact` blocks. A human agent's manual reply from the
   *  inbox also passes through here today; see the dispatcher (Phase
   *  4) for how opted-out contacts are still allowed a conversational
   *  reply without re-pitching. */
  isAutomated?: boolean;
}

export interface SendSmsMessageResult {
  messageId: string;
  twilioMessageId: string;
}

/**
 * Send an SMS in an existing conversation and persist it. `db` may be
 * an RLS-scoped user client (dashboard) or the service-role client
 * (automation dispatcher) — every query is filtered by `accountId`
 * either way.
 */
export async function sendSmsToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendSmsParams,
): Promise<SendSmsMessageResult> {
  const { conversationId, body } = params;

  if (!conversationId) {
    throw new SendMessageError('bad_request', 'conversation_id is required', 400);
  }
  if (!body || !body.trim()) {
    throw new SendMessageError('bad_request', 'body is required', 400);
  }
  if (body.length > 1600) {
    // Twilio splits/concatenates beyond 1600 chars (≈10 SMS segments);
    // reject rather than silently multi-segment-bill a runaway prompt.
    throw new SendMessageError('bad_request', 'body exceeds 1600 characters', 400);
  }

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendMessageError('bad_request', 'Contact phone number not found', 400);
  }

  if (params.isAutomated && contact.do_not_contact) {
    throw new SendMessageError(
      'do_not_contact',
      'Contact has opted out; refusing to send an automated message',
      409,
    );
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError('bad_request', 'Invalid phone number format', 400);
  }

  const { data: config, error: configError } = await db
    .from('sms_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new SendMessageError(
      'sms_not_configured',
      'SMS not configured. Please set up your Twilio integration first.',
      400,
    );
  }

  const authToken = decrypt(config.twilio_auth_token);

  if (isLegacyFormat(config.twilio_auth_token)) {
    void db
      .from('sms_config')
      .update({ twilio_auth_token: encrypt(authToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn('[sms send-message] auth_token GCM upgrade failed:', error.message);
        }
      });
  }

  let twilioMessageId: string;
  try {
    const result = await sendSms(
      {
        accountSid: config.twilio_account_sid,
        authToken,
        fromNumber: config.twilio_phone_number,
        messagingServiceSid: config.messaging_service_sid,
      },
      `+${sanitizedPhone}`,
      body,
    );
    twilioMessageId = result.twilioMessageId;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Twilio API error';
    console.error('[sms send-message] Twilio send failed:', message);
    throw new SendMessageError('twilio_error', `Twilio API error: ${message}`, 502);
  }

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      channel: 'sms',
      sender_type: 'agent',
      content_type: 'text',
      content_text: body,
      message_id: twilioMessageId,
      status: 'sent',
    })
    .select()
    .single();

  if (msgError) {
    console.error('[sms send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Twilio but failed to save to DB: ${msgError.message}`,
      500,
    );
  }

  await db
    .from('conversations')
    .update({
      last_message_text: body,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — a human agent
  // stepping in (or the qualification dispatcher moving past
  // automation) is the strongest "yield" signal. Best-effort, mirrors
  // the WhatsApp send core.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send (sms) failed:', pauseErr.message);
    }
  } catch (err) {
    console.error('[flows] pause-on-agent-send (sms) threw:', err instanceof Error ? err.message : err);
  }

  return { messageId: messageRecord.id, twilioMessageId };
}
