import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  renderInteractiveButtonsAsText,
  renderInteractiveListAsText,
  renderInteractiveAsText,
  resolveEmulatedInteractiveReply,
} from './interactive-fallback';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

describe('renderInteractiveButtonsAsText', () => {
  it('renders body + numbered buttons', () => {
    const text = renderInteractiveButtonsAsText({
      bodyText: 'Would you like to proceed?',
      buttons: [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'No' },
      ],
    });
    expect(text).toBe('Would you like to proceed?\n\n1. Yes\n2. No');
  });

  it('includes header and footer when present', () => {
    const text = renderInteractiveButtonsAsText({
      bodyText: 'Body',
      headerText: 'Header',
      footerText: 'Footer',
      buttons: [{ id: 'a', title: 'A' }],
    });
    expect(text).toBe('Header\n\nBody\n\n1. A\n\nFooter');
  });
});

describe('renderInteractiveListAsText', () => {
  it('numbers rows sequentially across sections', () => {
    const text = renderInteractiveListAsText({
      bodyText: 'Pick one',
      sections: [
        { title: 'Group A', rows: [{ id: 'r1', title: 'Row A' }] },
        { title: 'Group B', rows: [{ id: 'r2', title: 'Row B' }, { id: 'r3', title: 'Row C' }] },
      ],
    });
    expect(text).toBe(
      'Pick one\n\nGroup A\n1. Row A\nGroup B\n2. Row B\n3. Row C',
    );
  });

  it('includes a row description when present', () => {
    const text = renderInteractiveListAsText({
      bodyText: 'Pick one',
      sections: [{ rows: [{ id: 'r1', title: 'Row A', description: 'extra info' }] }],
    });
    expect(text).toContain('1. Row A — extra info');
  });
});

describe('renderInteractiveAsText', () => {
  it('dispatches a buttons payload', () => {
    const payload: InteractiveMessagePayload = {
      kind: 'buttons',
      body: 'Confirm?',
      buttons: [{ id: 'y', title: 'Yes' }],
    };
    expect(renderInteractiveAsText(payload)).toBe('Confirm?\n\n1. Yes');
  });

  it('dispatches a list payload', () => {
    const payload: InteractiveMessagePayload = {
      kind: 'list',
      body: 'Pick one',
      button_label: 'Choose',
      sections: [{ rows: [{ id: 'r1', title: 'Row A' }] }],
    };
    expect(renderInteractiveAsText(payload)).toBe('Pick one\n\n1. Row A');
  });
});

// ------------------------------------------------------------
// resolveEmulatedInteractiveReply
// ------------------------------------------------------------

interface Script {
  row?: { content_type: string; interactive_payload: InteractiveMessagePayload | null } | null;
  error?: { message: string } | null;
}

function makeDb(script: Script) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () =>
      Promise.resolve({ data: script.row ?? null, error: script.error ?? null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const BUTTONS_PAYLOAD: InteractiveMessagePayload = {
  kind: 'buttons',
  body: 'Would you like to proceed?',
  buttons: [
    { id: 'opt-yes', title: 'Yes' },
    { id: 'opt-no', title: 'No' },
  ],
};

const LIST_PAYLOAD: InteractiveMessagePayload = {
  kind: 'list',
  body: 'Pick a plan',
  button_label: 'Choose',
  sections: [
    { rows: [{ id: 'row-basic', title: 'Basic' }, { id: 'row-pro', title: 'Pro' }] },
  ],
};

describe('resolveEmulatedInteractiveReply', () => {
  it('maps a typed number back to the button option id', async () => {
    const db = makeDb({ row: { content_type: 'interactive', interactive_payload: BUTTONS_PAYLOAD } });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '2')).resolves.toBe('opt-no');
  });

  it('maps an exact label match (case-insensitive) back to the option id', async () => {
    const db = makeDb({ row: { content_type: 'interactive', interactive_payload: BUTTONS_PAYLOAD } });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', 'yes')).resolves.toBe('opt-yes');
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '  YES  ')).resolves.toBe(
      'opt-yes',
    );
  });

  it('maps a typed number for a list payload, numbering across sections', async () => {
    const db = makeDb({ row: { content_type: 'interactive', interactive_payload: LIST_PAYLOAD } });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '2')).resolves.toBe('row-pro');
  });

  it('returns null when there is no match', async () => {
    const db = makeDb({ row: { content_type: 'interactive', interactive_payload: BUTTONS_PAYLOAD } });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', 'maybe')).resolves.toBeNull();
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '99')).resolves.toBeNull();
  });

  it('returns null when the most recent bot message was not interactive', async () => {
    const db = makeDb({ row: { content_type: 'text', interactive_payload: null } });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '1')).resolves.toBeNull();
  });

  it('returns null when there is no prior bot message', async () => {
    const db = makeDb({ row: null });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '1')).resolves.toBeNull();
  });

  it('returns null on a DB error', async () => {
    const db = makeDb({ row: null, error: { message: 'db down' } });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '1')).resolves.toBeNull();
  });

  it('returns null for blank inbound text', async () => {
    const db = makeDb({ row: { content_type: 'interactive', interactive_payload: BUTTONS_PAYLOAD } });
    await expect(resolveEmulatedInteractiveReply(db, 'conv-1', '   ')).resolves.toBeNull();
  });
});
