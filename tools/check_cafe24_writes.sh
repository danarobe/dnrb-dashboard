#!/bin/bash
# 배포 전 검사 (2026-09-28 안전장치): 카페24로 값을 보내는(쓰기) 코드는 cafe24-analytics 의 허용 함수뿐이어야 한다.
#   ① cafe24MarkCollected — 반품·교환 수거 완료(2026-09-28)
#   ② cafe24CancelToRefunding — 자사몰 취소접수 → 취소처리중  ③ cafe24CompleteRefund — 환불완료(PG 결제취소)  (2026-10-05 사용자 요청·승인)
#      ②③은 공용 전송 함수 cafe24Write(주소 두 가지만 허용)를 쓴다. 금액·환불 수단·계좌·철회 필드는 보내지 않는다.
#   (2026-10-05 네이버페이 취소 접수 cafe24AcceptNaverCancel을 넣었다가 공개 API가 거절해 제거 — 접수는 브라우저 연결 스크립트가 한다)
#   (2026-09-29 품목 설정 쓰기 cafe24FixVariant를 만들었다가 사용자 결정으로 제거 — '상품 쓰기' 권한은 열지 않는다)
# 사용: bash tools/check_cafe24_writes.sh   → 통과하면 OK, 위반이 있으면 목록과 함께 실패(1)
cd "$(dirname "$0")/.." || exit 1
bad=0
# ① fetch 옵션에 쓰기 메서드가 있는 줄 가운데, 카페24 API 주소를 다루는 파일에서 허용 함수 밖에 있는 것
while IFS= read -r hit; do
  file="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"
  grep -q "cafe24api\|API_BASE" "$file" || continue
  case "$file" in
    supabase/functions/cafe24-oauth/index.ts) continue ;;   # OAuth 토큰 교환(주문 데이터 아님)
    supabase/functions/cafe24-analytics/index.ts)
      ok=0
      for fn in cafe24MarkCollected cafe24Write cafe24CancelToRefunding cafe24CompleteRefund; do
        s=$(grep -n "^async function $fn" "$file" | cut -d: -f1); e=$(awk -v s="$s" 'NR>s && /^}/ {print NR; exit}' "$file")
        [ -n "$s" ] && [ "$line" -ge "$s" ] && [ "$line" -le "$e" ] && ok=1
      done
      [ "$ok" = 1 ] && continue ;;
  esac
  # 우리 DB(sbRest/rest)·다른 함수 호출은 제외: 같은 줄이나 앞 5줄에 cafe24 주소가 있을 때만 위반으로 본다.
  # 토큰 갱신(oauth/token)은 주문 데이터 쓰기가 아니므로 제외.
  ctx=$(sed -n "$((line>5?line-5:1)),${line}p" "$file")
  echo "$ctx" | grep -q "oauth/token\|oauth2/token\|oauth2.0/token" && continue
  if echo "$ctx" | grep -q "cafe24api\|API_BASE"; then echo "위반: $file:$line"; bad=1; fi
done < <(grep -rn -E "method: *[\"'\`]?(PUT|POST|DELETE|PATCH)" supabase/functions --include=*.ts)
# ② 범용 쓰기 헬퍼가 다시 생기지 않았는지
if grep -rn -E "function (apiSend|apiPut|apiPost|apiDelete)\b" supabase/functions --include=*.ts; then echo "위반: 범용 카페24 쓰기 헬퍼가 있습니다"; bad=1; fi
# ③ 수거 완료 본문이 고정값 그대로인지
grep -q 'request: { pickup_completed: "T", recover_inventory: recover, items: itemCodes.map' supabase/functions/cafe24-analytics/index.ts || { echo "위반: cafe24MarkCollected 본문이 바뀌었습니다"; bad=1; }
# ③-2 환불 처리 본문이 고정값 그대로인지 + 금액·환불 수단·계좌·철회·취소완료 직행 필드는 어디에도 없어야 한다
F=supabase/functions/cafe24-analytics/index.ts
grep -q 'requests: \[{ order_id: orderId, claim_code: claimCode, status: "canceling", recover_inventory: recover, add_memo_too: "F" }\] });' $F || { echo "위반: cafe24CancelToRefunding 본문이 바뀌었습니다"; bad=1; }
grep -q 'request: { status: "complete", payment_gateway_cancel: "T", send_sms: "T", send_mail: "T" } });' $F || { echo "위반: cafe24CompleteRefund 본문이 바뀌었습니다"; bad=1; }
[ "$(grep -v "^\s*//" $F | grep -c 'payment_gateway_cancel *:')" = 1 ] || { echo "위반: PG 결제취소를 보내는 곳이 한 군데가 아닙니다"; bad=1; }
grep -n -E 'status: *"canceled"|refund_method_code *:|refund_bank[a-z_]* *:|undone *: *"T"|actual_refund_amount *:' $F | grep -v "^[0-9]*:\s*//" | grep -q . && { echo "위반: 취소완료 직행·환불 수단·계좌·철회·금액을 보내는 코드가 있습니다"; bad=1; }
grep -q 'cancellation|orders\\/\\d{8}-\\d{7}\\/refunds' $F || { echo "위반: cafe24Write의 허용 주소 검사가 바뀌었습니다"; bad=1; }
# ④ 쓰기 함수는 허용한 것뿐 + 상품 쓰기 권한(scope) 요청 금지
n=$(grep -c "^async function cafe24[A-Z][A-Za-z]*(" supabase/functions/cafe24-analytics/index.ts); [ "$n" -le 4 ] || { echo "위반: cafe24 쓰기 함수가 $n개입니다(허용 4개: 수거 완료·공용 전송·취소처리중·환불완료)"; bad=1; }
grep -q "mall.write_product" supabase/functions/cafe24-oauth/index.ts && { grep -n "mall.write_product" supabase/functions/cafe24-oauth/index.ts | grep -v "^[0-9]*:\s*//" | grep -q . && { echo "위반: 상품 쓰기(mall.write_product) 권한을 요청합니다"; bad=1; }; }
[ "$bad" = 0 ] && echo "OK — 카페24 쓰기는 수거 완료 + 자사몰 취소 환불(취소처리중·환불완료) · 상품 쓰기 권한 없음" || exit 1
