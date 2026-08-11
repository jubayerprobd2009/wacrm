/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 *
 * Row-shaping (header matching, tag parsing) lives in `parse-contact-rows.ts`
 * so `parse-contact-xlsx.ts` can reuse it without duplicating this logic —
 * this file only owns turning CSV text into a plain string table.
 */

import { rowsFromTable, type ParseContactCsvResult } from './parse-contact-rows';

export type {
  ParsedContactRow,
  ParseContactCsvResult,
} from './parse-contact-rows';
export { parseTagCell } from './parse-contact-rows';

export function parseContactCsv(text: string): ParseContactCsvResult {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const headers = lines[0]
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const dataRows = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCsvLine);

  return rowsFromTable(headers, dataRows);
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
