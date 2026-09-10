-- 급여 명세서 파일 (2026-09-10 사용자 요청): 매월 관리자가 직원별 명세서 파일(PDF/이미지)을 업로드하고,
-- 직원은 마이페이지에서 본인 것만 본다. 파일 본문은 비공개 스토리지 버킷 wm-payslips (경로 {employee_id}/{ym}/{uuid}.{ext}),
-- 접근은 전부 Edge Function(wm-admin 업로드/삭제, wm-me 본인 조회·다운로드) 경유 — anon 정책 없음, 공개 URL 없음.
create table if not exists wm_payslips (
  id           bigserial primary key,
  employee_id  integer not null references wm_employees(id),
  ym           text not null check (ym ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  file_name    text not null,
  mime         text not null,
  size         integer not null,
  storage_path text not null,
  note         text,
  uploaded_by  text not null,
  uploaded_at  timestamptz not null default now(),
  unique (employee_id, ym)
);
alter table wm_payslips enable row level security;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wm-payslips', 'wm-payslips', false, 10485760, array['application/pdf','image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;
