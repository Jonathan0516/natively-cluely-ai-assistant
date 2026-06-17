-- 套餐与用户订阅。InMemory 回退在 usage_repo 内置默认套餐，本表仅用于 Supabase 生产。
create table if not exists public.plans (
    id                 text primary key,           -- 'free' | 'pro' | ...
    label              text not null,
    credits_per_period bigint not null,            -- 周期内 credits 上限
    period             text not null default 'month',  -- 'month' | 'week'
    allowed_tiers      text[] not null default '{free}', -- 可解锁的模型 tier
    created_at         timestamptz not null default now()
);

create table if not exists public.user_subscriptions (
    user_id      uuid primary key references public.users(id) on delete cascade,
    plan_id      text not null references public.plans(id),
    period_start timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

insert into public.plans (id, label, credits_per_period, period, allowed_tiers)
values ('free', 'Free', 1000, 'month', '{free}')
on conflict (id) do nothing;
insert into public.plans (id, label, credits_per_period, period, allowed_tiers)
values ('pro', 'Pro', 100000, 'month', '{free,pro}')
on conflict (id) do nothing;
