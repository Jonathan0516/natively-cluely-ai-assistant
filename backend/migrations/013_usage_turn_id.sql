-- 把每次 LLM 调用关联到具体"一轮问答"(turn),用于按问答展示 token / 额度消耗。
-- 一条回答常含多次调用(意图判定 + 生成),它们共享同一个 turn_id。普通 uuid 列、不加外键
-- (与 meeting_id 同理,会中即写入)。可空:非问答触发的调用(如会后总结)turn_id 为空。
alter table public.usage_events
    add column if not exists turn_id uuid;

create index if not exists usage_events_meeting_turn_idx
    on public.usage_events (meeting_id, turn_id);
