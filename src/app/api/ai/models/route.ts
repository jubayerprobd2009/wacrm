import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import type { AiProvider } from '@/lib/ai/types'

/**
 * POST /api/ai/models  (admin+)
 *
 * Live model list for the settings form's searchable picker (see
 * ai-config.tsx). POST rather than GET because the not-yet-saved API
 * key has to travel in the body — mirrors the existing "Test key"
 * route (`/api/ai/test`), which does the same for the same reason.
 *
 * Body: `{ provider: 'openai' | 'anthropic' | 'openrouter', api_key: string }`.
 * Response: `{ models: { id: string, label?: string }[] }` on success,
 * or `{ error }` on failure — the frontend falls back to manual model
 * entry on any error rather than blocking the form.
 */

interface ModelOption {
  id: string
  label?: string
}

const NON_CHAT_OPENAI_PREFIXES = [
  'text-embedding',
  'whisper',
  'tts',
  'dall-e',
  'omni-moderation',
  'text-moderation',
  'davinci',
  'babbage',
  'ada',
]

function isChatCapableOpenAiModel(id: string): boolean {
  const lower = id.toLowerCase()
  return !NON_CHAT_OPENAI_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

async function listOpenAiModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`OpenAI rejected the request (${res.status})`)
  const data = (await res.json()) as { data?: { id?: string }[] }
  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && isChatCapableOpenAiModel(id))
  return ids.sort().map((id) => ({ id }))
}

async function listAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  })
  if (!res.ok) throw new Error(`Anthropic rejected the request (${res.status})`)
  const data = (await res.json()) as { data?: { id?: string; display_name?: string }[] }
  return (data.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: m.display_name }))
}

async function listOpenRouterModels(apiKey: string): Promise<ModelOption[]> {
  // Public endpoint — doesn't strictly require a key, but sending it
  // when present lets OpenRouter reflect account-specific
  // pricing/availability.
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  })
  if (!res.ok) throw new Error(`OpenRouter rejected the request (${res.status})`)
  const data = (await res.json()) as { data?: { id?: string; name?: string }[] }
  return (data.data ?? [])
    .filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: m.name }))
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-models:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const provider = body.provider as AiProvider
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'openrouter') {
      return NextResponse.json(
        { error: 'provider must be "openai", "anthropic", or "openrouter"' },
        { status: 400 },
      )
    }
    // OpenRouter's list is public, so an empty key is tolerated there;
    // OpenAI/Anthropic require one to list anything.
    if (!apiKey && provider !== 'openrouter') {
      return NextResponse.json({ error: 'api_key is required' }, { status: 400 })
    }

    try {
      const models =
        provider === 'openai'
          ? await listOpenAiModels(apiKey)
          : provider === 'anthropic'
            ? await listAnthropicModels(apiKey)
            : await listOpenRouterModels(apiKey)

      if (models.length === 0) {
        return NextResponse.json(
          { error: 'The provider returned no models for this key.' },
          { status: 400 },
        )
      }
      return NextResponse.json({ models })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not fetch models.'
      return NextResponse.json({ error: message }, { status: 400 })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
