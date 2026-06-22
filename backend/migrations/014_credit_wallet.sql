-- backend/migrations/014_credit_wallet.sql
-- 持久化"充值钱包"：购买的 credits 进 credit_wallets.balance，跨周期不清零，用完才没。
-- credit_ledger 记流水，stripe_event_id 唯一约束做 webhook 幂等。仅后端 service-role 访问。

create table if not exists public.credit_wallets (
    user_id    uuid primary key references public.users(id) on delete cascade,
    balance    bigint not null default 0,
    updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references public.users(id) on delete cascade,
    delta           bigint not null,                 -- + 充值, - 消耗
    reason          text not null,                   -- 'topup' | 'usage'
    stripe_event_id text unique,                     -- 幂等键（usage 行为 null）
    created_at      timestamptz not null default now()
);

create index if not exists credit_ledger_user_time_idx
    on public.credit_ledger (user_id, created_at);

alter table public.credit_wallets enable row level security;  -- service-role only, no policies
alter table public.credit_ledger  enable row level security;

-- 幂等充值：同一 event 只入账一次。返回 true=已入账，false=重复事件跳过。
create or replace function public.grant_credits(p_user uuid, p_credits bigint, p_event text)
returns boolean
language plpgsql
as $$
declare
    v_rows integer;
begin
    insert into public.credit_ledger (user_id, delta, reason, stripe_event_id)
    values (p_user, p_credits, 'topup', p_event)
    on conflict (stripe_event_id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
        return false;  -- 重复 event
    end if;
    insert into public.credit_wallets (user_id, balance)
    values (p_user, p_credits)
    on conflict (user_id)
    do update set balance = public.credit_wallets.balance + excluded.balance,
                  updated_at = now();
    return true;
end;
$$;

-- 消耗：从钱包扣减，clamp 到 0，永不为负。
create or replace function public.consume_credits(p_user uuid, p_amount bigint)
returns void
language plpgsql
as $$
begin
    update public.credit_wallets
       set balance = greatest(0, balance - p_amount), updated_at = now()
     where user_id = p_user;
    insert into public.credit_ledger (user_id, delta, reason)
    values (p_user, -p_amount, 'usage');
end;
$$;

-- 取消免费额度：免费/Pro 不再赠送周期 credits，钱包成为唯一来源。
update public.plans set credits_per_period = 0 where id in ('free', 'pro');
