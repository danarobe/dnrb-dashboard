-- 출장 여비 신청서 제출·관리자 확인 + 개인 사비 지출 내역·영수증 (2026-09-17 사용자 요청)
--   직원: 마이페이지 → 서류 발급 → 출장 여비 신청서 '입력완료' → wm_trip_claims 1행(초과근로·사비 지출은 JSONB)
--   영수증: 비공개 버킷 wm-receipts ({employee_id}/{uuid}.{ext}) + wm_trip_receipts 행. 접근은 wm-me(본인)·wm-admin(관리자) 함수 중계만.
--   관리자: 근무 관리 → '출장 여비' 탭에서 확인 완료/보완 요청 (status submitted → confirmed | returned)
create table if not exists wm_trip_claims (
  id            bigserial primary key,
  employee_id   integer not null references wm_employees(id),
  kind          text not null,             -- domestic | intl_short | intl_long
  place         text not null,
  purpose       text,
  start_date    date not null,
  end_date      date not null,
  nights        integer not null default 0,
  per_night     integer not null default 0,
  trip_pay      integer not null default 0,
  ot            jsonb not null default '[]'::jsonb,      -- [{date,s,e,meal,memo,raw,ceil}]
  ot_total_min  integer not null default 0,
  expenses      jsonb not null default '[]'::jsonb,      -- [{date,item,amount,memo,receipt_id}]
  expense_total integer not null default 0,
  note          text,
  status        text not null default 'submitted' check (status in ('submitted','confirmed','returned')),
  submitted_at  timestamptz not null default now(),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz not null default now()
);
create index if not exists wm_trip_claims_emp_idx on wm_trip_claims(employee_id, submitted_at desc);
alter table wm_trip_claims enable row level security;

create table if not exists wm_trip_receipts (
  id            bigserial primary key,
  employee_id   integer not null references wm_employees(id),
  claim_id      bigint references wm_trip_claims(id) on delete set null,
  file_name     text not null,
  mime          text not null,
  size          integer not null,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);
create index if not exists wm_trip_receipts_claim_idx on wm_trip_receipts(claim_id);
alter table wm_trip_receipts enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wm-receipts', 'wm-receipts', false, 10485760, array['application/pdf','image/png','image/jpeg','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;
