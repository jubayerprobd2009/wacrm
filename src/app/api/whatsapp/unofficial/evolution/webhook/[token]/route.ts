import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/crypto/encryption'
import { deriveEvolutionWebhookSecret, timingSafeCompare } from '@/lib/whatsapp/providers/webhook-auth'
import { normalizeEvolutionInboundMessage, type EvolutionWebhookBody } from '@/lib/whatsapp/providers/evolution/normalize-inbound'
import { createEvolutionProvider } from '@/lib/whatsapp/providers/evolution/adapter'
import { processInboundMessage } from '@/lib/whatsapp/inbound/process-inbound'
import { handleStatusUpdate } from '@/lib/whatsapp/inbound/status-updates'
import { ingestInboundMedia, MediaIngestError } from '@/lib/whatsapp/inbound/media-ingest'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

// See src/app/api/whatsapp/webhook/route.ts (Meta's equivalent) for
// why inbound processing runs inside `after()` rather than a floating
// promise — same reasoning applies here.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface EvolutionUnofficialConfigRow {
  id: string
  account_id: string
  provider: string
  status: string
  instance_name: string | null
  base_url: string | null
  admin_api_key: string | null
  instance_token: string | null
}

async function fetchConfigByToken(token: string): Promise<EvolutionUnofficialConfigRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_unofficial_config')
    .select('id, account_id, provider, status, instance_name, base_url, admin_api_key, instance_token')
    .eq('inbound_token', token)
    .eq('provider', 'evolution')
    .maybeSingle()

  if (error) {
    console.error('[evolution/webhook] config lookup failed:', error.message)
    return null
  }
  return (data as EvolutionUnofficialConfigRow | null) ?? null
}

/**
 * Evolution's own event-name casing is whatever it sends verbatim on
 * `connection.update` payloads — normalize-inbound.ts only handles
 * `messages.upsert`; connection lifecycle and message-status events
 * are handled directly in this route since they never produce a
 * `NormalizedInboundMessage` (out of scope for the shared inbound
 * core / parity contract, same as Meta's `statuses[]` branch in its
 * own webhook route).
 */
function isEvent(body: EvolutionWebhookBody, name: string): boolean {
  return (body.event ?? '').toLowerCase().replace(/_/g, '.') === name
}

interface EvolutionConnectionUpdateData {
  state?: 'open' | 'connecting' | 'close' | string
}

async function handleConnectionUpdate(
  config: EvolutionUnofficialConfigRow,
  data: EvolutionConnectionUpdateData | undefined
) {
  const state = data?.state
  if (!state) return

  if (state === 'open') {
    await supabaseAdmin()
      .from('whatsapp_unofficial_config')
      .update({ status: 'connected', connected_at: new Date().toISOString(), last_status_error: null })
      .eq('id', config.id)
  } else if (state === 'close') {
    await supabaseAdmin()
      .from('whatsapp_unofficial_config')
      .update({ status: 'disconnected' })
      .eq('id', config.id)
  }
  // 'connecting' — transient, config already defaults to 'pending' at
  // create time; nothing to persist.
}

interface EvolutionMessageUpdateData {
  keyId?: string
  key?: { id?: string }
  status?: string | number
}

// Evolution's ack codes (Baileys convention): 0 error, 1 pending,
// 2 sent (server ack), 3 delivered, 4 read. Mapped onto the same
// vocabulary `handleStatusUpdate` (Meta's status mirror, reused as-is
// here — see status-updates.ts) already validates transitions against.
const ACK_CODE_TO_STATUS: Record<number, string> = {
  0: 'failed',
  1: 'pending',
  2: 'sent',
  3: 'delivered',
  4: 'read',
}

async function handleMessagesUpdate(data: EvolutionMessageUpdateData | undefined) {
  if (!data) return
  const id = data.keyId ?? data.key?.id
  if (!id) return

  let status: string | null = null
  if (typeof data.status === 'number') {
    status = ACK_CODE_TO_STATUS[data.status] ?? null
  } else if (typeof data.status === 'string') {
    const lower = data.status.toLowerCase()
    status = (['pending', 'sent', 'delivered', 'read', 'failed'] as const).includes(
      lower as 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
    )
      ? lower
      : null
  }
  if (!status) return

  await handleStatusUpdate({
    id,
    status,
    timestamp: String(Math.floor(Date.now() / 1000)),
    recipient_id: '',
  })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params

  const config = await fetchConfigByToken(token)
  if (!config) {
    // 401 (not 404) — same status and body as every other rejection
    // below, so an attacker probing tokens can't distinguish "no such
    // token" from "token exists but unverifiable" via status code or
    // message. Mirrors the WaSenderAPI webhook route's posture.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!config.instance_name) {
    console.error('[evolution/webhook] config has no instance_name, cannot verify secret:', config.id)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const signingKey = process.env.WEBHOOK_SIGNING_KEY
  if (!signingKey) {
    // Fail closed — same posture as verifyMetaWebhookSignature when
    // META_APP_SECRET is unset. No secret configured means every
    // request is unverifiable, so reject all of them rather than
    // silently accepting.
    console.error('[evolution/webhook] WEBHOOK_SIGNING_KEY is not set — rejecting request')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const headerSecret = request.headers.get('x-webhook-secret')
  const expectedSecret = deriveEvolutionWebhookSecret(signingKey, config.instance_name)
  if (!headerSecret || !timingSafeCompare(headerSecret, expectedSecret)) {
    console.warn('[evolution/webhook] rejected request with invalid X-Webhook-Secret', config.id)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rawBody = await request.text()
  let body: EvolutionWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // See Meta's webhook route for why processing runs in after() rather
  // than a floating promise — identical reasoning (serverless function
  // can freeze/terminate the instant the response is sent).
  after(async () => {
    try {
      if (isEvent(body, 'connection.update')) {
        await handleConnectionUpdate(config, body.data as EvolutionConnectionUpdateData | undefined)
        return
      }

      if (isEvent(body, 'messages.update')) {
        await handleMessagesUpdate(body.data as EvolutionMessageUpdateData | undefined)
        return
      }

      if (isEvent(body, 'messages.upsert')) {
        const message = normalizeEvolutionInboundMessage(body, config.instance_name!)
        if (!message) return

        // Resolve media bytes now, before the message row is inserted —
        // normalize-inbound.ts always sets media.url = null (it has no
        // provider handle to fetch with); this is the one place that
        // does. A fetch/decrypt/upload failure degrades to url: null
        // rather than dropping the whole inbound message.
        if (message.media && config.admin_api_key) {
          try {
            const provider = createEvolutionProvider({
              baseUrl: config.base_url,
              adminApiKey: decrypt(config.admin_api_key),
              instanceToken: config.instance_token ? decrypt(config.instance_token) : undefined,
              instanceName: config.instance_name!,
            })
            const ingested = await ingestInboundMedia(message.providerMessageId, provider, {
              accountId: config.account_id,
              kind: message.media.kind,
            })
            message.media = { ...message.media, url: ingested.publicUrl }
          } catch (err) {
            const reason = err instanceof MediaIngestError ? err.message : String(err)
            console.warn('[evolution/webhook] inbound media ingestion failed, storing url=null:', reason)
          }
        }

        const userId = await resolveAuditUserId(supabaseAdmin(), config.account_id)

        await processInboundMessage({
          connection: { accountId: config.account_id, userId, nativeInteractive: false },
          message,
        })

        void supabaseAdmin()
          .from('whatsapp_unofficial_config')
          .update({ last_inbound_at: new Date().toISOString() })
          .eq('id', config.id)
          .then(({ error }: { error: { message: string } | null }) => {
            if (error) {
              console.warn('[evolution/webhook] last_inbound_at update failed:', error.message)
            }
          })
      }

      // SEND_MESSAGE events are our own outbound echoes — nothing to
      // do; other event names are ignored.
    } catch (error) {
      console.error('[evolution/webhook] error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
