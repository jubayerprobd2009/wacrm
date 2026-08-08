// ============================================================
// Opt-out detection shared by SMS (always) and WhatsApp (when the
// account's `ai_configs.opt_out_applies_to_whatsapp` toggle is on).
//
// Source: the client's own compliance document listed a broader set of
// opt-out phrases than the standard STOP-family keywords Twilio's
// Advanced Opt-Out (and the pre-existing STOP_KEYWORDS regex) already
// handles — e.g. "TAKE ME OFF YOUR LIST", "DO NOT CONTACT ME", "LEAVE
// ME ALONE", "NOT INTERESTED". Those are full phrases likely to appear
// inside a fuller sentence ("please do not contact me again"), not
// exact single-word messages, so they're matched as substrings rather
// than exact-match like the short STOP-family keywords — matching the
// short common words ("cancel", "end") as substrings would false-
// positive on unrelated text, so those stay exact-match only.
// ============================================================

/** Exact-message match only — the standard STOP-family keywords. */
const EXACT_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;

/**
 * Longer, unambiguous phrases from the client's own document — safe to
 * match as a substring anywhere in the message.
 */
const PHRASE_KEYWORDS = [
  'take me off your list',
  'do not contact me',
  "don't contact me",
  'do not call',
  "don't call",
  'do not text',
  "don't text",
  'do not message me',
  "don't message me",
  'no more messages',
  'leave me alone',
  'not interested',
];

/**
 * True when `text` is (or contains) a recognized opt-out request.
 * Case-insensitive; tolerant of surrounding whitespace/punctuation.
 */
export function isOptOutMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (EXACT_KEYWORDS.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return PHRASE_KEYWORDS.some((phrase) => lower.includes(phrase));
}

/**
 * Whether this account wants the phrase-list check applied to inbound
 * WhatsApp too (SMS always runs it). Defaults to true when the account
 * has no `ai_configs` row at all — same "safer default" the DB column
 * itself defaults to. A cheap single-column lookup — deliberately not
 * `loadAiConfig` (which also decrypts the provider API key), since
 * this runs on every inbound WhatsApp text message and only needs one
 * boolean.
 */
export async function shouldApplyOptOutToWhatsapp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts both the RLS-scoped and service-role Supabase clients
  db: any,
  accountId: string,
): Promise<boolean> {
  const { data } = await db
    .from('ai_configs')
    .select('opt_out_applies_to_whatsapp')
    .eq('account_id', accountId)
    .maybeSingle()
  return data?.opt_out_applies_to_whatsapp !== false
}
