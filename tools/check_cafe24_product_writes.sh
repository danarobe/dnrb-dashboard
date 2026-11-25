#!/bin/bash
# 배포 전 검사 (2026-11-25): 상품 등록 전용 카페24 앱(cafe24-product)의 안전장치가 그대로인지 본다.
#   - 상품 쓰기 권한(mall.write_product)과 그 토큰(api_tokens provider='cafe24p')은 cafe24-product 함수 안에서만 쓴다
#   - 카페24로 값을 보내는 곳은 c24pWrite 하나(+ 토큰 교환), DELETE·PATCH 없음
#   - 상품 만들기는 진열·판매 'F' 고정, 상품번호가 든 쓰기는 이 시스템이 만든 상품(c24p_registry)만
# 사용: bash tools/check_cafe24_product_writes.sh   (check_cafe24_writes.sh 가 끝에서 같이 부른다)
cd "$(dirname "$0")/.." || exit 1
F=supabase/functions/cafe24-product/index.ts
bad=0
[ -f "$F" ] || { echo "위반: $F 없음"; exit 1; }
code=$(grep -v '^\s*//' "$F")
# ① DELETE·PATCH 를 보내지 않는다
echo "$code" | grep -n -E '"(DELETE|PATCH)"|method: *"(DELETE|PATCH)"' | grep -q . && { echo "위반: cafe24-product 에 DELETE/PATCH 가 있습니다"; bad=1; }
# ② 카페24 주소로 fetch 하는 곳 = tokenRequest(토큰)·c24Get(읽기)·c24pWrite(쓰기) 세 군데뿐
n=$(grep -c 'fetch(`${API_BASE}' "$F"); [ "$n" = 3 ] || { echo "위반: 카페24 주소 fetch 가 $n 곳입니다(허용 3: 토큰·읽기·쓰기)"; bad=1; }
for fn in tokenRequest c24Get c24pWrite; do
  s=$(grep -n "^async function $fn" "$F" | cut -d: -f1); e=$(awk -v s="$s" 'NR>s && /^}/ {print NR; exit}' "$F")
  [ -n "$s" ] || { echo "위반: $fn 함수가 없습니다"; bad=1; continue; }
  c=$(sed -n "${s},${e}p" "$F" | grep -c 'fetch(`${API_BASE}'); [ "$c" = 1 ] || { echo "위반: $fn 안의 카페24 fetch 가 $c 곳"; bad=1; }
done
# c24Get 은 읽기만 (method 지정 없음)
s=$(grep -n "^async function c24Get" "$F" | cut -d: -f1); e=$(awk -v s="$s" 'NR>s && /^}/ {print NR; exit}' "$F")
sed -n "${s},${e}p" "$F" | grep -q 'method' && { echo "위반: c24Get 에 method 가 있습니다(읽기 전용이어야 함)"; bad=1; }
# ③ 허용 목록은 POST/PUT + 상품·분류·메인 진열 주소만
grep -n -E '^\s*\{ method: "' "$F" | grep -v -E 'method: "(POST|PUT)", re: /\^\\/admin\\/(products|categories|mains)' | grep -q . && { echo "위반: WRITE_RULES 에 허용 밖 메서드·주소가 있습니다"; bad=1; }
# ④ 상품 만들기 = 숨김·판매 안 함 고정, 내 상품 검사 두 곳
grep -q 'r.display = "F"; r.selling = "F";' "$F" || { echo "위반: 상품 만들기의 진열·판매 F 고정이 없습니다"; bad=1; }
grep -q 'isOurProduct(\[no\])' "$F" || { echo "위반: 주소 상품번호의 '이 시스템이 만든 상품' 검사가 없습니다"; bad=1; }
grep -q 'isOurProduct(nos)' "$F" || { echo "위반: 본문 상품번호의 '이 시스템이 만든 상품' 검사가 없습니다"; bad=1; }
# ⑤ 권한 범위 = 상품 읽기·쓰기, 분류 읽기, 디자인 읽기 (바꾸려면 사용자 결정 + 이 줄 수정)
grep -q '^const SCOPE = "mall.read_product,mall.write_product,mall.read_category,mall.read_design";' "$F" || { echo "위반: cafe24-product SCOPE 가 정해진 값과 다릅니다"; bad=1; }
# ⑥ 이 앱의 비밀값·토큰은 다른 함수가 쓰지 않는다
grep -rln -E 'CAFE24P_|"cafe24p"|c24p_registry' supabase/functions | grep -v "^$F$" | grep -q . && { echo "위반: 다른 함수가 상품 등록용 앱 비밀값·토큰을 씁니다:"; grep -rln -E 'CAFE24P_|"cafe24p"|c24p_registry' supabase/functions | grep -v "^$F$"; bad=1; }
[ "$bad" = 0 ] && echo "OK — 상품 등록용 앱: 쓰기 통로 1개·DELETE 없음·숨김 등록 고정·내 상품만 수정" || exit 1
