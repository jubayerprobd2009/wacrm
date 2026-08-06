import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getBaseUrl } from '@/lib/http/base-url'
import { getAuthUrl, GoogleOAuthError } from '@/lib/google/oauth'

/**
 * GET /api/google/oauth/connect  (admin+)
 *
 * Redirects the admin to Google's consent screen. Admin-only to
 * initiate — mirrors the WhatsApp/Twilio config routes' posture that
 * connecting a third-party integration is a settings-class action.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const baseUrl = getBaseUrl(request, '[GET /api/google/oauth/connect]')
    const url = getAuthUrl(baseUrl, accountId)
    return NextResponse.redirect(url)
  } catch (err) {
    if (err instanceof GoogleOAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
