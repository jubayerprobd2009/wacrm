// ============================================================
// WaSenderAPI adapter — implements the shared `WhatsAppProvider`
// interface (src/lib/whatsapp/providers/types.ts) on top of
// `client.ts`'s typed fetch wrapper.
//
// Phase 4 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// Capabilities: WaSenderAPI is a Baileys-backed unofficial provider —
// no Meta template approval, no native interactive buttons/lists, no
// reactions, but free-form sends work any time (no 24h window) and it
// needs outbound pacing to reduce ban risk.
//
// DEVIATIONS (documented, not silently swallowed):
//
// 1. `sendTemplate` / `sendInteractiveButtons` / `sendInteractiveList`
//    import from `@/lib/whatsapp/template-render` and
//    `@/lib/whatsapp/providers/interactive-fallback` — neither file
//    exists yet as of this writing (a parallel agent owns them per
//    the plan). This adapter is written against the exact function
//    signatures declared in the local `*.d`-style re-export types
//    below; it will link up once those modules land. Until then,
//    typechecking this file fails on the two missing imports — that
//    failure is expected and out of this task's scope to fix (fixing
//    it would mean writing those modules myself, which the task
//    explicitly says not to block on).
//
// 2. `markRead` — the shared `MarkReadArgs` type carries only
//    `messageId` (designed against Meta's `/messages` read-receipt
//    call, which only needs a message id). WaSenderAPI's
//    `POST /messages/read` needs a full `{id, remoteJid, fromMe}` key.
//    Lacking a `remoteJid` in the shared interface, this sends
//    `remoteJid: args.messageId` as a best-effort placeholder and logs
//    a warning — no caller in the codebase invokes `provider.markRead`
//    yet (grepped: only meta.ts/types.ts reference it), so this is not
//    an active correctness bug today, but will need `MarkReadArgs`
//    extended with the JID before any call site wires this up for
//    real. Flagged rather than fixed because `types.ts` belongs to an
//    earlier phase, outside this task's file scope.
//
// 3. `sendReaction` — `capabilities.reactions` is `false`, so the
//    shared core should never call this. Implemented as an explicit
//    throw (not a silent no-op) so a future caller that forgets to
//    capability-gate fails loudly instead of pretending to succeed.
//
// 4. `fetchInboundMedia` — decrypting WaSenderAPI's raw Baileys media
//    envelopes is `src/lib/whatsapp/providers/baileys-media.ts` in the
//    plan (Phase 4), not in this task's assigned file list. Throws an
//    explicit "not yet supported" error rather than returning garbage
//    bytes.
// ============================================================

import type { MessageTemplate } from '@/types';
import {
  WaSenderClient,
  type WaSenderClientConfig,
  type WaSenderSendMessageArgs,
} from './client';
import type {
  WhatsAppProvider,
  ProviderCapabilities,
  ProviderSendResult,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendReactionArgs,
  MarkReadArgs,
  SetTypingArgs,
  ConnectionStatusResult,
  FetchInboundMediaArgs,
  FetchInboundMediaResult,
  MediaKind,
} from '../types';
// NOTE (deviation 1, see file header): neither of these modules exists
// yet at the time this adapter was written — they are owned by a
// parallel agent per the plan. Importing them by their documented,
// expected names/signatures now (rather than inlining a placeholder
// implementation here) means this file needs zero changes once they
// land; until then, typechecking this file fails on these two lines
// specifically, which is expected and out of this task's scope to fix.
import { renderTemplateToMessage } from '@/lib/whatsapp/template-render';
import {
  renderInteractiveButtonsAsText,
  renderInteractiveListAsText,
} from '@/lib/whatsapp/providers/interactive-fallback';

/** Expected export shape of `@/lib/whatsapp/template-render`'s
 *  `renderTemplateToMessage(template, args)` — renders a local
 *  `message_templates` row to plain text (or media + caption) for
 *  providers without `metaTemplates` support. Kept here only as
 *  documentation of the contract this adapter codes against. */
export interface RenderedTemplateMessage {
  text: string;
  mediaUrl?: string | null;
  mediaKind?: MediaKind | null;
}
// Re-exported so `MessageTemplate` stays a used import even before
// template-render.ts's real signature is checked against this.
export type { MessageTemplate };

export const WASENDER_CAPABILITIES: ProviderCapabilities = {
  metaTemplates: false,
  templateApproval: false,
  nativeInteractive: false,
  reactions: false,
  freeformOutsideWindow: true,
  phoneVariantRetry: false,
  outboundPacing: true,
};

const MEDIA_URL_FIELD: Record<MediaKind, keyof WaSenderSendMessageArgs> = {
  image: 'imageUrl',
  video: 'videoUrl',
  audio: 'audioUrl',
  document: 'documentUrl',
};

export type WaSenderProviderConfig = WaSenderClientConfig;

/**
 * Build a `WhatsAppProvider` bound to one account's WaSenderAPI API
 * key. `resolve.ts` constructs one of these per account from the
 * account's `whatsapp_unofficial_config` row (Phase 4/5 wiring, not
 * this task's scope).
 */
export function createWaSenderProvider(config: WaSenderProviderConfig): WhatsAppProvider {
  const client = new WaSenderClient(config);

  return {
    id: 'wasender',
    capabilities: WASENDER_CAPABILITIES,

    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      const result = await client.sendMessage({ to: args.to, text: args.text });
      return { messageId: result.messageId };
    },

    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      const urlField = MEDIA_URL_FIELD[args.kind];
      const result = await client.sendMessage({
        to: args.to,
        text: args.caption,
        [urlField]: args.link,
      } as WaSenderSendMessageArgs);
      return { messageId: result.messageId };
    },

    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      // Cast to the documented contract (see `RenderedTemplateMessage`
      // above) rather than trusting whatever type the not-yet-landed
      // module happens to infer — keeps this call site's typing stable
      // once template-render.ts lands for real.
      const rendered = renderTemplateToMessage(args.template, args) as RenderedTemplateMessage;
      if (rendered.mediaUrl && rendered.mediaKind) {
        const urlField = MEDIA_URL_FIELD[rendered.mediaKind];
        const result = await client.sendMessage({
          to: args.to,
          text: rendered.text,
          [urlField]: rendered.mediaUrl,
        } as WaSenderSendMessageArgs);
        return { messageId: result.messageId };
      }
      const result = await client.sendMessage({ to: args.to, text: rendered.text });
      return { messageId: result.messageId };
    },

    async sendInteractiveButtons(
      args: SendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      const text = renderInteractiveButtonsAsText(args);
      const result = await client.sendMessage({ to: args.to, text });
      return { messageId: result.messageId };
    },

    async sendInteractiveList(
      args: SendInteractiveListArgs
    ): Promise<ProviderSendResult> {
      const text = renderInteractiveListAsText(args);
      const result = await client.sendMessage({ to: args.to, text });
      return { messageId: result.messageId };
    },

    // DEVIATION (3) — see file header. capabilities.reactions is
    // false; callers must capability-gate before reaching here.
    async sendReaction(_args: SendReactionArgs): Promise<ProviderSendResult> {
      void _args;
      throw new Error(
        '[wasender/adapter] sendReaction is not supported by WaSenderAPI (capabilities.reactions is false) — this should never be called.'
      );
    },

    // DEVIATION (2) — see file header. `remoteJid` isn't available on
    // `MarkReadArgs`; best-effort placeholder until the shared type is
    // extended.
    async markRead(args: MarkReadArgs): Promise<void> {
      console.warn(
        '[wasender/adapter] markRead called without a remoteJid — MarkReadArgs only carries messageId today; sending a best-effort key. See adapter.ts deviation (2).'
      );
      await client.markMessagesRead({
        id: args.messageId,
        remoteJid: args.messageId,
        fromMe: false,
      });
    },

    async setTyping(args: SetTypingArgs): Promise<void> {
      await client.sendPresenceUpdate({
        jid: args.to,
        type: args.isTyping ? 'composing' : 'paused',
      });
    },

    async getConnectionStatus(): Promise<ConnectionStatusResult> {
      try {
        const status = await client.getStatus();
        const normalized = String(status.status ?? '').toLowerCase();
        // Order matters: WaSenderAPI's intermediate QR/passkey-linking
        // states (e.g. "connecting", "need_scan") contain the substring
        // "connect" too, so the pending-like check must run BEFORE the
        // general "connect" match or a session still waiting to be
        // scanned gets misreported as connected.
        let resolvedStatus: 'connected' | 'disconnected' | 'pending';
        if (
          normalized.includes('connecting') ||
          normalized.includes('pending') ||
          normalized.includes('qr') ||
          normalized.includes('scan')
        ) {
          resolvedStatus = 'pending';
        } else if (normalized.includes('connect') && !normalized.includes('disconnect')) {
          resolvedStatus = 'connected';
        } else {
          resolvedStatus = 'disconnected';
        }
        return {
          status: resolvedStatus,
          phoneNumber:
            typeof status.phone_number === 'string'
              ? status.phone_number
              : typeof status.phoneNumber === 'string'
                ? status.phoneNumber
                : null,
        };
      } catch (err) {
        return {
          status: 'disconnected',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    // DEVIATION (4) — see file header. baileys-media.ts (Phase 4,
    // out of this task's scope) owns decrypting WaSenderAPI's raw
    // Baileys media envelopes.
    async fetchInboundMedia(
      _args: FetchInboundMediaArgs
    ): Promise<FetchInboundMediaResult> {
      void _args;
      throw new Error(
        '[wasender/adapter] fetchInboundMedia is not yet supported — requires baileys-media.ts (Phase 4), not landed.'
      );
    },
  };
}
