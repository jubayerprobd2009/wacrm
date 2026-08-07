'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useWhatsAppConnection } from '@/hooks/use-whatsapp-connection';

// Only Meta requires (and can even represent) an approval workflow —
// WaSenderAPI/Evolution send a local template row as plain text via
// `template-render.ts` with no approval concept at all (mirrors
// `ProviderCapabilities.templateApproval` in
// src/lib/whatsapp/providers/types.ts, which this client component
// can't import directly since it's server-oriented).
function hasTemplateApproval(activeProvider: string | null | undefined): boolean {
  return activeProvider === 'meta';
}

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { summary: connectionSummary, loading: connectionLoading } =
    useWhatsAppConnection();

  useEffect(() => {
    // Wait for the connection summary — it decides which filter to
    // apply, and re-running the query once it resolves is cheap and
    // beats guessing (and refetching) with the wrong filter first.
    if (connectionLoading) return;

    async function fetchTemplates() {
      try {
        const supabase = createClient();
        let query = supabase
          .from('message_templates')
          .select('*')
          .order('created_at', { ascending: false });

        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time, so hide them rather than letting
        // the user pick a template that will fail. Unofficial providers
        // have no approval workflow at all (template-render.ts renders
        // any local row to plain text), so every local template is a
        // valid broadcast pick there regardless of `status`.
        if (hasTemplateApproval(connectionSummary?.active_provider)) {
          query = query.eq('status', 'APPROVED');
        }

        const { data, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        setTemplates(data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('chooseTemplate.errorLoad'));
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, [connectionLoading, connectionSummary?.active_provider, t]);

  if (loading || connectionLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('chooseTemplate.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('chooseTemplate.subtitle')}
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('chooseTemplate.noTemplates')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('chooseTemplate.createFirst')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-sm font-medium text-foreground">{template.name}</h3>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{template.body_text}</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{template.language ?? 'en_US'}</span>
                  {/* When the active provider requires Meta approval,
                      every row here is already filtered to APPROVED so
                      the chip carries no information — omit it. On an
                      unofficial-only account there's no approval
                      concept at all: it always sends, so label it
                      "Ready to send" instead of the raw (often DRAFT)
                      local status, which would misleadingly read as
                      unfinished/blocked. */}
                  {!hasTemplateApproval(connectionSummary?.active_provider) && (
                    // Hardcoded rather than a new i18n key — i18n message
                    // files are owned by a parallel agent in this phase
                    // (see plan Phase 9); wire this into `messages/*.json`
                    // as `Broadcasts.wizard.chooseTemplate.readyToSend`
                    // in that follow-up.
                    <span className="text-emerald-400">Ready to send</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
