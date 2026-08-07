// ============================================================
// Evolution API adapter — implements the shared `WhatsAppProvider`
// interface (src/lib/whatsapp/providers/types.ts) on top of
// `client.ts`'s typed fetch wrapper.
//
// Phase 4 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// Capabilities mirror WaSenderAPI exactly — both are Baileys-backed
// unofficial providers with the same functional ceiling (see
// `src/lib/whatsapp/providers/wasender/adapter.ts`'s
// `WASENDER_CAPABILITIES`): no Meta template approval, no native
// interactive buttons/lists, no reactions, free-form sends work any
// time, and outbound pacing is needed to reduce ban risk.
//
// DEVIATIONS (documented, not silently swallowed):
//
// 1. `sendTemplate` / `sendInteractiveButtons` / `sendInteractiveList`
//    import from `@/lib/whatsapp/template-render` and
//    `@/lib/whatsapp/providers/interactive-fallback` — same situation
//    as the WaSenderAPI adapter: a parallel agent owns these per the
//    plan, and this file is written against their documented,
//    expected signatures (see `RenderedTemplateMessage` below, copied
//    from the wasender adapter's own documentation of the contract).
//    Typechecking this file fails on these two imports until those
//    modules land — expected, out of this task's scope to fix.
//
// 2. `sendReaction` — `capabilities.reactions` is `false`; implemented
//    as an explicit throw so a caller that forgets to capability-gate
//    fails loudly rather than silently no-oping.
//
// 3. `fetchInboundMedia` — unlike WaSenderAPI (which needs
//    `baileys-media.ts` to decrypt a raw envelope), Evolution exposes
//    `POST /chat/getBase64FromMediaMessage/{name}` directly, so this
//    IS fully implemented here — no placeholder needed.
//
// 4. `markRead` — Evolution's `markMessageAsRead` needs a full
//    `{remoteJid, id, fromMe}` key, but the shared `MarkReadArgs` type
//    only carries `messageId` (same shared-type gap flagged by the
//    WaSenderAPI adapter's deviation 2 — `types.ts` is out of this
//    task's file scope). Best-effort: sends `remoteJid: args.messageId`
//    as a placeholder and logs a warning. No caller in the codebase
//    invokes `provider.markRead` yet, so this isn't an active
//    correctness bug today.
// ============================================================

import type { MessageTemplate } from '@/types';
import {
  getConnectionState,
  sendText as evolutionSendText,
  sendMedia as evolutionSendMedia,
  markMessageAsRead as evolutionMarkMessageAsRead,
  sendPresence as evolutionSendPresence,
  getBase64FromMediaMessage,
  fetchInstances,
  type EvolutionConnectionConfig,
  type EvolutionMediaType,
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
// NOTE (deviation 1, see file header): neither module exists yet at
// the time this adapter was written — owned by a parallel agent per
// the plan. Written against the documented, expected signatures now
// so this file needs zero changes once they land.
import { renderTemplateToMessage } from '@/lib/whatsapp/template-render';
import {
  renderInteractiveButtonsAsText,
  renderInteractiveListAsText,
} from '@/lib/whatsapp/providers/interactive-fallback';

/** Expected export shape of `@/lib/whatsapp/template-render`'s
 *  `renderTemplateToMessage(template, args)` — see the identical
 *  documentation on the WaSenderAPI adapter; kept in sync here so both
 *  unofficial adapters code against the same contract. */
export interface RenderedTemplateMessage {
  text: string;
  mediaUrl?: string | null;
  mediaKind?: MediaKind | null;
}
// Re-exported so `MessageTemplate` stays a used import even before
// template-render.ts's real signature is checked against this.
export type { MessageTemplate };

// Same capability profile as WaSenderAPI — see file header.
export const EVOLUTION_CAPABILITIES: ProviderCapabilities = {
  metaTemplates: false,
  templateApproval: false,
  nativeInteractive: false,
  reactions: false,
  freeformOutsideWindow: true,
  phoneVariantRetry: false,
  outboundPacing: true,
};

const MEDIA_KIND_TO_EVOLUTION: Record<MediaKind, EvolutionMediaType> = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
};

export interface EvolutionProviderConfig extends EvolutionConnectionConfig {
  instanceName: string;
}

/**
 * Build a `WhatsAppProvider` bound to one account's Evolution instance.
 * `resolve.ts` constructs one of these per account from the account's
 * `whatsapp_unofficial_config` row (Phase 4/5 wiring, not this task's
 * scope).
 */
export function createEvolutionProvider(config: EvolutionProviderConfig): WhatsAppProvider {
  const { instanceName, ...clientConfig } = config;

  return {
    id: 'evolution',
    capabilities: EVOLUTION_CAPABILITIES,

    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      const result = await evolutionSendText(clientConfig, instanceName, {
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.key.id };
    },

    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      const result = await evolutionSendMedia(clientConfig, instanceName, {
        to: args.to,
        mediatype: MEDIA_KIND_TO_EVOLUTION[args.kind],
        media: args.link,
        caption: args.caption,
        fileName: args.filename,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.key.id };
    },

    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      const rendered: RenderedTemplateMessage = renderTemplateToMessage(args.template, args);
      if (rendered.mediaUrl && rendered.mediaKind) {
        const mediaKind: MediaKind = rendered.mediaKind;
        const result = await evolutionSendMedia(clientConfig, instanceName, {
          to: args.to,
          mediatype: MEDIA_KIND_TO_EVOLUTION[mediaKind],
          media: rendered.mediaUrl,
          caption: rendered.text,
          contextMessageId: args.contextMessageId,
        });
        return { messageId: result.key.id };
      }
      const result = await evolutionSendText(clientConfig, instanceName, {
        to: args.to,
        text: rendered.text,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.key.id };
    },

    async sendInteractiveButtons(
      args: SendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      const text = renderInteractiveButtonsAsText(args);
      const result = await evolutionSendText(clientConfig, instanceName, {
        to: args.to,
        text,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.key.id };
    },

    async sendInteractiveList(
      args: SendInteractiveListArgs
    ): Promise<ProviderSendResult> {
      const text = renderInteractiveListAsText(args);
      const result = await evolutionSendText(clientConfig, instanceName, {
        to: args.to,
        text,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.key.id };
    },

    // DEVIATION (2) — see file header. capabilities.reactions is
    // false; callers must capability-gate before reaching here.
    async sendReaction(_args: SendReactionArgs): Promise<ProviderSendResult> {
      void _args;
      throw new Error(
        '[evolution/adapter] sendReaction is not supported by Evolution API (capabilities.reactions is false) — this should never be called.'
      );
    },

    // DEVIATION (4) — see file header. `remoteJid` isn't available on
    // `MarkReadArgs`; best-effort placeholder until the shared type is
    // extended.
    async markRead(args: MarkReadArgs): Promise<void> {
      console.warn(
        '[evolution/adapter] markRead called without a remoteJid — MarkReadArgs only carries messageId today; sending a best-effort key. See adapter.ts deviation (4).'
      );
      await evolutionMarkMessageAsRead(clientConfig, instanceName, {
        remoteJid: args.messageId,
        messageId: args.messageId,
        fromMe: false,
      });
    },

    async setTyping(args: SetTypingArgs): Promise<void> {
      await evolutionSendPresence(clientConfig, instanceName, {
        to: args.to,
        presence: args.isTyping ? 'composing' : 'paused',
      });
    },

    async getConnectionStatus(): Promise<ConnectionStatusResult> {
      try {
        const state = await getConnectionState(clientConfig, instanceName);
        const connected = state.instance.state === 'open';
        let phoneNumber: string | null = null;
        if (connected) {
          const instances = await fetchInstances(clientConfig, instanceName);
          const match = instances.find(
            (i) => i.instanceName === instanceName || i.name === instanceName
          );
          phoneNumber =
            typeof match?.number === 'string'
              ? match.number
              : typeof match?.ownerJid === 'string'
                ? match.ownerJid.split('@')[0]
                : null;
        }
        return { status: connected ? 'connected' : 'disconnected', phoneNumber };
      } catch (err) {
        return {
          status: 'disconnected',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    // DEVIATION (3) — see file header. Fully implemented, unlike
    // WaSenderAPI's placeholder: Evolution exposes inbound media
    // resolution directly via getBase64FromMediaMessage.
    async fetchInboundMedia(
      args: FetchInboundMediaArgs
    ): Promise<FetchInboundMediaResult> {
      const result = await getBase64FromMediaMessage(clientConfig, instanceName, {
        messageKeyId: args.mediaRef,
      });
      return {
        buffer: Buffer.from(result.base64, 'base64'),
        contentType: result.mimetype || 'application/octet-stream',
      };
    },
  };
}
