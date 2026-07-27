-- ═══════════════════════════════════════════════
-- DNRB 쇼핑몰 성과 분석 대시보드 — 초기 스키마
-- ═══════════════════════════════════════════════

-- ── API 토큰 저장소 (Edge Function 전용 / 클라이언트 접근 불가) ──
create table if not exists api_tokens (
  provider    text primary key,          -- 'cafe24' | 'naver'
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,             -- access_token 만료 시각
  refresh_expires_at timestamptz,        -- refresh_token 만료 시각 (cafe24: 2주)
  updated_at    timestamptz default now()
);
alter table api_tokens enable row level security;
-- 정책 없음 = anon/authenticated 접근 차단. service_role만 접근 가능.

-- ── 취소·반품 분석 아카이브 (기존 젠스파크 tables/cr_archive 대체) ──
create table if not exists cr_archive (
  id uuid primary key default gen_random_uuid(),
  label            text not null,
  period_start     text default '',
  period_end       text default '',
  revenue          numeric default 0,
  cancel_cnt       integer default 0,
  return_cnt       integer default 0,
  cancel_amt       numeric default 0,
  return_amt       numeric default 0,
  cancel_ratio_rev numeric default 0,
  return_ratio_rev numeric default 0,
  total_ratio_rev  numeric default 0,
  memo             text default '',
  created_at       timestamptz default now()
);

-- ── 판매 성과 아카이브 (tables/perf_archive 대체) ──
create table if not exists perf_archive (
  id uuid primary key default gen_random_uuid(),
  label            text not null,
  period_start     text default '',
  period_end       text default '',
  overall_rr       numeric,
  avg_margin       numeric,
  avg_cost_rate    numeric,
  total_paid_qty   integer default 0,
  total_cancel_qty integer default 0,
  product_count    integer default 0,
  mapped_count     integer default 0,
  memo             text default '',
  created_at       timestamptz default now()
);

-- ── 광고 효율 아카이브 (tables/adv_archive 대체) ──
create table if not exists adv_archive (
  id uuid primary key default gen_random_uuid(),
  label            text not null,
  period_start     text default '',
  period_end       text default '',
  revenue          numeric default 0,
  adv_cost         numeric default 0,
  rent             numeric default 0,
  labor            numeric default 0,
  etc_cost         numeric default 0,
  months           integer default 1,
  supply_cost      numeric default 0,
  roas             numeric default 0,
  vat_amt          numeric default 0,
  corp_tax         numeric default 0,
  net_profit       numeric default 0,
  scenario_rev_delta  numeric default 0,
  scenario_roas_delta numeric default 0,
  memo             text default '',
  created_at       timestamptz default now()
);

-- ── 아카이브 3종: 개인용 도구이므로 anon 키로 읽기/쓰기 허용 ──
-- (주의: anon 키를 아는 사람은 누구나 접근 가능. 팀 외부에 anon 키 공개 금지)
alter table cr_archive   enable row level security;
alter table perf_archive enable row level security;
alter table adv_archive  enable row level security;

create policy "anon all cr_archive"   on cr_archive   for all using (true) with check (true);
create policy "anon all perf_archive" on perf_archive for all using (true) with check (true);
create policy "anon all adv_archive"  on adv_archive  for all using (true) with check (true);
