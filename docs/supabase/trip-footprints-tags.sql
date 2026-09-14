-- 足迹标签（2026-09-14）
--
-- 标签存在记录自己身上，不再多开一张表：一条足迹的标签是一小组短文本，
-- 查询/筛选都在客户端做（本地记录本来就要全量读出来排序），
-- 因此 text[] 就够了，配套 GIN 索引留给以后需要服务端按标签查询时再说。
--
-- 幂等：可重复执行。

alter table public.trip_footprints
  add column if not exists tags text[] not null default '{}';
