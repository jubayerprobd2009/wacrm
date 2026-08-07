// ============================================================
// normalizeMetaInboundMessage — Meta's raw webhook message payload ->
// NormalizedInboundMessage. Replaces the pre-refactor `parseMessageContent`
// + the phone/name extraction that used to live inline in
// src/app/api/whatsapp/webhook/route.ts's `processMessage`. Pure
// behavior-identical move (Phase 3 of the plan — see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// This is the ONLY place allowed to know Meta's payload shape for the
// inbound path — everything downstream (`processInboundMessage`) only
// ever sees the normalized shape.
// ============================================================

import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type {
  NormalizedInboundMedia,
  NormalizedInboundMessage,
  NormalizedMediaKind,
} from '@/lib/whatsapp/inbound/types'

export interface MetaWebhookMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  context?: { id: string }
}

export interface MetaWebhookContact {
  profile: { name: string }
  wa_id: string
}

// getMediaUrl signature is (mediaId, accessToken) — earlier code had
// the args swapped, so every verification hit an invalid Meta URL and
// fell through to the catch block, leaving mediaUrl as null. That's
// why images showed up as empty bubbles in the inbox.
async function resolveMedia(
  mediaId: string,
  mimeType: string,
  kind: NormalizedMediaKind,
  accessToken: string
): Promise<NormalizedInboundMedia> {
  try {
    await getMediaUrl({ mediaId, accessToken })
    return { kind, url: `/api/whatsapp/media/${mediaId}`, mimeType }
  } catch (error) {
    console.error(
      `Failed to verify media ${mediaId} with Meta:`,
      error instanceof Error ? error.message : error
    )
    return { kind, url: null, mimeType }
  }
}

export async function normalizeMetaInboundMessage(
  message: MetaWebhookMessage,
  contact: MetaWebhookContact,
  accessToken: string
): Promise<NormalizedInboundMessage> {
  const base = {
    providerMessageId: message.id,
    fromPhone: normalizePhone(message.from),
    senderName: contact.profile.name,
    timestampMs: parseInt(message.timestamp) * 1000,
    interactiveReplyId: null as string | null,
    reaction: null as NormalizedInboundMessage['reaction'],
    replyToProviderMessageId: message.context?.id ?? null,
    raw: { message, contact },
  }

  // Reactions are handled generically by the shared core (it short-
  // circuits on `message.reaction` before ever inserting a `messages`
  // row) — normalize the target id + emoji up front regardless of
  // `message.type`, mirroring the pre-refactor early-return in
  // `processMessage`.
  if (message.type === 'reaction' && message.reaction) {
    return {
      ...base,
      type: 'reaction',
      text: message.reaction.emoji || null,
      media: null,
      reaction: {
        targetProviderMessageId: message.reaction.message_id,
        emoji: message.reaction.emoji,
      },
    }
  }

  switch (message.type) {
    case 'text':
      return { ...base, type: 'text', text: message.text?.body || null, media: null }

    case 'image':
      if (message.image?.id) {
        return {
          ...base,
          type: 'image',
          text: message.image.caption || null,
          media: await resolveMedia(
            message.image.id,
            message.image.mime_type,
            'image',
            accessToken
          ),
        }
      }
      return { ...base, type: 'image', text: null, media: null }

    case 'video':
      if (message.video?.id) {
        return {
          ...base,
          type: 'video',
          text: message.video.caption || null,
          media: await resolveMedia(
            message.video.id,
            message.video.mime_type,
            'video',
            accessToken
          ),
        }
      }
      return { ...base, type: 'video', text: null, media: null }

    case 'document':
      if (message.document?.id) {
        return {
          ...base,
          type: 'document',
          text: message.document.caption || message.document.filename || null,
          media: await resolveMedia(
            message.document.id,
            message.document.mime_type,
            'document',
            accessToken
          ),
        }
      }
      return { ...base, type: 'document', text: null, media: null }

    case 'audio':
      if (message.audio?.id) {
        return {
          ...base,
          type: 'audio',
          text: null,
          media: await resolveMedia(
            message.audio.id,
            message.audio.mime_type,
            'audio',
            accessToken
          ),
        }
      }
      return { ...base, type: 'audio', text: null, media: null }

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. `processInboundMessage` maps
      // the DB content_type to 'image' for the CHECK constraint based
      // on `type` staying 'sticker' here.
      if (message.sticker?.id) {
        return {
          ...base,
          type: 'sticker',
          text: null,
          media: await resolveMedia(
            message.sticker.id,
            message.sticker.mime_type,
            'image',
            accessToken
          ),
        }
      }
      return { ...base, type: 'sticker', text: null, media: null }

    case 'location': {
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...base, type: 'location', text: locationText, media: null }
      }
      return { ...base, type: 'location', text: null, media: null }
    }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as text so the inbox bubble renders
      // the tap legibly ("Existing customer"), and stash the stable id
      // separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...base,
          type: 'interactive',
          text: reply.title || reply.id,
          media: null,
          interactiveReplyId: reply.id,
        }
      }
      return { ...base, type: 'interactive', text: '[Interactive reply]', media: null }
    }

    default:
      return {
        ...base,
        type: message.type,
        text: `[Unsupported message type: ${message.type}]`,
        media: null,
      }
  }
}
