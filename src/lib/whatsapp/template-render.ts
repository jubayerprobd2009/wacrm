// ============================================================
// template-render.ts — render a local `message_templates` row to a
// plain-text (or media+caption) message for providers that lack
// `capabilities.metaTemplates` (WaSenderAPI, Evolution).
//
// Phase 4 of the plan (see
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md).
//
// Reuses the existing param-parsing logic rather than reimplementing
// it: `extractVariableIndices` (template-validators.ts) for locating
// `{{n}}` placeholders, and `SendTimeParams` (template-send-builder.ts)
// for the send-time value shape — the same shape the Meta path uses
// to build its `components` array.
//
// NAMING NOTE: the plan's Phase 4 section names this function
// `renderTemplateAsPlainMessage`. By the time this file landed, the
// WaSenderAPI and Evolution adapters (`providers/wasender/adapter.ts`,
// `providers/evolution/adapter.ts` — built by parallel agents against
// this module's *documented, not-yet-existing* contract) had already
// been written calling a function named `renderTemplateToMessage`
// returning `{text, mediaUrl?, mediaKind?}`. Matching their existing,
// already-landed call sites keeps this integration a zero-diff drop-in
// for both adapters — inventing a second, incompatible name/shape here
// would silently break both. `renderTemplateToMessage` is therefore
// the primary, canonical export; `renderTemplateAsPlainMessage` is
// kept as a thin wrapper in the plan's originally-specified shape
// (`{kind, text, mediaUrl?, filename?}`) for callers that want that
// shape directly.
// ============================================================

import type { MessageTemplate, TemplateButton } from '@/types';
import type { MediaKind } from './providers/types';
import { extractVariableIndices } from './template-validators';
import type { SendTimeParams } from './template-send-builder';

/** WhatsApp's hard cap on a media message's caption. */
const MEDIA_CAPTION_MAX = 1024;

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

/** Args this module accepts — a subset of `SendTemplateArgs`
 *  (`providers/types.ts`) so callers can pass that type directly
 *  without an import cycle. */
export interface TemplateRenderArgs {
  /** Legacy positional body params, kept for parity with meta-api.ts. */
  params?: string[];
  /** Structured per-send values (body/header/button substitutions). */
  messageParams?: unknown;
}

/** Media-header kinds a template can carry (audio isn't a valid
 *  template header type per Meta's spec, so it's excluded here even
 *  though it's a member of the broader `MediaKind` union). */
type TemplateMediaKind = Extract<MediaKind, 'image' | 'video' | 'document'>;

export interface RenderedTemplateMessage {
  text: string;
  mediaUrl?: string | null;
  mediaKind?: TemplateMediaKind | null;
  /** Document-only display filename, best-effort from the media URL. */
  filename?: string;
}

function substituteVariables(text: string, values: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (match, indexStr: string) => {
    const index = Number(indexStr);
    const value = values[index - 1];
    return value !== undefined ? String(value) : match;
  });
}

function buttonAsLine(button: TemplateButton, index: number): string {
  const n = index + 1;
  switch (button.type) {
    case 'URL':
      return `${n}. ${button.text}: ${button.url}`;
    case 'PHONE_NUMBER':
      return `${n}. ${button.text}: ${button.phone_number}`;
    case 'COPY_CODE':
      return `${n}. ${button.text}: ${button.example}`;
    case 'QUICK_REPLY':
      return `${n}. ${button.text}`;
  }
}

function buttonsAsLines(buttons: TemplateButton[] | undefined): string[] {
  if (!buttons?.length) return [];
  return buttons.map(buttonAsLine);
}

function renderHeaderLine(
  template: MessageTemplate,
  sendParams: SendTimeParams,
): string | null {
  if (template.header_type !== 'text' || !template.header_content) return null;

  const varCount = extractVariableIndices(template.header_content).length;
  if (varCount === 0) return template.header_content;

  const value = sendParams.headerText;
  if (!value || !value.trim()) {
    throw new TemplateRenderError(
      `Template "${template.name}" header uses {{1}} — requires messageParams.headerText.`,
    );
  }
  return substituteVariables(template.header_content, [value]);
}

function renderMediaHeader(
  template: MessageTemplate,
  sendParams: SendTimeParams,
): { mediaUrl: string; mediaKind: TemplateMediaKind } | null {
  const headerType = template.header_type;
  if (headerType !== 'image' && headerType !== 'video' && headerType !== 'document') {
    return null;
  }

  const mediaUrl = sendParams.headerMediaUrl ?? template.header_media_url;
  if (!mediaUrl) {
    throw new TemplateRenderError(
      `Template "${template.name}" has a ${headerType} header but no media URL — set header_media_url on the template or pass messageParams.headerMediaUrl.`,
    );
  }
  return { mediaUrl, mediaKind: headerType };
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const base = path.split('/').filter(Boolean).pop();
    return base || undefined;
  } catch {
    const base = url.split('?')[0].split('/').filter(Boolean).pop();
    return base || undefined;
  }
}

/**
 * Render a local template row to plain text (or media + caption) —
 * the canonical shape the WaSenderAPI and Evolution adapters
 * (`providers/wasender/adapter.ts`, `providers/evolution/adapter.ts`)
 * are already written against.
 *
 * Substitutes positional/named body params, prepends header text (or
 * carries a media header separately), appends the footer, appends
 * buttons as numbered/URL lines, and — when the template has a media
 * header — returns the assembled text as a caption capped at
 * WhatsApp's 1024-char media-caption limit.
 *
 * Throws {@link TemplateRenderError} when a required param (a body
 * `{{n}}`, a header `{{1}}`, or a media header's URL) is missing.
 */
export function renderTemplateToMessage(
  template: MessageTemplate | null | undefined,
  args: TemplateRenderArgs = {},
): RenderedTemplateMessage {
  if (!template) {
    throw new TemplateRenderError('Cannot render template: no template row supplied.');
  }

  const sendParams = (args.messageParams as SendTimeParams | undefined) ?? {};
  // Structured `messageParams.body` wins when present; otherwise fall
  // back to the legacy positional `params` array (mirrors the Meta
  // send path's own `params ?? messageParams` precedence).
  const bodyValues = sendParams.body ?? args.params ?? [];

  const bodyVarCount = extractVariableIndices(template.body_text).length;
  if (bodyValues.length < bodyVarCount) {
    throw new TemplateRenderError(
      `Template "${template.name}" body needs ${bodyVarCount} param(s), got ${bodyValues.length}.`,
    );
  }
  const body = substituteVariables(template.body_text, bodyValues);

  const media = renderMediaHeader(template, sendParams);
  // Text headers only apply when there's no media header (a template
  // has at most one header component).
  const headerLine = media ? null : renderHeaderLine(template, sendParams);
  const footerLine = template.footer_text?.trim() || null;
  const buttonLines = buttonsAsLines(template.buttons);

  const parts = [headerLine, body, footerLine, buttonLines.join('\n') || null].filter(
    (p): p is string => !!p,
  );
  let text = parts.join('\n\n');

  if (media) {
    // Media header: the assembled text becomes the caption, subject to
    // WhatsApp's per-media caption cap.
    if (text.length > MEDIA_CAPTION_MAX) {
      text = text.slice(0, MEDIA_CAPTION_MAX);
    }
    return {
      text,
      mediaUrl: media.mediaUrl,
      mediaKind: media.mediaKind,
      ...(media.mediaKind === 'document'
        ? { filename: filenameFromUrl(media.mediaUrl) }
        : {}),
    };
  }

  return { text };
}

export type RenderedTemplateKind = 'text' | TemplateMediaKind;

export interface RenderedTemplatePlainMessage {
  kind: RenderedTemplateKind;
  text: string;
  mediaUrl?: string;
  filename?: string;
}

/**
 * Thin wrapper over {@link renderTemplateToMessage} in the shape
 * originally specified for this module
 * (`{kind, text, mediaUrl?, filename?}`) — see the NAMING NOTE above
 * for why `renderTemplateToMessage` is the primary export instead.
 */
export function renderTemplateAsPlainMessage(
  template: MessageTemplate | null | undefined,
  args: TemplateRenderArgs = {},
): RenderedTemplatePlainMessage {
  const rendered = renderTemplateToMessage(template, args);
  return {
    kind: rendered.mediaKind ?? 'text',
    text: rendered.text,
    ...(rendered.mediaUrl ? { mediaUrl: rendered.mediaUrl } : {}),
    ...(rendered.filename ? { filename: rendered.filename } : {}),
  };
}
