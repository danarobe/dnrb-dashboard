-- 광고 회의록: 회의 일자별 기록 (계정별 작성, 공유 시 전원 공개)
create table if not exists ad_meeting_notes (
  id uuid primary key default gen_random_uuid(),
  meeting_date date not null,
  author_id text not null,       -- 작성자 로그인 아이디
  author_name text not null,     -- 작성자 이름 (표시용)
  content text not null,
  shared boolean not null default false,  -- false = 작성자만 표시, true = 전원 표시
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table ad_meeting_notes enable row level security;
create policy "anon all ad_meeting_notes" on ad_meeting_notes for all using (true) with check (true);
