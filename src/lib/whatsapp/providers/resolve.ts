// ============================================================
// resolve.ts — account -> WhatsAppProvider.
//
// Extended (Providers phase, see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md, Phase 4)
// from the Phase 2 Meta-only version to also read
// `whatsapp_unofficial_config` (047_whatsapp_unofficial_config.sql)
// and apply the client's confirmed primary-connection precedence:
//
//   (a) unofficial connected AND is_primary=true -> unofficial wins
//   (b) else official connected                  -> official wins
//   (c) else unofficial connected                -> unofficial wins
//   (d) else                                      -> null
//
// Also centralizes the legacy-CBC secret self-heal that used to live
// duplicated in `send-message.ts` and the webhook route — one place
// to fire-and-forget the GCM upgrade instead of copies drifting, now
// generalized across both config tables' encrypted columns.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt, isLegacyFormat } from '@/lib/crypto/encryption';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { createMetaProvider } from './meta';
import { createWaSenderProvider } from './wasender/adapter';
import { createEvolutionProvider } from './evolution/adapter';
import type { WhatsAppProvider } from './types';
import type { WhatsAppProviderId } from '@/types';

export interface WhatsAppConnectionSummary {
  connected: boolean;
  /** Which provider is the primary send path, or null if nothing is
   *  connected — derived from the precedence rules documented above. */
  active_provider: WhatsAppProviderId | null;
  official: {
    /** A `whatsapp_config` row exists (regardless of its status). */
    configured: boolean;
    connected: boolean;
    phone_number?: string | null;
  };
  unofficial: {
    /** A `whatsapp_unofficial_config` row exists (regardless of status). */
    configured: boolean;
    connected: boolean;
    provider: 'wasender' | 'evolution' | null;
    phone_number?: string | null;
  };
}

interface WhatsAppConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  phone_number_id: string;
  access_token: string;
  status: 'connected' | 'disconnected';
  waba_id?: string | null;
}

interface WhatsAppUnofficialConfigRow {
  id: string;
  account_id: string;
  provider: 'wasender' | 'evolution';
  status: 'connected' | 'disconnected' | 'pending';
  is_primary: boolean;
  phone_number?: string | null;
  api_key?: string | null;
  webhook_secret?: string | null;
  base_url?: string | null;
  admin_api_key?: string | null;
  instance_name?: string | null;
  instance_token?: string | null;
}

/**
 * Decrypt one encrypted column on a config row, opportunistically
 * upgrading a legacy CBC ciphertext to GCM in the background
 * (fire-and-forget — matches the pattern previously duplicated across
 * call sites, now generalized to any table/column pair so both
 * `whatsapp_config.access_token` and `whatsapp_unofficial_config`'s
 * several encrypted columns share one self-heal path).
 */
function decryptWithSelfHeal(
  db: SupabaseClient,
  table: string,
  rowId: string,
  column: string,
  encryptedValue: string
): string {
  const decrypted = decrypt(encryptedValue);

  if (isLegacyFormat(encryptedValue)) {
    void db
      .from(table)
      .update({ [column]: encrypt(decrypted) })
      .eq('id', rowId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            `[whatsapp/providers/resolve] ${table}.${column} GCM upgrade failed:`,
            error.message
          );
        }
      });
  }

  return decrypted;
}

/**
 * Fetch the account's `whatsapp_config` row, or null if none exists.
 * Internal — callers should go through `getProviderForAccount` /
 * `isWhatsAppConnected` / `getConnectionSummary` instead.
 */
async function fetchWhatsAppConfig(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppConfigRow | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error(
      '[whatsapp/providers/resolve] whatsapp_config lookup failed:',
      error.message
    );
    return null;
  }
  return (data as WhatsAppConfigRow | null) ?? null;
}

/**
 * Fetch the account's `whatsapp_unofficial_config` row, or null if
 * none exists. Internal, mirrors `fetchWhatsAppConfig`.
 */
async function fetchWhatsAppUnofficialConfig(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppUnofficialConfigRow | null> {
  const { data, error } = await db
    .from('whatsapp_unofficial_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    console.error(
      '[whatsapp/providers/resolve] whatsapp_unofficial_config lookup failed:',
      error.message
    );
    return null;
  }
  return (data as WhatsAppUnofficialConfigRow | null) ?? null;
}

function buildMetaProvider(db: SupabaseClient, config: WhatsAppConfigRow): WhatsAppProvider {
  const accessToken = decryptWithSelfHeal(
    db,
    'whatsapp_config',
    config.id,
    'access_token',
    config.access_token
  );
  return createMetaProvider({
    phoneNumberId: config.phone_number_id,
    accessToken,
  });
}

function buildUnofficialProvider(
  db: SupabaseClient,
  config: WhatsAppUnofficialConfigRow
): WhatsAppProvider {
  if (config.provider === 'wasender') {
    if (!config.api_key) {
      throw new Error(
        `[whatsapp/providers/resolve] whatsapp_unofficial_config ${config.id} is provider=wasender but has no api_key.`
      );
    }
    const apiKey = decryptWithSelfHeal(
      db,
      'whatsapp_unofficial_config',
      config.id,
      'api_key',
      config.api_key
    );
    return createWaSenderProvider({ apiKey });
  }

  // provider === 'evolution'
  if (!config.admin_api_key || !config.instance_name) {
    throw new Error(
      `[whatsapp/providers/resolve] whatsapp_unofficial_config ${config.id} is provider=evolution but is missing admin_api_key/instance_name.`
    );
  }
  const adminApiKey = decryptWithSelfHeal(
    db,
    'whatsapp_unofficial_config',
    config.id,
    'admin_api_key',
    config.admin_api_key
  );
  const instanceToken = config.instance_token
    ? decryptWithSelfHeal(
        db,
        'whatsapp_unofficial_config',
        config.id,
        'instance_token',
        config.instance_token
      )
    : null;

  return createEvolutionProvider({
    baseUrl: config.base_url,
    adminApiKey,
    instanceToken,
    instanceName: config.instance_name,
  });
}

interface ResolvedConnections {
  official: WhatsAppConfigRow | null;
  unofficial: WhatsAppUnofficialConfigRow | null;
}

async function fetchBothConfigs(
  db: SupabaseClient,
  accountId: string
): Promise<ResolvedConnections> {
  const [official, unofficial] = await Promise.all([
    fetchWhatsAppConfig(db, accountId),
    fetchWhatsAppUnofficialConfig(db, accountId),
  ]);
  return { official, unofficial };
}

/**
 * The client's confirmed primary-connection precedence (see file
 * header). Pure — takes already-fetched connection state so it's
 * trivially unit-testable without a DB.
 */
function pickActiveProvider(
  officialConnected: boolean,
  unofficial: WhatsAppUnofficialConfigRow | null
): 'meta' | 'wasender' | 'evolution' | null {
  const unofficialConnected = unofficial?.status === 'connected';

  if (unofficialConnected && unofficial!.is_primary) return unofficial!.provider;
  if (officialConnected) return 'meta';
  if (unofficialConnected) return unofficial!.provider;
  return null;
}

/**
 * Resolve the account's active WhatsApp connection to a provider
 * instance, or null if nothing is connected. Unlike
 * `getProviderForAccount`, this never throws on a "not connected"
 * outcome — used by callers that want to degrade gracefully (status
 * checks, banners) rather than fail a send. A malformed *connected*
 * unofficial config (missing required encrypted fields) still throws,
 * since that's a genuine misconfiguration rather than "not connected".
 */
export async function resolveWhatsAppConnection(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppProvider | null> {
  const { official, unofficial } = await fetchBothConfigs(db, accountId);
  const officialConnected = official?.status === 'connected';
  const active = pickActiveProvider(officialConnected, unofficial);

  if (active === 'meta') return buildMetaProvider(db, official!);
  if (active === 'wasender' || active === 'evolution') {
    return buildUnofficialProvider(db, unofficial!);
  }
  return null;
}

/**
 * Resolve the account's active WhatsApp provider, throwing the same
 * `SendMessageError('whatsapp_not_configured')` the pre-refactor
 * `send-message.ts` raised, so existing callers/tests keep working
 * unchanged once they're pointed at this helper.
 */
export async function getProviderForAccount(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppProvider> {
  const provider = await resolveWhatsAppConnection(db, accountId);
  if (!provider) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  return provider;
}

/**
 * True if the account has ANY WhatsApp connection (official OR
 * unofficial) — the parity requirement is that every "is WhatsApp
 * connected" check in the app answers this question the same way.
 */
export async function isWhatsAppConnected(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { official, unofficial } = await fetchBothConfigs(db, accountId);
  return official?.status === 'connected' || unofficial?.status === 'connected';
}

/**
 * Aggregate connection summary backing every "is WhatsApp connected"
 * UI surface (settings tiles, inbox banner, the
 * `/api/whatsapp/connection` endpoint) — cheap by design (no live
 * provider API calls), so it's safe to poll from the client.
 */
export async function getConnectionSummary(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppConnectionSummary> {
  const { official, unofficial } = await fetchBothConfigs(db, accountId);
  const officialConnected = official?.status === 'connected';
  const unofficialConnected = unofficial?.status === 'connected';
  const activeProvider = pickActiveProvider(officialConnected, unofficial);

  return {
    connected: officialConnected || unofficialConnected,
    active_provider: activeProvider,
    official: {
      configured: !!official,
      connected: officialConnected,
      // Meta's `phone_number_id` (not a human-readable display
      // number — that requires a live `verifyPhoneNumber` call, which
      // this summary intentionally avoids to stay cheap for UI polls).
      phone_number: officialConnected ? official?.phone_number_id : null,
    },
    unofficial: {
      configured: !!unofficial,
      connected: unofficialConnected,
      provider: unofficial?.provider ?? null,
      phone_number: unofficialConnected ? unofficial?.phone_number : null,
    },
  };
}
