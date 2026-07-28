-- 광고 회의록: 논의 주제 (상품팀/광고팀)
create table if not exists ad_meeting_topics (
  id uuid primary key default gen_random_uuid(),
  team text not null check (team in ('product', 'ad')),   -- 상품팀 | 광고팀
  content text not null,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),  -- 논의 전 | 진행중 | 논의완료
  created_at timestamptz default now(),
  done_at timestamptz
);

-- 팀 내부 도구: anon 키로 읽기/쓰기 허용 (아카이브 테이블과 동일 정책)
alter table ad_meeting_topics enable row level security;
create policy "anon all ad_meeting_topics" on ad_meeting_topics for all using (true) with check (true);
