// ============================================================
// normalizeWaSenderInboundMessage — WaSenderAPI's raw webhook payload
// -> NormalizedInboundMessage (src/lib/whatsapp/inbound/types.ts).
//
// This is the ONLY place allowed to know WaSenderAPI's payload shape
// for the inbound path — everything downstream
// (`processInboundMessage`) only ever sees the normalized shape. See
// `src/lib/whatsapp/providers/meta/normalize-inbound.ts` for the
// sibling Meta normalizer this mirrors.
//
// Phase 4 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// Payload shape (WaSenderAPI wraps Baileys, so `data.messages.message`
// carries Baileys' own proto-derived message shapes):
//   {
//     event: 'messages.upsert' | ...,
//     data: {
//       messages: {
//         key: { id, remoteJid, fromMe, senderPn? },
//         message: { conversation?, extendedTextMessage?, imageMessage?,
//                     videoMessage?, documentMessage?, audioMessage?,
//                     stickerMessage?, locationMessage?, reactionMessage? },
//         messageBody?: string,
//         pushName?: string,
//         messageTimestamp?: number,
//       }
//     }
//   }
//
// Skipped (returns null, with a log line):
//   - group messages (`remoteJid` ends with the `@g.us` suffix)
//   - echoes of our own outbound sends (`key.fromMe === true`)
//   - malformed payloads missing `data.messages.key`
// ============================================================

import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type {
  NormalizedInboundMedia,
  NormalizedInboundMessage,
  NormalizedMediaKind,
} from '@/lib/whatsapp/inbound/types';

const GROUP_JID_SUFFIX = '@g.us';
// Baileys' individual-chat JID suffixes — stripped when falling back to
// `remoteJid` for the reply-to phone number (no `senderPn` present).
const INDIVIDUAL_JID_SUFFIXES = ['@s.whatsapp.net', '@c.us'];

export interface WaSenderWebhookKey {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  /** Present on newer Baileys/WaSenderAPI payloads — the sender's own
   *  phone-number JID, preferred over `remoteJid` when available (e.g.
   *  for messages relayed through a linked-device/LID JID). */
  senderPn?: string;
}

export interface WaSenderWebhookMessageContent {
  conversation?: string;
  extendedTextMessage?: {
    text?: string;
    contextInfo?: { stanzaId?: string };
  };
  imageMessage?: { caption?: string; mimetype?: string };
  videoMessage?: { caption?: string; mimetype?: string };
  documentMessage?: { caption?: string; mimetype?: string; fileName?: string };
  audioMessage?: { mimetype?: string };
  stickerMessage?: { mimetype?: string };
  locationMessage?: {
    degreesLatitude?: number;
    degreesLongitude?: number;
    name?: string;
    address?: string;
  };
  reactionMessage?: { key?: { id?: string }; text?: string };
}

export interface WaSenderWebhookMessages {
  key: WaSenderWebhookKey;
  message?: WaSenderWebhookMessageContent;
  /** Convenience plain-text field WaSenderAPI adds on top of the raw
   *  Baileys `message` object — preferred text source when present. */
  messageBody?: string;
  pushName?: string;
  messageTimestamp?: number;
}

export interface WaSenderWebhookPayload {
  event: string;
  data?: {
    messages?: WaSenderWebhookMessages;
  };
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_JID_SUFFIX);
}

function stripJidSuffix(jid: string): string {
  for (const suffix of INDIVIDUAL_JID_SUFFIXES) {
    if (jid.endsWith(suffix)) return jid.slice(0, -suffix.length);
  }
  return jid;
}

/**
 * Media is detected but not resolved to a servable URL here —
 * decrypting WaSenderAPI's raw Baileys media envelope is
 * `src/lib/whatsapp/providers/baileys-media.ts` (Phase 4 of the plan),
 * which is not part of this task's assigned files. Mirrors the
 * "resolution failed" branch of the Meta normalizer's `resolveMedia`:
 * `url: null` + a log line, rather than silently dropping the message
 * or crashing the webhook.
 */
function unresolvedMedia(
  kind: NormalizedMediaKind,
  mimeType: string | null,
  providerMessageId: string
): NormalizedInboundMedia {
  console.warn(
    `[wasender/normalize-inbound] media on message ${providerMessageId} (${kind}) not resolved — baileys-media.ts is not yet wired up.`
  );
  return { kind, url: null, mimeType };
}

export function normalizeWaSenderInboundMessage(
  payload: WaSenderWebhookPayload
): NormalizedInboundMessage | null {
  const entry = payload?.data?.messages;
  if (!entry || !entry.key || !entry.key.id || !entry.key.remoteJid) {
    console.warn('[wasender/normalize-inbound] malformed payload, skipping:', payload);
    return null;
  }

  const { key } = entry;

  if (isGroupJid(key.remoteJid)) {
    console.log(`[wasender/normalize-inbound] skipping group message on ${key.remoteJid}`);
    return null;
  }

  if (key.fromMe) {
    console.log(`[wasender/normalize-inbound] skipping echo of our own outbound message ${key.id}`);
    return null;
  }

  const fromPhone = normalizePhone(key.senderPn || stripJidSuffix(key.remoteJid));
  const message = entry.message;

  const base = {
    providerMessageId: key.id,
    fromPhone,
    senderName: entry.pushName || fromPhone,
    timestampMs: entry.messageTimestamp
      ? entry.messageTimestamp * 1000
      : Date.now(),
    interactiveReplyId: null as string | null,
    reaction: null as NormalizedInboundMessage['reaction'],
    replyToProviderMessageId: message?.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    raw: payload,
  };

  // Reactions short-circuit generically in the shared inbound core —
  // normalize target id + emoji regardless of what else is on the
  // payload, mirroring the Meta normalizer's early return.
  if (message?.reactionMessage?.key?.id) {
    return {
      ...base,
      type: 'reaction',
      text: message.reactionMessage.text || null,
      media: null,
      reaction: {
        targetProviderMessageId: message.reactionMessage.key.id,
        emoji: message.reactionMessage.text || '',
      },
    };
  }

  const text =
    entry.messageBody ??
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    null;

  if (message?.imageMessage) {
    return {
      ...base,
      type: 'image',
      text: message.imageMessage.caption || text,
      media: unresolvedMedia('image', message.imageMessage.mimetype ?? null, key.id),
    };
  }

  if (message?.videoMessage) {
    return {
      ...base,
      type: 'video',
      text: message.videoMessage.caption || text,
      media: unresolvedMedia('video', message.videoMessage.mimetype ?? null, key.id),
    };
  }

  if (message?.documentMessage) {
    return {
      ...base,
      type: 'document',
      text: message.documentMessage.caption || message.documentMessage.fileName || text,
      media: unresolvedMedia('document', message.documentMessage.mimetype ?? null, key.id),
    };
  }

  if (message?.audioMessage) {
    return {
      ...base,
      type: 'audio',
      text,
      media: unresolvedMedia('audio', message.audioMessage.mimetype ?? null, key.id),
    };
  }

  if (message?.stickerMessage) {
    return {
      ...base,
      type: 'image', // stickers map to images, matching process-inbound.ts's ALLOWED_CONTENT_TYPES fallback
      text: null,
      media: unresolvedMedia('image', message.stickerMessage.mimetype ?? null, key.id),
    };
  }

  if (message?.locationMessage) {
    const loc = message.locationMessage;
    const parts = [loc.name, loc.address].filter(Boolean);
    const label = parts.length
      ? parts.join(' — ')
      : `${loc.degreesLatitude ?? '?'}, ${loc.degreesLongitude ?? '?'}`;
    return {
      ...base,
      type: 'location',
      text: label,
      media: null,
    };
  }

  // Plain text (or an unrecognized/unsupported Baileys message subtype
  // that at least surfaced a `messageBody`/`conversation` string).
  return {
    ...base,
    type: 'text',
    text: text ?? '[unsupported message type]',
    media: null,
  };
}
