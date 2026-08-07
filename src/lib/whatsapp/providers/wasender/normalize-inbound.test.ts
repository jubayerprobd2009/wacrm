import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeWaSenderInboundMessage,
  type WaSenderWebhookPayload,
} from './normalize-inbound';

describe('normalizeWaSenderInboundMessage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes a plain text message via messageBody', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG1', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
          message: { conversation: 'hi there' },
          messageBody: 'hi there',
          pushName: 'Jane Doe',
          messageTimestamp: 1700000000,
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);

    expect(result).toEqual({
      providerMessageId: 'MSG1',
      fromPhone: '15551234567',
      senderName: 'Jane Doe',
      timestampMs: 1700000000 * 1000,
      interactiveReplyId: null,
      reaction: null,
      replyToProviderMessageId: null,
      raw: payload,
      type: 'text',
      text: 'hi there',
      media: null,
    });
  });

  it('falls back to message.conversation when messageBody is absent', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG2', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
          message: { conversation: 'from conversation field' },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.text).toBe('from conversation field');
  });

  it('falls back to message.extendedTextMessage.text when neither messageBody nor conversation is present', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG3', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
          message: { extendedTextMessage: { text: 'extended text body' } },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.text).toBe('extended text body');
  });

  it('prefers key.senderPn over remoteJid for fromPhone when present', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: {
            id: 'MSG4',
            remoteJid: '999888777@lid',
            fromMe: false,
            senderPn: '+1 (555) 123-4567',
          },
          message: { conversation: 'hi' },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.fromPhone).toBe('15551234567');
  });

  it('strips the individual-chat JID suffix when senderPn is absent', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG5', remoteJid: '15559876543@s.whatsapp.net', fromMe: false },
          message: { conversation: 'hi' },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.fromPhone).toBe('15559876543');
  });

  it('resolves the swipe-reply parent id from extendedTextMessage.contextInfo.stanzaId', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG6', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
          message: {
            extendedTextMessage: { text: 'replying', contextInfo: { stanzaId: 'PARENT1' } },
          },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.replyToProviderMessageId).toBe('PARENT1');
  });

  it('normalizes a reaction and short-circuits type detection', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG7', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
          message: { reactionMessage: { key: { id: 'TARGET1' }, text: '👍' } },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.type).toBe('reaction');
    expect(result?.reaction).toEqual({ targetProviderMessageId: 'TARGET1', emoji: '👍' });
  });

  it('normalizes an image message with url unresolved (baileys-media.ts not wired up)', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG8', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
          message: { imageMessage: { caption: 'look at this', mimetype: 'image/jpeg' } },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.type).toBe('image');
    expect(result?.text).toBe('look at this');
    expect(result?.media).toEqual({ kind: 'image', url: null, mimeType: 'image/jpeg' });
  });

  it('normalizes a location message into a text label', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG9', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
          message: {
            locationMessage: {
              degreesLatitude: 1.23,
              degreesLongitude: 4.56,
              name: 'HQ',
              address: '123 Main St',
            },
          },
        },
      },
    };

    const result = normalizeWaSenderInboundMessage(payload);
    expect(result?.type).toBe('location');
    expect(result?.text).toBe('HQ — 123 Main St');
  });

  it('skips group messages (remoteJid ends with @g.us) and returns null', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG10', remoteJid: '120363012345678901@g.us', fromMe: false },
          message: { conversation: 'group chatter' },
        },
      },
    };

    expect(normalizeWaSenderInboundMessage(payload)).toBeNull();
  });

  it('skips echoes of our own outbound sends (fromMe: true) and returns null', () => {
    const payload: WaSenderWebhookPayload = {
      event: 'messages.upsert',
      data: {
        messages: {
          key: { id: 'MSG11', remoteJid: '15551234567@s.whatsapp.net', fromMe: true },
          message: { conversation: 'we sent this' },
        },
      },
    };

    expect(normalizeWaSenderInboundMessage(payload)).toBeNull();
  });

  it('returns null on a malformed payload missing data.messages.key', () => {
    expect(normalizeWaSenderInboundMessage({ event: 'messages.upsert', data: {} })).toBeNull();
    expect(normalizeWaSenderInboundMessage({ event: 'messages.upsert' })).toBeNull();
    // @ts-expect-error - deliberately malformed input for the defensive branch
    expect(normalizeWaSenderInboundMessage(null)).toBeNull();
  });
});
