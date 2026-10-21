-- 순익 시나리오 — 세율·요율·단가 가정 (2026-10-21 사용자 요청 "급여·법인세·4대보험 등 빠진 세금을 자동 계산해 반영").
--   값은 화면 '가정(세율·단가)' 표에서 바꾸면 바로 저장(관리자). 퍼센트는 % 단위, 단가는 원.
create table if not exists public.profit_settings (
  key         text primary key,
  value       numeric not null default 0,
  label       text not null,
  unit        text not null default '%',
  note        text,
  sort_order  integer not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.profit_settings enable row level security;
insert into public.profit_settings (key, value, label, unit, note, sort_order) values
  ('ins_pension',  4.5,   '국민연금 회사 부담',        '%', '직원 급여 대비', 1),
  ('ins_health',   3.545, '건강보험 회사 부담',        '%', '2026년 요율 7.09%의 절반', 2),
  ('ins_care',     0.459, '장기요양보험 회사 부담',    '%', '건강보험료 × 12.95%', 3),
  ('ins_employ',   1.15,  '고용보험 회사 부담',        '%', '실업급여 0.9 + 고용안정·직업능력 0.25 (150인 미만)', 4),
  ('ins_accident', 0.7,   '산재보험',                  '%', '업종 요율 — 사업장 고지 요율로 확인', 5),
  ('retire',       8.33,  '퇴직급여 충당',             '%', '직원 급여의 1/12 (연 1개월분)', 6),
  ('ceo_ins',      8.5,   '대표 4대보험 회사 부담',     '%', '국민·건강·장기요양만 (고용·산재 제외)', 7),
  ('local_tax',    10,    '지방소득세',                '%', '법인세의 10%', 8),
  ('ad_vat',       10,    '광고비 부가세',             '%', 'Meta는 부가세 별도 청구 → 매입세액 공제', 9),
  ('ship_unit',    1850,  '택배 발송 단가',            '원', '주문 1건당 (면세)', 10),
  ('return_unit',  1850,  '반품 회수 단가',            '원', '반품 1건당 회수 택배비 (면세)', 11),
  ('pack_unit',    0,     '주문당 포장재·소모품',       '원', '주문 1건당 (과세 — 영수증 공제), 0이면 미반영', 12)
on conflict (key) do nothing;
