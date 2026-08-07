'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, Trash2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED_TOKEN = '••••••••••••••••';

interface SmsConfigResponse {
  configured: boolean;
  twilio_account_sid?: string;
  twilio_phone_number?: string;
  messaging_service_sid?: string | null;
  support_contact?: string | null;
  is_active?: boolean;
  has_token?: boolean;
}

export function SmsConfig() {
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [messagingServiceSid, setMessagingServiceSid] = useState('');
  const [supportContact, setSupportContact] = useState('');

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sms/config');
      const data: SmsConfigResponse = await res.json();
      if (!res.ok) {
        toast.error('Could not load SMS configuration.');
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setAccountSid(data.twilio_account_sid ?? '');
        setPhoneNumber(data.twilio_phone_number ?? '');
        setMessagingServiceSid(data.messaging_service_sid ?? '');
        setSupportContact(data.support_contact ?? '');
        setAuthToken(data.has_token ? MASKED_TOKEN : '');
        setTokenEdited(false);
      }
    } catch {
      toast.error('Could not load SMS configuration.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const handleSave = async () => {
    if (!accountSid.trim() || !phoneNumber.trim()) {
      toast.error('Account SID and phone number are required.');
      return;
    }
    if (!configured && !tokenEdited) {
      toast.error('Auth token is required.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/sms/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          twilio_account_sid: accountSid.trim(),
          twilio_auth_token: tokenEdited ? authToken.trim() : undefined,
          twilio_phone_number: phoneNumber.trim(),
          messaging_service_sid: messagingServiceSid.trim() || null,
          support_contact: supportContact.trim() || null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('SMS settings saved.');
        await fetchConfig();
      } else {
        toast.error(data.error ?? 'Failed to save SMS settings.');
      }
    } catch {
      toast.error('Failed to save SMS settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/sms/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success('SMS disconnected.');
        setConfigured(false);
        setAccountSid('');
        setAuthToken('');
        setTokenEdited(false);
        setPhoneNumber('');
        setMessagingServiceSid('');
        setSupportContact('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Failed to disconnect SMS.');
      }
    } catch {
      toast.error('Failed to disconnect SMS.');
    } finally {
      setRemoving(false);
    }
  };

  const disabled = !canEdit || loading;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsPanelHead
        title="SMS (Twilio)"
        description="Connect a Twilio number so leads can be texted automatically."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Twilio credentials</CardTitle>
            <CardDescription>
              From the Twilio console: Account SID, Auth Token, and the phone number to
              send from.
            </CardDescription>
          </div>
          {configured && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Connected
            </span>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sms-sid">Account SID</Label>
            <Input
              id="sms-sid"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              placeholder="AC..."
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sms-token">Auth token</Label>
            <Input
              id="sms-token"
              type="password"
              value={authToken}
              onChange={(e) => {
                setAuthToken(e.target.value);
                setTokenEdited(true);
              }}
              onFocus={() => {
                if (authToken === MASKED_TOKEN) {
                  setAuthToken('');
                  setTokenEdited(true);
                }
              }}
              placeholder="Your Twilio auth token"
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sms-phone">Twilio phone number</Label>
            <Input
              id="sms-phone"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+15551234567"
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sms-messaging-service">
              Messaging Service SID <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="sms-messaging-service"
              value={messagingServiceSid}
              onChange={(e) => setMessagingServiceSid(e.target.value)}
              placeholder="MG..."
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              Recommended: enables Twilio&apos;s built-in Advanced Opt-Out (STOP/START/HELP)
              at the platform level, on top of the app&apos;s own opt-out handling.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sms-support-contact">
              Support contact <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="sms-support-contact"
              value={supportContact}
              onChange={(e) => setSupportContact(e.target.value)}
              placeholder="(555) 123-4567 or support@company.com"
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              Shown as a &quot;Questions? Contact us: …&quot; line in appointment confirmation
              and reminder texts.
            </p>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button onClick={handleSave} disabled={disabled || saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
            {configured && (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={handleRemove}
                disabled={disabled || removing}
              >
                {removing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
