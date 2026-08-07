// ============================================================
// GET /api/whatsapp/connection
//
// The single aggregate endpoint every "is WhatsApp connected" UI
// surface reads (settings tiles for both Official and Unofficial,
// the inbox banner, etc — see Phase 7 of the plan,
// /home/jubayer-pro/.claude/plans/smooth-swinging-llama.md). Backed
// by `getConnectionSummary` (`src/lib/whatsapp/providers/resolve.ts`),
// which is deliberately cheap (no live provider API calls) so this is
// safe to poll from the client.
//
// Auth-only, no role gate — any signed-in account member can see
// whether WhatsApp is connected (mirrors `/api/whatsapp/config`'s
// GET, which has the same shape: 200 with `connected: false` rather
// than a 4xx for "not configured").
// ============================================================

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getConnectionSummary } from '@/lib/whatsapp/providers/resolve';

export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const accountId = profile?.account_id as string | undefined;
  if (profileError || !accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    );
  }

  const summary = await getConnectionSummary(supabase, accountId);
  return NextResponse.json(summary);
}
