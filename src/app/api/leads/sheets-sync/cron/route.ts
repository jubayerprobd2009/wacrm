import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { syncLeadsFromSheet } from '@/lib/google/sheets-sync'

/**
 * Pull new rows from every connected account's Google Sheet into
 * `contacts`. Same shared-secret auth pattern as the other cron
 * routes. Recommended interval: 5-15 minutes — Sheets doesn't need
 * sub-minute latency for a sales-outreach use case, and the outreach
 * cron (/api/leads/outreach/cron) picks up newly-synced leads on its
 * own next tick.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_SITE_URL is not configured' }, { status: 503 })
  }

  const admin = supabaseAdmin()

  const { data: connections, error } = await admin
    .from('google_connections')
    .select('account_id')
    .not('sheet_id', 'is', null)

  if (error) {
    console.error('[leads/sheets-sync cron] scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!connections?.length) return NextResponse.json({ synced: 0 })

  let totalCreated = 0
  const results: Record<string, unknown> = {}

  for (const conn of connections) {
    try {
      const result = await syncLeadsFromSheet(admin, conn.account_id, baseUrl)
      if (result) {
        totalCreated += result.created
        results[conn.account_id] = result
      }
    } catch (err) {
      console.error(`[leads/sheets-sync cron] failed for account ${conn.account_id}:`, err)
      results[conn.account_id] = { error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({ accounts: connections.length, created: totalCreated, results })
}
