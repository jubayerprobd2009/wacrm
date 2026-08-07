import {
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  resolveContactForSend,
  sendViaProviderWithRetry,
  healContactPhoneIfChanged,
  persistOutboundMessage,
  updateConversationLastMessage,
} from '@/lib/whatsapp/engine-send'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Flows-side sender (interactive variants).
//
// Thin wrapper over the shared `engine-send.ts` skeleton (Phase 2 of
// the plan) — this file used to hand-roll contact lookup, phone
// validation, a Meta phone-variant retry loop, and the
// messages/conversations writes for each of text/media/interactive-
// buttons/interactive-list. That's now the shared core; this file
// just supplies each send's provider-call closure and its
// `messages` row shape.
//
// Mirrors src/lib/automations/wa-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + provider lookups so a
   *  flow authored by user A still sends through the WhatsApp number
   *  user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
}

const CONTACT_ERRORS = {
  contactNotFound: () => new Error('contact not found for this account'),
  invalidPhone: (phone: string) => new Error(`contact phone invalid: ${phone}`),
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { contact, sanitizedPhone } = await resolveContactForSend(
    db,
    args.accountId,
    args.contactId,
    CONTACT_ERRORS,
  )

  const { waMessageId, workingPhone } = await sendViaProviderWithRetry(
    db,
    args.accountId,
    sanitizedPhone,
    (provider, phone) => provider.sendText({ to: phone, text: args.text }),
  )

  await healContactPhoneIfChanged(db, contact.id, sanitizedPhone, workingPhone)

  const { error: msgErr } = await persistOutboundMessage(db, {
    conversationId: args.conversationId,
    senderType: 'bot',
    contentType: 'text',
    contentText: args.text,
    messageId: waMessageId,
    aiGenerated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await updateConversationLastMessage(db, args.conversationId, args.text)

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message).
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { contact, sanitizedPhone } = await resolveContactForSend(
    db,
    args.accountId,
    args.contactId,
    CONTACT_ERRORS,
  )

  const { waMessageId, workingPhone } = await sendViaProviderWithRetry(
    db,
    args.accountId,
    sanitizedPhone,
    (provider, phone) =>
      provider.sendMedia({
        to: phone,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      }),
  )

  await healContactPhoneIfChanged(db, contact.id, sanitizedPhone, workingPhone)

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await persistOutboundMessage(db, {
    conversationId: args.conversationId,
    senderType: 'bot',
    contentType: args.kind,
    contentText: args.caption ?? null,
    messageId: waMessageId,
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await updateConversationLastMessage(db, args.conversationId, preview)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the provider message id so the caller (engine) can stash it
 * on the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaProvider({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaProvider({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaProvider(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { contact, sanitizedPhone } = await resolveContactForSend(
    db,
    input.accountId,
    input.contactId,
    CONTACT_ERRORS,
  )

  const { waMessageId, workingPhone } = await sendViaProviderWithRetry(
    db,
    input.accountId,
    sanitizedPhone,
    (provider, phone) =>
      input.kind === 'buttons'
        ? provider.sendInteractiveButtons({
            to: phone,
            bodyText: input.bodyText,
            buttons: input.buttons,
            headerText: input.headerText,
            footerText: input.footerText,
          })
        : provider.sendInteractiveList({
            to: phone,
            bodyText: input.bodyText,
            buttonLabel: input.buttonLabel,
            sections: input.sections,
            headerText: input.headerText,
            footerText: input.footerText,
          }),
  )

  await healContactPhoneIfChanged(db, contact.id, sanitizedPhone, workingPhone)

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives. We DO persist the structured payload so
  // the inbox thread re-renders the buttons/rows the bot sent (round-
  // trip), matching the composer + automation send paths.
  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const { error: msgErr } = await persistOutboundMessage(db, {
    conversationId: input.conversationId,
    senderType: 'bot',
    contentType: 'interactive',
    contentText: input.bodyText,
    interactivePayload,
    messageId: waMessageId,
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await updateConversationLastMessage(db, input.conversationId, input.bodyText)

  return { whatsapp_message_id: waMessageId }
}
