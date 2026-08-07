import { describe, it, expect, vi } from 'vitest';
import { normalizeEvolutionInboundMessage, type EvolutionWebhookBody } from './normalize-inbound';

const INSTANCE = 'wacrm-abc123';

function upsertBody(overrides: Partial<EvolutionWebhookBody> = {}): EvolutionWebhookBody {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { id: 'msg-1', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
      pushName: 'Jane Doe',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello there' },
    },
    ...overrides,
  };
}

describe('normalizeEvolutionInboundMessage', () => {
  it('normalizes a plain text message', () => {
    const result = normalizeEvolutionInboundMessage(upsertBody(), INSTANCE);
    expect(result).toMatchObject({
      providerMessageId: 'msg-1',
      fromPhone: '15551234567',
      senderName: 'Jane Doe',
      type: 'text',
      text: 'hello there',
      media: null,
      interactiveReplyId: null,
      reaction: null,
    });
    expect(result?.timestampMs).toBe(1700000000000);
  });

  it('falls back to extendedTextMessage.text when conversation is absent', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-2', remoteJid: '15551234567@s.whatsapp.net' },
        message: { extendedTextMessage: { text: 'extended text' } },
      },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result?.text).toBe('extended text');
    expect(result?.type).toBe('text');
  });

  it('returns null for a group message (@g.us)', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-3', remoteJid: '12345-6789@g.us' },
        message: { conversation: 'group hi' },
      },
    });
    expect(normalizeEvolutionInboundMessage(body, INSTANCE)).toBeNull();
  });

  it('returns null for our own outbound echo (fromMe)', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-4', remoteJid: '15551234567@s.whatsapp.net', fromMe: true },
        message: { conversation: 'echo' },
      },
    });
    expect(normalizeEvolutionInboundMessage(body, INSTANCE)).toBeNull();
  });

  it('returns null when body.instance does not match the config instance_name', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = upsertBody({ instance: 'some-other-instance' });
    expect(normalizeEvolutionInboundMessage(body, INSTANCE)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns null for a non-messages.upsert event', () => {
    expect(normalizeEvolutionInboundMessage(upsertBody({ event: 'connection.update' }), INSTANCE)).toBeNull();
  });

  it('accepts an uppercase/underscored event name defensively', () => {
    const result = normalizeEvolutionInboundMessage(upsertBody({ event: 'MESSAGES_UPSERT' }), INSTANCE);
    expect(result).not.toBeNull();
  });

  it('normalizes a reaction and short-circuits other fields', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-5', remoteJid: '15551234567@s.whatsapp.net' },
        message: { reactionMessage: { key: { id: 'target-msg-id' }, text: '👍' } },
      },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result).toMatchObject({
      type: 'reaction',
      text: '👍',
      media: null,
      reaction: { targetProviderMessageId: 'target-msg-id', emoji: '👍' },
    });
  });

  it('normalizes a buttons-response reply into an interactive reply id', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-6', remoteJid: '15551234567@s.whatsapp.net' },
        message: { buttonsResponseMessage: { selectedButtonId: 'opt_yes', selectedDisplayText: 'Yes' } },
      },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result).toMatchObject({ type: 'interactive', interactiveReplyId: 'opt_yes', text: 'Yes' });
  });

  it('normalizes a list-response reply into an interactive reply id', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-7', remoteJid: '15551234567@s.whatsapp.net' },
        message: {
          listResponseMessage: { singleSelectReply: { selectedRowId: 'row_1' }, title: 'Option 1' },
        },
      },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result).toMatchObject({ type: 'interactive', interactiveReplyId: 'row_1', text: 'Option 1' });
  });

  it('normalizes an image message with caption, leaving media.url null', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-8', remoteJid: '15551234567@s.whatsapp.net' },
        message: { imageMessage: { caption: 'look at this', mimetype: 'image/jpeg' } },
      },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result).toMatchObject({
      type: 'image',
      text: 'look at this',
      media: { kind: 'image', url: null, mimeType: 'image/jpeg' },
    });
  });

  it('normalizes a location message', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-9', remoteJid: '15551234567@s.whatsapp.net' },
        message: { locationMessage: { name: 'HQ', address: '123 Main St' } },
      },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result).toMatchObject({ type: 'location', text: 'HQ, 123 Main St' });
  });

  it('captures a swipe-reply context id from extendedTextMessage.contextInfo.stanzaId', () => {
    const body = upsertBody({
      data: {
        key: { id: 'msg-10', remoteJid: '15551234567@s.whatsapp.net' },
        message: {
          extendedTextMessage: { text: 'replying', contextInfo: { stanzaId: 'parent-id' } },
        },
      },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result?.replyToProviderMessageId).toBe('parent-id');
  });

  it('returns null when data.key is missing', () => {
    expect(normalizeEvolutionInboundMessage(upsertBody({ data: undefined }), INSTANCE)).toBeNull();
  });

  it('falls back to an unsupported-type placeholder when message is absent', () => {
    const body = upsertBody({
      data: { key: { id: 'msg-11', remoteJid: '15551234567@s.whatsapp.net' } },
    });
    const result = normalizeEvolutionInboundMessage(body, INSTANCE);
    expect(result).toMatchObject({ type: 'text', text: '[unsupported message type]' });
  });
});
