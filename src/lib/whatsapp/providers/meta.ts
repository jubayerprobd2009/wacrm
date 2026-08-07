// ============================================================
// Meta adapter — thin `WhatsAppProvider` wrapper around the existing
// src/lib/whatsapp/meta-api.ts functions. Pure refactor: no new
// behaviour, just reshaping the existing named-args calls to fit the
// shared provider interface (Phase 2 of the plan).
//
// meta-api.ts is intentionally left untouched (out of this task's
// assigned file scope) — it has no `markRead` / `setTyping` helpers
// today (the app has never sent read receipts or typing indicators to
// Meta), so those two methods are implemented here as minimal direct
// calls / a documented no-op rather than "wrapped". See the deviation
// note on each.
// ============================================================

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
  sendReactionMessage,
  verifyPhoneNumber,
  getMediaUrl,
  downloadMedia,
  type MediaKind as MetaMediaKind,
} from '@/lib/whatsapp/meta-api';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
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
} from './types';

export interface MetaProviderConfig {
  phoneNumberId: string;
  accessToken: string;
}

// Meta is the reference implementation — every capability holds
// except outbound pacing, which Meta's Cloud API doesn't need (no
// unofficial-provider ban risk to mitigate).
export const META_CAPABILITIES: ProviderCapabilities = {
  metaTemplates: true,
  templateApproval: true,
  nativeInteractive: true,
  reactions: true,
  freeformOutsideWindow: true,
  phoneVariantRetry: true,
  outboundPacing: false,
};

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/**
 * Build a `WhatsAppProvider` bound to one Meta phone number + access
 * token. `resolve.ts` constructs one of these per account from the
 * account's `whatsapp_config` row.
 */
export function createMetaProvider(config: MetaProviderConfig): WhatsAppProvider {
  const { phoneNumberId, accessToken } = config;

  return {
    id: 'meta',
    capabilities: META_CAPABILITIES,

    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      const result = await sendTextMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      const result = await sendMediaMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        kind: args.kind as MetaMediaKind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      const result = await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        templateName: args.templateName,
        language: args.language,
        template: args.template,
        params: args.params,
        messageParams: args.messageParams as SendTimeParams | undefined,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendInteractiveButtons(
      args: SendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      const result = await metaSendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: args.to,
        bodyText: args.bodyText,
        headerText: args.headerText,
        footerText: args.footerText,
        buttons: args.buttons,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendInteractiveList(
      args: SendInteractiveListArgs
    ): Promise<ProviderSendResult> {
      const result = await metaSendInteractiveList({
        phoneNumberId,
        accessToken,
        to: args.to,
        bodyText: args.bodyText,
        buttonLabel: args.buttonLabel,
        headerText: args.headerText,
        footerText: args.footerText,
        sections: args.sections,
        contextMessageId: args.contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendReaction(args: SendReactionArgs): Promise<ProviderSendResult> {
      const result = await sendReactionMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        targetMessageId: args.targetMessageId,
        emoji: args.emoji,
      });
      return { messageId: result.messageId };
    },

    // DEVIATION: meta-api.ts has no read-receipt helper (out of this
    // task's file scope to add one there) — Meta's Cloud API exposes
    // this as POST /{phone_number_id}/messages {status:"read",
    // message_id}, called directly here rather than via a wrapped
    // meta-api.ts export.
    async markRead(args: MarkReadArgs): Promise<void> {
      const response = await fetch(`${META_API_BASE}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: args.messageId,
        }),
      });
      if (!response.ok) {
        let message = `Meta API error: ${response.status}`;
        try {
          const data = (await response.json()) as {
            error?: { message?: string };
          };
          if (data.error?.message) message = data.error.message;
        } catch {
          // response body wasn't JSON — keep the fallback
        }
        throw new Error(message);
      }
    },

    // DEVIATION / no-op: Meta only exposes a typing indicator as part
    // of the mark-as-read call above (`typing_indicator` on a specific
    // inbound message id), not as a standalone "typing to this phone
    // number" toggle the way WaSenderAPI/Evolution's presence APIs
    // work. The app has never sent Meta typing indicators, so this is
    // zero behaviour change; left as an explicit no-op (not silently
    // unimplemented) so the interface contract is satisfied.
    async setTyping(_args: SetTypingArgs): Promise<void> {
      void _args;
    },

    async getConnectionStatus(): Promise<ConnectionStatusResult> {
      try {
        const info = await verifyPhoneNumber({ phoneNumberId, accessToken });
        return { status: 'connected', phoneNumber: info.display_phone_number };
      } catch (err) {
        return {
          status: 'disconnected',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async fetchInboundMedia(
      args: FetchInboundMediaArgs
    ): Promise<FetchInboundMediaResult> {
      const { url } = await getMediaUrl({
        mediaId: args.mediaRef,
        accessToken,
      });
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: url,
        accessToken,
      });
      return { buffer, contentType };
    },
  };
}
