import { NextResponse } from 'next/server';
import type { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { sendSmsToConversation } from '@/lib/sms/send-message';
import { SendMessageError } from '@/lib/whatsapp/send-message';

/**
 * The dashboard's outbound SMS endpoint — mirrors
 * `/api/whatsapp/send`'s shape (conversation_id or contact_id, role
 * gate, rate limit, delegate to the shared send core) but is text-
 * only, so there's no message-shape validation branch to run first.
 */
export async function POST(request: Request) {
  try {
    // Same reasoning as the WhatsApp route: the send core calls
    // Twilio BEFORE it persists, so the role gate has to happen here
    // rather than relying on RLS to block the eventual INSERT.
    const { supabase, accountId, userId } = await requireRole('manager');

    const limit = checkRateLimit(`sms-send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const {
      conversation_id: conversationIdInput,
      contact_id,
      body: messageBody,
    } = body as Record<string, unknown>;

    if ((!conversationIdInput && !contact_id) || typeof messageBody !== 'string' || !messageBody.trim()) {
      return NextResponse.json(
        { error: 'Either conversation_id or contact_id, plus body, are required' },
        { status: 400 },
      );
    }

    let conversationId: string | null = null;

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single();

      if (convError || !data) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }
      conversationId = data.id;
    } else {
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle();

      if (contactErr || !contactRow) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
      }

      const resolved = await findOrCreateSmsConversation(supabase, accountId, userId, contact_id as string);
      if (!resolved) {
        return NextResponse.json({ error: 'Failed to open a conversation for this contact' }, { status: 500 });
      }
      conversationId = resolved;
    }

    try {
      const result = await sendSmsToConversation(supabase, accountId, {
        conversationId: conversationId!,
        body: messageBody,
      });

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        twilio_message_id: result.twilioMessageId,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in SMS send POST:', error);
    return toErrorResponse(error);
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>;

async function findOrCreateSmsConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      channel: 'sms',
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error creating SMS conversation for contact send:', error.message);
    return null;
  }

  return created.id;
}
