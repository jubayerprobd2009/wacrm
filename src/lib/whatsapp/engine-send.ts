// ============================================================
// engine-send.ts — the single shared outbound skeleton.
//
// Extracted (Phase 2 of the plan, see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md) from the
// three near-duplicate Meta send implementations that had grown up
// independently:
//   - src/lib/whatsapp/send-message.ts (dashboard composer + public API)
//   - src/lib/automations/meta-send.ts (now wa-send.ts)
//   - src/lib/flows/meta-send.ts (now wa-send.ts)
//
// All three did the same five things in the same order — contact
// lookup, phone validation, config/provider resolution, a
// phone-variant retry loop around the actual send, then a `messages`
// insert + `conversations` update — with only the send closure and
// the exact error type differing. This module is the shared middle:
// provider resolution, the capability-gated retry loop, the contact
// phone self-heal, and the `messages`/`conversations` writes.
//
// Contact lookup is intentionally NOT fully unified: send-message.ts
// resolves the contact via a `conversations` join (it needs to
// validate the conversation belongs to the account first), while
// automations/wa-send.ts and flows/wa-send.ts look the contact up
// directly by `contactId`. The latter two shared byte-for-byte
// identical lookup code, so that piece IS shared here as
// `resolveContactForSend`; send-message.ts keeps its own join-based
// lookup (documented deviation — see its own comment).
//
// Pure refactor: no behavior change for the Meta provider. The
// phone-variant retry loop, which used to run unconditionally, now
// runs only when `provider.capabilities.phoneVariantRetry` is true —
// Meta's adapter sets that flag `true`, so this is a no-op change for
// every call site today.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { getProviderForAccount } from '@/lib/whatsapp/providers/resolve';
import type {
  ProviderSendResult,
  WhatsAppProvider,
} from '@/lib/whatsapp/providers/types';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export interface EngineSendContact {
  id: string;
  phone: string;
}

/**
 * Look up a contact by id (account-scoped) and validate its phone,
 * throwing caller-supplied errors on failure so each call site keeps
 * its own exact error type/message (automations/flows throw plain
 * `Error`s today; nothing here should change that).
 *
 * Shared verbatim logic from the old `automations/meta-send.ts` and
 * `flows/meta-send.ts` — both queried `contacts` the same way.
 */
export async function resolveContactForSend(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  errors: {
    contactNotFound: () => Error;
    invalidPhone: (phone: string) => Error;
  }
): Promise<{ contact: EngineSendContact; sanitizedPhone: string }> {
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone) {
    throw errors.contactNotFound();
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw errors.invalidPhone(contact.phone);
  }

  return { contact: contact as EngineSendContact, sanitizedPhone };
}

export interface SendViaProviderResult {
  provider: WhatsAppProvider;
  waMessageId: string;
  /** The phone variant that actually succeeded — may differ from the
   *  sanitized input when `phoneVariantRetry` kicked in. */
  workingPhone: string;
}

export interface SendWithRetryResult {
  waMessageId: string;
  workingPhone: string;
}

/**
 * Send through an already-resolved provider, retrying across
 * sanitized phone-number variants ONLY when the provider declares
 * `capabilities.phoneVariantRetry` — this is the capability gate the
 * plan calls for; every other provider skips the loop entirely and
 * sends once.
 *
 * `send` is the caller's closure choosing which provider method to
 * call (sendText / sendMedia / sendTemplate / sendInteractive*) —
 * kept as an injected callback rather than a `kind` enum so each call
 * site's exact argument shape (contextMessageId, template row, etc.)
 * stays exactly as it was pre-refactor.
 *
 * Split out from {@link sendViaProviderWithRetry} so a caller that
 * needs to resolve (and fail fast on) the provider BEFORE doing other
 * work — e.g. `send-message.ts`, which historically checked
 * `whatsapp_config` before resolving the reply-to target / template
 * row, and must keep raising `whatsapp_not_configured` at that same
 * point for behavior parity — can call `getProviderForAccount`
 * directly and pass the resolved provider in here.
 */
export async function sendWithPhoneVariantRetry(
  provider: WhatsAppProvider,
  sanitizedPhone: string,
  send: (provider: WhatsAppProvider, phone: string) => Promise<ProviderSendResult>
): Promise<SendWithRetryResult> {
  if (!provider.capabilities.phoneVariantRetry) {
    const result = await send(provider, sanitizedPhone);
    return { waMessageId: result.messageId, workingPhone: sanitizedPhone };
  }

  const variants = phoneVariants(sanitizedPhone);
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  let lastError: unknown = null;

  for (const variant of variants) {
    try {
      const result = await send(provider, variant);
      waMessageId = result.messageId;
      workingPhone = variant;
      lastError = null;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(message)) {
        throw err;
      }
      lastError = err;
      console.warn(
        `[engine-send] variant "${variant}" rejected by provider, trying next…`
      );
    }
  }

  if (lastError) throw lastError;

  return { waMessageId, workingPhone };
}

/**
 * Resolve the account's active provider AND send through it in one
 * call — the common case for automations/flows, which had no
 * ordering dependency on the config check relative to other work.
 */
export async function sendViaProviderWithRetry(
  db: SupabaseClient,
  accountId: string,
  sanitizedPhone: string,
  send: (provider: WhatsAppProvider, phone: string) => Promise<ProviderSendResult>
): Promise<SendViaProviderResult> {
  const provider = await getProviderForAccount(db, accountId);
  const result = await sendWithPhoneVariantRetry(provider, sanitizedPhone, send);
  return { provider, ...result };
}

/**
 * Persist a corrected phone back to the contact once a non-default
 * variant lands — so the next send goes straight through. Best-effort,
 * mirrors the pre-refactor inline `db.from('contacts').update(...)`.
 */
export async function healContactPhoneIfChanged(
  db: SupabaseClient,
  contactId: string,
  sanitizedPhone: string,
  workingPhone: string
): Promise<void> {
  if (workingPhone !== sanitizedPhone) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contactId);
  }
}

export interface PersistOutboundMessageInput {
  conversationId: string;
  senderType: 'agent' | 'bot';
  contentType: string;
  contentText: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: unknown | null;
  messageId: string;
  replyToMessageId?: string | null;
  aiGenerated?: boolean;
}

/**
 * Insert the sent message row. Returns the raw `{ data, error }` pair
 * (rather than throwing) so each call site keeps wrapping DB failures
 * in its own error type/message exactly as before — `SendMessageError`
 * with a specific 'db_error' code + message in send-message.ts, a
 * plain `Error` in automations/flows.
 */
export async function persistOutboundMessage(
  db: SupabaseClient,
  input: PersistOutboundMessageInput
) {
  return db
    .from('messages')
    .insert({
      conversation_id: input.conversationId,
      sender_type: input.senderType,
      content_type: input.contentType,
      content_text: input.contentText,
      media_url: input.mediaUrl ?? null,
      template_name: input.templateName ?? null,
      interactive_payload: input.interactivePayload ?? null,
      message_id: input.messageId,
      status: 'sent',
      reply_to_message_id: input.replyToMessageId ?? null,
      ...(input.aiGenerated !== undefined ? { ai_generated: input.aiGenerated } : {}),
    })
    .select()
    .single();
}

/**
 * Stamp the conversation's last-message preview. Identical across all
 * three pre-refactor implementations — nothing branches on the result,
 * so this one is safe to share unconditionally.
 */
export async function updateConversationLastMessage(
  db: SupabaseClient,
  conversationId: string,
  lastMessageText: string
): Promise<void> {
  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
}

/**
 * Pause any active Flow run for this contact — a manual agent send is
 * the strongest "yield, human is here" signal. Best-effort, matches
 * the pre-refactor inline block in `send-message.ts` verbatim. Only
 * the dashboard composer / public API manual-send path calls this
 * (automations/flows sends should never pause their own run).
 */
export async function pauseActiveFlowRunOnAgentSend(
  accountId: string,
  contactId: string
): Promise<void> {
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }
}
