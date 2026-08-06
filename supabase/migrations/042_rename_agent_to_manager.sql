-- ============================================================
-- 042_rename_agent_to_manager
--
-- Renames the `agent` role to `manager` (client's requested naming:
-- Owner / Admin / Manager). Same cardinality, same rank order
-- (owner=4 > admin=3 > manager=2 > viewer=1) — a label swap, not a
-- hierarchy change.
--
-- `viewer` is intentionally left in place (Postgres can't cheaply
-- drop an enum value — `ALTER TYPE ... DROP VALUE` doesn't exist and
-- would require a full type rebuild). The client didn't ask for a
-- read-only role, but nothing asked to remove it either; it's hidden
-- from the invite-role picker UI instead (see
-- src/components/settings/invite-member-dialog.tsx), leaving room
-- for a future "read-only auditor" role with zero migration risk.
--
-- `ALTER TYPE ... RENAME VALUE` is in-place — no table rewrite, no
-- downtime, and every row currently storing 'agent' becomes 'manager'
-- automatically since it's the same underlying enum value.
--
-- RLS policies that pass 'agent' as a literal argument to
-- `is_account_member(account_id, 'agent')` (throughout migrations
-- 017/035/038) do NOT need editing: CREATE POLICY stores its qual as
-- a pre-analyzed expression tree, so the literal is already resolved
-- to the enum's OID at policy-creation time — renaming the label
-- later doesn't touch that OID, so those calls keep working exactly
-- as before, now passing "the value now labeled manager".
--
-- `is_account_member` ITSELF is different and DOES need a rewrite:
-- it's a `LANGUAGE sql` function, and its body's CASE-WHEN literals
-- ('owner'/'admin'/'agent'/'viewer') are re-resolved against the
-- CURRENT catalog on (re)plan — confirmed by testing this migration
-- against a local Supabase instance: without this redefinition,
-- every call to is_account_member throws "invalid input value for
-- enum account_role_enum: agent" post-rename, which breaks RLS
-- app-wide (is_account_member backs nearly every policy in the app).
-- Redefined here with 'manager' so it matches the renamed enum.
--
-- Idempotent — guarded so re-running after the rename already
-- happened is a no-op instead of an error; CREATE OR REPLACE FUNCTION
-- is naturally idempotent.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'account_role_enum' AND e.enumlabel = 'agent'
  ) THEN
    ALTER TYPE account_role_enum RENAME VALUE 'agent' TO 'manager';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'   THEN 4
            WHEN 'admin'   THEN 3
            WHEN 'manager' THEN 2
            WHEN 'viewer'  THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'   THEN 4
            WHEN 'admin'   THEN 3
            WHEN 'manager' THEN 2
            WHEN 'viewer'  THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;
