import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { decrypt, encrypt, isLegacyFormat } = vi.hoisted(() => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  isLegacyFormat: vi.fn(() => false),
}));
vi.mock('@/lib/crypto/encryption', () => ({ decrypt, encrypt, isLegacyFormat }));

const { createMetaProvider } = vi.hoisted(() => ({
  createMetaProvider: vi.fn((args: { phoneNumberId: string; accessToken: string }) => ({
    id: 'meta',
    __args: args,
  })),
}));
vi.mock('./meta', () => ({ createMetaProvider }));

const { createWaSenderProvider } = vi.hoisted(() => ({
  createWaSenderProvider: vi.fn((args: { apiKey: string }) => ({
    id: 'wasender',
    __args: args,
  })),
}));
vi.mock('./wasender/adapter', () => ({ createWaSenderProvider }));

const { createEvolutionProvider } = vi.hoisted(() => ({
  createEvolutionProvider: vi.fn(
    (args: { baseUrl?: string | null; adminApiKey: string; instanceToken?: string | null; instanceName: string }) => ({
      id: 'evolution',
      __args: args,
    })
  ),
}));
vi.mock('./evolution/adapter', () => ({ createEvolutionProvider }));

import {
  resolveWhatsAppConnection,
  getProviderForAccount,
  isWhatsAppConnected,
  getConnectionSummary,
} from './resolve';
import { SendMessageError } from '@/lib/whatsapp/send-message';

interface Script {
  official?: Record<string, unknown> | null;
  officialError?: { message: string } | null;
  unofficial?: Record<string, unknown> | null;
  unofficialError?: { message: string } | null;
}

// Chainable Supabase stub keyed by table name, since resolve.ts now
// queries both `whatsapp_config` and `whatsapp_unofficial_config`.
// `.update().eq()` resolves to a thenable so the fire-and-forget
// self-heal can be awaited in tests without a real DB.
function makeDb(script: Script) {
  const updateCalls: Array<{ table: string; id: string; patch: Record<string, unknown> }> = [];

  function builderFor(table: string) {
    let pendingPatch: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (patch: Record<string, unknown>) => {
        pendingPatch = patch;
        return builder;
      },
      eq: (col: string, val: string) => {
        if (col === 'id') {
          updateCalls.push({ table, id: val, patch: pendingPatch });
        }
        return builder;
      },
      maybeSingle: () => {
        if (table === 'whatsapp_config') {
          return Promise.resolve({
            data: script.official ?? null,
            error: script.officialError ?? null,
          });
        }
        return Promise.resolve({
          data: script.unofficial ?? null,
          error: script.unofficialError ?? null,
        });
      },
      then: (resolve: (v: { data: null; error: null }) => void) =>
        resolve({ data: null, error: null }),
    };
    return builder;
  }

  const db = {
    from: (table: string) => builderFor(table),
  } as unknown as SupabaseClient;

  return { db, updateCalls };
}

const CONNECTED_OFFICIAL = {
  id: 'cfg-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  phone_number_id: 'PNID-1',
  access_token: 'ct:cfg-1',
  status: 'connected' as const,
};

const CONNECTED_WASENDER = {
  id: 'unof-1',
  account_id: 'acct-1',
  provider: 'wasender' as const,
  status: 'connected' as const,
  is_primary: false,
  phone_number: '+15550001111',
  api_key: 'ct:wasender-key',
};

const CONNECTED_EVOLUTION = {
  id: 'unof-2',
  account_id: 'acct-1',
  provider: 'evolution' as const,
  status: 'connected' as const,
  is_primary: false,
  phone_number: '+15550002222',
  base_url: 'https://evo.example.com',
  admin_api_key: 'ct:evo-admin',
  instance_name: 'acct-1-instance',
  instance_token: 'ct:evo-instance-token',
};

beforeEach(() => {
  vi.clearAllMocks();
  decrypt.mockImplementation((v: string) => `decrypted:${v}`);
  isLegacyFormat.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveWhatsAppConnection — Meta only (legacy path)', () => {
  it('returns null when neither table has a row', async () => {
    const { db } = makeDb({ official: null, unofficial: null });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toBeNull();
    expect(createMetaProvider).not.toHaveBeenCalled();
  });

  it('returns null when official exists but is disconnected', async () => {
    const { db } = makeDb({ official: { ...CONNECTED_OFFICIAL, status: 'disconnected' } });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toBeNull();
  });

  it('returns null on a DB error fetching official config', async () => {
    const { db } = makeDb({ official: null, officialError: { message: 'db down' } });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toBeNull();
  });

  it('builds a Meta provider from a connected config, decrypting the access token', async () => {
    const { db } = makeDb({ official: CONNECTED_OFFICIAL });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(decrypt).toHaveBeenCalledWith('ct:cfg-1');
    expect(createMetaProvider).toHaveBeenCalledWith({
      phoneNumberId: 'PNID-1',
      accessToken: 'decrypted:ct:cfg-1',
    });
    expect(result).toEqual({
      id: 'meta',
      __args: { phoneNumberId: 'PNID-1', accessToken: 'decrypted:ct:cfg-1' },
    });
  });

  it('self-heals a legacy-CBC access_token by writing back a GCM ciphertext', async () => {
    isLegacyFormat.mockReturnValue(true);
    const { db, updateCalls } = makeDb({ official: CONNECTED_OFFICIAL });

    await resolveWhatsAppConnection(db, 'acct-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(encrypt).toHaveBeenCalledWith('decrypted:ct:cfg-1');
    expect(updateCalls).toEqual([
      { table: 'whatsapp_config', id: 'cfg-1', patch: { access_token: 'encrypted:decrypted:ct:cfg-1' } },
    ]);
  });

  it('does not attempt a self-heal write when the token is already GCM', async () => {
    isLegacyFormat.mockReturnValue(false);
    const { db, updateCalls } = makeDb({ official: CONNECTED_OFFICIAL });

    await resolveWhatsAppConnection(db, 'acct-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(encrypt).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
  });
});

describe('resolveWhatsAppConnection — unofficial providers', () => {
  it('builds a WaSenderAPI provider, decrypting the api_key', async () => {
    const { db } = makeDb({ official: null, unofficial: CONNECTED_WASENDER });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(decrypt).toHaveBeenCalledWith('ct:wasender-key');
    expect(createWaSenderProvider).toHaveBeenCalledWith({
      apiKey: 'decrypted:ct:wasender-key',
    });
    expect(result).toMatchObject({ id: 'wasender' });
  });

  it('builds an Evolution provider, decrypting admin_api_key + instance_token', async () => {
    const { db } = makeDb({ official: null, unofficial: CONNECTED_EVOLUTION });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(createEvolutionProvider).toHaveBeenCalledWith({
      baseUrl: 'https://evo.example.com',
      adminApiKey: 'decrypted:ct:evo-admin',
      instanceToken: 'decrypted:ct:evo-instance-token',
      instanceName: 'acct-1-instance',
    });
    expect(result).toMatchObject({ id: 'evolution' });
  });

  it('throws when a connected wasender row has no api_key', async () => {
    const { db } = makeDb({
      official: null,
      unofficial: { ...CONNECTED_WASENDER, api_key: null },
    });
    await expect(resolveWhatsAppConnection(db, 'acct-1')).rejects.toThrow();
  });

  it('throws when a connected evolution row is missing admin_api_key/instance_name', async () => {
    const { db } = makeDb({
      official: null,
      unofficial: { ...CONNECTED_EVOLUTION, admin_api_key: null },
    });
    await expect(resolveWhatsAppConnection(db, 'acct-1')).rejects.toThrow();
  });
});

// ------------------------------------------------------------
// Precedence matrix — official present/connected x unofficial
// present/connected x is_primary, per the client's confirmed rule:
//   (a) unofficial connected AND is_primary=true -> unofficial wins
//   (b) else official connected                  -> official wins
//   (c) else unofficial connected                -> unofficial wins
//   (d) else                                      -> null
// ------------------------------------------------------------
describe('resolveWhatsAppConnection — precedence matrix', () => {
  it('(a) unofficial primary + connected wins over a connected official', async () => {
    const { db } = makeDb({
      official: CONNECTED_OFFICIAL,
      unofficial: { ...CONNECTED_WASENDER, is_primary: true },
    });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toMatchObject({ id: 'wasender' });
    expect(createMetaProvider).not.toHaveBeenCalled();
  });

  it('(b) official wins when unofficial is connected but not primary', async () => {
    const { db } = makeDb({
      official: CONNECTED_OFFICIAL,
      unofficial: { ...CONNECTED_WASENDER, is_primary: false },
    });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toMatchObject({ id: 'meta' });
  });

  it('(b) official wins when unofficial exists but is disconnected (even if is_primary)', async () => {
    const { db } = makeDb({
      official: CONNECTED_OFFICIAL,
      unofficial: { ...CONNECTED_WASENDER, status: 'disconnected', is_primary: true },
    });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toMatchObject({ id: 'meta' });
  });

  it('(c) unofficial wins when official is not connected, regardless of is_primary', async () => {
    const { db } = makeDb({
      official: null,
      unofficial: { ...CONNECTED_EVOLUTION, is_primary: false },
    });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toMatchObject({ id: 'evolution' });
  });

  it('(c) unofficial wins when official row exists but disconnected', async () => {
    const { db } = makeDb({
      official: { ...CONNECTED_OFFICIAL, status: 'disconnected' },
      unofficial: CONNECTED_WASENDER,
    });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toMatchObject({ id: 'wasender' });
  });

  it('(d) null when neither is connected', async () => {
    const { db } = makeDb({
      official: { ...CONNECTED_OFFICIAL, status: 'disconnected' },
      unofficial: { ...CONNECTED_WASENDER, status: 'disconnected' },
    });
    const result = await resolveWhatsAppConnection(db, 'acct-1');
    expect(result).toBeNull();
  });

  it('(d) null when neither table has a row', async () => {
    const { db } = makeDb({ official: null, unofficial: null });
    expect(await resolveWhatsAppConnection(db, 'acct-1')).toBeNull();
  });
});

describe('getProviderForAccount', () => {
  it('returns the resolved provider when connected', async () => {
    const { db } = makeDb({ official: CONNECTED_OFFICIAL });
    const provider = await getProviderForAccount(db, 'acct-1');
    expect(provider).toMatchObject({ id: 'meta' });
  });

  it('throws SendMessageError("whatsapp_not_configured") when nothing is connected', async () => {
    const { db } = makeDb({ official: null, unofficial: null });
    await expect(getProviderForAccount(db, 'acct-1')).rejects.toBeInstanceOf(
      SendMessageError
    );
    await getProviderForAccount(db, 'acct-1').catch((e: SendMessageError) => {
      expect(e.code).toBe('whatsapp_not_configured');
      expect(e.status).toBe(400);
    });
  });
});

describe('isWhatsAppConnected', () => {
  it('is true when official is connected', async () => {
    const { db } = makeDb({ official: CONNECTED_OFFICIAL, unofficial: null });
    await expect(isWhatsAppConnected(db, 'acct-1')).resolves.toBe(true);
  });

  it('is true when only unofficial is connected', async () => {
    const { db } = makeDb({ official: null, unofficial: CONNECTED_WASENDER });
    await expect(isWhatsAppConnected(db, 'acct-1')).resolves.toBe(true);
  });

  it('is false when both are disconnected or missing', async () => {
    const { db: disconnectedDb } = makeDb({
      official: { ...CONNECTED_OFFICIAL, status: 'disconnected' },
      unofficial: { ...CONNECTED_WASENDER, status: 'disconnected' },
    });
    await expect(isWhatsAppConnected(disconnectedDb, 'acct-1')).resolves.toBe(false);

    const { db: missingDb } = makeDb({ official: null, unofficial: null });
    await expect(isWhatsAppConnected(missingDb, 'acct-1')).resolves.toBe(false);
  });
});

describe('getConnectionSummary', () => {
  it('reports official connected, unofficial not configured', async () => {
    const { db } = makeDb({ official: CONNECTED_OFFICIAL, unofficial: null });
    const summary = await getConnectionSummary(db, 'acct-1');
    expect(summary).toEqual({
      connected: true,
      active_provider: 'meta',
      official: { configured: true, connected: true, phone_number: 'PNID-1' },
      unofficial: { configured: false, connected: false, provider: null, phone_number: null },
    });
  });

  it('reports both configured, unofficial primary and connected -> active_provider is unofficial', async () => {
    const { db } = makeDb({
      official: CONNECTED_OFFICIAL,
      unofficial: { ...CONNECTED_EVOLUTION, is_primary: true },
    });
    const summary = await getConnectionSummary(db, 'acct-1');
    expect(summary.connected).toBe(true);
    expect(summary.active_provider).toBe('evolution');
    expect(summary.official).toEqual({ configured: true, connected: true, phone_number: 'PNID-1' });
    expect(summary.unofficial).toEqual({
      configured: true,
      connected: true,
      provider: 'evolution',
      phone_number: '+15550002222',
    });
  });

  it('reports configured-but-not-connected unofficial (pending) distinctly from unconfigured', async () => {
    const { db } = makeDb({
      official: null,
      unofficial: { ...CONNECTED_WASENDER, status: 'pending' },
    });
    const summary = await getConnectionSummary(db, 'acct-1');
    expect(summary.connected).toBe(false);
    expect(summary.active_provider).toBeNull();
    expect(summary.unofficial).toEqual({
      configured: true,
      connected: false,
      provider: 'wasender',
      phone_number: null,
    });
  });

  it('reports disconnected + active_provider null when nothing is connected or configured', async () => {
    const { db } = makeDb({ official: null, unofficial: null });
    const summary = await getConnectionSummary(db, 'acct-1');
    expect(summary).toEqual({
      connected: false,
      active_provider: null,
      official: { configured: false, connected: false, phone_number: null },
      unofficial: { configured: false, connected: false, provider: null, phone_number: null },
    });
  });
});
