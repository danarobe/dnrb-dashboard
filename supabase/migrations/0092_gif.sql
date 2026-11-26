-- GIF 메이커(워크스페이스 내장, 2026-11-26 사용자 요청)
--   기존 GIF 메이커(카카오 로그인·별도 Supabase)와 연동하지 않는 별개 프로그램. 계정 = 워크스페이스 계정(app_users).
--   · gif_projects        : 프로젝트(글자·배치 설정은 data, 사진 파일은 Storage 'gif-projects' 버킷 ws/{프로젝트 id}/{파일})
--   · gif_perms           : 프로젝트 권한 — 관리자가 계정별로 'read'(읽기) / 'write'(쓰기)를 준다. 줄이 없으면 권한 없음. 관리자는 항상 쓰기.
--   · gif_templates       : 카드뉴스 템플릿(내가 만든 스타일) — GIF 메이커를 쓰는 사람 모두 보고, 고치기·지우기는 만든 사람과 관리자
--   · gif_template_names  : 기본 카드뉴스 템플릿의 바꾼 이름(관리자만 바꿈)
--   전부 RLS 켬·정책 없음 — 접근은 Edge Function 'gif'(service_role)로만.

create table if not exists gif_projects (
  id               text primary key check (id ~ '^[a-z0-9]{6,40}$'),
  name             text not null default '',
  data             jsonb not null default '{}'::jsonb,
  rev              integer not null default 1,          -- 저장할 때마다 +1 (동시 수정 감지)
  created_by       text,                                -- app_users.id (복제해 온 프로젝트는 null)
  created_by_name  text not null default '',
  updated_by       text,
  updated_by_name  text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists gif_projects_updated_idx on gif_projects (updated_at desc);

create table if not exists gif_perms (
  user_id   text primary key references app_users(id) on delete cascade,
  level     text not null check (level in ('read', 'write')),
  by_name   text not null default '',
  at        timestamptz not null default now()
);

create table if not exists gif_templates (
  id          text primary key check (id ~ '^[a-z0-9]{6,40}$'),
  owner_id    text not null,
  owner_name  text not null default '',
  name        text not null check (char_length(name) between 1 and 40),
  data        jsonb not null default '{}'::jsonb check (pg_column_size(data) < 60000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists gif_templates_created_idx on gif_templates (created_at);

create table if not exists gif_template_names (
  id          text primary key check (id ~ '^b:[a-z0-9_]{1,30}$'),
  name        text not null check (char_length(name) between 1 and 40),
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table gif_projects enable row level security;
alter table gif_perms enable row level security;
alter table gif_templates enable row level security;
alter table gif_template_names enable row level security;
revoke all on gif_projects, gif_perms, gif_templates, gif_template_names from anon, authenticated;

-- 사진 보관함(비공개). 올리기·받기는 서버가 만들어 주는 1회용·1시간짜리 주소로만.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gif-projects', 'gif-projects', false, 41943040, array['image/jpeg', 'image/gif'])
on conflict (id) do nothing;
