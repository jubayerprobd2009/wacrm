import { describe, expect, it, vi } from 'vitest';
import type { WhatsAppProvider } from '@/lib/whatsapp/providers/types';
import { ingestInboundMedia, MediaIngestError } from './media-ingest';

const { uploadMock, getPublicUrlMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(
    async (
      _path: string,
      _body: Buffer,
      _options: { contentType: string; upsert: boolean; cacheControl: string },
    ): Promise<{ error: { message: string } | null }> => ({ error: null }),
  ),
  getPublicUrlMock: vi.fn(() => ({
    data: { publicUrl: 'https://storage.example.com/chat-media/account-acct-1/file.jpg' },
  })),
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: uploadMock,
        getPublicUrl: getPublicUrlMock,
      }),
    },
  }),
}));

function makeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    id: 'evolution',
    capabilities: {
      metaTemplates: false,
      templateApproval: false,
      nativeInteractive: false,
      reactions: false,
      freeformOutsideWindow: true,
      phoneVariantRetry: false,
      outboundPacing: true,
    },
    sendText: vi.fn(),
    sendMedia: vi.fn(),
    sendTemplate: vi.fn(),
    sendInteractiveButtons: vi.fn(),
    sendInteractiveList: vi.fn(),
    sendReaction: vi.fn(),
    markRead: vi.fn(),
    setTyping: vi.fn(),
    getConnectionStatus: vi.fn(),
    fetchInboundMedia: vi.fn(async () => ({
      buffer: Buffer.from('fake image bytes'),
      contentType: 'image/jpeg',
    })),
    ...overrides,
  };
}

describe('ingestInboundMedia', () => {
  it('fetches via the provider, uploads to chat-media, and returns the public URL', async () => {
    const provider = makeProvider();
    const result = await ingestInboundMedia('media-ref-1', provider, {
      accountId: 'acct-1',
      kind: 'image',
    });

    expect(provider.fetchInboundMedia).toHaveBeenCalledWith({ mediaRef: 'media-ref-1' });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, buffer, options] = uploadMock.mock.calls[0];
    expect(path).toMatch(/^account-acct-1\//);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: false });
    expect(result.publicUrl).toBe(
      'https://storage.example.com/chat-media/account-acct-1/file.jpg',
    );
    expect(result.contentType).toBe('image/jpeg');
  });

  it('uses the filename hint when provided', async () => {
    const provider = makeProvider();
    await ingestInboundMedia('media-ref-1', provider, {
      accountId: 'acct-1',
      kind: 'document',
      fileNameHint: 'invoice.pdf',
    });
    const [path] = uploadMock.mock.calls.at(-1)!;
    expect(path).toContain('invoice.pdf');
  });

  it('throws MediaIngestError when the provider fetch fails', async () => {
    const provider = makeProvider({
      fetchInboundMedia: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(
      ingestInboundMedia('media-ref-1', provider, { accountId: 'acct-1', kind: 'image' }),
    ).rejects.toThrow(MediaIngestError);
  });

  it('throws MediaIngestError when the media exceeds the per-kind size cap', async () => {
    const oversized = Buffer.alloc(6 * 1024 * 1024); // > 5 MB image cap
    const provider = makeProvider({
      fetchInboundMedia: vi.fn().mockResolvedValue({ buffer: oversized, contentType: 'image/jpeg' }),
    });
    await expect(
      ingestInboundMedia('media-ref-1', provider, { accountId: 'acct-1', kind: 'image' }),
    ).rejects.toThrow(MediaIngestError);
  });

  it('allows a document up to the 16 MB cap', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024);
    const provider = makeProvider({
      fetchInboundMedia: vi.fn().mockResolvedValue({ buffer: big, contentType: 'application/pdf' }),
    });
    await expect(
      ingestInboundMedia('media-ref-1', provider, { accountId: 'acct-1', kind: 'document' }),
    ).resolves.toBeTruthy();
  });

  it('throws MediaIngestError when the storage upload fails', async () => {
    uploadMock.mockResolvedValueOnce({ error: { message: 'bucket rejected' } });
    const provider = makeProvider();
    await expect(
      ingestInboundMedia('media-ref-1', provider, { accountId: 'acct-1', kind: 'image' }),
    ).rejects.toThrow(MediaIngestError);
  });
});
