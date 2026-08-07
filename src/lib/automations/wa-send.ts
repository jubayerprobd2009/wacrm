import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/wa-send'
import {
  resolveContactForSend,
  sendViaProviderWithRetry,
  healContactPhoneIfChanged,
  persistOutboundMessage,
  updateConversationLastMessage,
} from '@/lib/whatsapp/engine-send'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side sender.
//
// Thin wrapper over the shared `engine-send.ts` skeleton (Phase 2 of
// the plan) — mirrors the logic in src/lib/whatsapp/send-message.ts
// but uses the service-role client (engine has no cookies) and
// accepts the user / conversation / contact identifiers the engine
// already has on hand. Kept here (rather than refactoring the
// user-facing send route) to avoid risk to the working manual-send
// path — they can converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + provider lookups so
   *  an automation authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaEngine({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaEngine({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

const CONTACT_ERRORS = {
  contactNotFound: () => new Error('contact not found for this account'),
  invalidPhone: (phone: string) => new Error(`contact phone invalid: ${phone}`),
}

async function sendViaEngine(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + provider lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { contact, sanitizedPhone } = await resolveContactForSend(
    db,
    input.accountId,
    input.contactId,
    CONTACT_ERRORS,
  )

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message (gated by the provider's capabilities).
  const { waMessageId, workingPhone } = await sendViaProviderWithRetry(
    db,
    input.accountId,
    sanitizedPhone,
    (provider, phone) =>
      input.kind === 'template'
        ? provider.sendTemplate({
            to: phone,
            templateName: input.templateName,
            language: input.language,
            params: input.params,
          })
        : provider.sendText({ to: phone, text: input.text }),
  )

  await healContactPhoneIfChanged(db, contact.id, sanitizedPhone, workingPhone)

  // Persist the sent message so it appears in the inbox with a real
  // provider message id. sender_type='bot' distinguishes automation
  // sends from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? input.text : null
  const template_name = input.kind === 'template' ? input.templateName : null

  const { error: msgErr } = await persistOutboundMessage(db, {
    conversationId: input.conversationId,
    senderType: 'bot',
    contentType: content_type,
    contentText: content_text,
    templateName: template_name,
    messageId: waMessageId,
  })
  if (msgErr) {
    // The provider already delivered the message; record the DB error
    // but don't pretend the send failed. The engine wraps this in a
    // log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  const lastMessageText =
    input.kind === 'template' ? `[template:${input.templateName}]` : input.text

  await updateConversationLastMessage(db, input.conversationId, lastMessageText)

  return { whatsapp_message_id: waMessageId }
}
