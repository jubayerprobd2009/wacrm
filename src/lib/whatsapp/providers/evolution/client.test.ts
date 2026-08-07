import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createInstance,
  fetchConnectQr,
  getConnectionState,
  logoutInstance,
  deleteInstance,
  fetchInstances,
  setWebhook,
  sendText,
  sendMedia,
  markMessageAsRead,
  sendPresence,
  getBase64FromMediaMessage,
  EvolutionApiError,
  type EvolutionConnectionConfig,
} from './client';

const ADMIN_CONFIG: EvolutionConnectionConfig = {
  baseUrl: 'https://evolution.example.com',
  adminApiKey: 'admin-key',
};
const INSTANCE_CONFIG: EvolutionConnectionConfig = {
  baseUrl: 'https://evolution.example.com',
  adminApiKey: 'admin-key',
  instanceToken: 'instance-hash',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('evolution client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EVOLUTION_API_URL;
  });

  it('createInstance POSTs /instance/create with the admin apikey and correct body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ instance: { instanceName: 'wacrm-1' }, hash: 'the-hash', qrcode: { base64: 'data:...' } })
    );

    const result = await createInstance(ADMIN_CONFIG, 'wacrm-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/instance/create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'admin-key' }),
      })
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      instanceName: 'wacrm-1',
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });
    expect(result.hash).toBe('the-hash');
  });

  it('fetchConnectQr GETs /instance/connect/{name} with the admin apikey', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ base64: 'data:...' }));
    await fetchConnectQr(ADMIN_CONFIG, 'wacrm-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/instance/connect/wacrm-1',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('getConnectionState GETs /instance/connectionState/{name}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ instance: { instanceName: 'wacrm-1', state: 'open' } }));
    const result = await getConnectionState(ADMIN_CONFIG, 'wacrm-1');
    expect(result.instance.state).toBe('open');
  });

  it('logoutInstance DELETEs /instance/logout/{name}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await logoutInstance(ADMIN_CONFIG, 'wacrm-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/instance/logout/wacrm-1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('deleteInstance DELETEs /instance/delete/{name}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await deleteInstance(ADMIN_CONFIG, 'wacrm-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/instance/delete/wacrm-1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('fetchInstances GETs /instance/fetchInstances and always returns an array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ instanceName: 'wacrm-1', number: '15551234567' }));
    const result = await fetchInstances(ADMIN_CONFIG, 'wacrm-1');
    expect(result).toEqual([{ instanceName: 'wacrm-1', number: '15551234567' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/instance/fetchInstances?instanceName=wacrm-1',
      expect.anything()
    );
  });

  it('setWebhook POSTs /webhook/set/{name} with the instance token and the documented event list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await setWebhook(INSTANCE_CONFIG, 'wacrm-1', {
      url: 'https://app.example.com/hook',
      secret: 'derived-secret',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/webhook/set/wacrm-1',
      expect.objectContaining({ headers: expect.objectContaining({ apikey: 'instance-hash' }) })
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      webhook: {
        enabled: true,
        url: 'https://app.example.com/hook',
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'SEND_MESSAGE'],
        byEvents: false,
        base64: false,
        headers: { 'X-Webhook-Secret': 'derived-secret' },
      },
    });
  });

  it('setWebhook throws when no instance token is configured', async () => {
    await expect(
      setWebhook(ADMIN_CONFIG, 'wacrm-1', { url: 'https://app.example.com/hook', secret: 's' })
    ).rejects.toThrow(/instance apikey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendText POSTs /message/sendText/{name} with number/text and returns the key id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: 'msg-1', remoteJid: '155@s.whatsapp.net' } }));
    const result = await sendText(INSTANCE_CONFIG, 'wacrm-1', { to: '15551234567', text: 'hi' });
    expect(result.key.id).toBe('msg-1');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ number: '15551234567', text: 'hi' });
  });

  it('sendText includes a quoted key when contextMessageId is given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: 'msg-2' } }));
    await sendText(INSTANCE_CONFIG, 'wacrm-1', { to: '15551234567', text: 'reply', contextMessageId: 'orig-id' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      number: '15551234567',
      text: 'reply',
      quoted: { key: { id: 'orig-id' } },
    });
  });

  it('sendMedia POSTs /message/sendMedia/{name}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: 'msg-3' } }));
    const result = await sendMedia(INSTANCE_CONFIG, 'wacrm-1', {
      to: '15551234567',
      mediatype: 'image',
      media: 'https://cdn.example/img.jpg',
      caption: 'caption',
    });
    expect(result.key.id).toBe('msg-3');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/message/sendMedia/wacrm-1',
      expect.anything()
    );
  });

  it('markMessageAsRead POSTs /chat/markMessageAsRead/{name} with a readMessages array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await markMessageAsRead(INSTANCE_CONFIG, 'wacrm-1', {
      remoteJid: '155@s.whatsapp.net',
      messageId: 'msg-1',
      fromMe: false,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      readMessages: [{ remoteJid: '155@s.whatsapp.net', id: 'msg-1', fromMe: false }],
    });
  });

  it('sendPresence defaults delay to 1200ms when not given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await sendPresence(INSTANCE_CONFIG, 'wacrm-1', { to: '15551234567', presence: 'composing' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ number: '15551234567', presence: 'composing', delay: 1200 });
  });

  it('sendPresence forwards an explicit delay', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await sendPresence(INSTANCE_CONFIG, 'wacrm-1', { to: '15551234567', presence: 'paused', delayMs: 500 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ delay: 500 });
  });

  it('getBase64FromMediaMessage POSTs /chat/getBase64FromMediaMessage/{name}', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ base64: 'aGVsbG8=', mimetype: 'image/jpeg' }));
    const result = await getBase64FromMediaMessage(INSTANCE_CONFIG, 'wacrm-1', { messageKeyId: 'msg-1' });
    expect(result.base64).toBe('aGVsbG8=');
    expect(result.mimetype).toBe('image/jpeg');
  });

  it('throws EvolutionApiError with the status and message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'instance not found' }, 404));
    await expect(getConnectionState(ADMIN_CONFIG, 'missing')).rejects.toMatchObject({
      status: 404,
      message: 'instance not found',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'instance not found' }, 404));
    await expect(getConnectionState(ADMIN_CONFIG, 'missing')).rejects.toBeInstanceOf(EvolutionApiError);
  });

  it('falls back to EVOLUTION_API_URL when baseUrl is not on the config', async () => {
    process.env.EVOLUTION_API_URL = 'https://env-default.example.com';
    fetchMock.mockResolvedValueOnce(jsonResponse({ instance: { instanceName: 'wacrm-2', state: 'close' } }));
    await getConnectionState({ adminApiKey: 'admin-key' }, 'wacrm-2');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://env-default.example.com/instance/connectionState/wacrm-2',
      expect.anything()
    );
  });

  it('throws when neither config.baseUrl nor EVOLUTION_API_URL is set', async () => {
    await expect(getConnectionState({ adminApiKey: 'admin-key' }, 'wacrm-3')).rejects.toThrow(
      /base_url is not configured/
    );
  });
});
