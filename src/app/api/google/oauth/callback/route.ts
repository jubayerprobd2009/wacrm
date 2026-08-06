import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { getBaseUrl } from '@/lib/http/base-url'
import { exchangeCodeForTokens, verifyState, encryptTokens, GoogleOAuthError } from '@/lib/google/oauth'

/**
 * GET /api/google/oauth/callback
 *
 * Google redirects the admin's browser here with `?code=&state=`
 * after consent (or `?error=` if they declined). No JSON API contract
 * here — this always redirects back to the Google settings page with
 * a `?connected=1` or `?error=...` query param for the UI to toast.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const baseUrl = getBaseUrl(request, '[GET /api/google/oauth/callback]')
  const settingsUrl = (params: string) => NextResponse.redirect(`${baseUrl}/settings/google?${params}`)

  const oauthError = url.searchParams.get('error')
  if (oauthError) {
    return settingsUrl(`error=${encodeURIComponent(oauthError)}`)
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) {
    return settingsUrl('error=missing_code_or_state')
  }

  const verified = verifyState(state)
  if (!verified) {
    return settingsUrl('error=invalid_state')
  }

  // Defense in depth: the state's account id is authoritative for
  // which row we write, but also require the CURRENT session to be an
  // admin of that same account — a stolen/replayed state param alone
  // shouldn't be enough to attach a Google connection.
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch {
    return settingsUrl('error=unauthorized')
  }
  if (ctx.accountId !== verified.accountId) {
    return settingsUrl('error=account_mismatch')
  }

  try {
    const tokens = await exchangeCodeForTokens(baseUrl, code)
    const encrypted = encryptTokens(tokens)

    const { error } = await ctx.supabase.from('google_connections').upsert(
      {
        account_id: ctx.accountId,
        google_email: tokens.email,
        access_token: encrypted.access_token,
        refresh_token: encrypted.refresh_token,
        token_expiry: new Date(tokens.expiryDate).toISOString(),
        scopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/spreadsheets.readonly',
        ],
      },
      { onConflict: 'account_id' },
    )

    if (error) {
      console.error('[google oauth callback] upsert failed:', error)
      return settingsUrl('error=save_failed')
    }

    return settingsUrl('connected=1')
  } catch (err) {
    const message = err instanceof GoogleOAuthError ? err.message : 'oauth_exchange_failed'
    console.error('[google oauth callback] exchange failed:', err)
    return settingsUrl(`error=${encodeURIComponent(message)}`)
  }
}
