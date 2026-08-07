import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------------
// `template-render.ts` / `interactive-fallback.ts` are owned by a
// parallel agent and may not exist yet (see adapter.ts's file-header
// deviation note). Mocked here against their documented expected
// signatures — same contract the WaSenderAPI adapter's own test suite
// mocks against — so this suite runs independent of their landing.
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

const {
  createInstance,
  getConnectionState,
  sendText,
  sendMedia,
  markMessageAsRead,
  sendPresence,
  getBase64FromMediaMessage,
  fetchInstances,
} = vi.hoisted(() => ({
  createInstance: vi.fn(),
  getConnectionState: vi.fn(async () => ({ instance: { instanceName: 'wacrm-1', state: 'open' } })),
  sendText: vi.fn(async () => ({ key: { id: 'msg-1' } })),
  sendMedia: vi.fn(async () => ({ key: { id: 'msg-2' } })),
  markMessageAsRead: vi.fn(async () => undefined),
  sendPresence: vi.fn(async () => undefined),
  getBase64FromMediaMessage: vi.fn(
    async (): Promise<{ base64: string; mimetype?: string }> => ({
      base64: 'aGVsbG8=',
      mimetype: 'image/jpeg',
    })
  ),
  fetchInstances: vi.fn(async () => [{ instanceName: 'wacrm-1', number: '15551234567' }]),
}));
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return {
    ...actual,
    createInstance,
    getConnectionState,
    sendText,
    sendMedia,
    markMessageAsRead,
    sendPresence,
    getBase64FromMediaMessage,
    fetchInstances,
  };
});

import { createEvolutionProvider, EVOLUTION_CAPABILITIES } from './adapter';

const CONFIG = { baseUrl: 'https://evolution.example.com', adminApiKey: 'admin-key', instanceName: 'wacrm-1' };

describe('createEvolutionProvider', () => {
  const provider = createEvolutionProvider(CONFIG);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports id "evolution" and the same capability profile as WaSenderAPI', () => {
    expect(provider.id).toBe('evolution');
    expect(provider.capabilities).toEqual(EVOLUTION_CAPABILITIES);
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

  it('sendText forwards to client.sendText and returns the key id', async () => {
    sendText.mockResolvedValueOnce({ key: { id: 'm1' } });
    const result = await provider.sendText({ to: '15551234567', text: 'hi' });
    expect(sendText).toHaveBeenCalledWith(
      { baseUrl: CONFIG.baseUrl, adminApiKey: CONFIG.adminApiKey },
      'wacrm-1',
      { to: '15551234567', text: 'hi', contextMessageId: undefined }
    );
    expect(result).toEqual({ messageId: 'm1' });
  });

  it('sendMedia maps MediaKind to Evolution mediatype', async () => {
    sendMedia.mockResolvedValueOnce({ key: { id: 'm2' } });
    const result = await provider.sendMedia({
      to: '15551234567',
      kind: 'document',
      link: 'https://cdn.example/file.pdf',
      filename: 'file.pdf',
    });
    expect(sendMedia).toHaveBeenCalledWith(
      expect.anything(),
      'wacrm-1',
      expect.objectContaining({
        to: '15551234567',
        mediatype: 'document',
        media: 'https://cdn.example/file.pdf',
        fileName: 'file.pdf',
      })
    );
    expect(result).toEqual({ messageId: 'm2' });
  });

  it('sendTemplate renders via template-render.ts then sends as text when no media', async () => {
    renderTemplateToMessage.mockReturnValueOnce({ text: 'Hello {{1}}' });
    sendText.mockResolvedValueOnce({ key: { id: 'm4' } });

    const result = await provider.sendTemplate({ to: '15551234567', templateName: 'greeting' });

    expect(renderTemplateToMessage).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(expect.anything(), 'wacrm-1', {
      to: '15551234567',
      text: 'Hello {{1}}',
      contextMessageId: undefined,
    });
    expect(result).toEqual({ messageId: 'm4' });
  });

  it('sendTemplate sends media + caption when the rendered template carries a mediaUrl', async () => {
    renderTemplateToMessage.mockReturnValueOnce({
      text: 'caption',
      mediaUrl: 'https://cdn.example/img.jpg',
      mediaKind: 'image',
    });
    sendMedia.mockResolvedValueOnce({ key: { id: 'm5' } });

    await provider.sendTemplate({ to: '15551234567', templateName: 'promo' });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.anything(),
      'wacrm-1',
      expect.objectContaining({
        to: '15551234567',
        mediatype: 'image',
        media: 'https://cdn.example/img.jpg',
        caption: 'caption',
      })
    );
  });

  it('sendInteractiveButtons renders numbered text via interactive-fallback.ts', async () => {
    sendText.mockResolvedValueOnce({ key: { id: 'm6' } });
    await provider.sendInteractiveButtons({
      to: '15551234567',
      bodyText: 'Pick one',
      buttons: [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'No' },
      ],
    });
    expect(renderInteractiveButtonsAsText).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(expect.anything(), 'wacrm-1', {
      to: '15551234567',
      text: '1. Yes\n2. No',
      contextMessageId: undefined,
    });
  });

  it('sendInteractiveList renders numbered text via interactive-fallback.ts', async () => {
    sendText.mockResolvedValueOnce({ key: { id: 'm7' } });
    await provider.sendInteractiveList({
      to: '15551234567',
      bodyText: 'Pick a row',
      buttonLabel: 'Choose',
      sections: [{ rows: [{ id: 'a', title: 'Row A' }, { id: 'b', title: 'Row B' }] }],
    });
    expect(renderInteractiveListAsText).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(expect.anything(), 'wacrm-1', {
      to: '15551234567',
      text: '1. Row A\n2. Row B',
      contextMessageId: undefined,
    });
  });

  it('sendReaction throws — capabilities.reactions is false and this should never be called', async () => {
    await expect(
      provider.sendReaction({ to: '1', targetMessageId: 'x', emoji: '👍' })
    ).rejects.toThrow(/not supported/i);
  });

  it('markRead calls client.markMessageAsRead with a best-effort remoteJid', async () => {
    await provider.markRead({ messageId: 'MSG1' });
    expect(markMessageAsRead).toHaveBeenCalledWith(expect.anything(), 'wacrm-1', {
      remoteJid: 'MSG1',
      messageId: 'MSG1',
      fromMe: false,
    });
  });

  it('setTyping maps isTyping to composing/paused presence updates', async () => {
    await provider.setTyping({ to: '15551234567', isTyping: true });
    expect(sendPresence).toHaveBeenCalledWith(expect.anything(), 'wacrm-1', {
      to: '15551234567',
      presence: 'composing',
    });

    await provider.setTyping({ to: '15551234567', isTyping: false });
    expect(sendPresence).toHaveBeenCalledWith(expect.anything(), 'wacrm-1', {
      to: '15551234567',
      presence: 'paused',
    });
  });

  it('getConnectionStatus returns connected + phoneNumber when state is open', async () => {
    getConnectionState.mockResolvedValueOnce({ instance: { instanceName: 'wacrm-1', state: 'open' } });
    fetchInstances.mockResolvedValueOnce([{ instanceName: 'wacrm-1', number: '15551234567' }]);
    const result = await provider.getConnectionStatus();
    expect(result).toEqual({ status: 'connected', phoneNumber: '15551234567' });
  });

  it('getConnectionStatus returns disconnected when state is not open, without calling fetchInstances', async () => {
    getConnectionState.mockResolvedValueOnce({ instance: { instanceName: 'wacrm-1', state: 'close' } });
    const result = await provider.getConnectionStatus();
    expect(result).toEqual({ status: 'disconnected', phoneNumber: null });
    expect(fetchInstances).not.toHaveBeenCalled();
  });

  it('getConnectionStatus catches errors and reports disconnected', async () => {
    getConnectionState.mockRejectedValueOnce(new Error('unauthorized'));
    const result = await provider.getConnectionStatus();
    expect(result).toEqual({ status: 'disconnected', error: 'unauthorized' });
  });

  it('fetchInboundMedia resolves via getBase64FromMediaMessage and decodes base64', async () => {
    getBase64FromMediaMessage.mockResolvedValueOnce({ base64: 'aGVsbG8=', mimetype: 'image/jpeg' });
    const result = await provider.fetchInboundMedia({ mediaRef: 'msg-1' });
    expect(getBase64FromMediaMessage).toHaveBeenCalledWith(expect.anything(), 'wacrm-1', {
      messageKeyId: 'msg-1',
    });
    expect(result.buffer.toString()).toBe('hello');
    expect(result.contentType).toBe('image/jpeg');
  });

  it('fetchInboundMedia falls back to application/octet-stream when mimetype is missing', async () => {
    getBase64FromMediaMessage.mockResolvedValueOnce({ base64: 'aGVsbG8=' });
    const result = await provider.fetchInboundMedia({ mediaRef: 'msg-1' });
    expect(result.contentType).toBe('application/octet-stream');
  });
});
