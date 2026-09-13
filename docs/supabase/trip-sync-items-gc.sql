-- 阶段 5.2：同步项与对象的清理策略
--
-- 原则：**默认只体检、不删除**。删除语句都放在注释里，确认清单后再手工执行。
-- 原因：迁移期仍存在「旧路径」引用（trip_footprints.image_url(s) 指向 <user>/<footprint>/<n>-<hash>.<ext>），
--       自动 GC 有误删用户图片的风险。

-- ---------------------------------------------------------------------------
-- 1) 墓碑清理（相对安全）
--    超过 30 天仍未引用的墓碑项可以物理删除。
-- ---------------------------------------------------------------------------
-- 体检：
select count(*) as stale_tombstones
from public.trip_sync_items
where deleted_at is not null
  and deleted_at < now() - interval '30 days';

-- 删除（确认体检结果后再执行）：
-- delete from public.trip_sync_items
-- where deleted_at is not null
--   and deleted_at < now() - interval '30 days';

-- ---------------------------------------------------------------------------
-- 2) 孤儿对象体检（storage.objects 没有任何引用）
--    被引用 = trip_sync_items.body 里出现该对象名，或 trip_footprints 的图片 URL 指向它。
-- ---------------------------------------------------------------------------
select
  o.name,
  (o.metadata->>'size') as size_bytes,
  o.created_at
from storage.objects o
where o.bucket_id = 'trip-footprint-images'
  and not exists (
    select 1 from public.trip_sync_items i
    where i.deleted_at is null and i.body like '%' || o.name || '%'
  )
  and not exists (
    select 1 from public.trip_footprints f
    where f.image_url like '%' || o.name || '%'
       or f.image_urls::text like '%' || o.name || '%'
  )
order by o.created_at desc;

-- 删除孤儿对象（先人工核对上面清单）：
-- 物理文件位于 /opt/notes-supabase/volumes/storage/stub/stub/trip-footprint-images/<name>/<uuid>，
-- 同时要删除 storage.objects 对应的行；建议按 name 逐个处理，不要按目录整删。

-- ---------------------------------------------------------------------------
-- 3) 0 字节对象体检（历史上传 bug 的残留）
--    这些对象在 App 侧会由「老数据修复」逻辑重传；重传成功后会自动消失。
-- ---------------------------------------------------------------------------
select name, created_at
from storage.objects
where bucket_id = 'trip-footprint-images'
  and (metadata->>'size')::bigint = 0
order by created_at desc;

-- ---------------------------------------------------------------------------
-- 4) 元数据与对象一致性体检
-- ---------------------------------------------------------------------------
select i.path, i.body::jsonb->>'remoteKey' as remote_key, (o.metadata->>'size') as object_size
from public.trip_sync_items i
left join storage.objects o
  on o.bucket_id = 'trip-footprint-images'
 and o.name = i.body::jsonb->>'remoteKey'
where i.deleted_at is null
  and (o.name is null or (o.metadata->>'size')::bigint = 0);
