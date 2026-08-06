// ============================================================
// Load + decrypt an account's Google connection, ready to hand to
// calendar.ts / sheets-sync.ts. Mirrors loadAiConfig()'s shape
// (decrypt at load time, return null when not configured) and
// send-message.ts's "self-heal + persist refreshed token" pattern.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/crypto/encryption'
import type { GoogleConnectionTokens } from './calendar'

export interface LoadedGoogleConnection {
  tokens: GoogleConnectionTokens
  sheetId: string | null
  sheetRange: string | null
  sheetColumnMapping: Record<string, string> | null
}

/**
 * Load and decrypt the account's Google connection. Returns `null`
 * when there's no row (not connected yet). `baseUrl` is needed here
 * (not just at OAuth time) because the underlying OAuth2Client is
 * constructed with the same redirect_uri it was issued against —
 * googleapis doesn't use it for anything at refresh/API-call time,
 * but the constructor requires it.
 */
export async function loadGoogleConnection(
  db: SupabaseClient,
  accountId: string,
  baseUrl: string,
): Promise<LoadedGoogleConnection | null> {
  const { data, error } = await db
    .from('google_connections')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !data) return null

  let accessToken: string
  let refreshToken: string
  try {
    accessToken = decrypt(data.access_token)
    refreshToken = decrypt(data.refresh_token)
  } catch (err) {
    console.error(
      `[google connection] could not decrypt tokens for account ${accountId} — check ENCRYPTION_KEY:`,
      err,
    )
    return null
  }

  const tokens: GoogleConnectionTokens = {
    baseUrl,
    accessToken,
    refreshToken,
    expiryDate: new Date(data.token_expiry).getTime(),
    calendarId: data.calendar_id || 'primary',
    onRefreshed: async (refreshed) => {
      await db
        .from('google_connections')
        .update({
          access_token: encrypt(refreshed.accessToken),
          token_expiry: new Date(refreshed.expiryDate).toISOString(),
        })
        .eq('account_id', accountId)
    },
  }

  return {
    tokens,
    sheetId: data.sheet_id ?? null,
    sheetRange: data.sheet_range ?? null,
    sheetColumnMapping:
      data.sheet_column_mapping && Object.keys(data.sheet_column_mapping).length > 0
        ? data.sheet_column_mapping
        : null,
  }
}
