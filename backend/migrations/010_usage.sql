-- 每次 LLM 调用的用量事件。credits 已按模型单价换算。
create table if not exists public.usage_events (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references public.users(id) on delete cascade,
    kind          text not null,        -- 'chat' | 'json' | 'embeddings' | 'stt'
    model         text not null,        -- 逻辑模型 id
    input_tokens  bigint not null default 0,
    output_tokens bigint not null default 0,
    audio_seconds double precision not null default 0,
    credits       bigint not null default 0,
    created_at    timestamptz not null default now()
);

create index if not exists usage_events_user_time_idx
    on public.usage_events (user_id, created_at);

alter table public.usage_events enable row level security;
alter table public.user_subscriptions enable row level security;
