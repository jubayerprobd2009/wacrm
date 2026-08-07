import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/crypto/encryption'
import { assertSafeOperatorUrl, SsrfGuardError } from '@/lib/http/ssrf-guard'
import { getBaseUrl } from '@/lib/http/base-url'
import { deriveEvolutionWebhookSecret } from '@/lib/whatsapp/providers/webhook-auth'
import {
  createInstance,
  setWebhook,
  deleteInstance,
  type EvolutionConnectionConfig,
} from '@/lib/whatsapp/providers/evolution/client'

/**
 * POST /api/whatsapp/unofficial/evolution/connect  (admin+)
 *
 * Creates (or re-creates) an Evolution instance for this account,
 * registers its webhook, and returns the QR code to render in-app.
 * Mirrors the plan's Evolution connect flow: instance lifecycle is
 * handled here rather than `.../unofficial/config`, which only
 * persists `base_url`/`admin_api_key`.
 *
 * Body (all optional — falls back to env / the existing saved row):
 *   { base_url?: string, admin_api_key?: string }
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`evolution-connect:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => ({}) as Record<string, unknown>)
    const bodyBaseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : undefined
    const bodyAdminKey = typeof body.admin_api_key === 'string' ? body.admin_api_key.trim() : undefined

    const { data: existing } = await supabase
      .from('whatsapp_unofficial_config')
      .select('id, inbound_token, base_url, admin_api_key, instance_name')
      .eq('account_id', accountId)
      .maybeSingle()

    const baseUrl = bodyBaseUrl || existing?.base_url || process.env.EVOLUTION_API_URL?.trim() || ''
    if (!baseUrl) {
      return NextResponse.json({ error: 'base_url is required (no saved value or EVOLUTION_API_URL configured)' }, { status: 400 })
    }

    try {
      await assertSafeOperatorUrl(baseUrl, 'base_url')
    } catch (err) {
      if (err instanceof SsrfGuardError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    const signingKey = process.env.WEBHOOK_SIGNING_KEY
    if (!signingKey) {
      console.error('[evolution/connect] WEBHOOK_SIGNING_KEY is not set — cannot register a verifiable webhook')
      return NextResponse.json({ error: 'Server is not configured for Evolution API (missing WEBHOOK_SIGNING_KEY)' }, { status: 500 })
    }

    const adminApiKeyPlain = bodyAdminKey || (existing?.admin_api_key ? undefined : process.env.EVOLUTION_API_KEY?.trim())
    // Prefer an explicitly-supplied key; otherwise reuse the stored one
    // (decrypted) if present; otherwise fall back to the env default.
    let resolvedAdminApiKey = adminApiKeyPlain
    if (!resolvedAdminApiKey && existing?.admin_api_key) {
      const { decrypt } = await import('@/lib/crypto/encryption')
      resolvedAdminApiKey = decrypt(existing.admin_api_key)
    }
    if (!resolvedAdminApiKey) {
      resolvedAdminApiKey = process.env.EVOLUTION_API_KEY?.trim()
    }
    if (!resolvedAdminApiKey) {
      return NextResponse.json({ error: 'admin_api_key is required (no saved value or EVOLUTION_API_KEY configured)' }, { status: 400 })
    }

    // Ensure a row exists so we have a stable `inbound_token` to build
    // the webhook URL from before Evolution's instance exists.
    const { data: upserted, error: upsertErr } = await supabase
      .from('whatsapp_unofficial_config')
      .upsert(
        {
          account_id: accountId,
          provider: 'evolution',
          status: 'pending',
          base_url: baseUrl,
          admin_api_key: encrypt(resolvedAdminApiKey),
        },
        { onConflict: 'account_id' }
      )
      .select('id, inbound_token, instance_name')
      .single()

    if (upsertErr || !upserted) {
      console.error('[evolution/connect] failed to upsert config row:', upsertErr)
      return NextResponse.json({ error: 'Failed to save Evolution configuration' }, { status: 500 })
    }

    const clientConfig: EvolutionConnectionConfig = { baseUrl, adminApiKey: resolvedAdminApiKey }

    // Best-effort cleanup of a previous instance on reconnect — an
    // orphaned Evolution-side instance from an earlier connect attempt
    // shouldn't block starting a fresh one.
    if (upserted.instance_name) {
      try {
        await deleteInstance(clientConfig, upserted.instance_name)
      } catch (err) {
        console.warn('[evolution/connect] cleanup of previous instance failed (continuing):', err)
      }
    }

    const instanceName = `wacrm-${accountId.replace(/-/g, '').slice(0, 12)}-${Date.now().toString(36)}`

    const created = await createInstance(clientConfig, instanceName)
    const instanceToken = created.hash

    const webhookSecret = deriveEvolutionWebhookSecret(signingKey, instanceName)
    const webhookUrl = `${getBaseUrl(request)}/api/whatsapp/unofficial/evolution/webhook/${upserted.inbound_token}`

    await setWebhook({ ...clientConfig, instanceToken }, instanceName, {
      url: webhookUrl,
      secret: webhookSecret,
    })

    const { error: finalizeErr } = await supabase
      .from('whatsapp_unofficial_config')
      .update({
        instance_name: instanceName,
        instance_token: encrypt(instanceToken),
        status: 'pending',
        last_status_error: null,
      })
      .eq('id', upserted.id)

    if (finalizeErr) {
      console.error('[evolution/connect] failed to persist instance details:', finalizeErr)
      return NextResponse.json({ error: 'Failed to save Evolution instance' }, { status: 500 })
    }

    return NextResponse.json({
      instance_name: instanceName,
      qrcode: created.qrcode?.base64 ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
