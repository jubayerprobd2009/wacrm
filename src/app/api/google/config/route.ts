import { NextResponse } from 'next/server'
import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/google/config
 *
 * Any member may read connection status. Tokens are never returned.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('google_connections')
      .select('google_email, calendar_id, sheet_id, sheet_range, sheet_column_mapping, sheet_last_synced_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[google/config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Google configuration' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ connected: false })

    return NextResponse.json({ connected: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/google/config  (admin+)
 *
 * Updates the Sheets sync settings (calendar id, sheet id/range,
 * column mapping) on an already-connected account — the OAuth tokens
 * themselves are only ever written by the callback route.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { calendar_id, sheet_id, sheet_range, sheet_column_mapping } = body as Record<string, unknown>

    const update: Record<string, unknown> = {}
    if (typeof calendar_id === 'string' && calendar_id.trim()) update.calendar_id = calendar_id.trim()
    if (typeof sheet_id === 'string') update.sheet_id = sheet_id.trim() || null
    if (typeof sheet_range === 'string' && sheet_range.trim()) update.sheet_range = sheet_range.trim()
    if (sheet_column_mapping && typeof sheet_column_mapping === 'object') {
      update.sheet_column_mapping = sheet_column_mapping
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('google_connections')
      .update(update)
      .eq('account_id', accountId)
      .select('google_email, calendar_id, sheet_id, sheet_range, sheet_column_mapping')
      .maybeSingle()

    if (error || !data) {
      console.error('[google/config PATCH] update error:', error)
      return NextResponse.json({ error: 'Google is not connected yet' }, { status: 400 })
    }

    return NextResponse.json({ connected: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/google/config  (admin+) — disconnect Google.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('google_connections').delete().eq('account_id', accountId)
    if (error) {
      console.error('[google/config DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to disconnect Google' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
