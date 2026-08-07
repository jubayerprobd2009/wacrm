// ============================================================
// interactive-fallback.ts — render WhatsApp interactive buttons/lists
// as numbered plain text for providers without
// `capabilities.nativeInteractive` (WaSenderAPI, Evolution — both
// Baileys-backed, where native interactive messages are unreliable),
// and reverse-map a customer's typed reply back to the option they
// meant.
//
// Phase 4 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md):
// "functional parity, not pixel parity" — a customer typing "2" (or
// the exact button/row label) is mapped back to the same option id a
// native tap would have produced, so Flows/Automations advance
// identically regardless of provider.
//
// NAMING NOTE: mirrors the situation documented in
// `../template-render.ts` — `providers/wasender/adapter.ts` and
// `providers/evolution/adapter.ts` (already landed, built by parallel
// agents against this module's documented contract) call
// `renderInteractiveButtonsAsText` / `renderInteractiveListAsText`
// directly with their respective `SendInteractive*Args`, not a single
// `renderInteractiveAsText(payload)` taking the persisted
// `InteractiveMessagePayload` shape. Both are provided here: the two
// `*Args`-shaped functions are canonical (matching the already-landed
// adapters); `renderInteractiveAsText` is a thin wrapper in the
// persisted-payload shape for any caller that has an
// `InteractiveMessagePayload` (e.g. `messages.interactive_payload`)
// instead of live send args.
//
// WIRING (not performed by this file — see deviation note in the
// final report): `resolveEmulatedInteractiveReply` is meant to be
// called from `src/lib/whatsapp/inbound/process-inbound.ts`, at the
// point where `message.interactiveReplyId` is read, gated on
// `!connection.capabilities?.nativeInteractive` (or equivalent) for
// providers that emulate interactive replies as plain text. That file
// is outside this task's assigned scope, so the call site itself is
// not wired here — this module is written to be dropped in cleanly
// once it is.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import type {
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
} from './types';

type ButtonsRenderArgs = Pick<
  SendInteractiveButtonsArgs,
  'bodyText' | 'headerText' | 'footerText' | 'buttons'
>;
type ListRenderArgs = Pick<
  SendInteractiveListArgs,
  'bodyText' | 'headerText' | 'footerText' | 'sections'
>;

function assembleBlock(
  headerText: string | undefined,
  bodyText: string,
  footerText: string | undefined,
  optionLines: string[],
): string {
  const parts = [headerText, bodyText, optionLines.join('\n'), footerText].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return parts.join('\n\n');
}

/**
 * Render an interactive-buttons send as body text + numbered options,
 * e.g. `"Would you like to proceed?\n\n1. Yes\n2. No"`.
 */
export function renderInteractiveButtonsAsText(args: ButtonsRenderArgs): string {
  const optionLines = args.buttons.map((b, i) => `${i + 1}. ${b.title}`);
  return assembleBlock(args.headerText, args.bodyText, args.footerText, optionLines);
}

/**
 * Render an interactive-list send as body text + numbered rows,
 * flattened across all sections (numbering continues across section
 * boundaries so "2" always means the same thing to the customer that
 * it would mean counting the rendered lines). Section titles, when
 * present, are rendered as a plain heading line above their rows.
 */
export function renderInteractiveListAsText(args: ListRenderArgs): string {
  const optionLines: string[] = [];
  let n = 0;
  for (const section of args.sections) {
    if (section.title) optionLines.push(section.title);
    for (const row of section.rows) {
      n += 1;
      const description = row.description ? ` — ${row.description}` : '';
      optionLines.push(`${n}. ${row.title}${description}`);
    }
  }
  return assembleBlock(args.headerText, args.bodyText, args.footerText, optionLines);
}

/**
 * Render a persisted `InteractiveMessagePayload` (the round-trippable
 * shape stored in `messages.interactive_payload`) as numbered plain
 * text. Thin wrapper over the two functions above — see NAMING NOTE.
 */
export function renderInteractiveAsText(payload: InteractiveMessagePayload): string {
  if (payload.kind === 'buttons') {
    return renderInteractiveButtonsAsText({
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    });
  }
  return renderInteractiveListAsText({
    bodyText: payload.body,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  });
}

interface FlatOption {
  id: string;
  title: string;
}

function flattenOptions(payload: InteractiveMessagePayload): FlatOption[] {
  if (payload.kind === 'buttons') {
    return payload.buttons.map((b) => ({ id: b.id, title: b.title }));
  }
  const out: FlatOption[] = [];
  for (const section of payload.sections) {
    for (const row of section.rows) out.push({ id: row.id, title: row.title });
  }
  return out;
}

interface RecentBotMessageRow {
  content_type: string;
  interactive_payload: InteractiveMessagePayload | null;
}

/**
 * Map a customer's typed reply back to the option id it corresponds
 * to, using the most recent bot-sent message in the conversation as
 * the menu it's replying to.
 *
 * Matches either:
 *   - a 1-based option number (as rendered by
 *     `renderInteractiveButtonsAsText` / `renderInteractiveListAsText`
 *     above — numbering matches exactly), or
 *   - the option's exact title (case-insensitive, trimmed).
 *
 * Returns null when: there is no prior bot message, the most recent
 * bot message was not `content_type='interactive'`, it carries no
 * `interactive_payload`, or the inbound text doesn't match any option.
 */
export async function resolveEmulatedInteractiveReply(
  db: SupabaseClient,
  conversationId: string,
  inboundText: string,
): Promise<string | null> {
  const trimmed = inboundText.trim();
  if (!trimmed) return null;

  const { data, error } = await db
    .from('messages')
    .select('content_type, interactive_payload')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as RecentBotMessageRow;
  if (row.content_type !== 'interactive' || !row.interactive_payload) return null;

  const options = flattenOptions(row.interactive_payload);
  if (!options.length) return null;

  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1].id;
  }

  const lower = trimmed.toLowerCase();
  const match = options.find((o) => o.title.trim().toLowerCase() === lower);
  return match ? match.id : null;
}
