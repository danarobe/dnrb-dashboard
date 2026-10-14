-- 중국 사입 관리 — 미출고 잔여 관리 제거 (2026-10-14 사용자 요청: "전달 항목에 잔여 1·잔여 2 해결 같은 표시는 필요 없다,
--   입고 엑셀은 출고 수량 E열만 참고하고 F열(미출고)은 참고하지 말라"). 0048의 직접 처리 칸을 지운다(쓰인 적 없음 — 처리한 줄 0개).
--   cn_lines.qty_left 칸은 남겨 두지만 이제 저장하지 않는다(새 입고는 늘 null, 화면·서버 어디에서도 읽지 않음).
alter table cn_lines drop column if exists left_closed;
alter table cn_lines drop column if exists left_note;
alter table cn_lines drop column if exists left_by_name;
alter table cn_lines drop column if exists left_at;
