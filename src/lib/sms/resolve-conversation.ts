// ============================================================
// Find-or-create the contact + SMS conversation for a phone number.
//
// Mirrors `src/lib/whatsapp/resolve-conversation.ts` — same
// find-or-create-contact / one-conversation-per-(account,contact)
// logic — but checks `sms_config` instead of `whatsapp_config` and
// tags the created conversation `channel: 'sms'`. Used by the
// outreach cron (Phase 4) to open a thread for a lead synced from
// Google Sheets that has never been contacted before.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedSmsConversation {
  conversationId: string;
  contactId: string;
  contactCreated: boolean;
}

export async function resolveSmsConversationByPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  name?: string | null,
): Promise<ResolvedSmsConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400,
    );
  }

  const { data: config } = await db
    .from('sms_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!config) {
    throw new SendMessageError(
      'sms_not_configured',
      'SMS not configured. Please set up your Twilio integration first.',
      400,
    );
  }

  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(db, accountId, sanitized);
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
  } else {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: sanitized,
        name: name || sanitized,
        lead_source: 'manual',
      })
      .select('id')
      .single();

    if (createErr || !created) {
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(db, accountId, sanitized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError('db_error', 'Failed to create contact', 500);
        }
      } else {
        console.error('[sms resolve-conversation] contact create error:', createErr);
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  const conversationId = await findOrCreateSmsConversationRow(db, accountId, contactId, ownerUserId);

  return { conversationId, contactId, contactCreated };
}

async function findOrCreateSmsConversationRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  ownerUserId: string,
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error('[sms resolve-conversation] conversation lookup error:', findErr);
    throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
  }

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      channel: 'sms',
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return raced[0].id;
      }
    }
    console.error('[sms resolve-conversation] conversation create error:', convErr);
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return newConv.id;
}
