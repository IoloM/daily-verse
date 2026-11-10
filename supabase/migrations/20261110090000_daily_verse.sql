-- Daily Verse: tables, security rules and helper functions.
--
-- Visitors (no account) can READ days whose date has arrived (UK time) and their comments,
-- and ADD comments only through add_comment(). Only the admin can write days, change settings,
-- upload videos or delete other people's comments.
-- The first account ever created becomes the admin; after that, new accounts are refused.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- helpers

create or replace function public.uk_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Europe/London')::date $$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- admins

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
create policy "admins can see themselves" on public.admins
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from public.admins where user_id = (select auth.uid())) $$;

-- lets the admin page know whether to offer "create the admin account" (only before it exists)
create or replace function public.has_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from public.admins) $$;

create or replace function public.guard_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.admins) then
    raise exception 'Sign-ups are closed.';
  end if;
  return new;
end $$;

create or replace function public.claim_first_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.admins) then
    insert into public.admins (user_id) values (new.id);
  end if;
  return new;
end $$;

create trigger daily_verse_guard_signup
  before insert on auth.users
  for each row execute function public.guard_signup();

create trigger daily_verse_claim_admin
  after insert on auth.users
  for each row execute function public.claim_first_admin();

-- ---------------------------------------------------------------- settings (one row)

create table public.settings (
  id smallint primary key default 1 check (id = 1),
  site_title text not null default 'Daily Verse' check (char_length(btrim(site_title)) between 1 and 60),
  tagline text not null default 'A Bible passage, a short reflection and a prayer for each day.'
    check (char_length(tagline) <= 200),
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);
alter table public.settings enable row level security;
create policy "anyone can read settings" on public.settings
  for select to anon, authenticated using (true);
create policy "admin can change settings" on public.settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- posts (one per day)

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  post_date date not null unique,
  title text check (char_length(title) <= 120),
  reference text not null check (char_length(btrim(reference)) between 1 and 120),
  translation text check (char_length(translation) <= 40),
  verse_text text not null check (char_length(btrim(verse_text)) between 1 and 8000),
  reflection text check (char_length(reflection) <= 12000),
  prayer text check (char_length(prayer) <= 6000),
  video_url text check (char_length(video_url) <= 800),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.posts enable row level security;

-- scheduled days stay hidden until their date arrives (midnight UK time); the admin sees everything
create policy "anyone can read days that have arrived" on public.posts
  for select to anon, authenticated
  using (post_date <= public.uk_today() or (select public.is_admin()));
create policy "admin can add days" on public.posts
  for insert to authenticated with check ((select public.is_admin()));
create policy "admin can edit days" on public.posts
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin can delete days" on public.posts
  for delete to authenticated using ((select public.is_admin()));
create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- comments

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  body text not null check (char_length(body) between 1 and 1500),
  by_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create index comments_post_created on public.comments (post_id, created_at);
create index comments_created on public.comments (created_at desc);
alter table public.comments enable row level security;

create policy "anyone can read comments on days that have arrived" on public.comments
  for select to anon, authenticated
  using (
    (select public.is_admin())
    or exists (select 1 from public.posts p where p.id = post_id and p.post_date <= public.uk_today())
  );
create policy "admin can delete comments" on public.comments
  for delete to authenticated using ((select public.is_admin()));
-- nobody inserts directly: comments go through add_comment() below

-- private: the secret that lets a commenter delete their own comment, and a one-way hash of
-- their network address so one person can't flood the discussion
create table public.comment_keys (
  comment_id uuid primary key references public.comments (id) on delete cascade,
  key_hash text not null,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index comment_keys_ip_created on public.comment_keys (ip_hash, created_at);
alter table public.comment_keys enable row level security;
-- no policies on purpose: only the functions below can touch it

create or replace function public.request_ip_hash()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  h json;
  ip text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if h is null then
    return null;
  end if;
  ip := btrim(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-real-ip', split_part(h ->> 'x-forwarded-for', ',', 1), ''));
  if ip = '' then
    return null;
  end if;
  return encode(extensions.digest(ip || ':daily-verse', 'sha256'), 'hex');
end $$;

create or replace function public.add_comment(p_post_id uuid, p_name text, p_body text)
returns table (id uuid, delete_key text, created_at timestamptz, by_admin boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_body text := btrim(regexp_replace(coalesce(p_body, ''), '\n{3,}', E'\n\n', 'g'));
  v_key text := encode(extensions.gen_random_bytes(18), 'hex');
  v_ip text := public.request_ip_hash();
  v_admin boolean := public.is_admin();
  v_id uuid;
  v_at timestamptz;
begin
  if char_length(v_name) = 0 then
    raise exception 'Please add your name.';
  end if;
  if char_length(v_name) > 40 then
    raise exception 'Names can be up to 40 characters.';
  end if;
  if char_length(v_body) = 0 then
    raise exception 'Please write something first.';
  end if;
  if char_length(v_body) > 1500 then
    raise exception 'Comments can be up to 1500 characters.';
  end if;
  if not exists (select 1 from public.posts p where p.id = p_post_id and p.post_date <= public.uk_today()) then
    raise exception 'This day isn''t open for comments yet.';
  end if;
  if not v_admin then
    if v_ip is not null and (
      select count(*) from public.comment_keys k
      where k.ip_hash = v_ip and k.created_at > now() - interval '1 minute'
    ) >= 5 then
      raise exception 'You''re posting very quickly. Please wait a minute and try again.';
    end if;
    if (select count(*) from public.comments c where c.created_at > now() - interval '1 minute') >= 60 then
      raise exception 'Lots of people are posting right now. Please try again in a minute.';
    end if;
  end if;

  insert into public.comments as c (post_id, name, body, by_admin)
  values (p_post_id, v_name, v_body, v_admin)
  returning c.id, c.created_at into v_id, v_at;

  insert into public.comment_keys (comment_id, key_hash, ip_hash)
  values (v_id, encode(extensions.digest(v_key, 'sha256'), 'hex'), v_ip);

  return query select v_id, v_key, v_at, v_admin;
end $$;

create or replace function public.delete_own_comment(p_comment_id uuid, p_key text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n int;
begin
  delete from public.comments c
  using public.comment_keys k
  where c.id = p_comment_id
    and k.comment_id = c.id
    and k.key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ---------------------------------------------------------------- who may call / touch what

revoke all on public.admins, public.settings, public.posts, public.comments, public.comment_keys from anon, authenticated;
grant select on public.settings, public.posts, public.comments to anon, authenticated;
grant select on public.admins to authenticated;
grant update (site_title, tagline) on public.settings to authenticated;
grant insert, update, delete on public.posts to authenticated;
grant delete on public.comments to authenticated;

revoke execute on function public.guard_signup() from public, anon, authenticated;
revoke execute on function public.claim_first_admin() from public, anon, authenticated;
revoke execute on function public.request_ip_hash() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.add_comment(uuid, text, text) from public;
revoke execute on function public.delete_own_comment(uuid, text) from public;
grant execute on function public.uk_today() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.has_admin() to anon, authenticated;
grant execute on function public.add_comment(uuid, text, text) to anon, authenticated;
grant execute on function public.delete_own_comment(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------- live updates for the discussion

alter publication supabase_realtime add table public.comments;

-- ---------------------------------------------------------------- video uploads (admin only, 50 MB max)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', true, 52428800, array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
on conflict (id) do nothing;

create policy "admin can see uploaded videos" on storage.objects
  for select to authenticated using (bucket_id = 'videos' and (select public.is_admin()));
create policy "admin can upload videos" on storage.objects
  for insert to authenticated with check (bucket_id = 'videos' and (select public.is_admin()));
create policy "admin can replace videos" on storage.objects
  for update to authenticated using (bucket_id = 'videos' and (select public.is_admin()));
create policy "admin can delete videos" on storage.objects
  for delete to authenticated using (bucket_id = 'videos' and (select public.is_admin()));
