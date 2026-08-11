/**
 * Excel (.xlsx/.xls) parsing for the contacts import modal — mirrors
 * `parse-contact-csv.ts` but reads the first sheet of a workbook instead
 * of splitting CSV text. Row-shaping is shared via `parse-contact-rows.ts`
 * so header matching / tag parsing stay identical between the two formats.
 */

import * as XLSX from 'xlsx';

import { rowsFromTable, type ParseContactCsvResult } from './parse-contact-rows';

export async function parseContactXlsx(file: File): Promise<ParseContactCsvResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }
  const sheet = workbook.Sheets[firstSheetName];

  // `header: 1` returns an array-of-arrays instead of objects keyed by
  // header text, matching the CSV path's plain string-table shape.
  // `raw: false` stringifies cells the same way a CSV cell would read
  // (so a phone number typed as a number doesn't come back as a JS
  // number losing e.g. a leading `+`).
  const table = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });

  if (table.length < 2) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const [headerRow, ...dataRows] = table;
  const headers = headerRow.map((cell) => String(cell ?? '').trim().toLowerCase());
  const rows = dataRows.map((row) => row.map((cell) => String(cell ?? '').trim()));

  return rowsFromTable(headers, rows);
}
