'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WhatsAppProviderId } from '@/types';

/**
 * Client-side mirror of `WhatsAppConnectionSummary`
 * (`src/lib/whatsapp/providers/resolve.ts`) — the JSON shape returned
 * by `GET /api/whatsapp/connection`.
 */
export interface WhatsAppConnectionSummary {
  connected: boolean;
  active_provider: WhatsAppProviderId | null;
  official: {
    configured: boolean;
    connected: boolean;
    phone_number?: string | null;
  };
  unofficial: {
    configured: boolean;
    connected: boolean;
    provider: 'wasender' | 'evolution' | null;
    phone_number?: string | null;
  };
}

export interface UseWhatsAppConnectionResult {
  summary: WhatsAppConnectionSummary | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch on demand — call after a settings save/connect/disconnect
   *  so the UI doesn't wait for the next natural remount. */
  refresh: () => void;
}

/**
 * Wraps `GET /api/whatsapp/connection` — the single aggregate endpoint
 * backing every "is WhatsApp connected" UI surface (settings tiles for
 * both Official and Unofficial, the inbox banner). See Phase 7 of the
 * plan (/home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
 *
 * Follows the loading/error state shape used elsewhere in this repo's
 * hooks — starts `loading: true`, resolves to either a `summary` or an
 * `error` string, never both.
 */
export function useWhatsAppConnection(): UseWhatsAppConnectionResult {
  const [summary, setSummary] = useState<WhatsAppConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/whatsapp/connection');
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const data = (await response.json()) as WhatsAppConnectionSummary;
        if (!cancelled) {
          setSummary(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load WhatsApp connection status.');
          setSummary(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return { summary, loading, error, refresh };
}
