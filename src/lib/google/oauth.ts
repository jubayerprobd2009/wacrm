// ============================================================
// Google OAuth2 — one connection per account, authorizing both
// Calendar (appointment booking, calendar.ts) and Sheets (lead sync,
// sheets-sync.ts) scopes in a single consent screen. See migration
// 040_google_integration.sql for the `google_connections` schema.
// ============================================================

import { google } from 'googleapis'
import crypto from 'node:crypto'
import { encrypt } from '@/lib/crypto/encryption'

// `googleapis` bundles its own nested copy of google-auth-library (via
// the googleapis-common package), which TypeScript treats as a
// distinct type from a standalone `google-auth-library` install even
// when both are the same version (private-field structural typing).
// Deriving the type from `google.auth.OAuth2` itself — rather than
// importing OAuth2Client from either package directly — guarantees
// every use in this file refers to the exact same class.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
] as const

export class GoogleOAuthError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.status = status
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new GoogleOAuthError(`${name} is not configured`, 503)
  }
  return value
}

export function buildRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/google/oauth/callback`
}

function oauthClient(baseUrl: string): OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
    requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    buildRedirectUri(baseUrl),
  )
}

/**
 * Signed state param carrying the account id through the OAuth
 * round-trip (Google just echoes `state` back verbatim — it doesn't
 * preserve any session). HMAC-signed with ENCRYPTION_KEY so the
 * callback can trust the account id came from a connect request we
 * issued, not a value an attacker crafted to link their Google
 * account into someone else's wacrm account.
 */
export function signState(accountId: string): string {
  const key = requireEnv('ENCRYPTION_KEY')
  const nonce = crypto.randomBytes(8).toString('hex')
  const payload = `${accountId}.${nonce}`
  const sig = crypto.createHmac('sha256', key).update(payload).digest('hex')
  return Buffer.from(`${payload}.${sig}`).toString('base64url')
}

export function verifyState(state: string): { accountId: string } | null {
  try {
    const key = requireEnv('ENCRYPTION_KEY')
    const decoded = Buffer.from(state, 'base64url').toString('utf8')
    const parts = decoded.split('.')
    if (parts.length !== 3) return null
    const [accountId, nonce, sig] = parts
    const expected = crypto.createHmac('sha256', key).update(`${accountId}.${nonce}`).digest('hex')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    return { accountId }
  } catch {
    return null
  }
}

export function getAuthUrl(baseUrl: string, accountId: string): string {
  const client = oauthClient(baseUrl)
  return client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token
    prompt: 'consent', // force refresh_token on re-connect too, not just first-ever consent
    scope: [...GOOGLE_SCOPES],
    state: signState(accountId),
  })
}

export interface ExchangedTokens {
  accessToken: string
  refreshToken: string
  expiryDate: number
  email: string
}

/**
 * Exchange the authorization `code` for tokens, and fetch the
 * connected Google account's email (stored for display in Settings —
 * "Connected as you@company.com").
 */
export async function exchangeCodeForTokens(baseUrl: string, code: string): Promise<ExchangedTokens> {
  const client = oauthClient(baseUrl)
  const { tokens } = await client.getToken(code)

  if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
    // Google omits refresh_token on a repeat consent for the same app+
    // user+scopes without `prompt=consent` forcing it — we always pass
    // `prompt: 'consent'` above specifically to avoid landing here.
    throw new GoogleOAuthError(
      'Google did not return a refresh token. Please try connecting again.',
      502,
    )
  }

  client.setCredentials(tokens)
  const userinfo = await client.request<{ email?: string }>({
    url: 'https://www.googleapis.com/oauth2/v2/userinfo',
  })

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    email: userinfo.data.email ?? 'unknown',
  }
}

/**
 * Return a live, ready-to-use OAuth2Client for an account's stored
 * connection — refreshing the access token first if it's expired (or
 * close to it). Callers (calendar.ts, sheets-sync.ts) pass this
 * straight to `googleapis`. `onRefreshed` lets the caller persist the
 * new access token/expiry back to `google_connections` without this
 * module needing a DB client of its own.
 */
export async function getAuthorizedClient(args: {
  baseUrl: string
  accessToken: string
  refreshToken: string
  expiryDate: number
  onRefreshed?: (tokens: { accessToken: string; expiryDate: number }) => Promise<void>
}): Promise<OAuth2Client> {
  const { baseUrl, accessToken, refreshToken, expiryDate, onRefreshed } = args
  const client = oauthClient(baseUrl)
  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
  })

  // 60s safety margin so a call that starts right at expiry doesn't
  // race Google's clock.
  if (expiryDate - Date.now() < 60_000) {
    const { credentials } = await client.refreshAccessToken()
    if (credentials.access_token && credentials.expiry_date) {
      client.setCredentials(credentials)
      if (onRefreshed) {
        await onRefreshed({
          accessToken: credentials.access_token,
          expiryDate: credentials.expiry_date,
        })
      }
    }
  }

  return client
}

/** Encrypt both tokens for storage — thin wrapper so call sites don't
 *  import `encrypt` directly and risk storing one encrypted / one not. */
export function encryptTokens(tokens: { accessToken: string; refreshToken: string }) {
  return {
    access_token: encrypt(tokens.accessToken),
    refresh_token: encrypt(tokens.refreshToken),
  }
}
