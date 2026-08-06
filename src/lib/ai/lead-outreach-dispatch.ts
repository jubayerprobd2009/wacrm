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
import { updateLeadStatus } from '@/lib/contacts/lead-status'

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
      const { text, usage } = await runOutreachTurn({
        config,
        companyName,
        messages,
        suppressPitch: true,
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
  const { text, data, ready, usage } = await runQualificationTurn({
    config,
    companyName,
    knownData: state.qualification_data ?? EMPTY_QUALIFICATION_DATA,
    messages,
  })
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
 */
export async function sendInitialOutreach(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
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

    const { text, usage } = await runOutreachTurn({ config, companyName, messages: [] })
    await logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'lead_outreach',
      provider: config.provider,
      model: config.model,
      usage,
    })
    if (!text) return

    await sendSmsToConversation(db, accountId, { conversationId, body: text, isAutomated: true })

    await db
      .from('lead_outreach_state')
      .upsert(
        {
          account_id: accountId,
          contact_id: contactId,
          conversation_id: conversationId,
          stage: 'outreach_sent',
          outreach_attempts: 1,
          last_outreach_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,contact_id' },
      )

    await updateLeadStatus(db, accountId, contactId, 'message_sent')
  } catch (err) {
    console.error('[lead-outreach-dispatch] initial outreach failed:', err)
  }
}
