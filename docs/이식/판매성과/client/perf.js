/* ═══════════════════════════════════════════════════════════════
   판매 성과 메뉴 — 클라이언트 (danarobe/dnrb-dashboard index.html 에서 발췌, 2026-09-04)
   원본은 프레임워크 없는 단일 HTML 안의 한 메뉴다. 이 파일은 그 블록에서 우리 대시보드 전용 부분
   (Meta ON 광고 열, 역할별 블러, 홈 화면 연동, CSV 업로드 경로)을 걷어낸 것.
   의존: Chart.js(월별 추이·비교 차트, CDN), Font Awesome 아이콘(선택 — 없으면 <i> 태그만 비어 보임)

   ▼ [어댑터] 이식처에 맞게 아래 4가지만 바꾸면 나머지는 그대로 동작한다
   ═══════════════════════════════════════════════════════════════ */
const PERF_API_URL = 'https://<프로젝트>.supabase.co/functions/v1/cafe24-perf';   // cafe24-perf 함수 주소(또는 그 프록시)
const PERF_API_HEADERS = () => ({ 'Content-Type': 'application/json' /* , 'x-api-key': ... ← 브라우저에 키를 두지 말고 백엔드 프록시 권장 */ });
/* 1) 서버 호출 — action/start_date/end_date 쿼리로 cafe24-perf(또는 그 프록시)를 부른다 */
async function perfApi(params) {
  const res = await fetch(`${PERF_API_URL}?${new URLSearchParams(params)}`, { headers: PERF_API_HEADERS() });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}
/* 2) 기록 저장(perf_archive) CRUD — 이식처 백엔드로 교체. 반환 형식만 맞추면 된다 */
async function sbList(table)         { throw new Error('sbList(' + table + ') 미구현 — 이식처 백엔드로 교체'); }   // → 행 배열 (created_at desc, 50개)
async function sbInsert(table, body) { throw new Error('sbInsert 미구현 — 이식처 백엔드로 교체'); }                  // → 없음
async function sbDelete(table, id)   { throw new Error('sbDelete 미구현 — 이식처 백엔드로 교체'); }                  // → 없음
/* 3) 역할 — 원본은 admin/staff(MD)/cs 세 역할로 금액·열을 숨겼다. 역할이 없으면 아래처럼 전부 관리자로 두면 된다 */
const isAdmin = () => true, isStaff = () => false, isCS = () => false;
/* 4) 공용 UI 헬퍼 — 이식처에 같은 것이 있으면 그걸로 대체 */
const $ = id => document.getElementById(id);
const fmt = n  => Math.round(n).toLocaleString('ko-KR');
const fmtP = n => n.toFixed(1) + '%';
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg) {
  const t = $('toast'); if (!t) { console.log('[toast]', msg); return; }
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
/* 기간 빠른 선택 (오늘/어제는 KST 기준) */
function qPeriod(sId, eId, kind) {
  const day = 864e5;
  const ymd = ms => new Date(ms).toISOString().slice(0, 10);
  let s, e = Date.now();
  if (kind === 'today' || kind === 'yest') {   // 하루짜리 — KST 기준 (toISOString은 UTC라 아침엔 하루 밀림)
    const v = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(Date.now() - (kind === 'yest' ? day : 0)));
    $(sId).value = v; $(eId).value = v;
    return;
  }
  if (kind === '7d') s = e - 6 * day;
  else if (kind === '14d') s = e - 13 * day;
  else if (kind === '30d') s = e - 29 * day;
  else if (kind === 'lastm') {  // 지난달 1일~말일 (정오 기준 — UTC 변환으로 하루 밀리는 것 방지)
    const d = new Date();
    s = new Date(d.getFullYear(), d.getMonth() - 1, 1, 12).getTime();
    e = new Date(d.getFullYear(), d.getMonth(), 0, 12).getTime();
  }
  $(sId).value = ymd(s); $(eId).value = ymd(e);
}

const __btnTimers = new Map();
function btnBusy(btn, label) {
  if (!btn) return;
  // 같은 버튼에 busy가 겹치면(광고관리자처럼 여러 조회가 한 버튼 공유) 기존 타이머를 먼저 지운다 —
  // 안 지우면 Map 덮어쓰기로 첫 타이머가 영영 남아 '불러오는 중 N초'가 무한 카운팅된다 (2026-08-28 실사례)
  clearInterval(__btnTimers.get(btn));
  const t0 = Date.now();
  btn.disabled = true;
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label} <span style="opacity:.75;font-size:.85em;">${s}초</span>`;
  };
  tick();
  __btnTimers.set(btn, setInterval(tick, 1000));
}
function btnIdle(btn, html) {
  if (!btn) return;
  clearInterval(__btnTimers.get(btn)); __btnTimers.delete(btn);
  btn.disabled = false; btn.innerHTML = html;
}

/* 판매 성과 상태 (원본 store 객체 중 이 메뉴가 쓰는 필드만) */
const store = { costMap: {}, salesData: [], perfFilter: 'all', netReturns: null, netTotals: null, prevRanks: null, perfSnapshot: null, perfArchiveRows: [] };

/* 메뉴 진입 시 호출: 기본 기간(최근 7일) + 월별 추이 패널 + 저장 기록 목록 */
function perfMenuInit() {
  if (!$('perfDateStart').value) qPeriod('perfDateStart', 'perfDateEnd', '7d');
  perfTrendInit();
  loadPerfArchive();
}

/* ══════════════════════════════════════
   [ C ] 판매 성과 분석 (기존 기능 유지)
══════════════════════════════════════ */



/* ──────────────────────────────
   반품 사유 모아보기 (판매 성과 표에서 상품명 클릭)

   카페24는 '반품 신청 사유'와 '반품 접수 사유'를 claim_reason 한 필드에 붙여서 준다:
       "사이즈작음 (구매자 주문취소 : 구매 의사 취소)"
   서버(cafe24-analytics returnreasons)가 둘로 쪼개서 주고, 여기서는 사용자 규칙대로
   **신청 사유가 있으면 그것만** 쓰고, 비어 있을 때만 접수 사유를 쓴다 (중복 집계 방지).

   성능: 조회는 상품명을 처음 클릭할 때 딱 한 번(기간당). 결과를 통째로 캐시하므로
   두 번째 클릭부터는 API 호출이 없다. 판매 성과 초기 로딩 속도에는 영향을 주지 않는다.
────────────────────────────── */
/* 핵심명 = 앞·뒤 괄호/대괄호를 전부 벗긴 상품명.
   2026-08-26 수정: "[Best] (2사이즈) 클레르 블라우스 (5 colors)"처럼 대괄호 태그나
   앞쪽 괄호가 여러 개면 예전 코드(앞 괄호 1개+뒤 괄호만)로는 핵심명이 안 나와 매칭이 전멸했다(실사례 1383). */
function paKey(name) {
  let s = String(name || '').trim();
  for (;;) {
    const m = s.match(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*(.*)$/);
    if (m) s = m[1]; else break;
  }
  for (;;) {
    const m = s.match(/^(.*?)\s*(?:\([^)]*\)|\[[^\]]*\])\s*$/);
    if (m) s = m[1]; else break;
  }
  return s.trim();
}
const rrState = { key: null, byProduct: null, loading: false };

/* 표기 흔들림 흡수 — 공백·문장부호·자음 반복 제거 + 흔한 오타 통일 */
function rrNorm(s) {
  let t = String(s || '').toLowerCase().replace(/[ㅠㅜㅋㅎ]+/g, '');
  t = t.replace(/[^0-9a-z가-힣]/g, '');
  return t.replace(/싸이즈|서이즈|사이스|싸이스/g, '사이즈');
}

/* 사유 분류 — 위에서부터 먼저 걸리는 것이 이긴다 (불량이 변심보다 우선)
   한글은 어미가 붙어 '두꺼'로 '두껍고'를 못 잡으므로 실제로 쓰이는 형태를 함께 넣었다 */
const RR_CATS = [
  ['불량·하자', ['불량','하자','실밥','튿','뜯','박음질','바느질','오염','얼룩','구멍','터짐','이염','올나','올이','올풀','풀려','파손','냄새','마감','찢','흠집','스크래치','짝짝']],
  ['사이즈·핏', ['사이즈','치수','핏이','기장','길이','작아','작음','작은','작네','작고','커요','커서','커용','컸','큽','큼','크고','크네','타이트','헐렁','짧','길어','길고','품이','부해','펑퍼짐','넓어','좁아','좁음','붕뜨','오버핏','정사이즈','꽉','답답','깊음','끼네','끼어']],
  ['원단·소재', ['원단','재질','소재','두께','두껍','두꺼','얇','비침','비쳐','비칩','촉감','까칠','신축','퀄리티','품질','뻣뻣','보풀','늘어남','더워']],
  ['색상·실물 차이', ['색상','색깔','컬러','색이','색감','사진','이미지','화면','실물','상이','달라','다름','다르','다릉','진해','연해','생각과','보이는것과']],
  ['배송·품절', ['배송','지연','늦','누락','오배송','품절','잘못보내','다른상품','다른제품']],
  ['단순 변심', ['변심','마음에','맘에','안들','어울','필요없','구매의사','재주문','다시주문','취소','불만족','느낌','생각했던','생각햇던','생각보다','생각한','이쁘','예쁘','이뻐','예뻐','이쁨','안예','안이','별로','불편','안맞','안어','실패','디자인']],
];
function rrCat(norm) {
  if (norm.length < 2) return '사유 미기재';
  for (const [name, kws] of RR_CATS) if (kws.some(k => norm.includes(k))) return name;
  return '기타';
}
const RR_CAT_COLOR = {
  '사이즈·핏': '#6366f1', '단순 변심': '#94a3b8', '원단·소재': '#0ea5e9',
  '불량·하자': '#dc2626', '색상·실물 차이': '#f59e0b', '배송·품절': '#10b981',
  '기타': '#a78bfa', '사유 미기재': '#d1d5db',
};

/* 기간이 바뀌면 캐시를 버리고 다시 받는다 */
async function rrEnsure(ds, de) {
  const key = ds + '~' + de;
  if (rrState.key === key && rrState.byProduct) return;
  const d = await perfApi({ action: 'returnreasons', start_date: ds, end_date: de });
  const items = d.items || [];

  /* ── 동반 반품 처리 ──
     카페24는 사유를 '클레임(반품 신청) 단위'로 하나만 받는다. 여러 상품을 한 번에 반품하면
     같은 문장이 모든 상품에 복사된다(실측: 클레임 22%가 다중 상품, 그중 87% 동일 사유).
     그래서 각 품목을 세 가지로 나눈다:
       sole   = 단독 반품이라 이 상품 사유가 확실 → TOP5 집계
       shared = 여러 상품 동반 반품 — 어느 상품 얘기인지 불확실 → 별도 구역 표시
       other  = 사유에 '다른' 상품 종류가 명시됨(예: 블라우스 반품인데 "원피스가 길어요") → 제외
     귀속 판별: 사유에 클레임 내 상품의 종류 단어(핵심명 마지막 단어: 원피스·블라우스 등)가
     정확히 한 상품 것만 나오면 그 상품 사유로 본다. */
  const claims = new Map();
  for (const x of items) {
    if (!x.claim) continue;
    if (!claims.has(x.claim)) claims.set(x.claim, new Map());
    claims.get(x.claim).set(x.product_no, x.product_name);
  }
  const catTok = nm => { const w = paKey(nm).split(/\s+/); return w[w.length - 1] || ''; };
  for (const x of items) {
    const prods = x.claim ? claims.get(x.claim) : null;
    x.share = 'sole'; x.others = [];
    if (!prods || prods.size <= 1) continue;
    x.others = [...prods].filter(([no]) => no !== x.product_no).map(([, nm]) => paKey(nm));
    const text = (x.request || x.accept || '').trim();
    if (!text) { x.share = 'shared'; continue; }
    const textN = text.replace(/\s+/g, '');

    // ① 상품 '이름'을 직접 쓴 경우가 최우선 (예: "내티 원피스는 색이 이상해요" — 원피스가 3개라도 확정)
    //    서로 부분 문자열 관계면 긴 이름만 인정 ("프리 셔링 원피스" 언급이 "셔링 원피스" 상품으로 새지 않게)
    let named = [...prods]
      .map(([no, nm]) => ({ no, full: paKey(nm).replace(/\s+/g, '') }))
      .filter(p => p.full.length >= 4 && textN.includes(p.full));
    named = named.filter(a => !named.some(b => b.no !== a.no && b.full.includes(a.full) && b.full !== a.full));
    if (named.length) {
      x.share = named.some(p => p.no === x.product_no) ? 'sole' : 'other';
      continue;
    }
    // ② 종류 단어(원피스·블라우스 등)는 클레임 안에서 유일할 때만 — 같은 종류가 여럿이면
    //    어느 것인지 알 수 없으므로 '불확실'로 남긴다 (무작위 배정 금지)
    const toks = [...prods].map(([no, nm]) => ({ no, tok: catTok(nm) }));
    const cnt = {}; toks.forEach(t => { cnt[t.tok] = (cnt[t.tok] || 0) + 1; });
    const mentioned = toks.filter(t => t.tok.length >= 2 && cnt[t.tok] === 1 && text.includes(t.tok));
    if (mentioned.length === 1) x.share = (mentioned[0].no === x.product_no) ? 'sole' : 'other';
    else x.share = 'shared';
  }

  const by = new Map();
  for (const x of items) {
    if (!by.has(x.product_no)) by.set(x.product_no, []);
    by.get(x.product_no).push(x);
  }
  rrState.key = key; rrState.byProduct = by;
}

async function showReturnReasons(productNo) {
  const ds = $('perfDateStart').value, de = $('perfDateEnd').value;
  if (!ds || !de) { showToast('분석 기간을 먼저 선택해주세요'); return; }
  const row = store.salesData.find(r => r.productNo === productNo);
  const modal = $('rr-modal');
  modal.style.display = 'flex';
  $('rr-title').textContent = row ? row.productName : '상품 #' + productNo;
  $('rr-sub').textContent = `${ds} ~ ${de} · 배송완료일 기준 반품 (신청·접수 포함)`;
  const cached = rrState.key === ds + '~' + de && rrState.byProduct;
  $('rr-body').innerHTML = `<div style="padding:28px;text-align:center;color:#6b7280;font-size:.82rem;">
    <i class="fa-solid fa-spinner fa-spin"></i> ${cached ? '집계 중...' : '반품 사유를 불러오는 중입니다 (처음 한 번만 5초 정도 걸립니다)'}</div>`;
  try {
    await rrEnsure(ds, de);
    rrRenderBody(productNo);
  } catch (e) {
    $('rr-body').innerHTML = `<div style="padding:24px;color:#b91c1c;font-size:.82rem;">불러오지 못했습니다: ${escHtml(e.message)}</div>`;
  }
}

function rrRenderBody(productNo) {
  const list = (rrState.byProduct.get(productNo) || []);
  if (!list.length) {
    $('rr-body').innerHTML = '<div style="padding:24px;text-align:center;color:#6b7280;font-size:.82rem;">이 기간에 이 상품의 반품이 없습니다.</div>';
    return;
  }
  $('rr-body').innerHTML = rrBuildHtml(list);
}

/* 사유 목록 → 묶음 TOP5 HTML (판매 성과 모달 + 반품 관리 상세에서 공용) */
function rrBuildHtml(list) {
  // 사용자 규칙: 신청 사유가 있으면 그것만 집계, 없을 때만 접수 사유 사용
  const groups = new Map();     // 분류 → { n, texts: Map(정규화 → {text, n}) }
  let fromAccept = 0, blank = 0, otherN = 0;
  const shared = new Map();     // 동반 반품 공유 사유: 정규화 → {text, n, others:Set}
  for (const x of list) {
    if (x.share === 'other') { otherN++; continue; }           // 다른 상품에 대한 사유 — 제외
    const req = (x.request || '').trim();
    const acc = (x.accept || '').trim();
    const text = req || acc;
    if (!text) { blank++; continue; }
    if (!req && acc) fromAccept++;
    const n = rrNorm(text);
    if (x.share === 'shared') {                                 // 동반 반품 — 별도 구역
      const s = shared.get(n) || { text, n: 0, others: new Set() };
      s.n++;
      (x.others || []).forEach(o => s.others.add(o));
      shared.set(n, s);
      continue;
    }
    const cat = rrCat(n);
    if (!groups.has(cat)) groups.set(cat, { n: 0, texts: new Map() });
    const g = groups.get(cat);
    g.n++;
    const t = g.texts.get(n);
    if (t) t.n++; else g.texts.set(n, { text, n: 1 });
  }
  const sharedN = [...shared.values()].reduce((s, v) => s + v.n, 0);
  const total = [...groups.values()].reduce((s, g) => s + g.n, 0);
  const ranked = [...groups.entries()].sort((a, b) => b[1].n - a[1].n);
  const top = ranked.slice(0, 5), restN = ranked.slice(5).reduce((s, g) => s + g[1].n, 0);

  const medal = ['1', '2', '3', '4', '5'];
  let html = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <span style="background:#eef2ff;color:#4338ca;border-radius:8px;padding:5px 10px;font-size:.75rem;font-weight:700;">반품 ${list.length}건</span>
      <span style="background:#f8f9ff;color:#6b7280;border-radius:8px;padding:5px 10px;font-size:.75rem;">이 상품 사유 확실 ${total}건</span>
      ${sharedN ? `<span style="background:#fffbeb;color:#92400e;border-radius:8px;padding:5px 10px;font-size:.75rem;">동반 반품(불확실) ${sharedN}건</span>` : ''}
      ${otherN ? `<span style="background:#f3f4f6;color:#6b7280;border-radius:8px;padding:5px 10px;font-size:.75rem;">다른 상품 사유 제외 ${otherN}건</span>` : ''}
      ${blank ? `<span style="background:#f3f4f6;color:#6b7280;border-radius:8px;padding:5px 10px;font-size:.75rem;">미기재 ${blank}건</span>` : ''}
      ${fromAccept ? `<span style="background:#fff7ed;color:#c2410c;border-radius:8px;padding:5px 10px;font-size:.75rem;">접수 사유로 대체 ${fromAccept}건</span>` : ''}
    </div>
    <div style="font-size:.82rem;font-weight:800;color:#4338ca;margin-bottom:8px;">비슷한 사유끼리 묶은 TOP ${top.length} <span style="font-weight:400;color:#6b7280;font-size:.7rem;">(이 상품 것이 확실한 사유만)</span></div>`;

  top.forEach(([cat, g], i) => {
    const pct = total > 0 ? (g.n / total * 100) : 0;
    const color = RR_CAT_COLOR[cat] || '#6366f1';
    // 같은 묶음 안에서는 실제 문장을 많이 나온 순으로 (같은 말은 이미 합쳐짐)
    const texts = [...g.texts.values()].sort((a, b) => b.n - a.n);
    html += `
      <div style="border:1.5px solid #eef2ff;border-radius:12px;padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="width:22px;height:22px;line-height:22px;text-align:center;background:${i===0?'#4f46e5':'#e5e7eb'};color:${i===0?'#fff':'#6b7280'};border-radius:50%;font-size:.75rem;font-weight:800;">${medal[i]}</span>
          <span style="font-weight:800;color:${color};font-size:.82rem;flex:1;">${cat}</span>
          <span style="font-weight:800;color:#1e1b4b;font-size:.82rem;">${g.n}건</span>
          <span style="color:#6b7280;font-size:.75rem;width:46px;text-align:right;">${pct.toFixed(0)}%</span>
        </div>
        <div style="height:7px;background:#f3f4f6;border-radius:4px;margin:7px 0 8px;overflow:hidden;">
          <div style="height:100%;width:${pct.toFixed(1)}%;background:${color};border-radius:4px;"></div>
        </div>
        <div style="font-size:.75rem;color:#4b5563;line-height:1.75;">
          ${texts.slice(0, 4).map(t => `<div style="display:flex;gap:6px;">
            <span style="color:#c7d2fe;">•</span>
            <span style="flex:1;">${escHtml(t.text)}</span>
            ${t.n > 1 ? `<span style="color:#6b7280;white-space:nowrap;">×${t.n}</span>` : ''}
          </div>`).join('')}
          ${texts.length > 4 ? `<details style="margin-top:4px;"><summary style="cursor:pointer;color:#6366f1;font-size:.75rem;">나머지 ${texts.length - 4}가지 더 보기</summary>
            <div style="margin-top:4px;">${texts.slice(4).map(t => `<div style="display:flex;gap:6px;">
              <span style="color:#e5e7eb;">•</span><span style="flex:1;">${escHtml(t.text)}</span>
              ${t.n > 1 ? `<span style="color:#6b7280;">×${t.n}</span>` : ''}</div>`).join('')}</div></details>` : ''}
        </div>
      </div>`;
  });
  if (restN > 0) html += `<div style="font-size:.75rem;color:#6b7280;text-align:center;margin-top:2px;">그 외 ${ranked.length - 5}개 묶음 ${restN}건</div>`;
  if (shared.size) {
    const rows = [...shared.values()].sort((a, b) => b.n - a.n);
    html += `<details style="margin-top:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:8px 12px;">
      <summary style="cursor:pointer;font-size:.78rem;font-weight:700;color:#92400e;">여러 상품 동반 반품의 사유 ${sharedN}건 — 어느 상품에 대한 말인지 불확실 (TOP 집계 제외)</summary>
      <div style="margin-top:6px;font-size:.75rem;color:#4b5563;line-height:1.8;">
        ${rows.map(s => `<div style="display:flex;gap:6px;flex-wrap:wrap;">
          <span style="flex:1;min-width:200px;">· ${escHtml(s.text)}${s.n > 1 ? ` <span style="color:#6b7280;">×${s.n}</span>` : ''}</span>
          <span style="color:#b45309;font-size:.7rem;">함께 반품: ${escHtml([...s.others].slice(0, 2).join(', '))}${s.others.size > 2 ? ' 외' : ''}</span>
        </div>`).join('')}
      </div></details>`;
  }
  html += `<div style="font-size:.7rem;color:#6b7280;margin-top:10px;line-height:1.6;border-top:1px solid #f3f4f6;padding-top:8px;">
    ※ 신청 사유와 접수 사유가 모두 있으면 <b>신청 사유만</b> 셉니다 (중복 방지) · 비슷한 표현은 자동으로 한 묶음 ·
    여러 상품을 한 번에 반품하면 카페24가 <b>한 문장을 모든 상품에 복사</b>하므로, 단독 반품 사유만 이 상품 것으로 확정합니다
    (사유에 상품 종류가 명시되면 그 상품으로 자동 귀속)</div>`;
  return html;
}

/* ──────────────────────────────
   판매 성과 · 월별 추이 — 직전 3개 완결 월의 순반품률 / 평균 마진율 / 취소반품률
   (예: 8월에 조회 → 5·6·7월. 이번 달은 아직 진행 중이라 제외)

   무거운 조회(월당 ~30초)라서:
   · 완결된 월의 수치는 변하지 않으므로 localStorage에 영구 저장 — 브라우저당 딱 한 번만 수집
   · 단, 월이 끝난 지 10일이 안 됐으면 반품이 덜 들어온 상태라 저장하지 않음(볼 때마다 새로 계산)
   · 키에 v2 = 반품 신청·접수 포함 기준 (기준이 또 바뀌면 버전을 올려 무효화)
────────────────────────────── */
const PT_KEY = ym => `dnrb_trend_v2_${ym}`;
function ptMonths() {
  const out = [], d = new Date();
  for (let i = 3; i >= 1; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 15);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
function ptRange(ym) {   // 'YYYY-MM' → [1일, 말일] (정오 기준 — UTC 변환으로 하루 밀림 방지)
  const [y, m] = ym.split('-').map(Number);
  const ymd = t => new Date(t).toISOString().slice(0, 10);
  return [ymd(new Date(y, m - 1, 1, 12)), ymd(new Date(y, m, 0, 12))];
}
async function ptFetchMonth(ym) {
  const saved = localStorage.getItem(PT_KEY(ym));
  if (saved) { try { return JSON.parse(saved); } catch { /* 깨진 값은 새로 수집 */ } }
  const [s, e] = ptRange(ym);
  const perf = await perfApi({ action: 'performance', start_date: s, end_date: e });
  const net = await perfApi({ action: 'netreturns', start_date: s, end_date: e });
  let paid = 0, cancel = 0, w = 0, wq = 0;
  for (const r of (perf.rows || [])) {
    paid += r.paid_qty; cancel += r.cancel_qty;
    const sq = Math.max(0, r.paid_qty - r.cancel_qty);
    if (r.supply_price > 0 && r.price > 0 && sq > 0) {
      w += (r.price - r.supply_price * 1.1) / r.price * 100 * sq; wq += sq;   // 홈 타일과 동일한 가중평균
    }
  }
  const stat = {
    nr: net.totals ? net.totals.net_return_rate : 0,
    margin: wq > 0 ? +(w / wq).toFixed(1) : 0,
    cr: paid > 0 ? +(cancel / paid * 100).toFixed(1) : 0,
  };
  if ((Date.now() - new Date(e).getTime()) / 864e5 >= 10) localStorage.setItem(PT_KEY(ym), JSON.stringify(stat));
  return stat;
}
const ptCharts = {};
let ptState = null;                          // {months, stats} — 7월처럼 아직 저장 안 되는 달의 세션 내 재사용
/* 수집 없이 바로 그릴 수 있으면 stats 반환 (메모리 → localStorage 순) */
function ptReady(months) {
  if (ptState && ptState.months.join() === months.join()) return ptState.stats;
  if (months.every(m => localStorage.getItem(PT_KEY(m)))) {
    try { return months.map(m => JSON.parse(localStorage.getItem(PT_KEY(m)))); } catch { return null; }
  }
  return null;
}
/* 메뉴 진입 시 — 패널 표시 + 데이터 있으면 그 메뉴의 컨테이너에 렌더 (숨은 캔버스에 그리면 깨져서 진입 때마다 새로 그림) */
function ptInitPanel(prefix) {
  const panel = $(prefix + '-trend'); if (!panel) return;
  panel.style.display = 'block';
  const months = ptMonths();
  $(prefix + '-trend-months').textContent = months.map(m => Number(m.split('-')[1]) + '월').join(' · ');
  const stats = ptReady(months);
  if (stats) ptRenderTo(prefix, months, stats);
}
function perfTrendInit() { ptInitPanel('perf'); }
async function perfTrendLoad(force, btnEl) {
  const months = ptMonths();
  const cached = !!ptReady(months);
  if (!force && !cached) return;
  const btn = btnEl || $('btn-perf-trend');
  if (!cached) btnBusy(btn, '수집 중');
  try {
    const stats = [];
    for (const m of months) stats.push(await ptFetchMonth(m));   // 순차 실행 — 카페24 요청 한도 보호
    ptState = { months, stats };
    // 지금 보이는 섹션에만 그림 — 다른 메뉴는 진입할 때 ptInitPanel이 그림
    ptRenderTo('perf', months, stats);
  } catch (e) { showToast('추이 수집 실패: ' + e.message); console.error(e); }
  finally { btnIdle(btn, '<i class="fa-solid fa-rotate"></i> 다시 불러오기'); }
}
function ptRenderTo(prefix, months, stats) {
  const label = months.map(m => Number(m.split('-')[1]) + '월');
  const row = (name, key, color, better) => `
    <tr>
      <td style="text-align:left;font-weight:700;color:#374151;">${name}</td>
      ${stats.map((s, i) => {
        const v = s[key], prev = i > 0 ? stats[i - 1][key] : null;
        const d = prev === null ? null : +(v - prev).toFixed(1);
        const good = d === null ? null : (better === 'down' ? d < 0 : d > 0);
        return `<td><b style="color:${color};">${v.toFixed(1)}%</b>
          ${d !== null && d !== 0 ? `<span style="font-size:.7rem;color:${good ? '#16a34a' : '#dc2626'};margin-left:4px;">${d > 0 ? '+' : ''}${d}%p</span>` : ''}</td>`;
      }).join('')}
    </tr>`;
  $(prefix + '-trend-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:center;" class="pt-grid">
      <div style="height:180px;"><canvas id="${prefix}-trend-canvas"></canvas></div>
      <div class="table-wrap"><table style="font-size:.82rem;">
        <thead><tr><th style="text-align:left;">지표</th>${label.map(l => `<th>${l}</th>`).join('')}</tr></thead>
        <tbody>
          ${row('순반품률', 'nr', '#4f46e5', 'down')}
          ${row('평균 마진율', 'margin', '#16a34a', 'up')}
          ${row('취소반품률', 'cr', '#d97706', 'down')}
        </tbody>
      </table></div>
    </div>
    <div style="font-size:.7rem;color:#6b7280;margin-top:8px;">순반품률 = 배송완료일 기준(신청·접수 포함) · 마진율 = 순판매량 가중평균(공급가×1.1) · 취소반품률 = 취소반품수량 ÷ 결제수량(주문일 기준) · 완결 월 수치는 저장돼 다시 계산하지 않습니다</div>`;
  if (typeof Chart === 'undefined') return;
  if (ptCharts[prefix]) { ptCharts[prefix].destroy(); delete ptCharts[prefix]; }
  ptCharts[prefix] = new Chart($(prefix + '-trend-canvas'), {
    type: 'line',
    data: { labels: label, datasets: [
      { label: '순반품률', data: stats.map(s => s.nr), borderColor: '#4f46e5', backgroundColor: '#4f46e5', tension: .3, pointRadius: 4 },
      { label: '평균 마진율', data: stats.map(s => s.margin), borderColor: '#16a34a', backgroundColor: '#16a34a', tension: .3, pointRadius: 4 },
      { label: '취소반품률', data: stats.map(s => s.cr), borderColor: '#d97706', backgroundColor: '#d97706', tension: .3, pointRadius: 4 },
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 12 } } },
      scales: { y: { ticks: { callback: v => v + '%' } } } },
  });
}

/* 판매 성과 실시간 API 조회 — CSV(salesData/costMap)와 동일 구조로 매핑해
   renderPerfResult·필터·아카이브 기능을 그대로 재사용 */
async function fetchPerfApi() {
  const ds = $('perfDateStart').value, de = $('perfDateEnd').value;
  if (!ds || !de) { showToast('분석 기간을 먼저 선택해주세요'); return; }
  const btn = $('btn-api-perf');
  btnBusy(btn, '조회 중');
  try {
    const [data, net] = await Promise.all([
      perfApi({ action: 'performance', start_date: ds, end_date: de }),
      perfApi({ action: 'netreturns', start_date: ds, end_date: de }),
    ]);
    store.costMap = {};
    store.salesData = [];
    // 순반품률(배송완료일 기준) — product_no로 조인
    store.netReturns = new Map((net.rows || []).map(r => [r.product_no, r]));
    store.netTotals = net.totals || null;
    let mappedCost = 0;
    (data.rows || []).forEach((r, i) => {
      const salesQty = Math.max(0, r.paid_qty - r.cancel_qty);
      // 순판매금액: 주문금액을 수량 비율로 안분
      const salesTotal = r.paid_qty > 0 ? Math.round(r.order_amount * salesQty / r.paid_qty) : 0;
      store.salesData.push({
        rank: i + 1,
        productNo: r.product_no,
        productName: (r.product_name || '').trim(),
        option: '',
        salePrice: r.price,
        paidQty: r.paid_qty,
        refundQty: r.cancel_qty,
        salesQty,
        salesTotal,
        cancelQty: r.cancel_qty,
        returnRate: r.paid_qty > 0 ? r.cancel_qty / r.paid_qty * 100 : 0,
      });
      if (r.supply_price > 0 && r.price > 0) {
        store.costMap[(r.product_name || '').toLowerCase().trim()] = { supplyCost: r.supply_price, salePrice: r.price };
        mappedCost++;
      }
    });
    store.perfFilter = 'all';
    // '오늘' 하루 조회면 어제 순위도 받아 등락 열 표시 (2026-09-01 사용자 요청).
    // 표를 먼저 그리고 백그라운드로 어제 데이터를 받아 다시 그린다 (첫 조회 수십 초 가능, 서버 10분 캐시).
    store.prevRanks = null;
    const kstToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    if (ds === de && ds === kstToday) {
      const yd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(Date.now() - 864e5));
      perfApi({ action: 'performance', start_date: yd, end_date: yd }).then(prev => {
        if ($('perfDateStart').value !== ds || $('perfDateEnd').value !== de) return;   // 기간이 바뀌었으면 버림
        store.prevRanks = new Map((prev.rows || []).map((r, i) => [r.product_no, i + 1]));
        if (store.salesData.length) renderPerfResult();
      }).catch(() => { /* 등락 없이 표시 */ });
    }
    renderPerfResult();
    const noCost = store.salesData.length - mappedCost;
    showToast(`${store.salesData.length}개 상품 로드 · 공급가 매핑 ${mappedCost}개${noCost > 0 ? ` (공급가 미입력 ${noCost}개는 마진 계산 제외)` : ''}`);
  } catch (e) {
    showToast('판매 성과 조회 실패: ' + e.message);
    console.error(e);
  } finally {
    btnIdle(btn, '<i class="fa-solid fa-cloud-arrow-down"></i> 카페24 불러오기');
  }
}

// 어제 대비 순위 등락 (결제수량 순위 기준) — 어제 10위 → 오늘 2위면 ↑ 8, 어제 없던 상품은 NEW
function perfRankDelta(row) {
  const prev = store.prevRanks.get(row.productNo);
  if (prev == null) return '<span style="background:#eef2ff;color:#4338ca;border-radius:6px;padding:1px 7px;font-size:.68rem;font-weight:800;" title="어제는 결제 기록이 없던 상품">NEW</span>';
  const d = prev - row.rank;
  if (d > 0) return `<span style="color:#dc2626;font-weight:800;white-space:nowrap;" title="어제 ${prev}위 → 오늘 ${row.rank}위">↑ ${d}</span>`;
  if (d < 0) return `<span style="color:#2563eb;font-weight:800;white-space:nowrap;" title="어제 ${prev}위 → 오늘 ${row.rank}위">↓ ${-d}</span>`;
  return `<span style="color:#9ca3af;" title="어제와 같은 ${prev}위">—</span>`;
}

function findCostData(productName) {
  const key = productName.toLowerCase().trim();
  if (store.costMap[key]) return store.costMap[key];
  for (const [k,v] of Object.entries(store.costMap)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

function renderPerfResult() {
  if (store.salesData.length === 0) return;

  let totalPaid=0, totalCancel=0, totalSalesQty=0, totalSalesAmt=0;
  let wMargin=0, wCostRate=0, mapped=0;
  let totalCancelAmt=0;  // 취소·반품 금액 (판매합계 기준 역산)

  store.salesData.forEach(r => {
    totalPaid     += r.paidQty;
    totalCancel   += r.cancelQty;
    totalSalesQty += r.salesQty;
    totalSalesAmt += r.salesTotal;

    // 취소·반품 금액 역산: 판매가 기준으로 취소수량만큼 환산
    if (r.salePrice > 0 && r.cancelQty > 0) {
      totalCancelAmt += r.salePrice * r.cancelQty;
    }

    const cd = findCostData(r.productName);
    if (cd && cd.salePrice > 0 && r.salesQty > 0) {
      const vatCost = cd.supplyCost * 1.1;
      wMargin   += ((cd.salePrice - vatCost) / cd.salePrice) * 100 * r.salesQty;
      wCostRate += (vatCost / cd.salePrice) * 100 * r.salesQty;
      mapped++;
    }
  });

  // 총매출 = 판매합계(순판매) + 취소·반품 금액
  const grossSalesAmt = totalSalesAmt + totalCancelAmt;
  // 순매출 = 판매합계(순판매)
  const netSalesAmt   = totalSalesAmt;

  const overallRR   = totalPaid > 0 ? totalCancel / totalPaid * 100 : 0;
  const avgMargin   = totalSalesQty > 0 && mapped > 0 ? wMargin   / totalSalesQty : NaN;
  const avgCostRate = totalSalesQty > 0 && mapped > 0 ? wCostRate / totalSalesQty : NaN;

  const ds = $('perfDateStart').value;
  const de = $('perfDateEnd').value;
  const period = ds&&de ? `${ds.replace(/-/g,'.')} ~ ${de.replace(/-/g,'.')}` : '기간 미선택';

  let filtered = perfFilterData(store.salesData, store.perfFilter);
  // 상품명 검색
  const perfQ = ($('perfSearch').value || '').trim().toLowerCase();
  if (perfQ) filtered = filtered.filter(r => r.productName.toLowerCase().includes(perfQ));

  let html = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      <span style="font-size:.82rem;font-weight:600;color:#6b7280;">기간</span>
      <span style="font-size:.82rem;font-weight:700;color:#4f46e5;background:#ede9fe;padding:3px 12px;border-radius:50px;">${period}</span>
      <span style="font-size:.82rem;color:#6b7280;">총 ${store.salesData.length}개 상품</span>
    </div>

    ${isStaff() ? '' : `
    <!-- 매출 요약 바 (CS팀은 블러) -->
    <div class="cs-blur" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
      <div style="background:#f8f9ff;border:1.5px solid #e8eaf0;border-radius:12px;padding:14px 16px;">
        <div style="font-size:.75rem;font-weight:600;color:#6b7280;margin-bottom:5px;">총 매출</div>
        <div style="font-size:1.25rem;font-weight:800;color:#1a1a2e;">${grossSalesAmt > 0 ? fmt(grossSalesAmt) + '원' : '—'}</div>
        <div style="font-size:.75rem;color:#6b7280;margin-top:3px;">순판매 + 취소·반품 금액</div>
      </div>
      <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:12px;padding:14px 16px;">
        <div style="font-size:.75rem;font-weight:600;color:#c2410c;margin-bottom:5px;">취소·반품 금액</div>
        <div style="font-size:1.25rem;font-weight:800;color:#c2410c;">${totalCancelAmt > 0 ? '- ' + fmt(totalCancelAmt) + '원' : '—'}</div>
        <div style="font-size:.75rem;color:#6b7280;margin-top:3px;">${totalCancelAmt > 0 && grossSalesAmt > 0 ? '총매출 대비 ' + fmtP(totalCancelAmt/grossSalesAmt*100) : '판매가 기준 역산'}</div>
      </div>
      <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:12px;padding:14px 16px;">
        <div style="font-size:.75rem;font-weight:600;color:#15803d;margin-bottom:5px;">순 매출</div>
        <div style="font-size:1.25rem;font-weight:800;color:#15803d;">${netSalesAmt > 0 ? fmt(netSalesAmt) + '원' : '—'}</div>
        <div style="font-size:.75rem;color:#6b7280;margin-top:3px;">판매합계 기준</div>
      </div>
    </div>`}

    <!-- 성과 요약 카드 (전사 합계 — CS팀은 블러) -->
    <div class="cs-blur" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px;">
      <div style="border-radius:13px;padding:16px;color:#fff;background:#4f46e5;">
        <div style="font-size:.75rem;font-weight:600;opacity:.85;margin-bottom:4px;">전체 순반품률 <span style="font-size:.7rem;opacity:.7;font-weight:400;">(배송완료일 기준)</span></div>
        <div style="font-size:1.9rem;font-weight:800;">${store.netTotals ? fmtP(store.netTotals.net_return_rate) : '—'}</div>
        <div style="font-size:.75rem;opacity:.7;margin-top:3px;">${store.netTotals ? `${store.netTotals.net_return_rate<10?'우수':store.netTotals.net_return_rate<20?'주의':'위험'} · 반품 ${fmt(store.netTotals.return_qty)}개 ÷ 배송완료 ${fmt(store.netTotals.total_qty)}개` : '카페24 불러오기 필요'}</div>
      </div>
      ${!isNaN(avgMargin) ? `
      <div style="border-radius:13px;padding:16px;color:#fff;background:#0e7490;">
        <div style="font-size:.75rem;font-weight:600;opacity:.85;margin-bottom:4px;">전체 평균 마진율</div>
        <div style="font-size:1.9rem;font-weight:800;">${fmtP(avgMargin)}</div>
        <div style="font-size:.75rem;opacity:.7;margin-top:3px;">원가 매핑 ${mapped}/${store.salesData.length}개 · 공급가×1.1 기준</div>
      </div>` : ''}
      <div style="border-radius:13px;padding:16px;color:#fff;background:#b45309;">
        <div style="font-size:.75rem;font-weight:600;opacity:.85;margin-bottom:4px;">전체 취소·반품률 <span style="font-size:.7rem;opacity:.7;font-weight:400;">(주문일 기준·참고용)</span></div>
        <div style="font-size:1.9rem;font-weight:800;">${fmtP(overallRR)}</div>
        <div style="font-size:.75rem;opacity:.7;margin-top:3px;">취소수량 ÷ 결제수량 · 정확한 수치는 취소&반품 메뉴</div>
      </div>
    </div>

    <!-- 필터 -->
    <div class="filter-tabs">
      <button class="filter-tab ${store.perfFilter==='all'?'active':''}"    onclick="setPerfFilter('all')">전체 (${store.salesData.length})</button>
      <button class="filter-tab ${store.perfFilter==='good'?'active':''}"   onclick="setPerfFilter('good')">우수</button>
      <button class="filter-tab ${store.perfFilter==='warn'?'active':''}"   onclick="setPerfFilter('warn')">주의</button>
      <button class="filter-tab ${store.perfFilter==='danger'?'active':''}" onclick="setPerfFilter('danger')">위험</button>
      <button class="filter-tab ${store.perfFilter==='nodata'?'active':''}" onclick="setPerfFilter('nodata')">수량 부족</button>
    </div>
    <div style="font-size:.82rem;color:#6b7280;margin-bottom:10px;">※ 우수/주의/위험 = 배송완료일 기준 순반품률 (반품 신청·접수 포함) · 배송완료 수량 10개 미만 상품은 판정 보류</div>
  `;

  if (filtered.length === 0) {
    html += `<div class="empty-state"><div class="es-icon"><i class="fa-regular fa-folder-open"></i></div><p>해당 필터 조건에 맞는 상품이 없습니다.</p></div>`;
  } else {
    html += `<div class="table-wrap"><table>
      <thead><tr>
        <th class="m-hide">순위</th>
        ${store.prevRanks ? '<th class="m-hide" title="어제 결제수량 순위와 비교한 등락">등락<br><span style="font-size:.7rem;font-weight:400;color:#6b7280;">어제 대비</span></th>' : ''}
        <th>상품명</th>
        <th class="m-hide">판매가</th>
        <th class="m-hide">공급가<br><span style="font-size:.7rem;font-weight:400;color:#6b7280;">VAT 제외</span></th>
        <th class="m-hide">결제수량</th>
        <th class="m-hide">환불수량</th>
        <th>순판매량</th>
        ${isStaff() || isCS() ? '' : '<th class="m-hide">판매합계</th>'}
        <th>순반품률<br class="m-hide"><span class="m-hide" style="font-size:.7rem;font-weight:400;color:#6b7280;">배송완료일 기준</span></th>
        <th class="m-hide">취소&amp;반품률<br><span style="font-size:.7rem;font-weight:400;color:#6b7280;">주문일 기준·참고용</span></th>
        ${isCS() ? '' : '<th>마진율<br class="m-hide"><span class="m-hide" style="font-size:.7rem;font-weight:400;color:#6b7280;">공급가×1.1 기준</span></th>'}
      </tr></thead>
      <tbody>`;

    filtered.forEach(row => {
      const cd = findCostData(row.productName);
      let mg='—',cr='—',sc='—';
      if (cd && cd.salePrice > 0) {
        const vatCost = cd.supplyCost * 1.1;  // 공급가 × 1.1 (부가세 포함 실원가)
        const m = ((cd.salePrice - vatCost) / cd.salePrice) * 100;
        const c = (vatCost / cd.salePrice) * 100;
        mg = marginBadge(m); cr = costBadge(c); sc = fmt(cd.supplyCost)+'원';
      }
      html += `<tr>
        <td class="m-hide">${row.rank}</td>
        ${store.prevRanks ? `<td class="m-hide">${perfRankDelta(row)}</td>` : ''}
        <td class="name-cell">${row.productNo
          ? `<span onclick="showReturnReasons(${row.productNo})" title="클릭하면 이 상품의 반품 사유를 모아 봅니다"
                   style="cursor:pointer;color:#4338ca;text-decoration:underline dotted;text-underline-offset:3px;">${escHtml(row.productName)}</span>`
          : escHtml(row.productName)}${row.option?`<div><span class="option-tag">${escHtml(row.option)}</span></div>`:''}</td>
        <td class="m-hide">${row.salePrice>0?fmt(row.salePrice)+'원':'—'}</td>
        <td class="m-hide">${sc}</td>
        <td class="m-hide">${fmt(row.paidQty)}</td><td class="m-hide">${fmt(row.refundQty)}</td><td>${fmt(row.salesQty)}</td>
        ${isStaff() || isCS() ? '' : `<td class="m-hide">${row.salesTotal>0?fmt(row.salesTotal)+'원':'—'}</td>`}
        <td>${netReturnBadge(row)}${(() => {
          const nr = netOf(row);
          if (!nr) return '';
          let cell = `<div style="font-size:.7rem;color:#6b7280;margin-top:2px;">${fmt(nr.return_qty)} ÷ ${fmt(nr.total_qty)}개</div>`;
          if ((nr.options || []).length > 1) {
            cell += `<button onclick="toggleNetOptions(${row.productNo})" id="nr-btn-${row.productNo}"
              style="margin-top:3px;border:1px solid #c7d2fe;background:#eef2ff;color:#4338ca;border-radius:6px;padding:2px 8px;font-size:.7rem;font-weight:700;cursor:pointer;">옵션 ${nr.options.length}개 ▾</button>`;
          }
          return cell;
        })()}</td>
        <td style="color:#6b7280;" class="m-hide">${fmtP(row.returnRate)}</td>
        ${isCS() ? '' : `<td>${mg}</td>`}
      </tr>`;
      // 옵션별 순반품률 접이식 상세 행 (기본 숨김 — 버튼 클릭 시 표시)
      const nrRow = netOf(row);
      if (nrRow && (nrRow.options || []).length > 1) {
        const optHtml = nrRow.options.map(o => {
          const color = o.total_qty < 10 ? '#9ca3af' : o.net_return_rate >= 20 ? '#dc2626' : o.net_return_rate >= 10 ? '#d97706' : '#16a34a';
          return `<div style="display:flex;align-items:center;gap:10px;padding:3px 0;border-bottom:1px dashed #f3f4f6;flex-wrap:wrap;">
            <span style="flex:1;min-width:180px;text-align:left;">${escHtml(o.option)}</span>
            <span style="color:#6b7280;font-size:.75rem;">${fmt(o.return_qty)} ÷ ${fmt(o.total_qty)}개</span>
            <span style="font-weight:800;color:${color};width:64px;text-align:right;">${o.total_qty < 10 ? fmtP(o.net_return_rate) + ' ' : fmtP(o.net_return_rate)}</span>
          </div>`;
        }).join('');
        html += `<tr id="nr-opt-${row.productNo}" style="display:none;">
          <td colspan="${11 + (store.prevRanks ? 1 : 0)}" style="background:#f8f9ff;text-align:left;padding:10px 18px;font-size:.82rem;color:#374151;">
            <div style="font-weight:700;color:#4338ca;margin-bottom:4px;">옵션별 순반품률 <span style="font-weight:400;color:#6b7280;font-size:.75rem;">(= 배송완료 10개 미만, 참고용)</span></div>
            ${optHtml}
          </td>
        </tr>`;
      }
    });
    html += '</tbody></table></div>';
  }

  $('perf-result').innerHTML = html;

  // 분석 완료 시 저장 패널 표시 + 스냅샷 보관
  $('perf-save-panel').style.display = 'block';
  store.perfSnapshot = {
    overallRR, avgMargin, avgCostRate,
    totalPaid, totalCancel,
    productCount: store.salesData.length,
    mappedCount: mapped,
    period: ds && de ? { start: ds, end: de } : null
  };
  // 저장 이름 자동 제안 (기간 있으면)
  if (ds && !$('perf-save-label').value) {
    $('perf-save-label').value = ds.slice(0, 7).replace('-', '년 ') + '월';
  }
  loadPerfArchive();
}

/* 배송완료일 기준 순반품률 정보 (없으면 null) */
function netOf(row) {
  if (!store.netReturns || row.productNo === undefined) return null;
  return store.netReturns.get(row.productNo) || null;
}
/* 순반품률 등급 뱃지 — 배송완료 수량 10개 미만은 판정 보류 */
function netReturnBadge(row) {
  const nr = netOf(row);
  if (!nr || nr.total_qty < 10) return '<span class="status-badge badge-gray">수량 부족</span>';
  const rate = nr.net_return_rate;
  if (rate < 10) return `<span class="status-badge badge-green">우수 ${fmtP(rate)}</span>`;
  if (rate < 20) return `<span class="status-badge badge-yellow">주의 ${fmtP(rate)}</span>`;
  return `<span class="status-badge badge-red">위험 ${fmtP(rate)}</span>`;
}

/* 옵션별 순반품률 상세 행 접기/펼치기 */
function toggleNetOptions(productNo) {
  const row = $('nr-opt-' + productNo);
  const btn = $('nr-btn-' + productNo);
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : '';
  if (btn) btn.innerHTML = btn.innerHTML.replace(open ? '▴' : '▾', open ? '▾' : '▴');
}

function returnBadge(rate, paidQty) {
  if (paidQty < 10) return '<span class="status-badge badge-gray">수량 부족</span>';
  if (rate < 10)  return `<span class="status-badge badge-green">우수 ${fmtP(rate)}</span>`;
  if (rate < 20)  return `<span class="status-badge badge-yellow">주의 ${fmtP(rate)}</span>`;
  return `<span class="status-badge badge-red">위험 ${fmtP(rate)}</span>`;
}
function marginBadge(r) {
  if (isNaN(r)) return '<span class="status-badge badge-gray">—</span>';
  if (r >= 40) return `<span class="status-badge badge-green">${fmtP(r)}</span>`;
  if (r >= 20) return `<span class="status-badge badge-blue">${fmtP(r)}</span>`;
  return `<span class="status-badge badge-orange">${fmtP(r)}</span>`;
}
function costBadge(r) {
  if (isNaN(r)) return '<span class="status-badge badge-gray">—</span>';
  if (r < 40)  return `<span class="status-badge badge-green">${fmtP(r)}</span>`;
  if (r < 60)  return `<span class="status-badge badge-blue">${fmtP(r)}</span>`;
  return `<span class="status-badge badge-orange">${fmtP(r)}</span>`;
}

function perfFilterData(data, f) {
  // 우수/주의/위험 판정 = 배송완료일 기준 순반품률 (배송완료 수량 10개 미만은 판정 보류)
  const rateOf = r => { const nr = netOf(r); return nr && nr.total_qty >= 10 ? nr.net_return_rate : null; };
  switch(f) {
    case 'good':   return data.filter(r => { const x = rateOf(r); return x !== null && x < 10; });
    case 'warn':   return data.filter(r => { const x = rateOf(r); return x !== null && x >= 10 && x < 20; });
    case 'danger': return data.filter(r => { const x = rateOf(r); return x !== null && x >= 20; });
    case 'nodata': return data.filter(r => rateOf(r) === null);
    default: return data;
  }
}
function setPerfFilter(f) { store.perfFilter = f; renderPerfResult(); }

/* ══════════════════════════════════════
   [ B-1 ] 판매 성과 아카이브 기능
══════════════════════════════════════ */

let perfChartInstance = null;

/** 판매 성과 결과 저장 */
async function savePerfArchive() {
  const snap = store.perfSnapshot;
  if (!snap) { showToast('먼저 카페24 불러오기로 분석을 실행해주세요.'); return; }

  const label = $('perf-save-label').value.trim();
  if (!label) { showToast('저장 이름을 입력해주세요.'); return; }

  const body = {
    label,
    period_start:  snap.period ? snap.period.start : '',
    period_end:    snap.period ? snap.period.end   : '',
    overall_rr:    +snap.overallRR.toFixed(2),
    avg_margin:    isNaN(snap.avgMargin)    ? null : +snap.avgMargin.toFixed(2),
    avg_cost_rate: isNaN(snap.avgCostRate)  ? null : +snap.avgCostRate.toFixed(2),
    total_paid_qty:   snap.totalPaid,
    total_cancel_qty: snap.totalCancel,
    product_count:    snap.productCount,
    mapped_count:     snap.mappedCount,
    memo: $('perf-save-memo').value.trim()
  };

  try {
    await sbInsert('perf_archive', body);
    showToast(`"${label}" 저장 완료!`);
    $('perf-save-label').value = '';
    $('perf-save-memo').value  = '';
    await loadPerfArchive();
  } catch(e) { showToast('저장 실패: ' + e.message); }
}

/** 저장 목록 불러오기 */
async function loadPerfArchive() {
  try {
    const rows = await sbList('perf_archive');

    if (!rows.length) {
      $('perf-archive-list').innerHTML =
        '<div style="color:#6b7280;font-size:.88rem;text-align:center;padding:24px 0;">저장된 기록이 없습니다.</div>';
      return;
    }

    const rrColor  = v => v == null ? '#6b7280' : v < 10 ? '#16a34a' : v < 20 ? '#d97706' : '#dc2626';
    const mrgColor = v => v == null ? '#6b7280' : v >= 40 ? '#16a34a' : v >= 20 ? '#d97706' : '#dc2626';

    let html = `
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:.82rem;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #e5e7eb;">
              <input type="checkbox" id="perf-check-all" onchange="perfCheckAll(this)" title="전체선택" />
            </th>
            <th style="padding:10px 12px;text-align:left;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;white-space:nowrap;">이름</th>
            <th style="padding:10px 12px;text-align:left;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;white-space:nowrap;">기간</th>
            <th style="padding:10px 12px;text-align:right;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;white-space:nowrap;">취소·반품률</th>
            <th style="padding:10px 12px;text-align:right;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;white-space:nowrap;">평균 마진율</th>
            <th style="padding:10px 12px;text-align:right;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;white-space:nowrap;">평균 원가율</th>
            <th style="padding:10px 12px;text-align:right;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;white-space:nowrap;">상품 수</th>
            <th style="padding:10px 12px;text-align:left;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">메모</th>
            <th style="padding:10px 8px;border-bottom:2px solid #e5e7eb;"></th>
          </tr>
        </thead>
        <tbody>`;

    rows.forEach((r, i) => {
      const period = r.period_start && r.period_end
        ? `${r.period_start.replace(/-/g,'.')} ~ ${r.period_end.replace(/-/g,'.')}`
        : '기간 미설정';
      const bg = i % 2 === 0 ? '#fff' : '#f9fafb';
      html += `
        <tr style="background:${bg};" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='${bg}'">
          <td style="padding:10px 8px;text-align:center;">
            <input type="checkbox" class="perf-check" value="${r.id}" onchange="limitPerfCheck(this)" />
          </td>
          <td style="padding:10px 12px;font-weight:600;color:#1e1b4b;">${escHtml(r.label||'')}</td>
          <td style="padding:10px 12px;color:#6b7280;white-space:nowrap;">${period}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:700;color:${rrColor(r.overall_rr)};">${r.overall_rr != null ? fmtP(r.overall_rr) : '—'}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:700;color:${mrgColor(r.avg_margin)};">${r.avg_margin != null ? fmtP(r.avg_margin) : '—'}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:700;color:#374151;">${r.avg_cost_rate != null ? fmtP(r.avg_cost_rate) : '—'}</td>
          <td style="padding:10px 12px;text-align:right;color:#6b7280;">${r.product_count != null ? fmt(r.product_count)+'개' : '—'}</td>
          <td style="padding:10px 12px;color:#6b7280;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.memo||'—')}</td>
          <td style="padding:10px 8px;text-align:center;">
            <button onclick="deletePerfArchive('${r.id}')" style="background:#fee2e2;color:#dc2626;border:none;border-radius:6px;padding:4px 10px;font-size:.82rem;cursor:pointer;font-weight:600;">삭제</button>
          </td>
        </tr>`;
    });

    html += '</tbody></table></div>';
    $('perf-archive-list').innerHTML = html;
    store.perfArchiveRows = rows;
  } catch(e) {
    $('perf-archive-list').innerHTML = '<div style="color:#dc2626;padding:16px;">기록 불러오기 실패</div>';
  }
}

function perfCheckAll(master) {
  document.querySelectorAll('.perf-check').forEach(cb => { cb.checked = master.checked; });
  limitPerfCheckAll();
}
function limitPerfCheck(cb) {
  if ([...document.querySelectorAll('.perf-check:checked')].length > 5) {
    cb.checked = false;
    showToast('최대 5개까지 선택할 수 있습니다.');
  }
}
function limitPerfCheckAll() {
  let cnt = 0;
  document.querySelectorAll('.perf-check').forEach(cb => {
    if (cb.checked) { cnt++; if (cnt > 5) cb.checked = false; }
  });
  if (cnt > 5) showToast('최대 5개까지 선택됩니다.');
}

/** 선택 항목 비교 */
function comparePerfArchive() {
  const checked = [...document.querySelectorAll('.perf-check:checked')];
  if (checked.length < 2) { showToast('비교할 항목을 2개 이상 선택해주세요.'); return; }
  const ids  = checked.map(cb => cb.value);
  const rows = (store.perfArchiveRows || []).filter(r => ids.includes(r.id));
  rows.sort((a,b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  renderPerfCompare(rows);
  $('perf-compare-result').style.display = 'block';
  $('perf-compare-result').scrollIntoView({ behavior:'smooth', block:'start' });
}

/** 비교 차트 + 테이블 렌더링 */
function renderPerfCompare(rows) {
  const labels = rows.map(r => r.label || '미입력');

  if (perfChartInstance) perfChartInstance.destroy();
  const ctx = document.getElementById('perf-compare-chart').getContext('2d');
  perfChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '취소·반품률 (%)',
          data: rows.map(r => r.overall_rr ?? 0),
          backgroundColor: 'rgba(124,58,237,0.7)',
          borderColor: '#4f46e5',
          borderWidth: 2,
          borderRadius: 6,
          yAxisID: 'y'
        },
        {
          label: '평균 마진율 (%)',
          data: rows.map(r => r.avg_margin ?? 0),
          backgroundColor: 'rgba(8,145,178,0.7)',
          borderColor: '#0891b2',
          borderWidth: 2,
          borderRadius: 6,
          yAxisID: 'y'
        },
        {
          label: '평균 원가율 (%)',
          data: rows.map(r => r.avg_cost_rate ?? 0),
          backgroundColor: 'rgba(5,150,105,0.7)',
          borderColor: '#059669',
          borderWidth: 2,
          borderRadius: 6,
          yAxisID: 'y',
          type: 'line',
          tension: 0.35,
          fill: false,
          pointRadius: 5,
          pointBackgroundColor: '#059669'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { position:'top', labels:{ font:{ size:13 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` } }
      },
      scales: {
        y: { beginAtZero:true, ticks:{ callback: v => v+'%' }, title:{ display:true, text:'비율 (%)' } }
      }
    }
  });

  // 비교 테이블
  const rrColor  = v => v == null ? '#6b7280' : v < 10 ? '#16a34a' : v < 20 ? '#d97706' : '#dc2626';
  const mrgColor = v => v == null ? '#6b7280' : v >= 40 ? '#16a34a' : v >= 20 ? '#d97706' : '#dc2626';

  const rows_html = [
    { label:'기간', fn: r => { const p = r.period_start&&r.period_end ? `${r.period_start.replace(/-/g,'.')}~${r.period_end.replace(/-/g,'.')}` : '미설정'; return `<td style="padding:10px 14px;text-align:right;color:#6b7280;white-space:nowrap;">${p}</td>`; }, bg:'#fff' },
    { label:'취소·반품률 (수량)', fn: r => `<td style="padding:10px 14px;text-align:right;font-weight:700;color:${rrColor(r.overall_rr)};">${r.overall_rr!=null?fmtP(r.overall_rr):'—'}</td>`, bg:'#f9fafb' },
    { label:'전체 평균 마진율', fn: r => `<td style="padding:10px 14px;text-align:right;font-weight:700;color:${mrgColor(r.avg_margin)};">${r.avg_margin!=null?fmtP(r.avg_margin):'—'}</td>`, bg:'#fff' },
    { label:'전체 평균 원가율', fn: r => `<td style="padding:10px 14px;text-align:right;font-weight:700;color:#374151;">${r.avg_cost_rate!=null?fmtP(r.avg_cost_rate):'—'}</td>`, bg:'#f9fafb' },
    { label:'분석 상품 수',     fn: r => `<td style="padding:10px 14px;text-align:right;color:#6b7280;">${r.product_count!=null?fmt(r.product_count)+'개':'—'}</td>`, bg:'#fff' },
    { label:'원가 매핑 수',     fn: r => `<td style="padding:10px 14px;text-align:right;color:#6b7280;">${r.mapped_count!=null?fmt(r.mapped_count)+'개':'—'}</td>`, bg:'#f9fafb' },
    { label:'메모',             fn: r => `<td style="padding:10px 14px;text-align:right;color:#6b7280;">${escHtml(r.memo||'—')}</td>`, bg:'#fff' },
  ];

  let thtml = `
    <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:.82rem;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:10px 14px;text-align:left;font-weight:700;color:#374151;border-bottom:2px solid #e5e7eb;">항목</th>
          ${rows.map(r=>`<th style="padding:10px 14px;text-align:right;font-weight:700;color:#0891b2;border-bottom:2px solid #e5e7eb;">${escHtml(r.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rows_html.map(row=>`
          <tr style="background:${row.bg};">
            <td style="padding:10px 14px;font-weight:600;color:#374151;">${row.label}</td>
            ${rows.map(r=>row.fn(r)).join('')}
          </tr>`).join('')}
      </tbody>
    </table>
    </div>`;
  $('perf-compare-table').innerHTML = thtml;
}

/** 기록 삭제 */
async function deletePerfArchive(id) {
  if (!confirm('이 기록을 삭제할까요?')) return;
  try {
    await sbDelete('perf_archive', id);
    showToast('삭제 완료');
    $('perf-compare-result').style.display = 'none';
    await loadPerfArchive();
  } catch(e) { showToast('삭제 실패: ' + e.message); }
}
