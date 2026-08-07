import { describe, expect, it } from 'vitest';
import {
  renderTemplateToMessage,
  renderTemplateAsPlainMessage,
  TemplateRenderError,
} from './template-render';
import type { MessageTemplate } from '@/types';

const BASE_TEMPLATE: MessageTemplate = {
  id: 'tpl-1',
  user_id: 'user-1',
  name: 'order_update',
  category: 'Utility',
  body_text: 'Hi {{1}}, your order {{2}} shipped.',
  created_at: '2024-01-01T00:00:00Z',
};

describe('renderTemplateToMessage — body params', () => {
  it('substitutes positional params (legacy `params`)', () => {
    const result = renderTemplateToMessage(BASE_TEMPLATE, { params: ['Sam', '#42'] });
    expect(result.text).toBe('Hi Sam, your order #42 shipped.');
  });

  it('substitutes structured messageParams.body', () => {
    const result = renderTemplateToMessage(BASE_TEMPLATE, {
      messageParams: { body: ['Sam', '#42'] },
    });
    expect(result.text).toBe('Hi Sam, your order #42 shipped.');
  });

  it('prefers messageParams.body over legacy params when both given', () => {
    const result = renderTemplateToMessage(BASE_TEMPLATE, {
      params: ['Legacy', '#00'],
      messageParams: { body: ['Structured', '#42'] },
    });
    expect(result.text).toBe('Hi Structured, your order #42 shipped.');
  });

  it('throws TemplateRenderError when a required body param is missing', () => {
    expect(() => renderTemplateToMessage(BASE_TEMPLATE, { params: ['Sam'] })).toThrow(
      TemplateRenderError,
    );
  });

  it('throws when no template row is supplied', () => {
    expect(() => renderTemplateToMessage(undefined, {})).toThrow(TemplateRenderError);
  });

  it('renders a fully-static body with no params needed', () => {
    const tpl: MessageTemplate = { ...BASE_TEMPLATE, body_text: 'Thanks for shopping with us!' };
    const result = renderTemplateToMessage(tpl, {});
    expect(result.text).toBe('Thanks for shopping with us!');
  });
});

describe('renderTemplateToMessage — header', () => {
  it('prepends a static text header', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      header_type: 'text',
      header_content: 'Order update',
    };
    const result = renderTemplateToMessage(tpl, { params: ['Sam', '#42'] });
    expect(result.text.startsWith('Order update\n\n')).toBe(true);
  });

  it('substitutes a {{1}} text header from messageParams.headerText', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      header_type: 'text',
      header_content: 'Hello {{1}}!',
    };
    const result = renderTemplateToMessage(tpl, {
      params: ['Sam', '#42'],
      messageParams: { headerText: 'VIP' },
    });
    expect(result.text.startsWith('Hello VIP!\n\n')).toBe(true);
  });

  it('throws when a {{1}} text header has no headerText value', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      header_type: 'text',
      header_content: 'Hello {{1}}!',
    };
    expect(() => renderTemplateToMessage(tpl, { params: ['Sam', '#42'] })).toThrow(
      TemplateRenderError,
    );
  });

  it('returns a media send with the body as caption for an image header', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      header_type: 'image',
      header_media_url: 'https://example.com/media/receipt.jpg',
    };
    const result = renderTemplateToMessage(tpl, { params: ['Sam', '#42'] });
    expect(result.mediaKind).toBe('image');
    expect(result.mediaUrl).toBe('https://example.com/media/receipt.jpg');
    expect(result.text).toBe('Hi Sam, your order #42 shipped.');
  });

  it('prefers messageParams.headerMediaUrl over the template default', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      header_type: 'video',
      header_media_url: 'https://example.com/default.mp4',
    };
    const result = renderTemplateToMessage(tpl, {
      params: ['Sam', '#42'],
      messageParams: { headerMediaUrl: 'https://example.com/override.mp4' },
    });
    expect(result.mediaUrl).toBe('https://example.com/override.mp4');
  });

  it('throws when a media header template has no media URL anywhere', () => {
    const tpl: MessageTemplate = { ...BASE_TEMPLATE, header_type: 'document' };
    expect(() => renderTemplateToMessage(tpl, { params: ['Sam', '#42'] })).toThrow(
      TemplateRenderError,
    );
  });

  it('derives a filename for document headers', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      header_type: 'document',
      header_media_url: 'https://example.com/files/invoice-42.pdf',
    };
    const result = renderTemplateToMessage(tpl, { params: ['Sam', '#42'] });
    expect(result.filename).toBe('invoice-42.pdf');
  });
});

describe('renderTemplateToMessage — footer + buttons', () => {
  it('appends the footer', () => {
    const tpl: MessageTemplate = { ...BASE_TEMPLATE, footer_text: 'Reply STOP to opt out' };
    const result = renderTemplateToMessage(tpl, { params: ['Sam', '#42'] });
    expect(result.text.endsWith('Reply STOP to opt out')).toBe(true);
  });

  it('appends buttons as numbered lines', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Yes' },
        { type: 'QUICK_REPLY', text: 'No' },
      ],
    };
    const result = renderTemplateToMessage(tpl, { params: ['Sam', '#42'] });
    expect(result.text).toContain('1. Yes');
    expect(result.text).toContain('2. No');
  });

  it('appends URL buttons with the target URL inline', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      buttons: [{ type: 'URL', text: 'Track order', url: 'https://example.com/track' }],
    };
    const result = renderTemplateToMessage(tpl, { params: ['Sam', '#42'] });
    expect(result.text).toContain('1. Track order: https://example.com/track');
  });
});

describe('renderTemplateToMessage — media caption cap', () => {
  it('caps the caption at 1024 chars for a media header', () => {
    const longBody = 'x'.repeat(1100) + ' {{1}}';
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      body_text: longBody,
      header_type: 'image',
      header_media_url: 'https://example.com/media/x.jpg',
    };
    const result = renderTemplateToMessage(tpl, { params: ['Sam'] });
    expect(result.text.length).toBe(1024);
  });

  it('does not truncate plain-text (non-media) messages', () => {
    const longBody = 'x'.repeat(1100) + ' {{1}}';
    const tpl: MessageTemplate = { ...BASE_TEMPLATE, body_text: longBody };
    const result = renderTemplateToMessage(tpl, { params: ['Sam'] });
    expect(result.text.length).toBeGreaterThan(1024);
  });
});

describe('renderTemplateAsPlainMessage', () => {
  it('returns {kind, text} for a plain-text template', () => {
    const result = renderTemplateAsPlainMessage(BASE_TEMPLATE, { params: ['Sam', '#42'] });
    expect(result).toEqual({ kind: 'text', text: 'Hi Sam, your order #42 shipped.' });
  });

  it('returns {kind, text, mediaUrl, filename} for a media-header template', () => {
    const tpl: MessageTemplate = {
      ...BASE_TEMPLATE,
      header_type: 'document',
      header_media_url: 'https://example.com/files/invoice.pdf',
    };
    const result = renderTemplateAsPlainMessage(tpl, { params: ['Sam', '#42'] });
    expect(result.kind).toBe('document');
    expect(result.mediaUrl).toBe('https://example.com/files/invoice.pdf');
    expect(result.filename).toBe('invoice.pdf');
  });
});
