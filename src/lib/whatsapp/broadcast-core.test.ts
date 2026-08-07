import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBroadcast, deliverBroadcast, BroadcastError, type BroadcastPlan } from './broadcast-core';
import type { WhatsAppProvider } from './providers/types';

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ------------------------------------------------------------
// deliverBroadcast — outboundPacing throttle
//
// A minimal chainable fake for the `broadcast_recipients` /
// `broadcasts` updates deliverBroadcast issues — no assertions
// depend on what's stored, only on send timing/order, so a no-op
// thenable is enough.
// ------------------------------------------------------------
function fakeDb(): SupabaseClient {
  const chain = {
    update: () => chain,
    eq: () => Promise.resolve({ data: null, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

function fakeProvider(outboundPacing: boolean): WhatsAppProvider {
  return {
    id: 'wasender',
    capabilities: {
      metaTemplates: false,
      templateApproval: false,
      nativeInteractive: false,
      reactions: false,
      freeformOutsideWindow: true,
      phoneVariantRetry: false,
      outboundPacing,
    },
    sendText: vi.fn(),
    sendMedia: vi.fn(),
    sendTemplate: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    sendInteractiveButtons: vi.fn(),
    sendInteractiveList: vi.fn(),
    sendReaction: vi.fn(),
    markRead: vi.fn(),
    setTyping: vi.fn(),
    getConnectionStatus: vi.fn(),
    fetchInboundMedia: vi.fn(),
  } as unknown as WhatsAppProvider;
}

function fakePlan(provider: WhatsAppProvider, recipientCount: number): BroadcastPlan {
  return {
    broadcastId: 'b1',
    templateName: 'promo',
    templateLanguage: 'en_US',
    provider,
    templateRow: null,
    rejected: 0,
    planned: Array.from({ length: recipientCount }, (_, i) => ({
      recipientRowId: `r${i}`,
      phone: '+14155550123',
      params: [],
    })),
  };
}

describe('deliverBroadcast outbound pacing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not delay between sends when capabilities.outboundPacing is false', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const provider = fakeProvider(false);
    await deliverBroadcast(fakeDb(), fakePlan(provider, 3));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(provider.sendTemplate).toHaveBeenCalledTimes(3);
  });

  it('sleeps ~3-6s with jitter between sends (not before the first) when capabilities.outboundPacing is true', async () => {
    const delays: number[] = [];
    // Capture requested delays but resolve immediately so the test
    // doesn't actually wait multiple seconds.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const provider = fakeProvider(true);
    await deliverBroadcast(fakeDb(), fakePlan(provider, 3));

    expect(provider.sendTemplate).toHaveBeenCalledTimes(3);
    // 3 recipients, paced *between* sends -> 2 delays, not 3.
    expect(delays).toHaveLength(2);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(3_000);
      expect(d).toBeLessThan(6_000);
    }
  });
});
