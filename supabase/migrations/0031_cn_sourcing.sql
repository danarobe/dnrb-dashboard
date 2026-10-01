-- 중국 사입 관리 (2026-10-01 사용자 요청): 중국에서 보낸 입고 엑셀(전달 수량)을 올려 두고, 현장에서 센 실제 수량을 적어 비교한다.
--   cn_shipments = 입고 건(엑셀 한 개), cn_lines = 옵션 줄(사입상품명·색상·사이즈).
--   사입상품명(sname) = 카페24 '공급사 상품명'과 같은 이름 → 등록 여부·판매량 연결.
--   읽기·쓰기는 cafe24-analytics(cn_list / cn_upload / cn_check / cn_ship)만. 단가는 서버가 관리자·MD에게만 내보낸다.
create table if not exists cn_shipments (
  id              bigserial primary key,
  title           text not null,
  vendor          text,
  order_round     text,
  ship_date       date,
  file_name       text,
  note            text,
  created_by      text,
  created_by_name text,
  created_at      timestamptz not null default now()
);
create table if not exists cn_lines (
  id              bigserial primary key,
  shipment_id     bigint not null references cn_shipments(id) on delete cascade,
  seq             int not null default 0,
  sname           text not null,
  color           text,
  size            text,
  qty_sent        int not null default 0,   -- 엑셀의 출고 수량(전달받은 수량)
  qty_left        int,                      -- 엑셀의 미출고 잔여(출완 = 0)
  unit_price      numeric,                  -- 단가(위안)
  line_note       text,                     -- 엑셀의 비고(기장 등)
  qty_actual      int,                      -- 현장에서 센 실제 수량(null = 아직 확인 전)
  checked_by      text,
  checked_by_name text,
  checked_at      timestamptz,
  memo            text
);
create index if not exists cn_lines_shipment_idx on cn_lines(shipment_id, seq);
alter table cn_shipments enable row level security;   -- anon 정책 없음 → service_role만
alter table cn_lines enable row level security;
