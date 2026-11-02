-- 매일 작업 자동화(~/daily-ops) — 워크스페이스 '중국 사입 / 제작 주문 점검'의 [자동화 실행] 버튼(2026-11-02 사용자 요청)
--   버튼 = automation_runs에 requested 행 추가 → 대표 맥의 대기 프로그램(daily-ops worker)이 10초마다 보고 실행 → 같은 행에 진행 단계·결과를 적는다.
--   automation_workers = 맥 대기 프로그램의 생존 신호(30초마다 last_seen) — 2분 넘게 없으면 화면이 '맥이 꺼져 있어요'로 버튼을 막는다.
create table if not exists public.automation_runs (
  id bigserial primary key,
  kind text not null default 'daily',
  status text not null default 'requested',   -- requested | running | done | failed
  requested_by text, requested_by_name text, requested_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz,
  step text,                                   -- 지금 하는 단계 (화면 표시용)
  steps jsonb not null default '[]'::jsonb,    -- 끝난 단계 목록 [{name, at, note}]
  result text, error text
);
create index if not exists automation_runs_status_idx on public.automation_runs (status, id);
alter table public.automation_runs enable row level security;

create table if not exists public.automation_workers (
  name text primary key,
  host text, last_seen timestamptz not null default now(), note text
);
alter table public.automation_workers enable row level security;
