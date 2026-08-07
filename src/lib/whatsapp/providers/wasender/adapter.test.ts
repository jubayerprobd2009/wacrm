import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------------
// `template-render.ts` / `interactive-fallback.ts` are owned by a
// parallel agent and may not exist yet (see adapter.ts's file-header
// deviation note). Mocked here against their documented expected
// signatures so this suite can run independent of their landing —
// Vitest/Vite mocks intercept the specifier without requiring the
// file to physically exist.
// ------------------------------------------------------------------
const { renderTemplateToMessage } = vi.hoisted(() => ({
  renderTemplateToMessage: vi.fn(
    (): { text: string; mediaUrl?: string; mediaKind?: string } => ({
      text: 'rendered template text',
    })
  ),
}));
vi.mock('@/lib/whatsapp/template-render', () => ({ renderTemplateToMessage }));

const { renderInteractiveButtonsAsText, renderInteractiveListAsText } = vi.hoisted(() => ({
  renderInteractiveButtonsAsText: vi.fn(() => '1. Yes\n2. No'),
  renderInteractiveListAsText: vi.fn(() => '1. Row A\n2. Row B'),
}));
vi.mock('@/lib/whatsapp/providers/interactive-fallback', () => ({
  renderInteractiveButtonsAsText,
  renderInteractiveListAsText,
}));

const { sendMessage, markMessagesRead, sendPresenceUpdate, getStatus } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ messageId: 'wa-msg-1', raw: {} })),
  markMessagesRead: vi.fn(async () => undefined),
  sendPresenceUpdate: vi.fn(async () => undefined),
  getStatus: vi.fn(
    async (): Promise<{ status: string; phone_number?: string }> => ({
      status: 'connected',
      phone_number: '+15551234567',
    })
  ),
}));
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  class FakeWaSenderClient {
    sendMessage = sendMessage;
    markMessagesRead = markMessagesRead;
    sendPresenceUpdate = sendPresenceUpdate;
    getStatus = getStatus;
  }
  return {
    ...actual,
    WaSenderClient: FakeWaSenderClient,
  };
});

import { createWaSenderProvider, WASENDER_CAPABILITIES } from './adapter';

describe('createWaSenderProvider', () => {
  const provider = createWaSenderProvider({ apiKey: 'test-key' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports id "wasender" and the documented capability flags', () => {
    expect(provider.id).toBe('wasender');
    expect(provider.capabilities).toEqual(WASENDER_CAPABILITIES);
    expect(provider.capabilities).toEqual({
      metaTemplates: false,
      templateApproval: false,
      nativeInteractive: false,
      reactions: false,
      freeformOutsideWindow: true,
      phoneVariantRetry: false,
      outboundPacing: true,
    });
  });

  it('sendText forwards to client.sendMessage as {to, text}', async () => {
    sendMessage.mockResolvedValueOnce({ messageId: 'm1', raw: {} });
    const result = await provider.sendText({ to: '+15551234567', text: 'hi' });
    expect(sendMessage).toHaveBeenCalledWith({ to: '+15551234567', text: 'hi' });
    expect(result).toEqual({ messageId: 'm1' });
  });

  it('sendMedia maps kind to the right *Url field', async () => {
    sendMessage.mockResolvedValueOnce({ messageId: 'm2', raw: {} });
    await provider.sendMedia({
      to: '+15551234567',
      kind: 'image',
      link: 'https://cdn.example/pic.jpg',
      caption: 'nice',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      to: '+15551234567',
      text: 'nice',
      imageUrl: 'https://cdn.example/pic.jpg',
    });
  });

  it('sendMedia maps document kind to documentUrl', async () => {
    sendMessage.mockResolvedValueOnce({ messageId: 'm3', raw: {} });
    await provider.sendMedia({
      to: '+15551234567',
      kind: 'document',
      link: 'https://cdn.example/file.pdf',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      to: '+15551234567',
      text: undefined,
      documentUrl: 'https://cdn.example/file.pdf',
    });
  });

  it('sendTemplate renders via template-render.ts then sends as text when no media', async () => {
    renderTemplateToMessage.mockReturnValueOnce({ text: 'Hello {{1}}' });
    sendMessage.mockResolvedValueOnce({ messageId: 'm4', raw: {} });

    const result = await provider.sendTemplate({ to: '+15551234567', templateName: 'greeting' });

    expect(renderTemplateToMessage).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ to: '+15551234567', text: 'Hello {{1}}' });
    expect(result).toEqual({ messageId: 'm4' });
  });

  it('sendTemplate sends media + caption when the rendered template carries a mediaUrl', async () => {
    renderTemplateToMessage.mockReturnValueOnce({
      text: 'caption',
      mediaUrl: 'https://cdn.example/img.jpg',
      mediaKind: 'image',
    });
    sendMessage.mockResolvedValueOnce({ messageId: 'm5', raw: {} });

    await provider.sendTemplate({ to: '+15551234567', templateName: 'promo' });

    expect(sendMessage).toHaveBeenCalledWith({
      to: '+15551234567',
      text: 'caption',
      imageUrl: 'https://cdn.example/img.jpg',
    });
  });

  it('sendInteractiveButtons renders numbered text via interactive-fallback.ts', async () => {
    sendMessage.mockResolvedValueOnce({ messageId: 'm6', raw: {} });
    await provider.sendInteractiveButtons({
      to: '+15551234567',
      bodyText: 'Pick one',
      buttons: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }],
    });
    expect(renderInteractiveButtonsAsText).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ to: '+15551234567', text: '1. Yes\n2. No' });
  });

  it('sendInteractiveList renders numbered text via interactive-fallback.ts', async () => {
    sendMessage.mockResolvedValueOnce({ messageId: 'm7', raw: {} });
    await provider.sendInteractiveList({
      to: '+15551234567',
      bodyText: 'Pick a row',
      buttonLabel: 'Choose',
      sections: [{ rows: [{ id: 'a', title: 'Row A' }, { id: 'b', title: 'Row B' }] }],
    });
    expect(renderInteractiveListAsText).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ to: '+15551234567', text: '1. Row A\n2. Row B' });
  });

  it('sendReaction throws — capabilities.reactions is false and this should never be called', async () => {
    await expect(
      provider.sendReaction({ to: '+1', targetMessageId: 'x', emoji: '👍' })
    ).rejects.toThrow(/not supported/i);
  });

  it('markRead calls client.markMessagesRead with a best-effort key', async () => {
    await provider.markRead({ messageId: 'MSG1' });
    expect(markMessagesRead).toHaveBeenCalledWith({
      id: 'MSG1',
      remoteJid: 'MSG1',
      fromMe: false,
    });
  });

  it('setTyping maps isTyping to composing/paused presence updates', async () => {
    await provider.setTyping({ to: '+15551234567', isTyping: true });
    expect(sendPresenceUpdate).toHaveBeenCalledWith({ jid: '+15551234567', type: 'composing' });

    await provider.setTyping({ to: '+15551234567', isTyping: false });
    expect(sendPresenceUpdate).toHaveBeenCalledWith({ jid: '+15551234567', type: 'paused' });
  });

  it('getConnectionStatus maps a connected status response', async () => {
    getStatus.mockResolvedValueOnce({ status: 'CONNECTED', phone_number: '+15551234567' });
    const result = await provider.getConnectionStatus();
    expect(result).toEqual({ status: 'connected', phoneNumber: '+15551234567' });
  });

  it('getConnectionStatus maps a disconnected status response', async () => {
    getStatus.mockResolvedValueOnce({ status: 'disconnected' });
    const result = await provider.getConnectionStatus();
    expect(result.status).toBe('disconnected');
  });

  it('getConnectionStatus catches errors and reports disconnected', async () => {
    getStatus.mockRejectedValueOnce(new Error('unauthorized'));
    const result = await provider.getConnectionStatus();
    expect(result).toEqual({ status: 'disconnected', error: 'unauthorized' });
  });

  it('fetchInboundMedia throws — baileys-media.ts is not wired up', async () => {
    await expect(provider.fetchInboundMedia({ mediaRef: 'ref1' })).rejects.toThrow(
      /not yet supported/i
    );
  });
});
