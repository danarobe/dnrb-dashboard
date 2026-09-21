-- 서류 출력 요청 (2026-09-21 사용자 요청): 직원이 마이페이지 서류 발급에서 '출력 요청' → 관리자 알림 → 근무 관리 '서류 요청' 탭에서 인쇄/PDF 후 '출력 완료'
create table if not exists wm_doc_requests (
  id           bigserial primary key,
  employee_id  integer not null references wm_employees(id),
  doc_type     text not null check (doc_type in ('cert','car')),   -- 재직증명서 / 차량 등록 요청서
  payload      jsonb not null default '{}'::jsonb,                  -- {use, car_no, car_model}
  status       text not null default 'requested' check (status in ('requested','printed','cancelled')),
  requested_at timestamptz not null default now(),
  handled_by   text,
  handled_at   timestamptz,
  note         text
);
create index if not exists wm_doc_requests_emp_idx on wm_doc_requests(employee_id, requested_at desc);
alter table wm_doc_requests enable row level security;
