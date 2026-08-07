import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
  verifyPhoneNumber,
  getMediaUrl,
  downloadMedia,
} = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid-text' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid-media' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-template' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid-buttons' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid-list' })),
  sendReactionMessage: vi.fn(async () => ({ messageId: 'wamid-reaction' })),
  verifyPhoneNumber: vi.fn(async () => ({
    id: 'PNID-1',
    display_phone_number: '+15551234567',
  })),
  getMediaUrl: vi.fn(async () => ({
    url: 'https://cdn.example/media',
    mimeType: 'image/jpeg',
  })),
  downloadMedia: vi.fn(async () => ({
    buffer: Buffer.from('bytes'),
    contentType: 'image/jpeg',
  })),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
  verifyPhoneNumber,
  getMediaUrl,
  downloadMedia,
}));

import { createMetaProvider, META_CAPABILITIES } from './meta';

const CONFIG = { phoneNumberId: 'PNID-1', accessToken: 'plaintext-token' };

describe('createMetaProvider', () => {
  const provider = createMetaProvider(CONFIG);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports id "meta" and every capability true except outboundPacing', () => {
    expect(provider.id).toBe('meta');
    expect(provider.capabilities).toEqual(META_CAPABILITIES);
    expect(provider.capabilities.outboundPacing).toBe(false);
    expect(provider.capabilities.metaTemplates).toBe(true);
    expect(provider.capabilities.templateApproval).toBe(true);
    expect(provider.capabilities.nativeInteractive).toBe(true);
    expect(provider.capabilities.reactions).toBe(true);
    expect(provider.capabilities.freeformOutsideWindow).toBe(true);
    expect(provider.capabilities.phoneVariantRetry).toBe(true);
  });

  it('sendText forwards phoneNumberId/accessToken and returns the wamid', async () => {
    const result = await provider.sendText({ to: '+15551234567', text: 'hi' });
    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID-1',
      accessToken: 'plaintext-token',
      to: '+15551234567',
      text: 'hi',
      contextMessageId: undefined,
    });
    expect(result).toEqual({ messageId: 'wamid-text' });
  });

  it('sendMedia forwards args and returns the wamid', async () => {
    const result = await provider.sendMedia({
      to: '+15551234567',
      kind: 'image',
      link: 'https://example.com/img.jpg',
      caption: 'caption',
    });
    expect(sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'PNID-1',
        accessToken: 'plaintext-token',
        to: '+15551234567',
        kind: 'image',
        link: 'https://example.com/img.jpg',
        caption: 'caption',
      })
    );
    expect(result).toEqual({ messageId: 'wamid-media' });
  });

  it('sendTemplate forwards args and returns the wamid', async () => {
    const result = await provider.sendTemplate({
      to: '+15551234567',
      templateName: 'order_update',
      language: 'en_US',
      params: ['Acme'],
    });
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'PNID-1',
        accessToken: 'plaintext-token',
        to: '+15551234567',
        templateName: 'order_update',
        language: 'en_US',
        params: ['Acme'],
      })
    );
    expect(result).toEqual({ messageId: 'wamid-template' });
  });

  it('sendInteractiveButtons forwards args and returns the wamid', async () => {
    const result = await provider.sendInteractiveButtons({
      to: '+15551234567',
      bodyText: 'Pick one',
      buttons: [{ id: 'yes', title: 'Yes' }],
    });
    expect(sendInteractiveButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'PNID-1',
        accessToken: 'plaintext-token',
        to: '+15551234567',
        bodyText: 'Pick one',
        buttons: [{ id: 'yes', title: 'Yes' }],
      })
    );
    expect(result).toEqual({ messageId: 'wamid-buttons' });
  });

  it('sendInteractiveList forwards args and returns the wamid', async () => {
    const result = await provider.sendInteractiveList({
      to: '+15551234567',
      bodyText: 'Pick one',
      buttonLabel: 'Options',
      sections: [{ rows: [{ id: 'a', title: 'A' }] }],
    });
    expect(sendInteractiveList).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'PNID-1',
        accessToken: 'plaintext-token',
        to: '+15551234567',
        buttonLabel: 'Options',
      })
    );
    expect(result).toEqual({ messageId: 'wamid-list' });
  });

  it('sendReaction forwards args and returns the wamid', async () => {
    const result = await provider.sendReaction({
      to: '+15551234567',
      targetMessageId: 'wamid-x',
      emoji: '👍',
    });
    expect(sendReactionMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID-1',
      accessToken: 'plaintext-token',
      to: '+15551234567',
      targetMessageId: 'wamid-x',
      emoji: '👍',
    });
    expect(result).toEqual({ messageId: 'wamid-reaction' });
  });

  it('getConnectionStatus reports connected + phoneNumber on success', async () => {
    const result = await provider.getConnectionStatus();
    expect(verifyPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: 'PNID-1',
      accessToken: 'plaintext-token',
    });
    expect(result).toEqual({
      status: 'connected',
      phoneNumber: '+15551234567',
    });
  });

  it('getConnectionStatus reports disconnected + error message on failure', async () => {
    verifyPhoneNumber.mockRejectedValueOnce(new Error('bad token'));
    const result = await provider.getConnectionStatus();
    expect(result).toEqual({ status: 'disconnected', error: 'bad token' });
  });

  it('fetchInboundMedia resolves the media URL then downloads the bytes', async () => {
    const result = await provider.fetchInboundMedia({ mediaRef: 'media-1' });
    expect(getMediaUrl).toHaveBeenCalledWith({
      mediaId: 'media-1',
      accessToken: 'plaintext-token',
    });
    expect(downloadMedia).toHaveBeenCalledWith({
      downloadUrl: 'https://cdn.example/media',
      accessToken: 'plaintext-token',
    });
    expect(result).toEqual({
      buffer: Buffer.from('bytes'),
      contentType: 'image/jpeg',
    });
  });

  it('markRead POSTs a read receipt to the Meta Graph API', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await provider.markRead({ messageId: 'wamid-inbound' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://graph.facebook.com/v21.0/PNID-1/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid-inbound',
    });
  });

  it('markRead throws Meta\'s error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'bad id' } }), {
            status: 400,
          })
      )
    );

    await expect(
      provider.markRead({ messageId: 'wamid-bad' })
    ).rejects.toThrow('bad id');
  });

  it('setTyping is a documented no-op (Meta has no standalone typing API)', async () => {
    await expect(
      provider.setTyping({ to: '+15551234567', isTyping: true })
    ).resolves.toBeUndefined();
  });
});
