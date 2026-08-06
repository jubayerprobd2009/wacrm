'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, Trash2, ExternalLink } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

interface GoogleConfigResponse {
  connected: boolean;
  google_email?: string;
  calendar_id?: string;
  sheet_id?: string | null;
  sheet_range?: string;
  sheet_column_mapping?: Record<string, string> | null;
  sheet_last_synced_at?: string | null;
}

const COLUMN_FIELDS: { key: string; label: string; defaultLetter: string }[] = [
  { key: 'name', label: 'Name column', defaultLetter: 'A' },
  { key: 'phone', label: 'Phone column', defaultLetter: 'B' },
  { key: 'email', label: 'Email column', defaultLetter: 'C' },
  { key: 'service', label: 'Insurance service column', defaultLetter: 'D' },
  { key: 'notes', label: 'Notes column', defaultLetter: 'E' },
  { key: 'status', label: 'Status column (written back by the CRM)', defaultLetter: 'F' },
];

export function GoogleConfig() {
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [connected, setConnected] = useState(false);
  const [email, setEmail] = useState('');
  const [calendarId, setCalendarId] = useState('primary');
  const [sheetId, setSheetId] = useState('');
  const [sheetRange, setSheetRange] = useState('Sheet1!A:F');
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/google/config');
      const data: GoogleConfigResponse = await res.json();
      if (!res.ok) {
        toast.error('Could not load Google configuration.');
        return;
      }
      setConnected(data.connected);
      if (data.connected) {
        setEmail(data.google_email ?? '');
        setCalendarId(data.calendar_id ?? 'primary');
        setSheetId(data.sheet_id ?? '');
        setSheetRange(data.sheet_range ?? 'Sheet1!A:F');
        setColumns(data.sheet_column_mapping ?? {});
        setLastSyncedAt(data.sheet_last_synced_at ?? null);
      }
    } catch {
      toast.error('Could not load Google configuration.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  // Feedback from the OAuth callback redirect (?connected=1 / ?error=).
  useEffect(() => {
    if (searchParams.get('connected') === '1') {
      toast.success('Google connected.');
      void fetchConfig();
    }
    const error = searchParams.get('error');
    if (error) {
      toast.error(`Google connection failed: ${error.replace(/_/g, ' ')}`);
    }
    // Only meant to run once on mount against the URL the page loaded
    // with — the redirect never changes searchParams again afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/google/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendar_id: calendarId.trim() || 'primary',
          sheet_id: sheetId.trim(),
          sheet_range: sheetRange.trim(),
          sheet_column_mapping: columns,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('Google settings saved.');
        await fetchConfig();
      } else {
        toast.error(data.error ?? 'Failed to save Google settings.');
      }
    } catch {
      toast.error('Failed to save Google settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/google/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success('Google disconnected.');
        setConnected(false);
        setEmail('');
        setSheetId('');
        setColumns({});
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Failed to disconnect Google.');
      }
    } catch {
      toast.error('Failed to disconnect Google.');
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
        title="Google (Calendar & Sheets)"
        description="Connect Google to book real Calendar appointments and sync leads from a Sheet."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">Connection</CardTitle>
            <CardDescription>
              {connected ? `Connected as ${email}` : 'Not connected yet.'}
            </CardDescription>
          </div>
          {connected ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Connected
            </span>
          ) : canEdit ? (
            // Anchor styled with `buttonVariants` rather than `<Button
            // asChild>` — the wacrm Button has no Radix-style asChild slot
            // (see invite-member-dialog.tsx for the same pattern).
            <a href="/api/google/oauth/connect" className={cn(buttonVariants({ variant: 'default' }))}>
              Connect Google <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          ) : (
            <Button disabled>
              Connect Google <ExternalLink className="ml-2 h-4 w-4" />
            </Button>
          )}
        </CardHeader>
      </Card>

      {connected && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Calendar</CardTitle>
              <CardDescription>Which calendar to check availability against and book into.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="google-calendar-id">Calendar ID</Label>
              <Input
                id="google-calendar-id"
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                placeholder="primary"
                disabled={disabled}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Leads spreadsheet</CardTitle>
              <CardDescription>
                Leads sync in from this sheet on a schedule; the CRM writes each lead&apos;s
                status back into the Status column. {lastSyncedAt && (
                  <>Last synced {new Date(lastSyncedAt).toLocaleString()}.</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="google-sheet-id">Spreadsheet ID</Label>
                <Input
                  id="google-sheet-id"
                  value={sheetId}
                  onChange={(e) => setSheetId(e.target.value)}
                  placeholder="the long id in the sheet's URL"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="google-sheet-range">Sheet name + range</Label>
                <Input
                  id="google-sheet-range"
                  value={sheetRange}
                  onChange={(e) => setSheetRange(e.target.value)}
                  placeholder="Sheet1!A:F"
                  disabled={disabled}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {COLUMN_FIELDS.map((f) => (
                  <div key={f.key} className="space-y-2">
                    <Label htmlFor={`google-col-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`google-col-${f.key}`}
                      value={columns[f.key] ?? ''}
                      onChange={(e) => setColumns((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={f.defaultLetter}
                      disabled={disabled}
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button onClick={handleSave} disabled={disabled || saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={handleDisconnect}
              disabled={disabled || removing}
            >
              {removing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Disconnect
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
