'use client';

// ============================================================
// Settings → Workspace → "WhatsApp Unofficial" panel.
//
// Provider picker (WaSenderAPI / Evolution API) + a provider-specific
// connect flow. Backed by the routes built in earlier phases:
//   - GET/POST/PATCH/DELETE /api/whatsapp/unofficial/config
//   - POST   /api/whatsapp/unofficial/evolution/connect
//   - GET    /api/whatsapp/unofficial/evolution/status
//   - GET    /api/whatsapp/unofficial/evolution/qr
//   - DELETE /api/whatsapp/unofficial/evolution/disconnect
//
// See Phase 5 of /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  QrCode,
  Unplug,
  ShieldAlert,
  MessageCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { useWhatsAppConnection } from '@/hooks/use-whatsapp-connection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';

type UnofficialProvider = 'wasender' | 'evolution';
type ConfigStatus = 'connected' | 'disconnected' | 'pending';

interface UnofficialConfigResponse {
  configured: boolean;
  id?: string;
  provider?: UnofficialProvider;
  status?: ConfigStatus;
  is_primary?: boolean;
  inbound_token?: string;
  phone_number?: string | null;
  connected_at?: string | null;
  last_inbound_at?: string | null;
  last_status_error?: string | null;
  has_api_key?: boolean;
  has_webhook_secret?: boolean;
  has_admin_api_key?: boolean;
  has_instance_token?: boolean;
  base_url?: string | null;
  instance_name?: string | null;
  display_name?: string | null;
}

const ACK_STORAGE_PREFIX = 'wacrm.unofficial-ban-ack.';
const EVOLUTION_POLL_INTERVAL_MS = 3000;
const EVOLUTION_POLL_MAX_ATTEMPTS = 40; // ~2 minutes

function getAppOrigin(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

export function WhatsAppUnofficialConfig() {
  const t = useTranslations('Settings.whatsappUnofficial');
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const connection = useWhatsAppConnection();

  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<UnofficialConfigResponse | null>(null);
  const [provider, setProvider] = useState<UnofficialProvider>('wasender');

  // One-time ban-risk acknowledgement — gates the Connect action. Kept
  // client-side (localStorage, per-account) rather than a new DB column;
  // it's a UX guardrail, not a compliance record.
  const [acknowledged, setAcknowledged] = useState(false);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/unofficial/config');
      const data = (await res.json()) as UnofficialConfigResponse;
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      setConfig(data);
      if (data.configured && data.provider) {
        setProvider(data.provider);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    try {
      const stored = window.localStorage.getItem(ACK_STORAGE_PREFIX + accountId);
      if (stored === '1') setAcknowledged(true);
    } catch {
      // localStorage unavailable (private mode etc) — just require the
      // checkbox again this session.
    }
  }, [accountId, fetchConfig]);

  const handleAcknowledgeChange = (checked: boolean) => {
    setAcknowledged(checked);
    if (accountId) {
      try {
        if (checked) window.localStorage.setItem(ACK_STORAGE_PREFIX + accountId, '1');
        else window.localStorage.removeItem(ACK_STORAGE_PREFIX + accountId);
      } catch {
        // best-effort only
      }
    }
  };

  // Re-check inbound-verified / connection status whenever the tab
  // regains focus, so pasting a webhook secret into another tab (the
  // provider's own dashboard) and tabbing back reflects promptly
  // without a manual refresh.
  useEffect(() => {
    const onFocus = () => void fetchConfig();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchConfig]);

  const disabled = !canEdit;
  const showPrimarySwitch =
    !!connection.summary?.official.connected && !!connection.summary?.unofficial.connected;

  const handlePrimaryChange = async (value: string) => {
    const nextIsPrimary = value === 'unofficial';
    try {
      const res = await fetch('/api/whatsapp/unofficial/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_primary: nextIsPrimary }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('primaryUpdateFailed'));
        return;
      }
      toast.success(t('primaryUpdateSuccess'));
      setConfig((prev) => (prev ? { ...prev, is_primary: nextIsPrimary } : prev));
      connection.refresh();
    } catch {
      toast.error(t('primaryUpdateFailed'));
    }
  };

  if (loading || profileLoading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Alert className="bg-amber-950/30 border-amber-700/50">
          <div className="flex items-start gap-2">
            <ShieldAlert className="size-4 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <AlertTitle className="text-amber-200">{t('banRiskTitle')}</AlertTitle>
              <AlertDescription className="text-amber-100/80 text-sm">
                {t('banRiskDesc')}
              </AlertDescription>
            </div>
          </div>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('providerTitle')}</CardTitle>
            <CardDescription>{t('providerDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 sm:max-w-xs">
              <Label>{t('provider')}</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as UnofficialProvider)}
                disabled={disabled || (config?.configured ?? false)}
              >
                <SelectTrigger>
                  <SelectValue>
                    {provider === 'wasender' ? t('providerWaSender') : t('providerEvolution')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wasender">{t('providerWaSender')}</SelectItem>
                  <SelectItem value="evolution">{t('providerEvolution')}</SelectItem>
                </SelectContent>
              </Select>
              {config?.configured && (
                <p className="text-xs text-muted-foreground">{t('providerLockedHint')}</p>
              )}
            </div>

            <label className="flex items-start gap-2.5 rounded-md border border-border p-3">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(c) => handleAcknowledgeChange(c === true)}
                disabled={disabled}
                className="mt-0.5"
              />
              <span className="text-sm text-muted-foreground">{t('banRiskAcknowledge')}</span>
            </label>
          </CardContent>
        </Card>

        {provider === 'wasender' ? (
          <WaSenderPanel
            t={t}
            config={config}
            canEdit={canEdit}
            acknowledged={acknowledged}
            onSaved={fetchConfig}
          />
        ) : (
          <EvolutionPanel
            t={t}
            config={config}
            canEdit={canEdit}
            acknowledged={acknowledged}
            onSaved={fetchConfig}
          />
        )}

        {showPrimarySwitch && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('primaryTitle')}</CardTitle>
              <CardDescription>{t('primaryDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={config?.is_primary ? 'unofficial' : 'official'}
                onValueChange={handlePrimaryChange}
                disabled={disabled}
              >
                <label className="flex items-center gap-2.5 py-1.5 text-sm">
                  <RadioGroupItem value="official" />
                  {t('primaryOfficial')}
                </label>
                <label className="flex items-center gap-2.5 py-1.5 text-sm">
                  <RadioGroupItem value="unofficial" />
                  {t('primaryUnofficial')}
                </label>
              </RadioGroup>
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// WaSenderAPI panel — two blocking steps (API key, then webhook secret
// pasted back from WaSenderAPI's own dashboard).
// ------------------------------------------------------------

function WaSenderPanel({
  t,
  config,
  canEdit,
  acknowledged,
  onSaved,
}: {
  t: ReturnType<typeof useTranslations>;
  config: UnofficialConfigResponse | null;
  canEdit: boolean;
  acknowledged: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState('');
  const [savingSecret, setSavingSecret] = useState(false);

  const isThisProvider = config?.configured && config.provider === 'wasender';
  const connected = isThisProvider && config?.status === 'connected';
  const hasSecret = isThisProvider && !!config?.has_webhook_secret;
  const inboundVerified = isThisProvider && !!config?.last_inbound_at;

  const webhookUrl =
    isThisProvider && config?.inbound_token
      ? `${getAppOrigin()}/api/whatsapp/unofficial/wasender/webhook/${config.inbound_token}`
      : '';

  const disabled = !canEdit || (!isThisProvider && !acknowledged);

  async function handleConnect() {
    if (!apiKey.trim()) {
      toast.error(t('wasenderApiKeyRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/unofficial/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'wasender', api_key: apiKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('wasenderConnectFailed'));
        return;
      }
      toast.success(t('wasenderConnectSuccess'));
      setApiKey('');
      await onSaved();
    } catch {
      toast.error(t('wasenderConnectFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSecret() {
    if (!webhookSecret.trim()) {
      toast.error(t('wasenderSecretRequired'));
      return;
    }
    setSavingSecret(true);
    try {
      const res = await fetch('/api/whatsapp/unofficial/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_secret: webhookSecret.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('wasenderSecretFailed'));
        return;
      }
      toast.success(t('wasenderSecretSuccess'));
      setWebhookSecret('');
      await onSaved();
    } catch {
      toast.error(t('wasenderSecretFailed'));
    } finally {
      setSavingSecret(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(t('disconnectConfirm'))) return;
    try {
      const res = await fetch('/api/whatsapp/unofficial/config', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('disconnectFailed'));
        return;
      }
      toast.success(t('disconnectSuccess'));
      await onSaved();
    } catch {
      toast.error(t('disconnectFailed'));
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success(t('webhookUrlCopied'));
  }

  return (
    <div className="space-y-6">
      {/* Connection status */}
      {isThisProvider && (
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connected ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connected ? t('connected') : t('notConnected')}
              {config?.phone_number ? ` — ${config.phone_number}` : ''}
            </AlertTitle>
          </div>
          {config?.last_status_error && (
            <AlertDescription className="text-muted-foreground">
              {config.last_status_error}
            </AlertDescription>
          )}
        </Alert>
      )}

      {/* Step 1 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              1
            </span>
            {t('wasenderStep1Title')}
          </CardTitle>
          <CardDescription>{t('wasenderStep1Desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>{t('wasenderApiKey')}</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isThisProvider ? t('wasenderApiKeySaved') : t('wasenderApiKeyPlaceholder')}
              disabled={!canEdit || (!isThisProvider && !acknowledged)}
              autoComplete="off"
            />
            {!isThisProvider && !acknowledged && (
              <p className="text-xs text-amber-400">{t('acknowledgeRequiredHint')}</p>
            )}
          </div>
          <Button onClick={handleConnect} disabled={disabled || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isThisProvider ? t('wasenderReconnect') : t('wasenderConnect')}
          </Button>
        </CardContent>
      </Card>

      {/* Step 2 — blocking until the webhook secret is saved */}
      {isThisProvider && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                2
              </span>
              {t('wasenderStep2Title')}
            </CardTitle>
            <CardDescription>{t('wasenderStep2Desc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!hasSecret && (
              <Alert className="bg-amber-950/40 border-amber-600/40">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <AlertTitle className="text-amber-200 mb-1">
                      {t('wasenderSecretMissingTitle')}
                    </AlertTitle>
                    <AlertDescription className="text-amber-100/80 text-sm">
                      {t('wasenderSecretMissingDesc')}
                    </AlertDescription>
                  </div>
                </div>
              </Alert>
            )}

            <div className="space-y-2">
              <Label>{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>

            <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
              <li>{t('wasenderStep2_1')}</li>
              <li>{t('wasenderStep2_2')}</li>
              <li>{t('wasenderStep2_3')}</li>
              <li>{t('wasenderStep2_4')}</li>
            </ol>

            <div className="space-y-2">
              <Label>{t('wasenderWebhookSecret')}</Label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  placeholder={hasSecret ? t('wasenderSecretSaved') : t('wasenderSecretPlaceholder')}
                  disabled={!canEdit}
                  autoComplete="off"
                />
                <Button onClick={handleSaveSecret} disabled={!canEdit || savingSecret}>
                  {savingSecret && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border p-3">
              {inboundVerified ? (
                <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
              ) : (
                <XCircle className="size-4 text-muted-foreground shrink-0" />
              )}
              <div className="text-sm">
                <p className="font-medium text-foreground">
                  {inboundVerified ? t('inboundVerified') : t('inboundNotVerified')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {inboundVerified && config?.last_inbound_at
                    ? t('inboundVerifiedSince', {
                        date: new Date(config.last_inbound_at).toLocaleString(),
                      })
                    : t('inboundNotVerifiedHint')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {isThisProvider && (
        <Button
          variant="outline"
          onClick={handleDisconnect}
          disabled={!canEdit}
          className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
        >
          <Unplug className="size-4" />
          {t('disconnect')}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Evolution API panel — no server URL / admin key fields in the UI
// (those come entirely from EVOLUTION_API_URL / EVOLUTION_API_KEY on
// the server). Just a name → QR → connected modal, then a status card
// with Reconnect once a connection exists.
// ------------------------------------------------------------

type EvolutionModalStep = 'name' | 'scan' | 'connected';

function EvolutionPanel({
  t,
  config,
  canEdit,
  acknowledged,
  onSaved,
}: {
  t: ReturnType<typeof useTranslations>;
  config: UnofficialConfigResponse | null;
  canEdit: boolean;
  acknowledged: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const isThisProvider = config?.configured && config.provider === 'evolution';
  const connected = isThisProvider && config?.status === 'connected';
  const savedDisplayName = (isThisProvider && config?.display_name) || '';

  const [modalOpen, setModalOpen] = useState(false);
  const [step, setStep] = useState<EvolutionModalStep>('name');
  const [displayName, setDisplayName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollAttemptsRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollAttemptsRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollAttemptsRef.current += 1;
      try {
        const res = await fetch('/api/whatsapp/unofficial/evolution/status');
        const data = await res.json();
        if (data.status === 'connected') {
          stopPolling();
          setConnectedPhone(typeof data.phone_number === 'string' ? data.phone_number : null);
          setStep('connected');
          await onSaved();
          return;
        }
      } catch {
        // transient — keep polling until the attempt cap
      }
      if (pollAttemptsRef.current >= EVOLUTION_POLL_MAX_ATTEMPTS) {
        stopPolling();
        toast.error(t('evolutionPollTimeout'));
        setModalOpen(false);
      }
    }, EVOLUTION_POLL_INTERVAL_MS);
  }, [onSaved, stopPolling, t]);

  function openConnectModal() {
    setDisplayName(savedDisplayName);
    setQrCode(null);
    setConnectedPhone(null);
    setStep('name');
    setModalOpen(true);
  }

  // Reconnect skips straight to generating a fresh QR under the
  // already-known name — no need to re-ask for it.
  async function openReconnectModal() {
    setDisplayName(savedDisplayName);
    setConnectedPhone(null);
    setModalOpen(true);
    await generateQr(savedDisplayName);
  }

  async function generateQr(nameOverride?: string) {
    setGenerating(true);
    try {
      const res = await fetch('/api/whatsapp/unofficial/evolution/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: (nameOverride ?? displayName).trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('evolutionConnectFailed'));
        setStep('name');
        return;
      }
      setQrCode(data.qrcode ?? null);
      setStep('scan');
      await onSaved();
      startPolling();
    } catch {
      toast.error(t('evolutionConnectFailed'));
      setStep('name');
    } finally {
      setGenerating(false);
    }
  }

  function handleModalOpenChange(open: boolean) {
    if (!open) stopPolling();
    setModalOpen(open);
  }

  async function handleDisconnect() {
    if (!confirm(t('disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/unofficial/evolution/disconnect', {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('disconnectFailed'));
        return;
      }
      toast.success(t('disconnectSuccess'));
      await onSaved();
    } catch {
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }

  const cardName = savedDisplayName || t('evolutionDefaultName');
  const disabled = !canEdit || !acknowledged;

  return (
    <div className="space-y-6">
      {isThisProvider ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
                <MessageCircle className="size-5 text-emerald-400" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {cardName}
                  {config?.phone_number ? ` — ${config.phone_number}` : ''}
                </p>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <QrCode className="size-3" />
                  {t('providerEvolution')}
                  <span
                    className={`ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                      connected
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-muted-foreground'}`}
                    />
                    {connected ? t('active') : t('notConnected')}
                  </span>
                </div>
                {config?.last_status_error && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{config.last_status_error}</p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!connected && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openReconnectModal}
                  disabled={!canEdit}
                >
                  <QrCode className="size-4" />
                  {t('evolutionReconnect')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={!canEdit || disconnecting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
                {t('disconnect')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('evolutionSetupTitle')}</CardTitle>
            <CardDescription>{t('evolutionSetupDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!acknowledged && (
              <p className="text-xs text-amber-400">{t('acknowledgeRequiredHint')}</p>
            )}
            <Button onClick={openConnectModal} disabled={disabled}>
              <QrCode className="mr-2 h-4 w-4" />
              {t('evolutionConnect')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={modalOpen} onOpenChange={handleModalOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('evolutionModalTitle')}</DialogTitle>
            <DialogDescription>{t('evolutionModalDesc')}</DialogDescription>
          </DialogHeader>

          <div className="mb-1 flex items-center justify-center gap-2 text-xs">
            {(['name', 'scan', 'connected'] as const).map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <span
                  className={`flex size-5 items-center justify-center rounded-full text-[11px] font-bold ${
                    step === s
                      ? 'bg-primary text-primary-foreground'
                      : (['name', 'scan', 'connected'] as const).indexOf(step) > i
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {i + 1}
                </span>
                <span className={step === s ? 'text-foreground' : 'text-muted-foreground'}>
                  {t(`evolutionModalStep_${s}` as 'evolutionModalStep_name')}
                </span>
                {i < 2 && <span className="text-muted-foreground">—</span>}
              </div>
            ))}
          </div>

          {step === 'name' && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t('evolutionDisplayName')}</Label>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t('evolutionDisplayNamePlaceholder')}
                  disabled={!canEdit}
                  autoFocus
                />
              </div>
              <Button
                onClick={() => generateQr()}
                disabled={!canEdit || generating}
                className="w-full"
              >
                {generating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <QrCode className="mr-2 h-4 w-4" />
                )}
                {t('evolutionGenerateQr')}
              </Button>
            </div>
          )}

          {step === 'scan' && (
            <div className="space-y-3">
              <div className="flex justify-center">
                {qrCode ? (
                  // eslint-disable-next-line @next/next/no-img-element -- base64 data URI from Evolution, not a static asset
                  <img
                    src={qrCode.startsWith('data:') ? qrCode : `data:image/png;base64,${qrCode}`}
                    alt={t('evolutionQrAlt')}
                    className="h-64 w-64 rounded-md border border-border bg-white p-2"
                  />
                ) : (
                  <div className="flex h-64 w-64 items-center justify-center rounded-md border border-border bg-muted">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
              <p className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('evolutionScanDescPolling')}
              </p>
            </div>
          )}

          {step === 'connected' && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle2 className="size-12 text-emerald-400" />
              <div>
                <p className="font-medium text-foreground">{t('evolutionConnectSuccess')}</p>
                {connectedPhone && (
                  <p className="text-sm text-muted-foreground">{connectedPhone}</p>
                )}
              </div>
              <Button onClick={() => setModalOpen(false)} className="mt-1">
                {t('done')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
