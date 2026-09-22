-- 반품 스캔 소메뉴 '불량·오배송 처리' (2026-09-22 사용자 요청): 최근 1달 불량·오배송 사유의 반품·교환 건을 목록으로 보고
--   '처리전 / 처리완료'를 체크해 팀 전체가 같은 상태를 본다. 목록 자체는 rscan_index(카페24)에서 서버(cafe24-analytics rscan_issues)가 판정해 만들고,
--   여기에는 체크 상태만 저장한다. key = `${kind}:${order_id}:${claim_code}` (rscan_index payload 항목과 같은 키)
create table if not exists rscan_done (
  key       text primary key,
  order_id  text,
  done      boolean not null default true,
  done_by   text,
  done_at   timestamptz not null default now()
);
alter table rscan_done enable row level security;   -- anon 정책 없음 → db 프록시(service_role)만 접근
