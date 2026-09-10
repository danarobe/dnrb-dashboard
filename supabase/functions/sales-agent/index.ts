// ═══════════════════════════════════════════════
// 매출 분석 에이전트 (2026-09-10) — 에이전트 그룹의 첫 번째 담당자
//   매일 아침(08:00 KST, pg_cron `sales-agent-morning`) 또는 대시보드의 [지금 분석하기]로 실행.
//   ① 기존 함수(cafe24-analytics / cafe24-claims / meta-ads)를 x-agent-secret으로 호출해 숫자를 모으고
//   ② Claude(claude-opus-5)에게 넘겨 대표가 읽는 한국어 리포트(JSON)를 받아
//   ③ agent_reports 테이블에 저장 + 관리자 전원에게 알림(종 아이콘 + 웹 푸시)
//
//   POST ?action=run      (관리자 로그인 또는 x-cron-secret) body {date?: 'YYYY-MM-DD'} → 리포트 생성·저장
//   GET  ?action=collect  (관리자 로그인 또는 x-cron-secret) &date= → 수집 숫자만 반환 (Claude 미호출, 점검용)
//   GET  ?action=status   (관리자 로그인) → API 키 설정 여부·마지막 리포트
//
// 필요 secrets: ANTHROPIC_API_KEY(Claude), AGENT_SECRET(다른 함수 호출용 — 세 함수가 이 값을 admin으로 인정),
//               CRON_SECRET(자동 실행 검증, meta-budget과 공유), SUPABASE_ANON_KEY(함수 게이트웨이 통과용),
//               VAPID_*(선택 — 웹 푸시)
// ═══════════════════════════════════════════════
import Anthropic from "npm:@anthropic-ai/sdk";
import webpush from "npm:web-push@3.6.7";
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const AGENT_SECRET = Deno.env.get("AGENT_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = "claude-opus-5";
const AGENT = "sales";
const DASHBOARD_URL = "https://danarobe.github.io/dnrb-dashboard/";

// ── 날짜 (KST) ──
const seoulToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
function addDays(ymd: string, d: number): string {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const dow = (ymd: string) => DOW[new Date(`${ymd}T12:00:00Z`).getUTCDay()] + "요일";
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (a: number, b: number) => b > 0 ? Math.round((a - b) / b * 1000) / 10 : null;   // 증감률 %, 기준 0이면 null

// ── Supabase PostgREST (service_role) ──
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

// ── 다른 Edge Function 호출 (x-agent-secret → 그쪽에서 admin으로 인정) ──
async function callFn(name: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SB_URL}/functions/v1/${name}?${qs}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "x-agent-secret": AGENT_SECRET },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) throw new Error(`${name}(${params.action ?? ""}) ${res.status}: ${body?.error ?? ""}`);
  return body as Record<string, unknown>;
}

type Row = Record<string, unknown>;

// ═══════════════════ ① 수집 ═══════════════════
async function collect(D: string) {
  const errors: string[] = [];
  const safe = async <T>(label: string, f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) { errors.push(`${label}: ${String((e as Error)?.message ?? e).slice(0, 160)}`); return null; }
  };

  const d1 = addDays(D, -1), d7 = addDays(D, -7);
  const cur7 = [addDays(D, -6), D], prev7 = [addDays(D, -13), d7];
  const mStart = D.slice(0, 8) + "01";
  const lmEnd = addDays(mStart, -1);                       // 지난달 말일
  const lmStart = lmEnd.slice(0, 8) + "01";
  const lmSameDay = Math.min(Number(D.slice(8, 10)), Number(lmEnd.slice(8, 10)));
  const lmSame = [lmStart, lmStart.slice(0, 8) + String(lmSameDay).padStart(2, "0")];

  const rev = async (s: string, e: string) => {
    const b = await callFn("cafe24-analytics", { action: "revenue", start_date: s, end_date: e });
    return { revenue: num(b.revenue), orders: num(b.order_count) };
  };
  // 카페24 토큰 동시 갱신 경쟁 방지 — 첫 호출로 토큰을 확보한 뒤 나머지를 병렬로
  const rD = await safe("매출(어제)", () => rev(D, D));
  const [rD1, rD7, rCur7, rPrev7, rMtd, rLmSame, rLm] = await Promise.all([
    safe("매출(그저께)", () => rev(d1, d1)),
    safe("매출(지난주 같은 요일)", () => rev(d7, d7)),
    safe("매출(최근 7일)", () => rev(cur7[0], cur7[1])),
    safe("매출(직전 7일)", () => rev(prev7[0], prev7[1])),
    safe("매출(이달 누적)", () => rev(mStart, D)),
    safe("매출(지난달 같은 기간)", () => rev(lmSame[0], lmSame[1])),
    safe("매출(지난달 전체)", () => rev(lmStart, lmEnd)),
  ]);

  // 상품 조회수·주문 (애널리틱스, 가벼움)
  const sum = async (s: string, e: string) =>
    (await callFn("cafe24-analytics", { action: "summary", start_date: s, end_date: e })) as { rows: Row[]; totals: Row };
  const [sD, sCur, sPrev] = await Promise.all([
    safe("상품(어제)", () => sum(D, D)),
    safe("상품(최근 7일)", () => sum(cur7[0], cur7[1])),
    safe("상품(직전 7일)", () => sum(prev7[0], prev7[1])),
  ]);

  // 취소·반품 (최근 7일, 주문일 기준 — 주문 스캔이라 가장 오래 걸림)
  const claims = await safe("취소반품(최근 7일)", () =>
    callFn("cafe24-claims", { start_date: cur7[0], end_date: cur7[1] }));

  // Meta 광고 (연동 안 됐으면 null)
  const meta = async (s: string, e: string) => {
    const b = await callFn("meta-ads", { action: "summary", start_date: s, end_date: e });
    if (b.error === "not_connected") return null;
    return { spend: num(b.spend), purchases: num(b.purchases), purchase_value: num(b.purchase_value), meta_roas: num(b.meta_roas) };
  };
  const [mD, mCur7, mPrev7] = await Promise.all([
    safe("광고(어제)", () => meta(D, D)),
    safe("광고(최근 7일)", () => meta(cur7[0], cur7[1])),
    safe("광고(직전 7일)", () => meta(prev7[0], prev7[1])),
  ]);

  // ── 파생 지표 ──
  const prevMap = new Map<number, Row>((sPrev?.rows ?? []).map((r) => [Number(r.product_no), r]));
  const K = 5, MIN_QTY = 10;
  // 급증: 홈 '판매량 급증 TOP10'과 같은 규칙 (이번 주 10개↑, 평활 성장배수)
  const trending = (sCur?.rows ?? [])
    .filter((r) => num(r.order_qty) >= MIN_QTY)
    .map((r) => {
      const p = prevMap.get(Number(r.product_no));
      const prevQty = p ? num(p.order_qty) : 0;
      return {
        product_no: Number(r.product_no), name: String(r.product_name ?? ""),
        qty_7d: num(r.order_qty), qty_prev7d: prevQty, views_7d: num(r.views), rate_7d: num(r.rate),
        score: (num(r.order_qty) + K) / (prevQty + K),
      };
    })
    .filter((r) => r.qty_7d > r.qty_prev7d)
    .sort((a, b) => b.score - a.score).slice(0, 8)
    .map(({ score: _s, ...r }) => r);

  // 주문율 하락: 두 주 모두 조회 300↑, 직전 주문율 1%↑, 이번 주 주문율이 직전의 60% 이하
  const rateDrops = (sCur?.rows ?? [])
    .map((r) => {
      const p = prevMap.get(Number(r.product_no));
      if (!p) return null;
      const v = num(r.views), pv = num(p.views), rt = num(r.rate), prt = num(p.rate);
      if (v < 300 || pv < 300 || prt < 1 || rt > prt * 0.6) return null;
      return { product_no: Number(r.product_no), name: String(r.product_name ?? ""), views_7d: v, rate_7d: rt, rate_prev7d: prt, qty_7d: num(r.order_qty), qty_prev7d: num(p.order_qty) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.views_7d - a.views_7d).slice(0, 6);

  // 조회수는 많은데 안 팔리는 상품 (최근 7일 조회 500↑, 주문율 0.5% 미만)
  const highViewLowRate = (sCur?.rows ?? [])
    .filter((r) => num(r.views) >= 500 && num(r.rate) < 0.5)
    .sort((a, b) => num(b.views) - num(a.views)).slice(0, 5)
    .map((r) => ({ product_no: Number(r.product_no), name: String(r.product_name ?? ""), views_7d: num(r.views), rate_7d: num(r.rate), qty_7d: num(r.order_qty) }));

  const topYesterday = (sD?.rows ?? [])
    .filter((r) => num(r.order_qty) > 0)
    .sort((a, b) => num(b.order_qty) - num(a.order_qty)).slice(0, 8)
    .map((r) => ({ product_no: Number(r.product_no), name: String(r.product_name ?? ""), qty: num(r.order_qty), amount: num(r.order_amount), views: num(r.views), rate: num(r.rate) }));

  const totals = (s: { totals: Row } | null) => s ? { views: num(s.totals.views), orders: num(s.totals.order_count), qty: num(s.totals.order_qty), rate: num(s.totals.rate) } : null;
  const roas = (r: { revenue: number } | null, m: { spend: number } | null) => r && m && m.spend > 0 ? Math.round(r.revenue / m.spend * 100) / 100 : null;

  const c = claims as Record<string, Row> | null;
  const top3 = (arr: unknown) => Array.isArray(arr) ? (arr as Row[]).slice(0, 3).map((x) => `${x.reason} ${x.cnt}건`) : [];

  return {
    base_date: D, base_dow: dow(D), generated_at: new Date().toISOString(),
    periods: { yesterday: D, day_before: d1, same_dow_last_week: d7, last7: cur7, prev7, mtd: [mStart, D], last_month_same: lmSame, last_month: [lmStart, lmEnd] },
    revenue: {
      yesterday: rD, day_before: rD1, same_dow_last_week: rD7,
      last7: rCur7, prev7: rPrev7, mtd: rMtd, last_month_same: rLmSame, last_month: rLm,
      change_pct: {
        vs_day_before: rD && rD1 ? pct(rD.revenue, rD1.revenue) : null,
        vs_same_dow_last_week: rD && rD7 ? pct(rD.revenue, rD7.revenue) : null,
        last7_vs_prev7: rCur7 && rPrev7 ? pct(rCur7.revenue, rPrev7.revenue) : null,
        mtd_vs_last_month_same: rMtd && rLmSame ? pct(rMtd.revenue, rLmSame.revenue) : null,
      },
      avg_order_value_yesterday: rD && rD.orders > 0 ? Math.round(rD.revenue / rD.orders) : null,
    },
    traffic: { yesterday: totals(sD), last7: totals(sCur), prev7: totals(sPrev) },
    products: { top_yesterday: topYesterday, trending_7d: trending, rate_drops_7d: rateDrops, high_view_low_rate_7d: highViewLowRate },
    claims_last7: c ? {
      cancel_count: num(c.cancel?.count), cancel_amount: num(c.cancel?.amount), cancel_reasons_top3: top3(c.cancel?.reasons),
      return_count: num(c.return?.count), return_amount: num(c.return?.amount), return_reasons_top3: top3(c.return?.reasons),
      note: "카페24 자사몰 기준(네이버페이 주문 제외), 주문일 기준",
    } : null,
    ads: mCur7 === null && mD === null ? null : {
      yesterday: mD, last7: mCur7, prev7: mPrev7,
      roas_cafe24: { yesterday: roas(rD, mD), last7: roas(rCur7, mCur7), prev7: roas(rPrev7, mPrev7) },
      note: "ROAS(카페24) = 카페24 결제매출 ÷ Meta 광고비. Meta ROAS는 Meta가 잡은 전환 기준",
    },
    errors,
  };
}

// ═══════════════════ ② Claude 리포트 ═══════════════════
const REPORT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "한 문장 제목, 40자 이내. 어제 실적의 핵심 한 줄" },
    mood: { type: "string", enum: ["good", "neutral", "bad"], description: "어제 실적의 전반 톤" },
    summary: { type: "array", items: { type: "string" }, description: "핵심 요약 3~5줄. 각 줄에 숫자 근거 포함" },
    highlights: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title", "detail"], additionalProperties: false },
      description: "주목할 상품·신호 (밀어줄 만한 것). 최대 5개",
    },
    warnings: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title", "detail"], additionalProperties: false },
      description: "걱정되는 신호 (하락·반품·광고 효율 악화). 없으면 빈 배열",
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "오늘 할 일 한 줄" },
          why: { type: "string", description: "왜 (데이터 근거)" },
          owner: { type: "string", enum: ["광고팀", "상품팀", "CS팀", "대표"] },
        },
        required: ["title", "why", "owner"], additionalProperties: false,
      },
      description: "오늘 당장 실행할 구체적 액션 정확히 3개",
    },
    note: { type: "string", description: "데이터 한계나 주의점. 없으면 빈 문자열" },
  },
  required: ["headline", "mood", "summary", "highlights", "warnings", "actions", "note"],
  additionalProperties: false,
} as const;

const SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 매출 분석 담당자입니다. 매일 아침 대표에게 어제 실적을 보고합니다.

독자: 개발자가 아닌 경영자. 쉬운 한국어로, 짧고 분명하게 씁니다.
원칙:
- 모든 판단에는 숫자 근거를 붙입니다 (예: "어제 매출 1,230만 원, 지난주 같은 요일보다 12% 감소").
- 요일 효과를 항상 고려합니다. 전날 대비보다 '지난주 같은 요일 대비'와 '최근 7일 vs 직전 7일'을 더 신뢰합니다.
- 금액은 '만 원' 단위로 반올림해 읽기 쉽게 씁니다 (12,345,678원 → 1,235만 원). 억 단위면 '1.2억 원'.
- 확실하지 않은 원인은 "~로 보입니다", "확인 필요"처럼 추측임을 밝힙니다.
- 액션은 오늘 당장 할 수 있는 구체적인 것 3개. 담당(광고팀/상품팀/CS팀/대표)을 정합니다. 예산 변경·가격 변경 같은 큰 결정은 '대표 확인 후'로 표현합니다.
- 데이터가 비어 있거나(null) 수집 오류(errors)가 있으면 그 부분은 모른다고 쓰고, 있는 데이터로만 판단합니다.
- 상품명은 데이터에 있는 그대로 씁니다. 없는 상품이나 숫자를 만들어내지 않습니다.
- 응답은 지정된 JSON 형식으로만 씁니다.`;

async function writeReport(data: unknown): Promise<{ report: Record<string, unknown>; usage: unknown; model: string }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 미설정 — Supabase secrets에 Claude API 키를 넣고 sales-agent를 재배포하세요");
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: REPORT_SCHEMA } },
    messages: [{
      role: "user",
      content: `아래는 기준일(어제)까지의 수집 데이터입니다. 아침 리포트를 작성하세요.\n\n${JSON.stringify(data)}`,
    }],
  } as Parameters<typeof client.messages.create>[0]);
  if (res.stop_reason === "refusal") throw new Error("Claude가 응답을 거부했습니다");
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return { report: JSON.parse(text), usage: res.usage, model: res.model };
}

// ═══════════════════ ③ 저장 + 알림 ═══════════════════
async function saveRow(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await rest("agent_reports", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`리포트 저장 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())[0];
}

async function notifyAdmins(D: string, headline: string): Promise<{ saved: number; pushed: number }> {
  const ures = await rest("app_users?role=eq.admin&select=id");
  const ids: string[] = ures.ok ? ((await ures.json()) as { id: string }[]).map((u) => u.id) : [];
  if (!ids.length) return { saved: 0, pushed: 0 };
  const msg = `[${D.slice(5).replace("-", "/")} 매출 리포트] ${headline}`.slice(0, 200);
  await rest("notifications", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(ids.map((user_id) => ({ user_id, actor_name: "매출 분석 담당", message: msg, link_menu: "report" }))),
  });
  let pushed = 0;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY") ?? "", priv = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  if (pub && priv) {
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com", pub, priv);
    const sres = await rest(`push_subscriptions?user_id=in.(${ids.map((i) => `"${i}"`).join(",")})`);
    const subs = sres.ok ? await sres.json() : [];
    const payload = JSON.stringify({ title: "오늘의 매출 리포트가 도착했어요", body: headline, url: `${DASHBOARD_URL}#report` });
    await Promise.all(subs.map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); pushed++; }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode ?? 0;
        if (code === 404 || code === 410) await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      }
    }));
  }
  return { saved: ids.length, pushed };
}

// ═══════════════════ 핸들러 ═══════════════════
Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";

  // 서버 간(cron) 또는 관리자 로그인
  const viaCron = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
  const me = viaCron ? null : await verifyAuthToken(req);
  if (!viaCron && (!me || me.role !== "admin")) return json({ error: "접근 권한이 없습니다" }, 403);

  try {
    if (action === "status") {
      const r = await rest(`agent_reports?agent=eq.${AGENT}&select=id,report_date,status,trigger,created_at,error&order=created_at.desc&limit=1`);
      const last = r.ok ? ((await r.json())[0] ?? null) : null;
      return json({ configured: !!ANTHROPIC_API_KEY, secret_ready: !!AGENT_SECRET, model: MODEL, last });
    }

    // 기준일: 지정 없으면 어제(KST). 오늘은 집계가 안 끝나 제외.
    let D = url.searchParams.get("date") ?? "";
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body?.date) D = String(body.date);
    }
    const yesterday = addDays(seoulToday(), -1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(D) || D > yesterday) D = yesterday;
    if (!AGENT_SECRET) return json({ error: "AGENT_SECRET 미설정" }, 500);

    if (action === "collect") {
      const t0 = Date.now();
      const data = await collect(D);
      return json({ ...data, took_ms: Date.now() - t0 });
    }

    if (action === "run") {
      const trigger = viaCron ? "cron" : "manual";
      const t0 = Date.now();
      let data: Awaited<ReturnType<typeof collect>> | null = null;
      try {
        data = await collect(D);
        const { report, usage, model } = await writeReport(data);
        const row = await saveRow({
          agent: AGENT, report_date: D, trigger, status: "ok", data, report, model, usage,
          created_by: me?.id ?? null,
        });
        const notified = await notifyAdmins(D, String(report.headline ?? "")).catch(() => ({ saved: 0, pushed: 0 }));
        return json({ ok: true, id: row.id, report_date: D, report, notified, took_ms: Date.now() - t0 });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 500);
        // 실패도 남긴다 — 화면에서 "왜 안 왔는지" 볼 수 있게. 수집 데이터가 있으면 같이 저장.
        await saveRow({ agent: AGENT, report_date: D, trigger, status: "error", data, error: msg, created_by: me?.id ?? null }).catch(() => {});
        return json({ error: msg, report_date: D, took_ms: Date.now() - t0 }, 500);
      }
    }

    return json({ error: "알 수 없는 action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
