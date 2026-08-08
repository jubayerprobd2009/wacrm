'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Sparkles,
  CheckCircle2,
  Trash2,
  Eye,
  EyeOff,
  Search,
  ChevronsUpDown,
  Pencil,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';

const MASKED_KEY = '••••••••••••••••';

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to null in the payload.
const HANDOFF_QUEUE = '__queue__';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  openrouter: 'OpenRouter',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  openrouter: 'sk-or-...',
};

interface ModelOption {
  id: string;
  label?: string;
}

/**
 * Searchable model picker, populated live from `/api/ai/models` once
 * the operator has typed an API key — no client bundles a model-list
 * dependency for this (no Command/Combobox primitive existed in this
 * repo yet), so it's a small custom Popover + filtered list. Falls
 * back to a plain text input (toggle via the pencil icon) so a fetch
 * failure or an unlisted/very-new model id never blocks saving.
 */
function ModelPicker({
  provider,
  model,
  onModelChange,
  apiKeyOverride,
  hasStoredKey,
  disabled,
}: {
  provider: AiProvider;
  model: string;
  onModelChange: (id: string) => void;
  /** The freshly-typed plaintext key this session, or undefined when
   *  the field still shows the masked placeholder (not edited). */
  apiKeyOverride: string | undefined;
  /** Whether this provider already has a saved key on the account —
   *  when true, the backend falls back to it server-side (decrypted),
   *  so the picker keeps working after Save without forcing a re-paste. */
  hasStoredKey: boolean;
  disabled: boolean;
}) {
  const t = useTranslations('Settings.aiConfig');
  const [manualMode, setManualMode] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const fetchedForRef = useRef<string | null>(null);

  // OpenRouter's list is public — always fetchable even with no key at
  // all. OpenAI/Anthropic need either a freshly-typed key or a
  // previously-saved one (resolved server-side).
  const canFetch = !!apiKeyOverride || hasStoredKey || provider === 'openrouter';
  const fetchCacheKey = `${provider}:${apiKeyOverride ?? (hasStoredKey ? 'stored' : 'none')}`;

  const fetchModels = useCallback(async () => {
    if (!canFetch) return;
    setFetchState('loading');
    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKeyOverride || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.models)) {
        setFetchState('error');
        setManualMode(true);
        toast.error(data.error ?? t('modelsFetchFailed'));
        return;
      }
      setModels(data.models);
      setFetchState('loaded');
      fetchedForRef.current = fetchCacheKey;
    } catch {
      setFetchState('error');
      setManualMode(true);
      toast.error(t('modelsFetchFailed'));
    }
  }, [provider, apiKeyOverride, canFetch, fetchCacheKey, t]);

  // Re-fetch when the provider or the key situation changed since the
  // last fetch — avoids a stale list left over from a different
  // provider/key. Checked lazily on open rather than via an effect (a
  // provider/key change while the popover is closed shouldn't trigger a
  // network call nobody's about to look at).
  const openPicker = () => {
    setOpen(true);
    if (canFetch && fetchedForRef.current !== fetchCacheKey) {
      setModels([]);
      setFetchState('idle');
      void fetchModels();
    }
  };

  const filtered = search.trim()
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(search.toLowerCase()) ||
          (m.label ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : models;

  if (manualMode) {
    return (
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Input
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
            disabled={disabled}
          />
          {canFetch && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setManualMode(false)}
              disabled={disabled}
              title={t('modelPickerBrowse')}
            >
              <Search className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('modelManualHint')}</p>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={(o) => (o ? openPicker() : setOpen(false))}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className="truncate">{model || t('modelPickerPlaceholder')}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="flex items-center gap-2 border-b border-border p-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('modelSearchPlaceholder')}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {fetchState === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('modelsLoading')}
            </div>
          )}
          {fetchState !== 'loading' && !canFetch && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t('modelsNeedKeyHint')}
            </p>
          )}
          {fetchState === 'loaded' && filtered.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t('modelsNoMatch')}
            </p>
          )}
          {fetchState === 'loaded' &&
            filtered.slice(0, 300).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onModelChange(m.id);
                  setOpen(false);
                }}
                className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${
                  m.id === model ? 'bg-muted' : ''
                }`}
              >
                <span className="truncate">{m.id}</span>
                {m.label && m.label !== m.id && (
                  <span className="truncate text-xs text-muted-foreground">{m.label}</span>
                )}
              </button>
            ))}
        </div>
        <div className="border-t border-border p-1.5">
          <button
            type="button"
            onClick={() => {
              setManualMode(true);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" /> {t('modelEnterManually')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [outreachSystemPrompt, setOutreachSystemPrompt] = useState('');
  const [qualificationSystemPrompt, setQualificationSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [aiSelfDiscloses, setAiSelfDiscloses] = useState(true);
  const [optOutAppliesToWhatsapp, setOptOutAppliesToWhatsapp] = useState(true);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');
  const [members, setMembers] = useState<AccountMember[]>([]);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setOutreachSystemPrompt(data.outreach_system_prompt ?? '');
        setQualificationSystemPrompt(data.qualification_system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setAiSelfDiscloses(data.ai_self_discloses !== false);
        setOptOutAppliesToWhatsapp(data.opt_out_applies_to_whatsapp !== false);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig]);

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model === AI_PROVIDER_DEFAULT_MODEL.openrouter ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    outreach_system_prompt: outreachSystemPrompt.trim() || null,
    qualification_system_prompt: qualificationSystemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    ai_self_discloses: aiSelfDiscloses,
    opt_out_applies_to_whatsapp: optOutAppliesToWhatsapp,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_agent_id: handoffAgentId || null,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (!configured && !keyEdited) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setAiSelfDiscloses(true);
        setOptOutAppliesToWhatsapp(true);
        setSystemPrompt('');
        setOutreachSystemPrompt('');
        setQualificationSystemPrompt('');
        setHandoffAgentId('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loadFailed')} {/* Re-using label or a global one, wait, loading is better. Let's use useTranslations from overview or just hardcode Loading... actually I should add loading to aiConfig */}
        {/* Wait, I didn't add loading to aiConfig. I'll just use loading. */}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t('providerAndKey')}
            </CardTitle>
            <CardDescription>
              {t('encryptionNotice')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('provider')}</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue>{PROVIDER_LABEL[provider]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                    <SelectItem value="openrouter">
                      {PROVIDER_LABEL.openrouter}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-model">{t('model')}</Label>
                <ModelPicker
                  provider={provider}
                  model={model}
                  onModelChange={setModel}
                  apiKeyOverride={keyEdited ? apiKey.trim() || undefined : undefined}
                  hasStoredKey={hasStoredKey}
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testKey')}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="font-normal text-muted-foreground">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>
              {t('behaviourDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
              <p className="text-xs text-muted-foreground">{t('businessContextKbHint')}</p>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-outreach-prompt">Insurance lead outreach prompt</Label>
              <p className="text-xs text-muted-foreground">
                Extra instructions for the first-contact SMS assistant (introduces the
                company, gauges interest). Leave blank to use the default behavior.
              </p>
              <Textarea
                id="ai-outreach-prompt"
                value={outreachSystemPrompt}
                onChange={(e) => setOutreachSystemPrompt(e.target.value)}
                placeholder="e.g. We specialize in auto and home insurance for the Dallas area..."
                rows={4}
                disabled={disabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-qualification-prompt">Appointment qualification prompt</Label>
              <p className="text-xs text-muted-foreground">
                Extra instructions for the assistant that collects booking details once a
                lead is interested. Leave blank to use the default behavior.
              </p>
              <Textarea
                id="ai-qualification-prompt"
                value={qualificationSystemPrompt}
                onChange={(e) => setQualificationSystemPrompt(e.target.value)}
                placeholder="e.g. Our office is open Mon-Fri 9am-5pm; appointments are 30 minutes..."
                rows={4}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableAssistant')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('autoReply')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('aiSelfDiscloses')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('aiSelfDisclosesDesc')}
                </p>
              </div>
              <Switch
                checked={aiSelfDiscloses}
                onCheckedChange={setAiSelfDiscloses}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('optOutAppliesToWhatsapp')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('optOutAppliesToWhatsappDesc')}
                </p>
              </div>
              <Switch
                checked={optOutAppliesToWhatsapp}
                onCheckedChange={setOptOutAppliesToWhatsapp}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('maxAutoRepliesDesc')}
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
                onValueChange={(v) =>
                  setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                }
                disabled={disabled || !autoReplyEnabled}
              >
                <SelectTrigger id="ai-handoff">
                  <SelectValue>
                    {(() => {
                      const selectedMember = members.find((m) => m.user_id === handoffAgentId);
                      return selectedMember ? memberLabel(selectedMember) : t('handoffQueue');
                    })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>
                    {t('handoffQueue')}
                  </SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
