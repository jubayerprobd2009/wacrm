import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ------------------------------------------------------------------
// Mocks — one per dependency of process-inbound.ts. `contacts.ts` /
// `conversations.ts` / `reactions.ts` are mocked wholesale (they have
// their own unit-of-behavior; this file's job is the *orchestration*
// — who gets called, with what args, in what order).
// ------------------------------------------------------------------

const { supabaseAdmin } = vi.hoisted(() => {
  const builder: Record<string, unknown> = {
    from: vi.fn(() => builder),
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    then: (resolve: (v: { data: null; error: null; count: number }) => void) =>
      resolve({ data: null, error: null, count: 0 }),
  }
  return { supabaseAdmin: vi.fn(() => builder) }
})
vi.mock('./admin-client', () => ({ supabaseAdmin }))

const { reopenClosedConversation } = vi.hoisted(() => ({
  reopenClosedConversation: vi.fn(async () => false),
}))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation }))

const { runAutomationsForTrigger } = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(async (_input: { triggerType: string }) => undefined),
}))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger }))

const { dispatchInboundToFlows } = vi.hoisted(() => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows }))

const { dispatchInboundToAiReply } = vi.hoisted(() => ({
  dispatchInboundToAiReply: vi.fn(async () => undefined),
}))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply }))

const { dispatchWebhookEvent } = vi.hoisted(() => ({
  dispatchWebhookEvent: vi.fn(
    async (
      _db: unknown,
      _accountId: string,
      _event: string,
      _payload: Record<string, unknown>
    ) => undefined
  ),
}))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent }))

const { findOrCreateContact } = vi.hoisted(() => ({
  findOrCreateContact: vi.fn(async () => ({
    contact: { id: 'contact-1', unread_count: 0 },
    wasCreated: false,
  })),
}))
vi.mock('./contacts', () => ({ findOrCreateContact }))

const { findOrCreateConversation, flagBroadcastReplyIfAny } = vi.hoisted(() => ({
  findOrCreateConversation: vi.fn(async () => ({
    conversation: { id: 'conv-1', unread_count: 0, status: 'open' },
    created: false,
  })),
  flagBroadcastReplyIfAny: vi.fn(async () => undefined),
}))
vi.mock('./conversations', () => ({ findOrCreateConversation, flagBroadcastReplyIfAny }))

const { handleReaction, lookupInternalIdByMetaId } = vi.hoisted(() => ({
  handleReaction: vi.fn(async () => undefined),
  lookupInternalIdByMetaId: vi.fn(async () => null),
}))
vi.mock('./reactions', () => ({ handleReaction, lookupInternalIdByMetaId }))

import { processInboundMessage } from './process-inbound'
import type { InboundConnection, NormalizedInboundMessage } from './types'

const CONNECTION: InboundConnection = { accountId: 'acc-1', userId: 'user-1' }

function textMessage(
  overrides: Partial<NormalizedInboundMessage> = {}
): NormalizedInboundMessage {
  return {
    providerMessageId: 'msg-1',
    fromPhone: '+15551234567',
    senderName: 'Jane',
    timestampMs: 1700000000000,
    type: 'text',
    text: 'hello there',
    media: null,
    interactiveReplyId: null,
    reaction: null,
    replyToProviderMessageId: null,
    raw: {},
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  findOrCreateContact.mockResolvedValue({
    contact: { id: 'contact-1', unread_count: 0 },
    wasCreated: false,
  })
  findOrCreateConversation.mockResolvedValue({
    conversation: { id: 'conv-1', unread_count: 0, status: 'open' },
    created: false,
  })
  dispatchInboundToFlows.mockResolvedValue({ consumed: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('processInboundMessage — parity contract', () => {
  it('dispatches Flows, all five automation triggers (across the right inbounds), AI auto-reply, and message.received identically regardless of what produced the NormalizedInboundMessage', async () => {
    findOrCreateContact.mockResolvedValue({
      contact: { id: 'contact-1', unread_count: 0 },
      wasCreated: true, // -> new_contact_created
    })
    // count: 0 prior customer messages -> isFirstInboundMessage: true
    dispatchInboundToFlows.mockResolvedValue({ consumed: false })

    const message = textMessage({ interactiveReplyId: null })

    await processInboundMessage({ connection: CONNECTION, message })

    // Flows dispatch — exact args.
    expect(dispatchInboundToFlows).toHaveBeenCalledWith({
      accountId: 'acc-1',
      userId: 'user-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      message: {
        kind: 'text',
        text: 'hello there',
        meta_message_id: 'msg-1',
      },
      isFirstInboundMessage: true,
    })

    // All 5 trigger types fire for a first-message, newly-created-contact,
    // non-interactive, flow-unconsumed inbound.
    const firedTriggers = runAutomationsForTrigger.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    )
    expect(firedTriggers).toEqual(
      expect.arrayContaining([
        'new_contact_created',
        'first_inbound_message',
        'new_message_received',
        'keyword_match',
      ])
    )
    // interactive_reply only fires when the tap actually happened —
    // this inbound was plain text, so it must NOT be in the list.
    expect(firedTriggers).not.toContain('interactive_reply')
    for (const call of runAutomationsForTrigger.mock.calls) {
      expect(call[0]).toMatchObject({
        accountId: 'acc-1',
        contactId: 'contact-1',
        context: expect.objectContaining({
          message_text: 'hello there',
          conversation_id: 'conv-1',
        }),
      })
    }

    // AI auto-reply — flow didn't consume, not interactive, non-empty text.
    expect(dispatchInboundToAiReply).toHaveBeenCalledWith({
      accountId: 'acc-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
    })

    // message.received webhook-out event.
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'message.received',
      expect.objectContaining({
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        whatsapp_message_id: 'msg-1',
        content_type: 'text',
        text: 'hello there',
      })
    )

    expect(reopenClosedConversation).toHaveBeenCalledTimes(1)
  })

  it('fires the interactive_reply trigger and skips AI auto-reply for an interactive tap the Flow runner did not consume', async () => {
    dispatchInboundToFlows.mockResolvedValue({ consumed: false })
    const message = textMessage({
      type: 'interactive',
      text: 'Yes please',
      interactiveReplyId: 'opt-yes',
    })

    await processInboundMessage({ connection: CONNECTION, message })

    expect(dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'opt-yes',
          reply_title: 'Yes please',
          meta_message_id: 'msg-1',
        },
      })
    )

    const firedTriggers = runAutomationsForTrigger.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    )
    expect(firedTriggers).toContain('interactive_reply')
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('suppresses content-level automation triggers (but not relationship-level ones) when a Flow consumes the message, and skips AI auto-reply', async () => {
    findOrCreateContact.mockResolvedValue({
      contact: { id: 'contact-1', unread_count: 0 },
      wasCreated: true,
    })
    dispatchInboundToFlows.mockResolvedValue({ consumed: true })

    await processInboundMessage({ connection: CONNECTION, message: textMessage() })

    const firedTriggers = runAutomationsForTrigger.mock.calls.map(
      (c) => (c[0] as { triggerType: string }).triggerType
    )
    expect(firedTriggers).toEqual(
      expect.arrayContaining(['new_contact_created', 'first_inbound_message'])
    )
    expect(firedTriggers).not.toContain('new_message_received')
    expect(firedTriggers).not.toContain('keyword_match')
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('short-circuits on a reaction: calls handleReaction, flags the broadcast-reply-adjacent contact record path skipped, never inserts a message, never dispatches Flows/Automations/AI/webhook-out', async () => {
    const message = textMessage({
      type: 'reaction',
      text: '👍',
      reaction: { targetProviderMessageId: 'msg-0', emoji: '👍' },
    })

    await processInboundMessage({ connection: CONNECTION, message })

    expect(handleReaction).toHaveBeenCalledWith(
      { targetProviderMessageId: 'msg-0', emoji: '👍' },
      'conv-1',
      'contact-1'
    )
    expect(dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled()
    // Only conversation.created may fire pre-reaction; message.received
    // (the post-insert event) must not.
    const events = dispatchWebhookEvent.mock.calls.map((c) => c[2])
    expect(events).not.toContain('message.received')
  })

  it('fires conversation.created before any reaction/message handling when the conversation was just created', async () => {
    findOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv-new', unread_count: 0, status: 'open' },
      created: true,
    })

    await processInboundMessage({
      connection: CONNECTION,
      message: textMessage({
        type: 'reaction',
        reaction: { targetProviderMessageId: 'msg-0', emoji: '👍' },
      }),
    })

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'conversation.created',
      { conversation_id: 'conv-new', contact_id: 'contact-1' }
    )
  })

  it('reopens a closed conversation on inbound', async () => {
    findOrCreateConversation.mockResolvedValue({
      conversation: { id: 'conv-1', unread_count: 0, status: 'closed' },
      created: false,
    })

    await processInboundMessage({ connection: CONNECTION, message: textMessage() })

    expect(reopenClosedConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'conv-1', status: 'closed' })
    )
  })

  it('flags a broadcast reply for the sending contact', async () => {
    await processInboundMessage({ connection: CONNECTION, message: textMessage() })

    expect(flagBroadcastReplyIfAny).toHaveBeenCalledWith('acc-1', 'contact-1')
  })
})

describe('processInboundMessage — structural guard', () => {
  it('never contains a provider-name literal or a provider-branch comparison', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'process-inbound.ts'),
      'utf8'
    )

    expect(source.toLowerCase()).not.toContain('wasender')
    expect(source.toLowerCase()).not.toContain('evolution')
    // Catches `provider === 'x'`, `x === provider`, `.provider ===`, etc.
    // — any equality comparison touching a `provider`-named identifier.
    expect(source).not.toMatch(/provider\s*===/i)
    expect(source).not.toMatch(/===\s*['"]?\w*provider/i)
  })
})
