// ============================================================
// One-way inbound sync: Google Sheet → CRM leads.
//
// Reads new rows since `sheet_last_synced_row`, upserts `contacts`
// (dedup by phone, same convention as migration 022), and sets
// `lead_status = 'new_lead'` / `lead_source = 'google_sheets'` only
// for genuinely new contacts — never resets status on a contact
// that's already being worked, so a re-sync can't undo an
// in-progress qualification.
//
// The write-back half (CRM status → a "Status" column on the sheet)
// lives in sheets-writeback.ts — kept separate because it fires from
// a different trigger (a status change, not a sync tick).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { getAuthorizedClient } from './oauth'
import { loadGoogleConnection } from './connection'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

const DEFAULT_COLUMN_MAPPING: Record<string, string> = {
  name: 'A',
  phone: 'B',
  email: 'C',
  service: 'D',
  notes: 'E',
  status: 'F',
}

export function columnLetterToIndex(letter: string): number {
  let index = 0
  for (const ch of letter.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64)
  }
  return index - 1 // zero-based
}

export function extractSheetName(sheetRange: string): string {
  const bang = sheetRange.indexOf('!')
  return bang === -1 ? sheetRange : sheetRange.slice(0, bang)
}

export interface SyncResult {
  created: number
  skipped: number
  nextSyncRow: number
}

export async function syncLeadsFromSheet(
  db: SupabaseClient,
  accountId: string,
  baseUrl: string,
): Promise<SyncResult | null> {
  const connection = await loadGoogleConnection(db, accountId, baseUrl)
  if (!connection || !connection.sheetId) return null

  const mapping = connection.sheetColumnMapping ?? DEFAULT_COLUMN_MAPPING
  const sheetName = extractSheetName(connection.sheetRange || 'Sheet1!A:E')
  const { data: cursorRow } = await db
    .from('google_connections')
    .select('sheet_last_synced_row')
    .eq('account_id', accountId)
    .single()
  const startRow = Math.max((cursorRow?.sheet_last_synced_row ?? 1) + 1, 2)

  const auth = await getAuthorizedClient(connection.tokens)
  const sheets = google.sheets({ version: 'v4', auth })

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: connection.sheetId,
    range: `${sheetName}!A${startRow}:Z`,
  })

  const rows = res.data.values ?? []
  if (rows.length === 0) return { created: 0, skipped: 0, nextSyncRow: startRow - 1 }

  const nameIdx = columnLetterToIndex(mapping.name ?? DEFAULT_COLUMN_MAPPING.name)
  const phoneIdx = columnLetterToIndex(mapping.phone ?? DEFAULT_COLUMN_MAPPING.phone)
  const emailIdx = columnLetterToIndex(mapping.email ?? DEFAULT_COLUMN_MAPPING.email)
  const serviceIdx = columnLetterToIndex(mapping.service ?? DEFAULT_COLUMN_MAPPING.service)
  const notesIdx = columnLetterToIndex(mapping.notes ?? DEFAULT_COLUMN_MAPPING.notes)

  const { data: ownerAccount } = await db.from('accounts').select('owner_user_id').eq('id', accountId).single()
  const ownerUserId = ownerAccount?.owner_user_id

  let created = 0
  let skipped = 0

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = startRow + i
    const row = rows[i]
    const rawPhone = (row[phoneIdx] ?? '').toString().trim()
    if (!rawPhone) {
      skipped++
      continue
    }

    const normalized = normalizePhone(rawPhone)
    const existing = await findExistingContact(db, accountId, normalized)
    if (existing) {
      // Already known — don't touch lead_status/lead_source, just
      // record the row number if it wasn't tracked yet (e.g. it was
      // originally created manually and happens to share a phone).
      await db
        .from('contacts')
        .update({ sheet_row_number: rowNumber })
        .eq('id', existing.id)
        .is('sheet_row_number', null)
      skipped++
      continue
    }

    const { data: createdContact, error: insertErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: rawPhone,
        name: (row[nameIdx] ?? '').toString().trim() || rawPhone,
        email: (row[emailIdx] ?? '').toString().trim() || null,
        insurance_service: (row[serviceIdx] ?? '').toString().trim() || null,
        lead_source: 'google_sheets',
        sheet_row_number: rowNumber,
      })
      .select('id')
      .single()

    if (insertErr || !createdContact) {
      if (!isUniqueViolation(insertErr)) {
        console.error(`[sheets-sync] insert failed for row ${rowNumber}:`, insertErr)
      }
      skipped++
      continue
    }

    // Notes go on a contact_notes row, mirroring how the rest of the
    // app records notes rather than overloading a contacts column.
    const noteText = (row[notesIdx] ?? '').toString().trim()
    if (noteText) {
      await db.from('contact_notes').insert({
        account_id: accountId,
        contact_id: createdContact.id,
        user_id: ownerUserId,
        note_text: noteText,
      })
    }
    created++
  }

  const nextSyncRow = startRow + rows.length - 1
  await db
    .from('google_connections')
    .update({ sheet_last_synced_row: nextSyncRow, sheet_last_synced_at: new Date().toISOString() })
    .eq('account_id', accountId)

  return { created, skipped, nextSyncRow }
}
