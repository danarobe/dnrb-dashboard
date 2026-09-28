#!/bin/bash
# 배포 전 검사 (2026-09-28 안전장치): 카페24로 값을 보내는(쓰기) 코드는 cafe24-analytics 의 cafe24MarkCollected 하나여야 한다.
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
      s=$(grep -n "^async function cafe24MarkCollected" "$file" | cut -d: -f1); e=$(awk -v s="$s" 'NR>s && /^}/ {print NR; exit}' "$file")
      [ -n "$s" ] && [ "$line" -ge "$s" ] && [ "$line" -le "$e" ] && continue ;;
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
[ "$bad" = 0 ] && echo "OK — 카페24 쓰기는 수거 완료 하나뿐" || exit 1
