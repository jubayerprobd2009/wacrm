import crypto from 'node:crypto';

/**
 * Verify the HMAC-SHA1 signature Twilio attaches to webhook POSTs.
 *
 * Unlike Meta (HMAC-SHA256 over the raw JSON body), Twilio signs the
 * full request URL concatenated with the sorted `key+value` pairs of
 * every POST param, base64-encoded — see:
 *   https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * Twilio webhooks are `application/x-www-form-urlencoded`, so the
 * caller passes the parsed params (not a raw body string) plus the
 * exact public URL Twilio was configured to hit — that URL must match
 * byte-for-byte (scheme, host, path, query) or the signature won't
 * verify even with the correct auth token.
 *
 * Contract: fails closed. A missing auth token or missing/malformed
 * signature header rejects the request rather than falling open,
 * mirroring `verifyMetaWebhookSignature`.
 */
export function verifyTwilioWebhookSignature(
  authToken: string | undefined,
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null,
): boolean {
  if (!authToken) {
    console.error(
      '[sms webhook] no auth token available for signature verification — rejecting request.',
    );
    return false;
  }
  if (!signatureHeader) return false;

  const sorted = Object.keys(params).sort();
  const data = sorted.reduce((acc, key) => acc + key + params[key], url);

  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
