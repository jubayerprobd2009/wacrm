/**
 * Shared row-shaping logic for the contacts import modal — takes an
 * already-tabular header row + data rows (from CSV line-splitting or an
 * XLSX sheet) and resolves them into `ParsedContactRow`s. Kept separate
 * from `parse-contact-csv.ts` so the XLSX parser can reuse the exact same
 * header-matching/tag-parsing behavior without re-implementing it.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the header includes a `company` column. */
  hasCompanyColumn: boolean;
}

/** Split a cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

/**
 * Resolve a lower-cased header row + raw data rows into contact rows.
 * `headerRow` must already be trimmed/lower-cased/quote-stripped by the
 * caller; each cell in `dataRows` may still carry surrounding quotes
 * (stripped here) since that's how the CSV line-splitter leaves them.
 */
export function rowsFromTable(
  headerRow: string[],
  dataRows: string[][],
): ParseContactCsvResult {
  const phoneIdx = headerRow.indexOf('phone');
  if (phoneIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const nameIdx = headerRow.indexOf('name');
  const emailIdx = headerRow.indexOf('email');
  const companyIdx = headerRow.indexOf('company');
  const tagsIdx = headerRow.indexOf('tags');

  const rows: ParsedContactRow[] = [];

  for (const values of dataRows) {
    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    rows.push({
      phone,
      name:
        nameIdx >= 0
          ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      email:
        emailIdx >= 0
          ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      company:
        companyIdx >= 0
          ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}
