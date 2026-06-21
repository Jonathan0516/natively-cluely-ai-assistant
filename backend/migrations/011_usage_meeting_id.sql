-- 把每次 LLM 调用关联到具体会议,用于"用量详情"(按会议 / 按模型聚合)。
-- 普通 uuid 列,不加外键:会中的 LLM 调用先于会议落库(meetings 行在会议结束时才写入),
-- 外键会导致会中写入失败。可空:并非所有调用都来自会议(例如临时问答)。会议被丢弃 /
-- 未保存时,事件仍保留(计费真值),只是无法关联到会议标题。
alter table public.usage_events
    add column if not exists meeting_id uuid;

create index if not exists usage_events_user_meeting_idx
    on public.usage_events (user_id, meeting_id);
