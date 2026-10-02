-- 중국 사입 관리 — 사입상품명별 작은 사진 (2026-10-02 사용자 요청: 사진이 없어 헷갈림, 단 사이트가 느려지면 안 됨).
--   입고 엑셀 B열 그림을 브라우저가 160px JPEG(몇 KB)로 줄여 data URL로 저장. 목록(cn_list)과 따로 cn_thumbs로 불러온다(표를 먼저 그림).
create table if not exists cn_thumbs (
  sname      text primary key,
  img        text not null,
  updated_by_name text,
  updated_at timestamptz not null default now()
);
alter table cn_thumbs enable row level security;   -- anon 정책 없음 → service_role만
