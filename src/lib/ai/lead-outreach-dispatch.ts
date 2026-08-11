// ============================================================
// Two-stage AI lead outreach/qualification dispatcher.
//
// Owns the `lead_outreach_state.stage` state machine:
//
//   not_started → outreach_sent → qualifying → slot_offered → booked
//                       ↓              ↓
//                  opted_out      opted_out
//
// `dispatchInboundToLeadOutreach` handles an inbound SMS reply (called
// from the SMS webhook's `after()` block). `sendInitialOutreach`
// handles the outbound-first case (called from the outreach cron,
// Phase-4-adjacent, for a lead who was just synced from Google Sheets
// and has never been texted).
//
// Mirrors `src/lib/ai/auto-reply.ts`'s contract: owns its own
// try/catch and never throws — a failing or slow LLM call must not
// affect the webhook's 200 to Twilio.
//
// Stage transition policy (deliberately simple, per the "keep it
// simple" brief): the FIRST reply after outreach is sent moves
// straight to `qualifying` — the qualification assistant's own prompt
// already opens by confirming interest, so a separate "is this lead
// interested?" classifier call isn't needed. A lead who says no during
// qualification just never completes it; the (Phase 4c) no-reply
// timeout eventually marks them `follow_up_needed`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, ChatMessage } from './types'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { latestUserMessage } from './query'
import { retrieveKnowledge } from './knowledge'
import { runOutreachTurn } from './outreach-assistant'
import {
  runQualificationTurn,
  EMPTY_QUALIFICATION_DATA,
  type QualificationData,
} from './qualification-assistant'
import { offerSlots, matchOfferedSlot, bookAppointment } from './booking-flow'
import { sendConfirmation, detectBookedReplyIntent, cancelAppointment } from './confirmation'
import type { TimeSlot } from '@/lib/google/calendar'
import { logAiUsage } from './usage'
import { sendSmsToConversation } from '@/lib/sms/send-message'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { updateLeadStatus } from '@/lib/contacts/lead-status'
import type { WhatsAppProviderId } from '@/types'

interface LeadOutreachStateRow {
  id: string
  stage: string
  outreach_attempts: number
  qualification_data: QualificationData
  offered_slots: TimeSlot[]
}

async function loadState(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<LeadOutreachStateRow | null> {
  const { data } = await db
    .from('lead_outreach_state')
    .select('id, stage, outreach_attempts, qualification_data, offered_slots')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  return (data as LeadOutreachStateRow) ?? null
}

async function loadCompanyName(db: SupabaseClient, accountId: string): Promise<string> {
  const { data } = await db.from('accounts').select('name').eq('id', accountId).maybeSingle()
  return data?.name || 'our team'
}

/**
 * Handle an inbound SMS reply for a lead already in the outreach flow.
 * No-ops (silently) when:
 *   - the contact has no `lead_outreach_state` row at all — they were
 *     never enrolled by the outreach cron, so this inbound-first
 *     conversation isn't part of the automated flow;
 *   - `do_not_contact` is set AND the stage is anything other than
 *     `opted_out`/a normal reply — handled by the opted_out branch
 *     below, which still answers questions but never re-pitches;
 *   - AI isn't configured/active for the account.
 */
export async function dispatchInboundToLeadOutreach(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<void> {
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('do_not_contact, lead_status')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact) return

    const state = await loadState(db, accountId, contactId)
    if (!state) return // never enrolled by the outreach cron — not this dispatcher's conversation

    const config = await loadAiConfig(db, accountId)
    if (!config) return

    const companyName = await loadCompanyName(db, accountId)
    const messages = await buildConversationContext(db, conversationId)

    // Always record that the lead responded, regardless of stage —
    // even an opted-out contact replying is "customer_responded" from
    // a CRM-status point of view (it just won't progress toward booking).
    if (contact.lead_status === 'new_lead' || contact.lead_status === 'message_sent') {
      await updateLeadStatus(db, accountId, contactId, 'customer_responded')
    }

    if (contact.do_not_contact || state.stage === 'opted_out') {
      // Opted out: still answer questions conversationally, but the
      // outreach assistant is told to never pitch/ask-to-book again.
      const knowledge = await retrieveKnowledge(db, accountId, config, latestUserMessage(messages))
      try {
        const { text, usage } = await runOutreachTurn({
          config,
          companyName,
          messages,
          suppressPitch: true,
          knowledge,
        })
        await logAiUsage(db, {
          accountId,
          conversationId,
          mode: 'lead_outreach',
          provider: config.provider,
          model: config.model,
          usage,
        })
        if (text) {
          await sendSmsToConversation(db, accountId, { conversationId, body: text, isAutomated: false })
        }
      } catch (err) {
        // Opted-out is already a terminal, at-rest state — a provider
        // failure here just means this one question goes unanswered
        // (no state transition needed, unlike the qualifying case
        // below). Logged so it's not invisible.
        console.error('[lead-outreach-dispatch] opted-out reply generation failed:', err)
      }
      return
    }

    if (state.stage === 'not_started' || state.stage === 'outreach_sent' || state.stage === 'awaiting_reply') {
      // First reply after outreach — move straight to qualification.
      await db.from('lead_outreach_state').update({ stage: 'qualifying' }).eq('id', state.id)
      await updateLeadStatus(db, accountId, contactId, 'interested')
      await runQualificationStep(db, accountId, contactId, conversationId, config, companyName, state, messages)
      return
    }

    if (state.stage === 'qualifying') {
      await runQualificationStep(db, accountId, contactId, conversationId, config, companyName, state, messages)
      return
    }

    if (state.stage === 'slot_offered') {
      const picked = matchOfferedSlot(latestUserMessage(messages), state.offered_slots ?? [])
      if (!picked) {
        await sendSmsToConversation(db, accountId, {
          conversationId,
          body: 'Sorry, I didn\'t catch that — please reply with the number (1, 2, or 3) next to the time that works for you.',
          isAutomated: true,
        })
        return
      }

      const booked = await bookAppointment(db, accountId, {
        contactId,
        conversationId,
        slot: picked,
        data: state.qualification_data ?? EMPTY_QUALIFICATION_DATA,
      })

      if (!booked) {
        // Lost the double-booking race, or Calendar call failed — offer
        // a fresh set of slots rather than leaving the lead stuck.
        const offer = await offerSlots(db, accountId)
        if (offer && offer.slots.length > 0) {
          await db
            .from('lead_outreach_state')
            .update({ offered_slots: offer.slots })
            .eq('id', state.id)
          await sendSmsToConversation(db, accountId, {
            conversationId,
            body: `That time just got taken — here are some other options:\n${offer.message}`,
            isAutomated: true,
          })
        } else {
          await sendSmsToConversation(db, accountId, {
            conversationId,
            body: 'That time just got taken, and I\'m having trouble finding another — someone from our team will reach out shortly to find a time.',
            isAutomated: true,
          })
          await db.from('lead_outreach_state').update({ stage: 'handed_off' }).eq('id', state.id)
        }
        return
      }

      await db
        .from('lead_outreach_state')
        .update({ stage: 'booked', offered_slots: [] })
        .eq('id', state.id)
      await updateLeadStatus(db, accountId, contactId, 'appointment_booked')

      const { data: apptRow } = await db
        .from('appointments')
        .select('id, scheduled_start, scheduled_end, location_or_link, google_calendar_event_id, google_calendar_id')
        .eq('id', booked.appointmentId)
        .single()
      if (apptRow) {
        await sendConfirmation(db, accountId, conversationId, apptRow, companyName)
      }
      return
    }

    if (state.stage === 'booked') {
      const intent = detectBookedReplyIntent(latestUserMessage(messages))
      if (intent === 'other') return // no automated action; human can reply from the inbox

      const { data: appt } = await db
        .from('appointments')
        .select('id, scheduled_start, scheduled_end, location_or_link, google_calendar_event_id, google_calendar_id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('status', 'confirmed')
        .order('scheduled_start', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (!appt) return

      if (intent === 'cancel') {
        await cancelAppointment(db, accountId, conversationId, appt)
        await updateLeadStatus(db, accountId, contactId, 'not_interested')
        await db.from('lead_outreach_state').update({ stage: 'handed_off' }).eq('id', state.id)
        return
      }

      // reschedule: cancel the existing booking, then re-offer slots
      // exactly like the initial qualifying→slot_offered transition.
      await cancelAppointment(db, accountId, conversationId, appt)
      const offer = await offerSlots(db, accountId)
      if (offer && offer.slots.length > 0) {
        await db
          .from('lead_outreach_state')
          .update({ stage: 'slot_offered', offered_slots: offer.slots })
          .eq('id', state.id)
        await updateLeadStatus(db, accountId, contactId, 'appointment_requested')
        await sendSmsToConversation(db, accountId, { conversationId, body: offer.message, isAutomated: true })
      } else {
        await db.from('lead_outreach_state').update({ stage: 'handed_off' }).eq('id', state.id)
        await sendSmsToConversation(db, accountId, {
          conversationId,
          body: "Someone from our team will reach out shortly to find a new time.",
          isAutomated: true,
        })
      }
      return
    }

    // stage is 'handed_off' — nothing further to automate; a human
    // agent can always reply manually via the inbox regardless of
    // stage (that path doesn't go through here).
  } catch (err) {
    console.error('[lead-outreach-dispatch] inbound dispatch failed:', err)
  }
}

async function runQualificationStep(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
  config: AiConfig,
  companyName: string,
  state: LeadOutreachStateRow,
  messages: ChatMessage[],
): Promise<void> {
  const knowledge = await retrieveKnowledge(db, accountId, config, latestUserMessage(messages))

  let text: string, data: QualificationData, ready: boolean, usage: Awaited<ReturnType<typeof runQualificationTurn>>['usage']
  try {
    ;({ text, data, ready, usage } = await runQualificationTurn({
      config,
      companyName,
      knownData: state.qualification_data ?? EMPTY_QUALIFICATION_DATA,
      messages,
      knowledge,
    }))
  } catch (err) {
    // Same failure mode confirmed live on the WhatsApp side (see
    // auto-reply.ts): a provider error (rate limit, empty response,
    // timeout) must not leave the lead silently stuck mid-qualification
    // forever with nothing indicating it needs a human. `lead_outreach_
    // state` has no dedicated error-message column (unlike
    // `conversations.ai_handoff_summary`), so this stops short of a
    // rich note — but at minimum the lead is taken off autopilot so a
    // human reviewing stalled leads will actually see it.
    console.error('[lead-outreach-dispatch] qualification turn failed, handing off:', err)
    await db.from('lead_outreach_state').update({ stage: 'handed_off' }).eq('id', state.id)
    return
  }

  await logAiUsage(db, {
    accountId,
    conversationId,
    mode: 'lead_qualification',
    provider: config.provider,
    model: config.model,
    usage,
  })

  if (!ready) {
    await db
      .from('lead_outreach_state')
      .update({ qualification_data: data, stage: 'qualifying' })
      .eq('id', state.id)
    if (text) {
      await sendSmsToConversation(db, accountId, { conversationId, body: text, isAutomated: true })
    }
    return
  }

  await updateLeadStatus(db, accountId, contactId, 'appointment_requested')

  const offer = await offerSlots(db, accountId)
  if (offer && offer.slots.length > 0) {
    await db
      .from('lead_outreach_state')
      .update({ qualification_data: data, stage: 'slot_offered', offered_slots: offer.slots })
      .eq('id', state.id)
    const combined = text ? `${text}\n\n${offer.message}` : offer.message
    await sendSmsToConversation(db, accountId, { conversationId, body: combined, isAutomated: true })
  } else {
    // No Google connection, or no open slots — hand off to a human
    // rather than leaving the lead in limbo.
    await db
      .from('lead_outreach_state')
      .update({ qualification_data: data, stage: 'handed_off' })
      .eq('id', state.id)
    const fallback = "Thanks! Someone from our team will reach out shortly to find a time that works."
    await sendSmsToConversation(db, accountId, {
      conversationId,
      body: text ? `${text}\n\n${fallback}` : fallback,
      isAutomated: true,
    })
  }
}

/**
 * Send the first outreach message to a lead that has never been
 * contacted. Called by the outreach cron for `contacts` where
 * `lead_status = 'new_lead'` and no `lead_outreach_state` row exists
 * yet (or `stage = 'not_started'`).
 *
 * `channel`/`activeWhatsAppProvider` come from the cron's single
 * `decideInitialOutreachChannel` call (see `outreach-channel.ts`) — not
 * re-derived here, to avoid a second live lookup and any race between
 * decision and send.
 */
export async function sendInitialOutreach(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
  channel: 'whatsapp' | 'sms',
  activeWhatsAppProvider: WhatsAppProviderId | null,
): Promise<void> {
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('do_not_contact')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact || contact.do_not_contact) return

    const config = await loadAiConfig(db, accountId)
    if (!config) return

    const companyName = await loadCompanyName(db, accountId)

    // No customer message exists yet for the very first touch — ground
    // the introduction itself against the KB with a generic query
    // describing what this turn needs (services + benefits overview),
    // rather than skipping retrieval entirely (see plan section B4).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      'introduce the company and the insurance services and benefits offered',
    )
    const { text, usage } = await runOutreachTurn({ config, companyName, messages: [], knowledge })
    await logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'lead_outreach',
      provider: config.provider,
      model: config.model,
      usage,
    })
    if (!text) return

    let sendResult: { messageId: string }
    // Tracks what actually happened, which may differ from the
    // requested `channel` if a WhatsApp attempt throws immediately
    // (never reached the provider — fall straight to SMS rather than
    // waiting for a delivery-status webhook that will never arrive).
    let effectiveChannel: 'whatsapp' | 'sms' = channel
    let firedInlineFallback = false

    if (channel === 'whatsapp') {
      try {
        sendResult = await sendInitialWhatsAppOutreach(
          db,
          accountId,
          conversationId,
          text,
          config,
          activeWhatsAppProvider,
        )
      } catch (err) {
        console.error(
          '[lead-outreach-dispatch] initial WhatsApp outreach failed, falling back to SMS inline:',
          err,
        )
        sendResult = await sendSmsToConversation(db, accountId, {
          conversationId,
          body: text,
          isAutomated: true,
        })
        await db.from('conversations').update({ channel: 'sms' }).eq('id', conversationId)
        effectiveChannel = 'sms'
        firedInlineFallback = true
      }
    } else {
      sendResult = await sendSmsToConversation(db, accountId, {
        conversationId,
        body: text,
        isAutomated: true,
      })
    }

    const now = new Date().toISOString()
    await db.from('lead_outreach_state').upsert(
      {
        account_id: accountId,
        contact_id: contactId,
        conversation_id: conversationId,
        stage: 'outreach_sent',
        outreach_attempts: 1,
        last_outreach_at: now,
        outreach_channel_attempted: effectiveChannel,
        outreach_message_id: sendResult.messageId,
        // Already fell back inline above — mark it done so the webhook
        // reaction / cron sweep don't try to fall back a second time.
        whatsapp_failed_at: firedInlineFallback ? now : null,
        sms_fallback_sent_at: firedInlineFallback ? now : null,
      },
      { onConflict: 'account_id,contact_id' },
    )

    await updateLeadStatus(db, accountId, contactId, 'message_sent')
  } catch (err) {
    console.error('[lead-outreach-dispatch] initial outreach failed:', err)
  }
}

/**
 * Send the initial WhatsApp touch. Meta's Cloud API requires an
 * APPROVED template (not free text) for a business-initiated message
 * to a contact who has never messaged in — see migration 051 and the
 * `outreach_whatsapp_template_name` setting. Unofficial providers
 * (Evolution/WaSender, Baileys-backed) have no such restriction and
 * send free text like any other message.
 */
async function sendInitialWhatsAppOutreach(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  text: string,
  config: AiConfig,
  provider: WhatsAppProviderId | null,
): Promise<{ messageId: string }> {
  if (provider === 'meta') {
    if (!config.outreachWhatsappTemplateName) {
      throw new Error(
        'outreach_whatsapp_template_name not configured — required for Meta cold outreach',
      )
    }
    return sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: 'template',
      templateName: config.outreachWhatsappTemplateName,
      templateLanguage: config.outreachWhatsappTemplateLanguage,
      templateMessageParams: { body: [text] },
    })
  }

  // Unofficial (wasender/evolution): free text is fine.
  return sendMessageToConversation(db, accountId, {
    conversationId,
    messageType: 'text',
    contentText: text,
  })
}

/**
 * Fall back a lead's first-touch WhatsApp attempt to SMS. Shared by
 * two trigger paths — the delivery-status webhook (on an explicit
 * `'failed'` status) and the outreach cron's timeout sweep (when
 * WhatsApp neither confirms nor explicitly fails within the stall
 * window) — so it must be safe to call from both without ever double-
 * sending.
 *
 * The conditional `UPDATE ... WHERE sms_fallback_sent_at IS NULL` is
 * an atomic claim: Postgres serializes per-row updates, so whichever
 * caller's UPDATE commits first gets a non-null `.select()` back and
 * proceeds; the loser sees `sms_fallback_sent_at` already set, gets
 * null back, and returns false without sending anything.
 *
 * Reuses the same AI-drafted text already sent to WhatsApp (stored on
 * `conversations.last_message_text` by the WhatsApp send) — no second
 * LLM call for the fallback.
 */
export async function fallbackToSmsIfNeeded(
  db: SupabaseClient,
  state: {
    id: string
    account_id: string
    contact_id: string
    conversation_id: string | null
    outreach_message_id: string | null
  },
): Promise<boolean> {
  if (!state.conversation_id || !state.outreach_message_id) return false

  const { data: claimed } = await db
    .from('lead_outreach_state')
    .update({ whatsapp_failed_at: new Date().toISOString() })
    .eq('id', state.id)
    .is('sms_fallback_sent_at', null)
    .select('id')
    .maybeSingle()
  if (!claimed) return false // already handled or already fell back

  const { data: msg } = await db
    .from('messages')
    .select('status')
    .eq('id', state.outreach_message_id)
    .maybeSingle()
  if (msg?.status === 'delivered' || msg?.status === 'read') return false // WA actually got through

  const { data: contact } = await db
    .from('contacts')
    .select('do_not_contact')
    .eq('id', state.contact_id)
    .maybeSingle()
  if (contact?.do_not_contact) return false

  const { data: convo } = await db
    .from('conversations')
    .select('last_message_text')
    .eq('id', state.conversation_id)
    .maybeSingle()
  const body = convo?.last_message_text?.trim()
  if (!body) return false

  await sendSmsToConversation(db, state.account_id, {
    conversationId: state.conversation_id,
    body,
    isAutomated: true,
  })
  await db.from('conversations').update({ channel: 'sms' }).eq('id', state.conversation_id)
  await db
    .from('lead_outreach_state')
    .update({ sms_fallback_sent_at: new Date().toISOString(), outreach_channel_attempted: 'sms' })
    .eq('id', state.id)
  return true
}
