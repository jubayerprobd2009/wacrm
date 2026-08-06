// ============================================================
// Thin Twilio REST client — send an SMS, nothing else.
//
// Twilio's Messages API is a single POST with Basic Auth (Account
// SID as username, Auth Token as password). No SDK dependency:
// `fetch` + `URLSearchParams` covers the one endpoint this app needs,
// matching the project's existing preference for hand-rolled API
// wrappers over provider SDKs (see meta-api.ts).
//
// Reference: https://www.twilio.com/docs/sms/api/message-resource
// ============================================================

export class TwilioApiError extends Error {
  readonly status: number;
  readonly twilioCode?: number;
  constructor(message: string, status: number, twilioCode?: number) {
    super(message);
    this.name = 'TwilioApiError';
    this.status = status;
    this.twilioCode = twilioCode;
  }
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** Optional Messaging Service SID — when set, Twilio's Advanced
   *  Opt-Out (STOP/START/HELP handling) applies automatically and
   *  `messagingServiceSid` is sent instead of `from`. */
  messagingServiceSid?: string | null;
}

export interface SendSmsResult {
  /** Twilio's message SID (e.g. "SM...") — stored as our message_id,
   *  mirroring how WhatsApp's `wamid` is stored. */
  twilioMessageId: string;
  status: string;
}

/**
 * Send a single SMS via Twilio. Throws `TwilioApiError` on any
 * non-2xx response — callers (send-message.ts) decide how to map
 * that onto `SendMessageError`.
 */
export async function sendSms(
  creds: TwilioCredentials,
  to: string,
  body: string,
): Promise<SendSmsResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`;

  const params = new URLSearchParams();
  params.set('To', to);
  params.set('Body', body);
  if (creds.messagingServiceSid) {
    params.set('MessagingServiceSid', creds.messagingServiceSid);
  } else {
    params.set('From', creds.fromNumber);
  }

  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const json = (await res.json().catch(() => null)) as
    | { sid?: string; status?: string; message?: string; code?: number }
    | null;

  if (!res.ok || !json?.sid) {
    throw new TwilioApiError(
      json?.message || `Twilio send failed with status ${res.status}`,
      res.status,
      json?.code,
    );
  }

  return { twilioMessageId: json.sid, status: json.status ?? 'queued' };
}

/**
 * Verify a Twilio Account SID + Auth Token pair by fetching the
 * account resource — used by the config route's "Test connection"
 * action, mirroring `verifyPhoneNumber` in meta-api.ts.
 */
export async function verifyTwilioAccount(
  accountSid: string,
  authToken: string,
): Promise<{ friendlyName: string; status: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const json = (await res.json().catch(() => null)) as
    | { friendly_name?: string; status?: string; message?: string }
    | null;

  if (!res.ok) {
    throw new TwilioApiError(
      json?.message || `Twilio account lookup failed with status ${res.status}`,
      res.status,
    );
  }

  return {
    friendlyName: json?.friendly_name ?? accountSid,
    status: json?.status ?? 'unknown',
  };
}
