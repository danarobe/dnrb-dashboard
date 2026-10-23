-- 중국 사입/제작 관리 — 차이 정리 + 초과 인정 (2026-10-23 사용자 요청)
--   ① "1차 입고의 6800·6800短款·26729-2# 부족분은 모두 없애줘 — 기록에 (첫 입고여서 차이가 있었음. 감안)"
--      → 입고 줄의 차이(중국출고 − 실입고, 양수 = 부족)를 '정리'로 표시. 실입고 숫자는 그대로 두고, 차이·부족 합계·'차이 있음' 칩에서만 뺀다.
alter table public.cn_lines add column if not exists gap_closed integer check (gap_closed is null or gap_closed <> 0);   -- 정리한 차이(중국출고 − 실입고, 정리할 때 값)
alter table public.cn_lines add column if not exists gap_note text;
alter table public.cn_lines add column if not exists gap_by_name text;
alter table public.cn_lines add column if not exists gap_at timestamptz;
--   ② "2517 베이지는 주문보다 1개 더 출고, 다른 색이 1개 덜 들어와 총 수량은 맞다 — 이런 경우도 확인하고 정리해서 헷갈리지 않게"
--      → 폐기(cn_discards.qty)에 마이너스 = '초과 인정'(주문보다 더 나온 수량을 받아들임). 미송 = 주문 − 출고 − 폐기 합이라 0이 된다.
alter table public.cn_discards drop constraint if exists cn_discards_qty_check;
alter table public.cn_discards add constraint cn_discards_qty_check check (qty <> 0 and qty between -1000000 and 1000000);
