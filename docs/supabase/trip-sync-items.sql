-- Joplin 风格同步项表（阶段 3）。
-- path 规则：'<user_id>/<32位hex>.md'（记录/资产元数据）、'<user_id>/resources/<32位hex>'（x 资源标记）
-- 带用户前缀的原因：
--   1) RLS 可以直接用 split_part(path,'/',1) 判定归属，无需额外列；
--   2) Joplin 的 isSystemPath()/pathToId() 只看最后一段，因此前缀不影响复用逻辑（最后一段仍是 '<32位hex>.md'）。

create table if not exists public.trip_sync_items (
  path             text primary key,
  item_id          text not null,
  type_            int  not null,      -- 1=记录 2=资产元数据 9=资源
  body             text,
  jop_updated_time bigint not null,
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create index if not exists trip_sync_items_updated_idx
  on public.trip_sync_items (updated_at);

-- updated_at 必须由服务端写入：basicDelta 完全依赖它做增量与"同毫秒边界"判断。
create or replace function public.trip_sync_items_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trip_sync_items_touch on public.trip_sync_items;
create trigger trip_sync_items_touch
  before insert or update on public.trip_sync_items
  for each row execute function public.trip_sync_items_touch();

alter table public.trip_sync_items enable row level security;

grant select, insert, update, delete on table public.trip_sync_items to authenticated;

drop policy if exists "trip sync items are user owned" on public.trip_sync_items;
create policy "trip sync items are user owned"
  on public.trip_sync_items
  for all
  to authenticated
  using (auth.uid()::text = split_part(path, '/', 1))
  with check (auth.uid()::text = split_part(path, '/', 1));
