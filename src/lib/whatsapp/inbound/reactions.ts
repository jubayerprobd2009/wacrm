// ============================================================
// handleReaction + lookupInternalIdByMetaId — moved verbatim (Phase 3
// refactor) from src/app/api/whatsapp/webhook/route.ts. Behavior
// unchanged. `lookupInternalIdByMetaId` is generically "resolve a
// provider message id to our internal row id" — reused by
// process-inbound.ts to resolve swipe-reply parents too, not just
// reaction targets.
// ============================================================

import { supabaseAdmin } from './admin-client'

/**
 * Resolve a provider-side message id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
export async function lookupInternalIdByMetaId(
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to the provider.
 */
export async function handleReaction(
  reaction: { targetProviderMessageId: string; emoji: string },
  conversationId: string,
  contactId: string
) {
  if (!reaction.targetProviderMessageId) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.targetProviderMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound] reaction target message not found; skipping',
      reaction.targetProviderMessageId
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[inbound] reaction upsert failed:', upsertError.message)
  }
}
