-- 수거 완료 처리 기록에 재고 복구 여부·불량 판정을 별도 열로 (2026-09-28 사용자 요청: 나중에 누가 눌렀고 재고를 복구했는지 바로 알 수 있게)
alter table rscan_actions add column if not exists recover_inventory text;   -- 'T' 복구함 | 'F' 복구 안 함
alter table rscan_actions add column if not exists defect boolean;           -- 불량 접수로 판정했는지
-- 이미 남은 기록은 result 문구에서 채운다
update rscan_actions set recover_inventory = case when result like '%재고 복구 함%' then 'T' when result like '%재고 복구 안 함%' then 'F' end,
                         defect = case when result like '%(불량)%' then true when result like '%(불량 아님)%' then false end
 where recover_inventory is null and ok = true;
