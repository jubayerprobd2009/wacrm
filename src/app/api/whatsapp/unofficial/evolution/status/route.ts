import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/crypto/encryption'
import { getConnectionState, fetchInstances } from '@/lib/whatsapp/providers/evolution/client'

/**
 * GET /api/whatsapp/unofficial/evolution/status  (admin+)
 *
 * Polled every ~3s by the settings UI while a QR is displayed (per the
 * plan). On `open`, flips the config row to `connected` and stamps
 * `phone_number` from `fetchInstances` (connectionState alone doesn't
 * carry the number).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data: config, error } = await supabase
      .from('whatsapp_unofficial_config')
      .select('id, base_url, admin_api_key, instance_name, status')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle()

    if (error) {
      console.error('[evolution/status] config lookup failed:', error.message)
      return NextResponse.json({ error: 'Failed to load Evolution configuration' }, { status: 500 })
    }
    if (!config || !config.instance_name || !config.admin_api_key) {
      return NextResponse.json({ status: 'disconnected', phone_number: null })
    }

    const clientConfig = { baseUrl: config.base_url, adminApiKey: decrypt(config.admin_api_key) }

    let state: string
    try {
      const result = await getConnectionState(clientConfig, config.instance_name)
      state = result.instance.state
    } catch (err) {
      console.error('[evolution/status] connectionState call failed:', err)
      return NextResponse.json({ status: 'disconnected', phone_number: null, error: 'Could not reach Evolution API' })
    }

    if (state === 'open') {
      let phoneNumber: string | null = null
      try {
        const instances = await fetchInstances(clientConfig, config.instance_name)
        const match = instances.find((i) => i.instanceName === config.instance_name || i.name === config.instance_name)
        phoneNumber =
          typeof match?.number === 'string' ? match.number : typeof match?.ownerJid === 'string' ? match.ownerJid.split('@')[0] : null
      } catch (err) {
        console.warn('[evolution/status] fetchInstances failed (continuing without phone_number):', err)
      }

      if (config.status !== 'connected') {
        await supabase
          .from('whatsapp_unofficial_config')
          .update({
            status: 'connected',
            connected_at: new Date().toISOString(),
            phone_number: phoneNumber,
            last_status_error: null,
          })
          .eq('id', config.id)
      }

      return NextResponse.json({ status: 'connected', phone_number: phoneNumber })
    }

    if (config.status === 'connected') {
      await supabase.from('whatsapp_unofficial_config').update({ status: 'disconnected' }).eq('id', config.id)
    }

    return NextResponse.json({ status: state === 'connecting' ? 'pending' : 'disconnected', phone_number: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
