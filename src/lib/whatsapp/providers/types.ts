// ============================================================
// WhatsAppProvider — the swappable adapter underneath the single
// shared send/inbound core.
//
// "One send path, one inbound path": nothing above this boundary
// branches on provider ('meta' | 'wasender' | 'evolution'). Every
// adapter implements the same interface; capability flags tell the
// shared core which optional behaviours (native interactive, template
// approval, outbound pacing, ...) this provider actually supports so
// the core can gate around gaps structurally instead of by
// provider-name checks scattered through call sites.
//
// This is Phase 2 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md) — pure
// interface + a Meta-only adapter (`meta.ts`) for now. The
// wasender/evolution adapters land in a later phase.
// ============================================================

import type { MessageTemplate } from '@/types';
import type {
  InteractiveButton,
  InteractiveListSection,
} from '@/lib/whatsapp/interactive';

export type MediaKind = 'image' | 'video' | 'document' | 'audio';

export interface ProviderSendResult {
  /** The provider's message id for the delivered message (Meta's
   *  `wamid`, WaSenderAPI/Evolution's message key id, ...). Persisted
   *  to `messages.message_id`. */
  messageId: string;
}

export interface SendTextArgs {
  to: string;
  text: string;
  /** Provider message id being replied to, for a quoted reply. */
  contextMessageId?: string;
}

export interface SendMediaArgs {
  to: string;
  kind: MediaKind;
  /** Publicly-fetchable URL for the media. */
  link: string;
  caption?: string;
  /** Document-only display filename. */
  filename?: string;
  contextMessageId?: string;
}

export interface SendTemplateArgs {
  to: string;
  templateName: string;
  language?: string;
  /** The local template row — providers without `metaTemplates` render
   *  this to plain text/media+caption instead of calling out to Meta
   *  (see `template-render.ts`, Phase 4). */
  template?: MessageTemplate;
  /** Legacy positional body params, kept for parity with meta-api.ts. */
  params?: string[];
  /** Structured per-send values (body/header/button substitutions). */
  messageParams?: unknown;
  contextMessageId?: string;
}

export interface SendInteractiveButtonsArgs {
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: InteractiveButton[];
  contextMessageId?: string;
}

export interface SendInteractiveListArgs {
  to: string;
  bodyText: string;
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: InteractiveListSection[];
  contextMessageId?: string;
}

export interface SendReactionArgs {
  to: string;
  /** Provider message id of the message being reacted to. */
  targetMessageId: string;
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string;
}

export interface MarkReadArgs {
  /** Provider message id to mark as read. */
  messageId: string;
}

export interface SetTypingArgs {
  to: string;
  /** false stops any typing indicator currently shown. */
  isTyping: boolean;
}

export type ProviderConnectionStatus = 'connected' | 'disconnected' | 'pending';

export interface ConnectionStatusResult {
  status: ProviderConnectionStatus;
  phoneNumber?: string | null;
  error?: string | null;
}

export interface FetchInboundMediaArgs {
  /** Provider-specific media reference (Meta media id, Evolution's
   *  message key, WaSenderAPI's raw envelope pointer, ...). */
  mediaRef: string;
}

export interface FetchInboundMediaResult {
  buffer: Buffer;
  contentType: string;
}

/**
 * Capability flags the shared send/inbound core reads to decide what
 * to do instead of branching on provider name. Every adapter must set
 * every flag explicitly (no defaulting) so a new provider can't
 * silently inherit the wrong parity assumptions.
 */
export interface ProviderCapabilities {
  /** Can send Meta-approved message templates natively. */
  metaTemplates: boolean;
  /** Templates go through an approval workflow before they're usable. */
  templateApproval: boolean;
  /** Supports WhatsApp's native interactive buttons/list messages —
   *  when false, the core falls back to numbered-text rendering
   *  (`interactive-fallback.ts`, Phase 4). */
  nativeInteractive: boolean;
  /** Supports message reactions. */
  reactions: boolean;
  /** Can send free-form text outside Meta's 24-hour customer-service
   *  window (true for every unofficial provider — a strict superset,
   *  not a gap). */
  freeformOutsideWindow: boolean;
  /** Supports retrying a send across sanitized phone-number variants
   *  when the first attempt is rejected as "not in allowed list". */
  phoneVariantRetry: boolean;
  /** Provider needs (and the UI should offer) an outbound sending-pace
   *  control to reduce ban risk on broadcasts. */
  outboundPacing: boolean;
}

/**
 * The single interface every provider adapter (Meta / WaSenderAPI /
 * Evolution) implements. The shared send core (`engine-send.ts`,
 * Phase 2) and inbound core (`process-inbound.ts`, Phase 3) are
 * written against this interface only — no provider-name branches
 * above this boundary.
 */
export interface WhatsAppProvider {
  readonly id: 'meta' | 'wasender' | 'evolution';
  readonly capabilities: ProviderCapabilities;

  sendText(args: SendTextArgs): Promise<ProviderSendResult>;
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>;
  sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult>;
  sendInteractiveButtons(
    args: SendInteractiveButtonsArgs
  ): Promise<ProviderSendResult>;
  sendInteractiveList(
    args: SendInteractiveListArgs
  ): Promise<ProviderSendResult>;
  sendReaction(args: SendReactionArgs): Promise<ProviderSendResult>;
  markRead(args: MarkReadArgs): Promise<void>;
  setTyping(args: SetTypingArgs): Promise<void>;
  getConnectionStatus(): Promise<ConnectionStatusResult>;
  fetchInboundMedia(
    args: FetchInboundMediaArgs
  ): Promise<FetchInboundMediaResult>;
}
