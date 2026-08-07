import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/crypto/encryption'
import { fetchConnectQr } from '@/lib/whatsapp/providers/evolution/client'

/**
 * GET /api/whatsapp/unofficial/evolution/qr  (admin+)
 *
 * Fetches a fresh QR code for the account's already-created Evolution
 * instance (Evolution's QR codes are short-lived, so the settings UI
 * re-polls this after `connect` has run once).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data: config, error } = await supabase
      .from('whatsapp_unofficial_config')
      .select('base_url, admin_api_key, instance_name')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle()

    if (error) {
      console.error('[evolution/qr] config lookup failed:', error.message)
      return NextResponse.json({ error: 'Failed to load Evolution configuration' }, { status: 500 })
    }
    if (!config || !config.instance_name || !config.admin_api_key) {
      return NextResponse.json({ error: 'Evolution is not connected yet — call connect first' }, { status: 400 })
    }

    const result = await fetchConnectQr(
      { baseUrl: config.base_url, adminApiKey: decrypt(config.admin_api_key) },
      config.instance_name
    )

    return NextResponse.json({ qrcode: result.base64 ?? null, pairing_code: result.pairingCode ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
