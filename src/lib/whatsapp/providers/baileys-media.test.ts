import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptBaileysMedia, expandMediaKey, BaileysMediaError } from './baileys-media';

// ------------------------------------------------------------
// Test vector — computed independently of `baileys-media.ts` via a
// standalone Node script implementing the same published Baileys
// media-encryption scheme (HKDF-SHA256 app-info "WhatsApp Image Keys"
// -> iv/cipherKey/macKey -> AES-256-CBC encrypt -> HMAC-SHA256(iv||
// ciphertext) truncated to 10 bytes appended as a MAC), then hardcoded
// here as fixed bytes. This exercises the real algorithm end-to-end
// (encrypt with independently-derived key material, decrypt with the
// module under test) rather than asserting against itself.
//
// TODO: replace/augment with a captured real WaSenderAPI inbound-media
// payload once one is available from a live connected test account —
// this vector proves the crypto is implemented correctly per the
// published scheme, but hasn't been checked against WaSenderAPI's
// actual wire bytes.
// ------------------------------------------------------------
const MEDIA_KEY_B64 = 'Bjl0lEQnANY0WkTGX+bwoTiUR2fmlFeP4pkLsCdlvS8=';
const PLAINTEXT = 'Baileys media test vector payload — hello!';
const ENCRYPTED_FILE_B64 =
  'qw3CqvQffvsUB7/js1+SNqFuHCH2+m+LjA4REG60jSrLInKUP+kqdLLn/r2Fyib3WvUs6EVxpjyBcQ==';

function mockFetchOnce(bodyB64: string, ok = true, status = 200) {
  const buf = Buffer.from(bodyB64, 'base64');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decryptBaileysMedia', () => {
  it('decrypts a known-good envelope against the independently-computed test vector', async () => {
    mockFetchOnce(ENCRYPTED_FILE_B64);
    const result = await decryptBaileysMedia({
      url: 'https://example.com/media/1',
      mediaKey: MEDIA_KEY_B64,
      mimetype: 'image/jpeg',
    });
    expect(result.bytes.toString('utf8')).toBe(PLAINTEXT);
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('derives mediaType from the mimetype when not explicitly given', async () => {
    // Same vector was encrypted with the "image" app-info string, so
    // an explicit mediaType is required for it to decrypt correctly —
    // this asserts the mimetype-derived default matches ('image/jpeg' -> 'image').
    mockFetchOnce(ENCRYPTED_FILE_B64);
    const result = await decryptBaileysMedia({
      url: 'https://example.com/media/1',
      mediaKey: MEDIA_KEY_B64,
      mimetype: 'image/jpeg',
    });
    expect(result.bytes.toString('utf8')).toBe(PLAINTEXT);
  });

  it('throws BaileysMediaError when the MAC does not verify (tampered ciphertext)', async () => {
    const tampered = Buffer.from(ENCRYPTED_FILE_B64, 'base64');
    tampered[0] ^= 0xff; // flip a bit in the ciphertext
    mockFetchOnce(tampered.toString('base64'));
    await expect(
      decryptBaileysMedia({
        url: 'https://example.com/media/1',
        mediaKey: MEDIA_KEY_B64,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(BaileysMediaError);
  });

  it('throws BaileysMediaError with the wrong mediaKey', async () => {
    mockFetchOnce(ENCRYPTED_FILE_B64);
    const wrongKey = Buffer.alloc(32, 7).toString('base64');
    await expect(
      decryptBaileysMedia({
        url: 'https://example.com/media/1',
        mediaKey: wrongKey,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(BaileysMediaError);
  });

  it('throws BaileysMediaError when the mediaKey is not 32 bytes', async () => {
    mockFetchOnce(ENCRYPTED_FILE_B64);
    await expect(
      decryptBaileysMedia({
        url: 'https://example.com/media/1',
        mediaKey: Buffer.alloc(10).toString('base64'),
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(BaileysMediaError);
  });

  it('throws BaileysMediaError on a failed download', async () => {
    mockFetchOnce('', false, 404);
    await expect(
      decryptBaileysMedia({
        url: 'https://example.com/media/missing',
        mediaKey: MEDIA_KEY_B64,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(BaileysMediaError);
  });

  it('throws BaileysMediaError when required fields are missing', async () => {
    await expect(
      decryptBaileysMedia({ url: '', mediaKey: MEDIA_KEY_B64, mimetype: 'image/jpeg' }),
    ).rejects.toThrow(BaileysMediaError);
  });

  it('throws BaileysMediaError when the payload is too short to contain a MAC', async () => {
    mockFetchOnce(Buffer.alloc(4).toString('base64'));
    await expect(
      decryptBaileysMedia({
        url: 'https://example.com/media/1',
        mediaKey: MEDIA_KEY_B64,
        mimetype: 'image/jpeg',
      }),
    ).rejects.toThrow(BaileysMediaError);
  });
});

describe('expandMediaKey', () => {
  it('is deterministic for the same key + media kind', () => {
    const key = Buffer.from(MEDIA_KEY_B64, 'base64');
    const a = expandMediaKey(key, 'image');
    const b = expandMediaKey(key, 'image');
    expect(a.iv.equals(b.iv)).toBe(true);
    expect(a.cipherKey.equals(b.cipherKey)).toBe(true);
    expect(a.macKey.equals(b.macKey)).toBe(true);
  });

  it('produces different key material per media kind (distinct app-info)', () => {
    const key = Buffer.from(MEDIA_KEY_B64, 'base64');
    const image = expandMediaKey(key, 'image');
    const video = expandMediaKey(key, 'video');
    expect(image.cipherKey.equals(video.cipherKey)).toBe(false);
  });

  it('throws when the key is not 32 bytes', () => {
    expect(() => expandMediaKey(Buffer.alloc(16), 'image')).toThrow(BaileysMediaError);
  });
});
