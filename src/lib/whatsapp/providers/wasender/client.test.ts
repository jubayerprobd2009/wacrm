import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WaSenderClient,
  WaSenderAuthError,
  WaSenderRateLimitError,
  WaSenderUnavailableError,
  WaSenderApiError,
} from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WaSenderClient', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  let client: WaSenderClient;

  beforeEach(() => {
    fetchImpl = vi.fn();
    client = new WaSenderClient({
      apiKey: 'test-key',
      baseUrl: 'https://wasender.test/api',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus sends a bearer-authed GET to /status', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { status: 'connected' }));

    const result = await client.getStatus();

    expect(result).toEqual({ status: 'connected' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://wasender.test/api/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      })
    );
  });

  it('sendMessage posts {to, text} for a text-only send and extracts the message id', async () => {
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { success: true, data: { msgId: 'wa-msg-1' } })
    );

    const result = await client.sendMessage({ to: '+15551234567', text: 'hello' });

    expect(result).toEqual({
      messageId: 'wa-msg-1',
      raw: { success: true, data: { msgId: 'wa-msg-1' } },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://wasender.test/api/send-message');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ to: '+15551234567', text: 'hello' });
  });

  it('sendMessage posts media fields alongside an optional caption', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { data: { msgId: 'wa-msg-2' } }));

    await client.sendMessage({
      to: '+15551234567',
      text: 'caption text',
      imageUrl: 'https://cdn.example/pic.jpg',
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      to: '+15551234567',
      text: 'caption text',
      imageUrl: 'https://cdn.example/pic.jpg',
    });
  });

  it('markMessagesRead posts the message key to /messages/read', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { success: true }));

    await client.markMessagesRead({ id: 'm1', remoteJid: '123@s.whatsapp.net', fromMe: false });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://wasender.test/api/messages/read');
    expect(JSON.parse(init.body)).toEqual({
      key: { id: 'm1', remoteJid: '123@s.whatsapp.net', fromMe: false },
    });
  });

  it('sendPresenceUpdate posts jid/type/delayMs to /send-presence-update', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { success: true }));

    await client.sendPresenceUpdate({ jid: '123@s.whatsapp.net', type: 'composing', delayMs: 500 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://wasender.test/api/send-presence-update');
    expect(JSON.parse(init.body)).toEqual({
      jid: '123@s.whatsapp.net',
      type: 'composing',
      delayMs: 500,
    });
  });

  it('maps HTTP 401 to WaSenderAuthError', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(401, { message: 'bad key' }));
    await expect(client.getStatus()).rejects.toBeInstanceOf(WaSenderAuthError);
  });

  it('maps HTTP 429 to WaSenderRateLimitError', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(429, { message: 'slow down' }));
    await expect(client.getStatus()).rejects.toBeInstanceOf(WaSenderRateLimitError);
  });

  it('maps HTTP 500 to WaSenderUnavailableError', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));
    await expect(client.getStatus()).rejects.toBeInstanceOf(WaSenderUnavailableError);
  });

  it('maps a network failure (fetch throws) to WaSenderUnavailableError', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(client.getStatus()).rejects.toBeInstanceOf(WaSenderUnavailableError);
  });

  it('maps other non-2xx statuses to a generic WaSenderApiError carrying the status', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse(400, { message: 'bad request' }));
    await expect(client.getStatus()).rejects.toMatchObject({
      status: 400,
      message: 'bad request',
    });
    fetchImpl.mockResolvedValueOnce(jsonResponse(400, { message: 'bad request' }));
    await expect(client.getStatus()).rejects.toBeInstanceOf(WaSenderApiError);
  });

  it('handles a non-JSON success body without throwing', async () => {
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(client.markMessagesRead({ id: 'm1', remoteJid: 'x', fromMe: false })).resolves.toBeUndefined();
  });
});
