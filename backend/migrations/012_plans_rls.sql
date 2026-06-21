-- plans 是套餐目录,仅由后端(service-role,绕过 RLS)读取;客户端只经 FastAPI 网关访问,
-- 从不直连 Supabase Data API。开启 RLS 且不加策略 = 锁死到 service-role(与 users /
-- user_subscriptions / usage_events 等同样的姿态),消除 rls_disabled_in_public 报错。
alter table public.plans enable row level security;
