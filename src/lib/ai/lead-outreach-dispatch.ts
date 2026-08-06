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
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { runOutreachTurn } from './outreach-assistant'
import {
  runQualificationTurn,
  EMPTY_QUALIFICATION_DATA,
  type QualificationData,
} from './qualification-assistant'
import { logAiUsage } from './usage'
import { sendSmsToConversation } from '@/lib/sms/send-message'

interface LeadOutreachStateRow {
  id: string
  stage: string
  outreach_attempts: number
  qualification_data: QualificationData
}

async function loadState(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<LeadOutreachStateRow | null> {
  const { data } = await db
    .from('lead_outreach_state')
    .select('id, stage, outreach_attempts, qualification_data')
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
      await db.from('contacts').update({ lead_status: 'customer_responded' }).eq('id', contactId)
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
      await db
        .from('lead_outreach_state')
        .update({ stage: 'qualifying' })
        .eq('id', state.id)
      await db.from('contacts').update({ lead_status: 'interested' }).eq('id', contactId)

      const { text, data, ready, usage } = await runQualificationTurn({
        config,
        companyName,
        knownData: state.qualification_data ?? EMPTY_QUALIFICATION_DATA,
        messages,
      })
      await persistQualificationTurn(db, accountId, contactId, state.id, data, ready)
      await logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'lead_qualification',
        provider: config.provider,
        model: config.model,
        usage,
      })
      if (text) {
        await sendSmsToConversation(db, accountId, { conversationId, body: text, isAutomated: true })
      }
      return
    }

    if (state.stage === 'qualifying') {
      const { text, data, ready, usage } = await runQualificationTurn({
        config,
        companyName,
        knownData: state.qualification_data ?? EMPTY_QUALIFICATION_DATA,
        messages,
      })
      await persistQualificationTurn(db, accountId, contactId, state.id, data, ready)
      await logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'lead_qualification',
        provider: config.provider,
        model: config.model,
        usage,
      })
      if (text) {
        await sendSmsToConversation(db, accountId, { conversationId, body: text, isAutomated: true })
      }
      return
    }

    // stage is 'slot_offered', 'booked', or 'handed_off' — Phase 4b
    // (Calendar) and Phase 4c (confirmations) own those transitions;
    // this dispatcher doesn't send anything further on its own for
    // those stages. A human agent can always reply manually via the
    // inbox regardless of stage (that path doesn't go through here).
  } catch (err) {
    console.error('[lead-outreach-dispatch] inbound dispatch failed:', err)
  }
}

async function persistQualificationTurn(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  stateId: string,
  data: QualificationData,
  ready: boolean,
): Promise<void> {
  await db
    .from('lead_outreach_state')
    .update({
      qualification_data: data,
      stage: ready ? 'slot_offered' : 'qualifying',
    })
    .eq('id', stateId)

  if (ready) {
    await db.from('contacts').update({ lead_status: 'appointment_requested' }).eq('id', contactId)
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

    await db.from('contacts').update({ lead_status: 'message_sent' }).eq('id', contactId)
  } catch (err) {
    console.error('[lead-outreach-dispatch] initial outreach failed:', err)
  }
}
