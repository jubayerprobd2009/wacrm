import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/crypto/encryption'
import { logoutInstance, deleteInstance } from '@/lib/whatsapp/providers/evolution/client'

/**
 * DELETE /api/whatsapp/unofficial/evolution/disconnect  (admin+)
 *
 * Logs out + deletes the Evolution-side instance, then deletes the
 * config row entirely (unlike a simple status flip — a stale instance
 * on the client's VPS with no corresponding row would leak resources
 * and eventually collide with a new instanceName's uniqueness).
 * Evolution-side cleanup is best-effort: if the instance is already
 * gone (e.g. manually removed on the VPS), the DB row is still
 * deleted so the account isn't stuck "connected" to nothing.
 */
export async function DELETE() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`evolution-disconnect:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: config, error } = await supabase
      .from('whatsapp_unofficial_config')
      .select('id, base_url, admin_api_key, instance_name')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle()

    if (error) {
      console.error('[evolution/disconnect] config lookup failed:', error.message)
      return NextResponse.json({ error: 'Failed to load Evolution configuration' }, { status: 500 })
    }
    if (!config) {
      return NextResponse.json({ ok: true }) // already disconnected
    }

    if (config.instance_name && config.admin_api_key) {
      const clientConfig = { baseUrl: config.base_url, adminApiKey: decrypt(config.admin_api_key) }
      try {
        await logoutInstance(clientConfig, config.instance_name)
      } catch (err) {
        console.warn('[evolution/disconnect] logout failed (continuing):', err)
      }
      try {
        await deleteInstance(clientConfig, config.instance_name)
      } catch (err) {
        console.warn('[evolution/disconnect] instance delete failed (continuing):', err)
      }
    }

    const { error: deleteErr } = await supabase.from('whatsapp_unofficial_config').delete().eq('id', config.id)
    if (deleteErr) {
      console.error('[evolution/disconnect] row delete failed:', deleteErr)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
