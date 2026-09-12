create table if not exists public.trip_footprints (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  location text not null default '',
  coordinate text,
  visit_date text not null default '',
  notes text,
  rating numeric,
  image_url text,
  image_urls jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists trip_footprints_user_updated_idx
  on public.trip_footprints (user_id, updated_at desc);

alter table public.trip_footprints enable row level security;

grant select, insert, update, delete on table public.trip_footprints to authenticated;

drop policy if exists "trip footprints are user owned" on public.trip_footprints;
create policy "trip footprints are user owned"
  on public.trip_footprints
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'trip-footprint-images',
  'trip-footprint-images',
  true,
  52428800,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "trip footprint images are public readable" on storage.objects;
create policy "trip footprint images are public readable"
  on storage.objects
  for select
  using (bucket_id = 'trip-footprint-images');

drop policy if exists "trip footprint images are user owned" on storage.objects;
create policy "trip footprint images are user owned"
  on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'trip-footprint-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'trip-footprint-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
