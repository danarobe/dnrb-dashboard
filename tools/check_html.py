#!/usr/bin/env python3
# index.html 구조 검사 (2026-10-06 사고 뒤 추가): 여는 <div>가 하나 더 들어가면 그 뒤 화면(.page-sec)들이 앞 화면 안으로 들어가
# 메뉴를 눌러도 아무것도 안 보인다(반품 스캔 안내문을 고치다 실제로 발생 — 18개 메뉴가 빈 화면).
# 사용: python3 tools/check_html.py  → 문제없으면 OK, 있으면 목록과 함께 실패(1). index.html을 고친 뒤 커밋 전에 실행.
import re, sys, os
s = open(os.path.join(os.path.dirname(__file__), '..', 'index.html'), encoding='utf-8').read()
html = re.sub(r'<script[\s\S]*?</script>', '', s)
html = re.sub(r'<style[\s\S]*?</style>', '', html)
html = re.sub(r'<!--[\s\S]*?-->', '', html)
opens, closes = len(re.findall(r'<div\b', html)), len(re.findall(r'</div>', html))
stack, nested, extra_close = [], [], 0
for m in re.finditer(r'<div\b([^>]*)>|</div>', html):
    if m.group(0).startswith('</'):
        if stack: stack.pop()
        else: extra_close += 1
    else:
        attrs = m.group(1)
        sec = 'page-sec' in attrs
        sid = (re.search(r'id="([^"]+)"', attrs) or [None, None])[1]
        outer = [x for x in stack if x]
        if sec and outer: nested.append(f'{sid} ⊂ {outer[-1]}')
        stack.append(sid if sec else None)
ids = re.findall(r'\bid="([^"${}]+)"', html)
dup = sorted({i for i in ids if ids.count(i) > 1})
bad = []
if opens != closes: bad.append(f'<div> 여닫기 수가 다릅니다: 열기 {opens} · 닫기 {closes}')
if stack: bad.append(f'닫히지 않은 <div> {len(stack)}개')
if extra_close: bad.append(f'짝 없는 </div> {extra_close}개')
if nested: bad.append('화면이 다른 화면 안에 들어가 있습니다: ' + ', '.join(nested[:8]))
if dup: bad.append('같은 id가 두 번 이상: ' + ', '.join(dup[:10]))
if bad:
    print('구조 문제:'); [print('  -', b) for b in bad]; sys.exit(1)
print(f'OK — <div> {opens}쌍 · 화면 겹침 없음 · id 중복 없음')
