-- 彻底退役 trip_footprints 里的图片字段（image_url / image_urls）
--
-- 分两步，务必按顺序执行：
--   第 1 步「回填」：把旧字段指向的 Storage 对象登记成 trip_sync_items 里的资产元数据项，
--                    这样新客户端（以及重装/换设备）仍能通过资产通道发现并下载这些老图片。
--   第 2 步「删列」：移除 trip_footprints.image_url / image_urls。
--
-- 注意：删列后，仍是旧版本的客户端会同步失败（它还会读写这两列）——必须先让设备升到新版本。

-- ---------------------------------------------------------------------------
-- 第 1 步：回填资产元数据项（幂等，可重复执行）
--   object_key = '<user>/<footprint>/<n>-<hash>.<ext>'（旧命名）
--   资产 id 用 md5(object_key) 的前 32 位，满足客户端 isSystemPath() 的 32 位 hex 规则
-- ---------------------------------------------------------------------------
with legacy as (
  select
    f.id as footprint_id,
    f.user_id,
    f.updated_at,
    u.uri::text as uri,
    (u.ordinality - 1)::int as position
  from public.trip_footprints f
  cross join lateral unnest(
    case
      when f.image_urls is not null and jsonb_typeof(f.image_urls) = 'array'
        then array(select jsonb_array_elements_text(f.image_urls))
      when f.image_url is not null
        then array[f.image_url]
      else array[]::text[]
    end
  ) with ordinality as u(uri, ordinality)
  where f.deleted_at is null
),
parsed as (
  select
    l.footprint_id,
    l.user_id,
    l.updated_at,
    l.position,
    split_part(l.uri, '/storage/v1/object/public/trip-footprint-images/', 2) as object_key
  from legacy l
  where l.uri like '%/storage/v1/object/public/trip-footprint-images/%'
),
with_id as (
  select
    p.*,
    substr(md5(p.object_key), 1, 32) as asset_id,
    regexp_replace(p.object_key, '^.*\.', '') as ext
  from parsed p
  where p.object_key <> ''
)
insert into public.trip_sync_items (path, item_id, type_, body, jop_updated_time)
select
  w.user_id::text || '/' || w.asset_id || '.md',
  w.asset_id,
  2,
  jsonb_build_object(
    'id', w.asset_id,
    'footprintId', w.footprint_id,
    'position', w.position,
    'fileName', w.asset_id || '.' || w.ext,
    'size', coalesce((o.metadata->>'size')::bigint, 0),
    'mime', coalesce(o.metadata->>'mimetype', 'image/jpeg'),
    'blobUpdatedTime', (extract(epoch from w.updated_at) * 1000)::bigint,
    'remoteKey', w.object_key
  )::text,
  (extract(epoch from w.updated_at) * 1000)::bigint
from with_id w
left join storage.objects o
  on o.bucket_id = 'trip-footprint-images' and o.name = w.object_key
on conflict (path) do nothing;

-- 回填结果核对
select
  count(*) as backfilled_items,
  count(*) filter (where (body::jsonb->>'size')::bigint = 0) as referenced_zero_byte_objects
from public.trip_sync_items
where type_ = 2;

-- ---------------------------------------------------------------------------
-- @@STEP2_BELOW@@（脚本按此标记切分「回填」与「删列」两段，请勿删除）
-- ---------------------------------------------------------------------------
-- 第 2 步：删列（确认上一步结果、且设备已升级后再执行）
-- ---------------------------------------------------------------------------
alter table public.trip_footprints drop column if exists image_url;
alter table public.trip_footprints drop column if exists image_urls;
