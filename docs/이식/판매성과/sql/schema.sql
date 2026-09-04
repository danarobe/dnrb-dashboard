-- 판매 성과 이식용 스키마 (Supabase Postgres 기준, danarobe/dnrb-dashboard 에서 발췌, 2026-09-04)
-- 전부 RLS를 켜고 정책을 두지 않는다 = anon/authenticated 직접 접근 차단. 접근은 서버(service_role)로만.

-- 카페24 OAuth 토큰 (cafe24-oauth가 저장, cafe24-perf가 읽고 갱신)
create table if not exists api_tokens (
  provider            text primary key,     -- 'cafe24'
  access_token        text,
  refresh_token       text,
  expires_at          timestamptz,          -- access_token 만료 (카페24: 2시간)
  refresh_expires_at  timestamptz,          -- refresh_token 만료 (카페24: 2주 — 2주 동안 한 번도 안 부르면 재인증 필요)
  updated_at          timestamptz default now()
);
alter table api_tokens enable row level security;

-- 서버 결과 캐시 (10분) — 카페24 요청 한도 방어선. 없으면 조회마다 수십 초 + 429 위험
create table if not exists api_cache (
  cache_key   text primary key,
  payload     jsonb,
  created_at  timestamptz default now()
);
alter table api_cache enable row level security;

-- 판매 성과 결과 저장 (기간별 비교용 스냅샷 — 표 전체가 아니라 요약 수치만 저장)
create table if not exists perf_archive (
  id               uuid primary key default gen_random_uuid(),
  label            text not null,           -- 저장 이름 (예: 2026년 3월)
  period_start     text default '',
  period_end       text default '',
  overall_rr       numeric,                 -- 전체 취소·반품률(%) — 취소수량 ÷ 결제수량
  avg_margin       numeric,                 -- 전체 평균 마진율(%) — 순판매량 가중, 공급가×1.1 기준
  avg_cost_rate    numeric,                 -- 전체 평균 원가율(%)
  total_paid_qty   integer default 0,
  total_cancel_qty integer default 0,
  product_count    integer default 0,
  mapped_count     integer default 0,       -- 공급가가 있어 마진 계산에 들어간 상품 수
  memo             text default '',
  created_at       timestamptz default now()
);
alter table perf_archive enable row level security;
