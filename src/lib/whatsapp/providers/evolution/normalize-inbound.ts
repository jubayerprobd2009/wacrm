// ============================================================
// normalizeEvolutionInboundMessage — Evolution API's raw webhook
// payload -> NormalizedInboundMessage. This is the ONLY place allowed
// to know Evolution's payload shape for the inbound path — everything
// downstream (`processInboundMessage`) only ever sees the normalized
// shape (Phase 3's parity contract).
//
// Payload shape: `body.data.key` / `body.data.message` /
// `body.data.pushName` sit directly under `data` (no extra nesting
// the way Meta's `entry[].changes[].value.messages[]` does), and
// `body.event` carries the event name we subscribed to in
// `client.ts`'s `setWebhook` (MESSAGES_UPSERT / MESSAGES_UPDATE /
// CONNECTION_UPDATE / SEND_MESSAGE — Evolution echoes these back
// lowercased+dotted, e.g. `messages.upsert`; this normalizer accepts
// either casing defensively).
//
// DEVIATION: `NormalizedInboundMedia.url` is always `null` here. The
// interface explicitly allows null "if the provider failed to
// verify/resolve it" — Evolution's media resolution
// (`getBase64FromMediaMessage`, see `client.ts` /
// `EvolutionProvider.fetchInboundMedia`) needs a second API call, an
// upload to the `chat-media` storage bucket, and a DB write, which is
// `src/lib/whatsapp/inbound/media-ingest.ts` (Phase 6 of the plan) —
// not in this task's assigned file list. `message.providerMessageId`
// IS the media reference `fetchInboundMedia({mediaRef})` needs (it's
// `data.key.id`, the same id `getBase64FromMediaMessage` takes), so
// the Phase 6 agent has everything needed to resolve it without any
// change here.
// ============================================================

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type {
  NormalizedInboundMedia,
  NormalizedInboundMessage,
  NormalizedMediaKind,
} from '@/lib/whatsapp/inbound/types'

export interface EvolutionMessageKey {
  id: string
  remoteJid: string
  fromMe?: boolean
}

export interface EvolutionRawMessage {
  conversation?: string
  extendedTextMessage?: { text?: string; contextInfo?: { stanzaId?: string } }
  imageMessage?: { caption?: string; mimetype?: string }
  videoMessage?: { caption?: string; mimetype?: string }
  documentMessage?: { caption?: string; mimetype?: string; fileName?: string }
  audioMessage?: { mimetype?: string }
  locationMessage?: {
    degreesLatitude?: number
    degreesLongitude?: number
    name?: string
    address?: string
  }
  reactionMessage?: { key?: { id?: string }; text?: string }
  buttonsResponseMessage?: { selectedButtonId?: string; selectedDisplayText?: string }
  listResponseMessage?: { singleSelectReply?: { selectedRowId?: string }; title?: string }
  contextInfo?: { stanzaId?: string }
}

export interface EvolutionInboundData {
  key: EvolutionMessageKey
  message?: EvolutionRawMessage
  pushName?: string
  /** Baileys-style epoch seconds (may arrive as a numeric string). */
  messageTimestamp?: number | string
}

export interface EvolutionWebhookBody {
  event?: string
  /** Must match the config's `instance_name` — validated below. */
  instance?: string
  data?: EvolutionInboundData
}

function mediaKindAndMime(
  msg: EvolutionRawMessage
): { kind: NormalizedMediaKind; mimeType: string | null } | null {
  if (msg.imageMessage) return { kind: 'image', mimeType: msg.imageMessage.mimetype ?? null }
  if (msg.videoMessage) return { kind: 'video', mimeType: msg.videoMessage.mimetype ?? null }
  if (msg.documentMessage)
    return { kind: 'document', mimeType: msg.documentMessage.mimetype ?? null }
  if (msg.audioMessage) return { kind: 'audio', mimeType: msg.audioMessage.mimetype ?? null }
  return null
}

/**
 * Returns null (caller should no-op / skip) when: the event isn't a
 * message upsert, `body.instance` doesn't match this config's
 * `instance_name` (misrouted or stale webhook — the unique index on
 * `instance_name` from migration 047 is what makes this check
 * meaningful), the message is from a group (`@g.us`), or it's an echo
 * of our own outbound send (`key.fromMe`) — same skip rules as the
 * WaSenderAPI normalizer.
 */
export function normalizeEvolutionInboundMessage(
  body: EvolutionWebhookBody,
  instanceName: string
): NormalizedInboundMessage | null {
  const event = (body.event ?? '').toLowerCase().replace(/_/g, '.')
  if (event !== 'messages.upsert') return null

  if (!body.instance || body.instance !== instanceName) {
    console.warn(
      `[evolution/normalize-inbound] instance mismatch: payload="${body.instance}" config="${instanceName}" — dropping message`
    )
    return null
  }

  const data = body.data
  if (!data?.key?.id || !data.key.remoteJid) return null

  const { key, message, pushName } = data
  if (key.remoteJid.endsWith('@g.us')) return null // group message — skip
  if (key.fromMe) return null // echo of our own outbound send — skip

  const fromPhone = normalizePhone(key.remoteJid.split('@')[0])
  const timestampRaw = data.messageTimestamp
  const timestampSeconds =
    typeof timestampRaw === 'string'
      ? parseInt(timestampRaw, 10)
      : (timestampRaw ?? Math.floor(Date.now() / 1000))
  const timestampMs = Math.round(
    (Number.isFinite(timestampSeconds) ? timestampSeconds : Math.floor(Date.now() / 1000)) * 1000
  )

  const base = {
    providerMessageId: key.id,
    fromPhone,
    senderName: pushName || fromPhone,
    timestampMs,
    interactiveReplyId: null as string | null,
    reaction: null as NormalizedInboundMessage['reaction'],
    replyToProviderMessageId:
      message?.extendedTextMessage?.contextInfo?.stanzaId ??
      message?.contextInfo?.stanzaId ??
      null,
    raw: body,
  }

  if (!message) {
    return { ...base, type: 'text', text: '[unsupported message type]', media: null }
  }

  // Reactions short-circuit generically in the shared core — normalize
  // regardless of anything else on the payload, mirroring the Meta
  // normalizer's early handling.
  if (message.reactionMessage) {
    return {
      ...base,
      type: 'reaction',
      text: message.reactionMessage.text || null,
      media: null,
      reaction: {
        targetProviderMessageId: message.reactionMessage.key?.id ?? '',
        emoji: message.reactionMessage.text ?? '',
      },
    }
  }

  if (message.buttonsResponseMessage) {
    return {
      ...base,
      type: 'interactive',
      text: message.buttonsResponseMessage.selectedDisplayText ?? null,
      media: null,
      interactiveReplyId: message.buttonsResponseMessage.selectedButtonId ?? null,
    }
  }

  if (message.listResponseMessage) {
    return {
      ...base,
      type: 'interactive',
      text: message.listResponseMessage.title ?? null,
      media: null,
      interactiveReplyId: message.listResponseMessage.singleSelectReply?.selectedRowId ?? null,
    }
  }

  if (message.locationMessage) {
    const loc = message.locationMessage
    const line = [loc.name, loc.address].filter(Boolean).join(', ')
    return {
      ...base,
      type: 'location',
      text: line || `${loc.degreesLatitude ?? ''},${loc.degreesLongitude ?? ''}`,
      media: null,
    }
  }

  const mediaInfo = mediaKindAndMime(message)
  if (mediaInfo) {
    const media: NormalizedInboundMedia = {
      kind: mediaInfo.kind,
      url: null, // see DEVIATION note above — Phase 6 media-ingest.ts resolves this
      mimeType: mediaInfo.mimeType,
    }
    const caption =
      message.imageMessage?.caption ??
      message.videoMessage?.caption ??
      message.documentMessage?.caption ??
      null
    return { ...base, type: mediaInfo.kind, text: caption, media }
  }

  const text = message.conversation ?? message.extendedTextMessage?.text ?? null
  if (text !== null) {
    return { ...base, type: 'text', text, media: null }
  }

  return { ...base, type: 'text', text: '[unsupported message type]', media: null }
}
