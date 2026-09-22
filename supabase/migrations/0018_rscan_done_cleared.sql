-- 불량·오배송 처리 목록 '처리완료 정리' (2026-09-22 사용자 요청): 처리완료 건을 목록에서 지워 쌓이지 않게 한다.
--   cleared=true 인 키(그룹 kind:order_id 또는 옛 접수 키)는 rscan_issues 응답에서 제외. 카페24 데이터·처리 기록은 그대로.
alter table rscan_done add column if not exists cleared boolean not null default false;
alter table rscan_done add column if not exists cleared_at timestamptz;
