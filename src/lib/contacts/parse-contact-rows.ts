/**
 * Shared row-shaping logic for the contacts import modal — takes an
 * already-tabular header row + data rows (from CSV line-splitting or an
 * XLSX sheet) and resolves them into `ParsedContactRow`s. Kept separate
 * from `parse-contact-csv.ts` so the XLSX parser can reuse the exact same
 * header-matching/tag-parsing behavior without re-implementing it.
 *
 * Column matching is alias-based and normalized (case/space/punctuation
 * insensitive) rather than requiring an exact "phone"/"name" header —
 * real-world lead-list exports (CRM/ad-platform dumps, spreadsheets from
 * a client) rarely use those exact names. See PHONE_ALIASES etc. below.
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
  /** True when the header includes a `tags`-like column. */
  hasTagsColumn: boolean;
  /** True when the header includes a `company`-like column. */
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

/** "Other Phone 1" -> "otherphone1", "E-mail" -> "email". */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Phone-like columns, ordered by preference — mobile/cell/WhatsApp first
 * since those are the numbers actually capable of receiving SMS/WhatsApp,
 * generic "phone" next, then less-likely-to-be-mobile columns last
 * (a lead sheet's "Other Phone" often turns out to be the only filled
 * column even when Home/Mobile/Work exist but are blank — see real
 * export samples — so every one of these is tried per row, not just
 * the first that has a header match).
 */
const PHONE_ALIASES = [
  'mobile',
  'mobilephone',
  'mobilenumber',
  'cell',
  'cellphone',
  'cellnumber',
  'whatsapp',
  'whatsappnumber',
  'phone',
  'phonenumber',
  'contactnumber',
  'contact',
  'telephone',
  'tel',
  'otherphone1',
  'otherphone',
  'otherphonenumber',
  'homephone',
  'home',
  'workphone',
  'work',
];

const NAME_ALIASES = ['name', 'fullname', 'contactname', 'leadname', 'clientname'];
const FIRST_NAME_ALIASES = ['firstname', 'fname', 'first'];
const LAST_NAME_ALIASES = ['lastname', 'lname', 'last', 'surname'];
const EMAIL_ALIASES = ['email', 'emailaddress', 'mail'];
const COMPANY_ALIASES = ['company', 'companyname', 'employer', 'business', 'organization'];
const TAGS_ALIASES = ['tags', 'tag', 'labels'];

/** First header index (in alias-preference order) matching any alias. */
function findFirst(normHeaders: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = normHeaders.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Every header index matching any alias, in alias-preference order. */
function findAll(normHeaders: string[], aliases: string[]): number[] {
  const found: number[] = [];
  for (const alias of aliases) {
    const idx = normHeaders.indexOf(alias);
    if (idx >= 0 && !found.includes(idx)) found.push(idx);
  }
  return found;
}

function clean(value: string | undefined): string {
  return (value ?? '').replace(/["']/g, '').trim();
}

/**
 * Resolve a header row + raw data rows into contact rows. `headerRow` is
 * matched via normalized aliases (see PHONE_ALIASES etc. above), so it
 * does not need to already be lower-cased/stripped by the caller — this
 * function normalizes it itself. Each cell in `dataRows` may still carry
 * surrounding quotes (stripped here) since that's how the CSV
 * line-splitter leaves them.
 */
export function rowsFromTable(
  headerRow: string[],
  dataRows: string[][],
): ParseContactCsvResult {
  const normHeaders = headerRow.map(normalizeHeader);

  const phoneIndices = findAll(normHeaders, PHONE_ALIASES);
  if (phoneIndices.length === 0) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false };
  }

  const nameIdx = findFirst(normHeaders, NAME_ALIASES);
  const firstNameIdx = findFirst(normHeaders, FIRST_NAME_ALIASES);
  const lastNameIdx = findFirst(normHeaders, LAST_NAME_ALIASES);
  const emailIdx = findFirst(normHeaders, EMAIL_ALIASES);
  const companyIdx = findFirst(normHeaders, COMPANY_ALIASES);
  const tagsIdx = findFirst(normHeaders, TAGS_ALIASES);

  const rows: ParsedContactRow[] = [];

  for (const values of dataRows) {
    let phone = '';
    for (const idx of phoneIndices) {
      const candidate = clean(values[idx]);
      if (candidate) {
        phone = candidate;
        break;
      }
    }
    if (!phone) continue;

    let name: string | undefined;
    if (nameIdx >= 0) {
      name = clean(values[nameIdx]) || undefined;
    } else if (firstNameIdx >= 0 || lastNameIdx >= 0) {
      const combined = [
        firstNameIdx >= 0 ? clean(values[firstNameIdx]) : '',
        lastNameIdx >= 0 ? clean(values[lastNameIdx]) : '',
      ]
        .filter(Boolean)
        .join(' ');
      name = combined || undefined;
    }

    rows.push({
      phone,
      name,
      email: emailIdx >= 0 ? clean(values[emailIdx]) || undefined : undefined,
      company: companyIdx >= 0 ? clean(values[companyIdx]) || undefined : undefined,
      tagNames: tagsIdx >= 0 ? parseTagCell(clean(values[tagsIdx])) : [],
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}
