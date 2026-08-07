// ============================================================
// media-ingest.ts — resolve inbound media (fetch + decrypt, provider-
// agnostic) and upload it to the `chat-media` storage bucket so
// `messages.media_url` works identically to the Meta path for every
// provider.
//
// Phase 6 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// Deliberately generic over `provider.fetchInboundMedia` (the shared
// `WhatsAppProvider` interface, `providers/types.ts`) rather than
// branching on provider id: Meta and Evolution's adapters already
// implement it fully; WaSenderAPI's `providers/wasender/adapter.ts`
// currently throws "not yet supported" pending a small follow-up patch
// to route through `providers/baileys-media.ts` (out of this task's
// assigned file scope — see the DEVIATION note on that file). Nothing
// here needs to change once that follow-up lands.
//
// DEVIATION from the plan's literal `ingestInboundMedia(mediaRef,
// provider)` two-arg signature: the storage path needs `accountId`
// (RLS write policy match, mirrors `upload-media.ts`'s
// `buildMediaPath`) and the size cap depends on `kind` (Meta's own
// per-kind caps, `MEDIA_MAX_BYTES_BY_KIND`) — neither is optional in
// practice, so both are required via a third `opts` argument instead
// of being silently inferred or hardcoded.
//
// NOTE: `src/lib/storage/upload-media.ts`'s `uploadAccountMedia` is a
// browser-only helper (uses the browser Supabase client + resolves
// `account_id` via `auth.getUser()`, and takes a `File`) — this module
// runs server-side inside a webhook handler, where the account is
// already known from the resolved `InboundConnection` and there's no
// signed-in browser session. So this reuses `upload-media.ts`'s pure,
// exported `buildMediaPath` (same path convention / RLS match) and
// `MEDIA_MAX_BYTES_BY_KIND`, but uploads directly via the shared
// admin client + a `Buffer`, mirroring every other file in this
// directory (`contacts.ts`, `conversations.ts`, ...).
// ============================================================

import { supabaseAdmin } from './admin-client';
import { buildMediaPath, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import { extensionForMime } from '@/lib/media/filename';
import type { WhatsAppProvider, MediaKind } from '@/lib/whatsapp/providers/types';

const CHAT_MEDIA_BUCKET = 'chat-media';

export class MediaIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaIngestError';
  }
}

export interface IngestInboundMediaOptions {
  /** Account the storage object is namespaced under (RLS write policy
   *  match — see `upload-media.ts`'s `buildMediaPath`). */
  accountId: string;
  /** Drives which per-kind size cap (`MEDIA_MAX_BYTES_BY_KIND`) applies. */
  kind: MediaKind;
  /** Original filename hint (e.g. a document's reported `fileName`),
   *  used for the storage object's basename when available. */
  fileNameHint?: string | null;
}

export interface IngestInboundMediaResult {
  /** Public URL for `messages.media_url`. */
  publicUrl: string;
  /** Storage object path (account-scoped). */
  path: string;
  contentType: string;
}

/**
 * Fetch (and, for providers whose media needs it, decrypt) inbound
 * media bytes via `provider.fetchInboundMedia`, then upload them to
 * the `chat-media` bucket, returning the resulting public URL.
 *
 * Enforces the same per-kind size cap the rest of the app's media
 * upload path uses (`MEDIA_MAX_BYTES_BY_KIND` — Meta's own Cloud API
 * caps, mirrored here so a file that would be rejected on the Official
 * path doesn't silently succeed on Unofficial).
 *
 * Throws {@link MediaIngestError} on a fetch/decrypt failure, an
 * oversized payload, or a storage upload failure — callers (each
 * provider's webhook route, before calling `processInboundMessage`)
 * should catch this and fall back to inserting the message with
 * `media.url = null` rather than dropping the whole inbound message.
 */
export async function ingestInboundMedia(
  mediaRef: string,
  provider: WhatsAppProvider,
  opts: IngestInboundMediaOptions,
): Promise<IngestInboundMediaResult> {
  const { accountId, kind, fileNameHint } = opts;

  let buffer: Buffer;
  let contentType: string;
  try {
    const fetched = await provider.fetchInboundMedia({ mediaRef });
    buffer = fetched.buffer;
    contentType = fetched.contentType;
  } catch (err) {
    throw new MediaIngestError(
      `Failed to fetch inbound media via provider "${provider.id}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const cap = MEDIA_MAX_BYTES_BY_KIND[kind] ?? MEDIA_MAX_BYTES_BY_KIND.document;
  if (buffer.length > cap) {
    throw new MediaIngestError(
      `Inbound ${kind} media (${buffer.length} bytes) exceeds the ${cap}-byte cap.`,
    );
  }

  const baseName =
    (fileNameHint && fileNameHint.trim()) || `inbound-${kind}.${extensionForMime(contentType)}`;
  const path = buildMediaPath(accountId, baseName);

  const { error: uploadError } = await supabaseAdmin()
    .storage.from(CHAT_MEDIA_BUCKET)
    .upload(path, buffer, {
      contentType,
      upsert: false,
      cacheControl: '3600',
    });
  if (uploadError) {
    throw new MediaIngestError(`Failed to upload inbound media: ${uploadError.message}`);
  }

  const {
    data: { publicUrl },
  } = supabaseAdmin().storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);

  return { publicUrl, path, contentType };
}
