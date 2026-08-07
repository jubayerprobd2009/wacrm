import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  resolveAuditUserId,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});

describe('resolveAuditUserId', () => {
  /**
   * Minimal per-table fake — only implements the exact chains
   * `resolveAuditUserId` calls: `.from(table).select().eq(...).maybeSingle()`
   * and, for the `profiles` admin lookup, `.from('profiles').select().eq().in()`
   * (no terminal `.maybeSingle()` — the code awaits the builder directly
   * for a row array).
   */
  function fakeDb(responses: {
    whatsapp_config?: { user_id: string } | null;
    profiles?: { user_id: string; account_role: string }[];
    accounts?: { owner_user_id: string } | null;
  }): SupabaseClient {
    return {
      from(table: string) {
        if (table === 'whatsapp_config') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: responses.whatsapp_config ?? null, error: null }),
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                in: () => Promise.resolve({ data: responses.profiles ?? [], error: null }),
              }),
            }),
          };
        }
        if (table === 'accounts') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: responses.accounts ?? null, error: null }),
              }),
            }),
          };
        }
        throw new Error(`fakeDb: unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;
  }

  it('prefers whatsapp_config.user_id (Official owner) when present', async () => {
    const db = fakeDb({
      whatsapp_config: { user_id: 'official-owner' },
      profiles: [{ user_id: 'some-admin', account_role: 'admin' }],
      accounts: { owner_user_id: 'account-owner' },
    });
    await expect(resolveAuditUserId(db, 'acc')).resolves.toBe('official-owner');
  });

  it('falls back to the account admin (profiles.account_role) for an unofficial-only account', async () => {
    // No whatsapp_config row at all — the exact bug this fix targets:
    // an unofficial-only account must not resolve to nothing.
    const db = fakeDb({
      whatsapp_config: null,
      profiles: [{ user_id: 'the-admin', account_role: 'admin' }],
      accounts: { owner_user_id: 'account-owner' },
    });
    await expect(resolveAuditUserId(db, 'acc')).resolves.toBe('the-admin');
  });

  it('prefers owner over admin when both exist in profiles', async () => {
    const db = fakeDb({
      whatsapp_config: null,
      profiles: [
        { user_id: 'the-admin', account_role: 'admin' },
        { user_id: 'the-owner', account_role: 'owner' },
      ],
      accounts: { owner_user_id: 'account-owner' },
    });
    await expect(resolveAuditUserId(db, 'acc')).resolves.toBe('the-owner');
  });

  it('falls back to accounts.owner_user_id when profiles has no owner/admin row', async () => {
    const db = fakeDb({
      whatsapp_config: null,
      profiles: [],
      accounts: { owner_user_id: 'account-owner' },
    });
    await expect(resolveAuditUserId(db, 'acc')).resolves.toBe('account-owner');
  });

  it('throws a 500 ContactError when no owner can be resolved anywhere', async () => {
    const db = fakeDb({ whatsapp_config: null, profiles: [], accounts: null });
    await expect(resolveAuditUserId(db, 'acc')).rejects.toMatchObject({ status: 500 });
    await expect(resolveAuditUserId(db, 'acc')).rejects.toBeInstanceOf(ContactError);
  });
});
