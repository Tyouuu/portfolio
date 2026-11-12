-- Phase 17: remaining fixes from the security audit
-- (docs/security-and-feature-gap-audit.md) that didn't warrant their own
-- migration.

-- 1) setNotificationsMasterEnabled (account/actions.ts) writes straight to
--    profiles, but profiles' only UPDATE policy is master-only (0001/0008) —
--    for accountant/cs the toggle flips in the UI and silently reverts on
--    reload, every time, because the RLS write is rejected and never
--    checked. Same failure class 0009 already fixed once for dealers.status.
--    A narrow self-scoped RPC, not a broader self-update policy on profiles
--    — opening `id = auth.uid()` on the whole table via RLS would also let a
--    user rewrite their own `role` column and self-promote to master.
create or replace function set_own_notifications_enabled(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set notifications_enabled = p_enabled where id = auth.uid();
end;
$$;

revoke execute on function set_own_notifications_enabled(boolean) from public, anon;
grant execute on function set_own_notifications_enabled(boolean) to authenticated, service_role;

-- 2) seed_dealer_rate_history (0009) correctly re-checked *who* is calling
--    but never *what* they're claiming — any cs/master session could seed a
--    fabricated rate at any time, not just onboarding, with no check against
--    the real flat-rate rule or whether this dealer already has history.
create or replace function seed_dealer_rate_history(p_dealer_id uuid, p_package text, p_rate numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_role_name(), '') not in ('cs', 'master') then
    raise exception 'not authorized';
  end if;
  if p_package not in ('A', 'B', 'C') then
    raise exception 'invalid package';
  end if;
  if p_rate is distinct from 6 then
    raise exception 'rate must match the current flat package rate';
  end if;
  if exists (select 1 from dealer_rate_history where dealer_id = p_dealer_id) then
    raise exception 'this dealer already has rate history — seed is for first-time onboarding only';
  end if;

  insert into dealer_rate_history (dealer_id, old_package, old_rate, new_package, new_rate, changed_by)
  values (p_dealer_id, null, null, p_package, p_rate, auth.uid());
end;
$$;

revoke execute on function seed_dealer_rate_history(uuid, text, numeric) from public, anon;
grant execute on function seed_dealer_rate_history(uuid, text, numeric) to authenticated, service_role;

-- 3) dealer_last_verified_activity (0007) is the one view in this schema
--    with security_invoker=off and no role check in its WHERE clause, unlike
--    its sibling delivery_queue (0003) — any authenticated Supabase user,
--    even one with no profiles row at all, could query it directly.
create or replace view dealer_last_verified_activity
with (security_invoker = off) as
select dealer_id, max(tx_date) as last_tx_date
from transactions
where status = 'verified'
  and current_role_name() in ('cs', 'accountant', 'master')
group by dealer_id;

-- 4) The correcting-entry feature (0013) assumes a verified transaction's
--    money_rm/points/rate are never edited in place — true through the app's
--    own UI, but transactions_update_accountant (0001) has no column
--    restriction, so a direct API call could still do exactly what the
--    feature exists to prevent, with no audit trail (unlike
--    dealer_rate_history/company_statement_revisions, which both capture
--    before/after). This closes it at the DB layer regardless of caller.
create or replace function block_verified_transaction_edits()
returns trigger
language plpgsql
as $$
begin
  if OLD.status = 'verified' and (
    NEW.money_rm is distinct from OLD.money_rm or
    NEW.points is distinct from OLD.points or
    NEW.rate is distinct from OLD.rate
  ) then
    raise exception 'cannot directly edit a verified transaction''s amount — post a linked adjustment instead';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_block_verified_transaction_edits on transactions;
create trigger trg_block_verified_transaction_edits
  before update on transactions
  for each row execute function block_verified_transaction_edits();
