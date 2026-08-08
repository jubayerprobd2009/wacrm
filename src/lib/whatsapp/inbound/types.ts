// ============================================================
// The provider-agnostic inbound message shape — every provider's
// webhook (Meta today; WaSenderAPI / Evolution in a later phase)
// normalizes its raw payload into this before handing it to the
// shared `processInboundMessage` core.
//
// "One inbound path": nothing in `process-inbound.ts` (or the helpers
// under this directory) branches on which provider produced the
// message — see the structural-guard test in
// `process-inbound.test.ts`. Everything provider-specific happens in
// each provider's own `normalize-inbound.ts`, which is the only place
// allowed to know about Meta/WaSenderAPI/Evolution payload shapes.
//
// This is Phase 3 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md) — the type
// + the Meta normalizer are wired up now; wasender/evolution
// normalizers land in a later phase and produce this same shape.
// ============================================================

export type NormalizedMediaKind = 'image' | 'video' | 'document' | 'audio'

export interface NormalizedInboundMedia {
  kind: NormalizedMediaKind
  /**
   * Already-resolved, app-servable URL for this media (e.g. Meta's
   * `/api/whatsapp/media/<id>` proxy route), or null if the provider
   * failed to verify/resolve it. `processInboundMessage` never talks
   * to a provider API itself — resolution is entirely the normalizer's
   * job, so the shared core stays a pure DB-and-dispatch pipeline.
   */
  url: string | null
  mimeType: string | null
}

export interface NormalizedInboundReaction {
  /** Provider message id of the message being reacted to. */
  targetProviderMessageId: string
  /** Empty string means "reaction removed" (matches Meta's Cloud API spec). */
  emoji: string
}

export interface NormalizedInboundMessage {
  /** The provider's id for this message (Meta's `wamid`, ...). Persisted
   *  to `messages.message_id`. */
  providerMessageId: string
  /** E.164-ish phone, already run through `normalizePhone`. */
  fromPhone: string
  /** Sender's display name, for contact creation / rename. */
  senderName: string
  /** Provider-reported send time, epoch milliseconds. */
  timestampMs: number
  /**
   * Already mapped to the app's own vocabulary: one of the
   * `messages.content_type` CHECK values (`text`, `image`, `document`,
   * `audio`, `video`, `location`, `template`, `interactive`), or the
   * sentinel `'reaction'`, which `processInboundMessage` short-circuits
   * on without ever inserting a `messages` row.
   */
  type: string
  /**
   * The resolved display text for this message — body text, a media
   * caption, an interactive reply's title, a formatted location line,
   * a reaction emoji, or an "unsupported type" fallback string. Mirrors
   * what the pre-refactor `parseMessageContent`'s `contentText` held.
   */
  text: string | null
  media: NormalizedInboundMedia | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option. Drives the Flows engine + the `interactive_reply`
   * automation trigger. Null for everything else.
   */
  interactiveReplyId: string | null
  reaction: NormalizedInboundReaction | null
  /** Provider message id this message is a swipe-reply to, if any. */
  replyToProviderMessageId: string | null
  /** Original provider payload — for logging / future provider-specific
   *  needs downstream of the shared core. Not read by
   *  `processInboundMessage` itself. */
  raw: unknown
}

/**
 * Tenancy + audit context the shared inbound core needs, resolved by
 * each provider's webhook route before calling `processInboundMessage`
 * (Meta's route resolves this from the matched `whatsapp_config` row).
 */
export interface InboundConnection {
  /** Drives every contact / conversation lookup and the engines'
   *  active-row dispatch. */
  accountId: string
  /** Sender-of-record for inserts that need a NOT NULL `user_id` FK
   *  (contacts, conversations). */
  userId: string
  /**
   * Whether this provider delivers real, tappable interactive
   * buttons/lists. Omitted or `true` (Meta) means the normalizer's
   * `interactiveReplyId` is trusted as-is. Explicit `false`
   * (WaSenderAPI / Evolution — see `providers/interactive-fallback.ts`)
   * makes `processInboundMessage` additionally try to map a customer's
   * typed reply back to the option they meant, so Flows/Automations
   * still advance identically. A capability flag, not a provider name —
   * keeps the shared inbound core provider-agnostic per the structural
   * guard test.
   */
  nativeInteractive?: boolean
}
