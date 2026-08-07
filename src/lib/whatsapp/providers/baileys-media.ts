// ============================================================
// baileys-media.ts — decrypt WaSenderAPI's raw Baileys media envelope
// (`{url, mediaKey, mimetype}`) into servable bytes.
//
// Phase 4 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// This is the standard WhatsApp/Baileys media-encryption scheme (used
// by every Baileys-based library, WaSenderAPI included, since it's a
// thin wrapper over the multi-device WhatsApp Web protocol):
//
//   1. `mediaKey` (32 raw bytes, delivered base64-encoded) is expanded
//      via HKDF-SHA256 (no salt, an app-info string specific to the
//      media type) into 112 bytes:
//        [0:16)   iv
//        [16:48)  cipherKey  (AES-256-CBC key)
//        [48:80)  macKey     (HMAC-SHA256 key)
//        [80:112) refKey     (unused here — sidecar/streaming key)
//   2. The encrypted file downloaded from `url` is
//        ciphertext (AES-256-CBC of the plaintext, PKCS7-padded)
//        || mac (first 10 bytes of HMAC-SHA256(macKey, iv || ciphertext))
//   3. Verify the MAC (constant-time) before decrypting — an
//      unauthenticated CBC decrypt on attacker-influenced ciphertext is
//      exactly the bit-flipping risk `src/lib/crypto/encryption.ts`
//      documents for its own legacy CBC format; verify-then-decrypt
//      avoids it here too.
//   4. AES-256-CBC decrypt with `cipherKey`/`iv`, then Node's decipher
//      strips the PKCS7 padding automatically.
//
// DEVIATION: `providers/wasender/adapter.ts`'s `fetchInboundMedia` is
// currently an explicit "not yet supported" throw (that file predates
// this module and is outside this task's assigned scope to edit). A
// follow-up change to that adapter — swapping its throw for a call
// into `decryptBaileysMedia` — is needed before WaSenderAPI inbound
// media actually flows end-to-end; `media-ingest.ts` in this same
// task is written against `provider.fetchInboundMedia` generically, so
// no further change will be needed there once that follow-up lands.
// ============================================================

import crypto from 'crypto';
import type { MediaKind } from './types';

export class BaileysMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaileysMediaError';
  }
}

/** HKDF "app info" strings per WhatsApp's Baileys media-key derivation —
 *  one per media category (audio/document share no `image`/`video`
 *  branch, but document also covers stickers in some Baileys forks; we
 *  only need the four WhatsApp actually differentiates). */
const MEDIA_KEY_APP_INFO: Record<'image' | 'video' | 'audio' | 'document', string> = {
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  audio: 'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
};

const HKDF_EXPANDED_LENGTH = 112;
const MAC_LENGTH = 10;
const MEDIA_KEY_RAW_LENGTH = 32;

export interface BaileysMediaEnvelope {
  /** Encrypted media's fetch URL (WaSenderAPI's raw Baileys pointer). */
  url: string;
  /** Base64-encoded 32-byte media key. */
  mediaKey: string;
  mimetype: string;
  /** Explicit override when the caller already knows the Baileys media
   *  category; otherwise derived from `mimetype`'s top-level type. */
  mediaType?: 'image' | 'video' | 'audio' | 'document';
}

export interface DecryptedBaileysMedia {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Expand a 32-byte media key into `{iv, cipherKey, macKey}` via
 * HKDF-SHA256, per the Baileys/WhatsApp media-key derivation scheme.
 * Exported for testing (constructing an independent encrypt-side test
 * vector needs the same expansion).
 */
export function expandMediaKey(
  mediaKey: Buffer,
  mediaKind: 'image' | 'video' | 'audio' | 'document',
): { iv: Buffer; cipherKey: Buffer; macKey: Buffer } {
  if (mediaKey.length !== MEDIA_KEY_RAW_LENGTH) {
    throw new BaileysMediaError(
      `mediaKey must decode to ${MEDIA_KEY_RAW_LENGTH} bytes, got ${mediaKey.length}.`,
    );
  }
  const appInfo = MEDIA_KEY_APP_INFO[mediaKind];
  const expanded = Buffer.from(
    crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(0), Buffer.from(appInfo, 'utf8'), HKDF_EXPANDED_LENGTH),
  );
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
  };
}

function mediaKindFromMimetype(mimetype: string): MediaKind {
  const top = mimetype.split('/')[0]?.trim().toLowerCase();
  if (top === 'image' || top === 'video' || top === 'audio') return top;
  return 'document';
}

/**
 * Download and decrypt a WaSenderAPI/Baileys raw media envelope.
 * Verifies the trailing 10-byte MAC (constant-time comparison) before
 * decrypting — throws {@link BaileysMediaError} on any failure
 * (missing fields, bad key length, download failure, MAC mismatch).
 */
export async function decryptBaileysMedia(
  envelope: BaileysMediaEnvelope,
): Promise<DecryptedBaileysMedia> {
  const { url, mediaKey, mimetype } = envelope;
  if (!url || !mediaKey || !mimetype) {
    throw new BaileysMediaError(
      'Baileys media envelope is missing url/mediaKey/mimetype.',
    );
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new BaileysMediaError(
      `Failed to download encrypted media (${response.status} ${response.statusText}).`,
    );
  }
  const encrypted = Buffer.from(await response.arrayBuffer());
  if (encrypted.length <= MAC_LENGTH) {
    throw new BaileysMediaError('Encrypted media payload is too short to contain a MAC.');
  }

  const mediaKind = envelope.mediaType ?? mediaKindFromMimetype(mimetype);
  const keyBuf = Buffer.from(mediaKey, 'base64');
  const { iv, cipherKey, macKey } = expandMediaKey(keyBuf, mediaKind);

  const file = encrypted.subarray(0, encrypted.length - MAC_LENGTH);
  const mac = encrypted.subarray(encrypted.length - MAC_LENGTH);

  const computedMac = crypto
    .createHmac('sha256', macKey)
    .update(iv)
    .update(file)
    .digest()
    .subarray(0, MAC_LENGTH);

  if (mac.length !== computedMac.length || !crypto.timingSafeEqual(mac, computedMac)) {
    throw new BaileysMediaError(
      'Media MAC verification failed — ciphertext may be corrupted or tampered.',
    );
  }

  let bytes: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    bytes = Buffer.concat([decipher.update(file), decipher.final()]);
  } catch (err) {
    throw new BaileysMediaError(
      `Media decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { bytes, mimeType: mimetype };
}
