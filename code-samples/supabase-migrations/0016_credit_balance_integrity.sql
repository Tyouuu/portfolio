-- Phase 16: close a real race condition found in the security audit
-- (docs/security-and-feature-gap-audit.md) — the credit-balance hard-block
-- (src/lib/credit-balance.ts) reads "available" and later inserts a new
-- transaction as two separate round trips, with nothing at the database
-- level tying them together. Two concurrent large transactions can both read
-- the same balance, both pass the check, and together oversell past what
-- was actually paid for. Fixed here at the DB layer so it holds even for a
-- direct API call, not just the two Server Actions that currently do the
-- app-layer check (entry/actions.ts, records/actions.ts) — matching this
-- codebase's established defense-in-depth pattern.

-- 1) get_credit_balance(): a real server-side aggregate, replacing the
--    pull-every-row-and-sum-in-JS approach, which had no .limit() and would
--    silently undercount totalCommitted (making available look *bigger* than
--    reality — the unsafe direction) once transactions crosses PostgREST's
--    per-request row cap. One aggregate query, immune to that regardless of
--    table size. Used by both the trigger below and getAvailablePointsBalance.
create or replace function get_credit_balance()
returns table(total_purchased numeric, total_committed numeric, available numeric)
language sql
stable
as $$
  select
    coalesce((select sum(points) from credit_purchases), 0) as total_purchased,
    coalesce((select sum(points) from transactions where status != 'flagged'), 0) as total_committed,
    coalesce((select sum(points) from credit_purchases), 0)
      - coalesce((select sum(points) from transactions where status != 'flagged'), 0) as available;
$$;

grant execute on function get_credit_balance() to authenticated;

-- 2) The actual race fix: an advisory lock forces concurrent inserts to
--    serialize before each one computes its own balance snapshot, so the
--    second caller sees the first caller's already-committed row. Session-
--    scoped pg_advisory_lock would be unsafe under Supabase's pooled
--    connections (Supavisor, transaction mode) — pg_advisory_xact_lock is
--    transaction-scoped and releases automatically at commit/rollback,
--    which is safe regardless of pooling mode.
create or replace function enforce_credit_balance()
returns trigger
language plpgsql
as $$
declare
  v_available numeric;
begin
  if NEW.status = 'flagged' or NEW.points <= 0 then
    return NEW;
  end if;

  perform pg_advisory_xact_lock(hashtext('vibe_dealer_credit_balance'));

  select available into v_available from get_credit_balance();

  if NEW.points > v_available then
    raise exception 'insufficient_credit_balance: % pts available, % pts requested', v_available, NEW.points;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_credit_balance on transactions;
create trigger trg_enforce_credit_balance
  before insert on transactions
  for each row execute function enforce_credit_balance();

-- 3) A narrower, related race: two concurrent corrections to the *same*
--    verified transaction (adjustTransaction, 0013) both read the same
--    pre-correction baseline and both apply independently instead of the
--    second accounting for the first. Only one pending adjustment per
--    original transaction can exist at a time — the second racing
--    correction now fails on a unique violation instead of double-applying.
--    Once the first is verified or flagged, a new one can be posted.
create unique index if not exists idx_one_pending_adjustment_per_original
  on transactions (adjusts_id)
  where type = 'adjustment' and status = 'pending';
