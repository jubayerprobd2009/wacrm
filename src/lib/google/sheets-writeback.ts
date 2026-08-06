// ============================================================
// Outbound half of the two-way Sheets sync: write a contact's
// `lead_status` into the "Status" column of the sheet row it was
// synced from. This is the ONLY field that round-trips back to the
// sheet — every other column stays CRM-owned once a lead exists here,
// so there's no conflict-resolution logic to write.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import { getAuthorizedClient } from './oauth'
import { loadGoogleConnection } from './connection'
import { extractSheetName } from './sheets-sync'

const DEFAULT_STATUS_COLUMN = 'F'

const STATUS_LABELS: Record<string, string> = {
  new_lead: 'New Lead',
  message_sent: 'Message Sent',
  customer_responded: 'Customer Responded',
  interested: 'Interested',
  not_interested: 'Not Interested',
  appointment_requested: 'Appointment Requested',
  appointment_booked: 'Appointment Booked',
  follow_up_needed: 'Follow-Up Needed',
  do_not_contact: 'Do Not Contact',
}

/**
 * Best-effort — never throws. A failed write-back means the Sheet's
 * Status column goes stale, which is a minor UX papercut, not
 * something worth failing the caller's actual status change over.
 */
export async function writeBackLeadStatus(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  leadStatus: string,
  baseUrl: string,
): Promise<void> {
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('sheet_row_number, lead_source')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact?.sheet_row_number || contact.lead_source !== 'google_sheets') return

    const connection = await loadGoogleConnection(db, accountId, baseUrl)
    if (!connection || !connection.sheetId) return

    const mapping = connection.sheetColumnMapping
    const statusColumn = mapping?.status ?? DEFAULT_STATUS_COLUMN
    const sheetName = extractSheetName(connection.sheetRange || 'Sheet1!A:E')

    const auth = await getAuthorizedClient(connection.tokens)
    const sheets = google.sheets({ version: 'v4', auth })

    await sheets.spreadsheets.values.update({
      spreadsheetId: connection.sheetId,
      range: `${sheetName}!${statusColumn}${contact.sheet_row_number}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[STATUS_LABELS[leadStatus] ?? leadStatus]] },
    })
  } catch (err) {
    console.error(`[sheets-writeback] failed for contact ${contactId}:`, err)
  }
}
