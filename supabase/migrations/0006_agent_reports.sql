-- 매출 분석 에이전트 리포트 (2026-09-10)
-- sales-agent 함수가 매일 아침(08:00 KST) 또는 수동 실행으로 생성. anon 정책 없음 → db 프록시(admin) 경유.
create table if not exists agent_reports (
  id uuid primary key default gen_random_uuid(),
  agent text not null default 'sales',        -- 담당 에이전트 종류 (앞으로 'returns'/'content' 등 확장)
  report_date date not null,                  -- 기준일 (= 실행일 전날, KST)
  trigger text not null default 'manual',     -- 'cron' | 'manual'
  status text not null default 'ok',          -- 'ok' | 'error'
  data jsonb,                                 -- 수집한 원자료 (매출·상품·광고 숫자)
  report jsonb,                               -- Claude가 쓴 리포트 (headline/summary/actions ...)
  model text,
  usage jsonb,
  error text,
  created_by text,                            -- 수동 실행자 id (cron이면 null)
  created_at timestamptz not null default now()
);
create index if not exists agent_reports_agent_date_idx on agent_reports (agent, report_date desc, created_at desc);
alter table agent_reports enable row level security;
