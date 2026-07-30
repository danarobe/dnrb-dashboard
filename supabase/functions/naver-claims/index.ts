// ═══════════════════════════════════════════════
// 네이버 커머스API 취소·반품 집계 함수
//   GET ?start_date=2026-07-01&end_date=2026-07-26
//   → { cancel: {count, amount, reasons[]}, return: {...} }
//
//   GET ...&raw=1 → 첫 상세조회 원본 반환 (필드 매핑 디버그용)
//
// 인증: client_credentials + bcrypt 전자서명
//   client_secret_sign = base64( bcrypt(client_id + "_" + timestamp, salt=client_secret) )
//
// 필요 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
// ═══════════════════════════════════════════════
import bcrypt from "npm:bcryptjs@2.4.3";
import { handleOptions, json, getToken, saveToken, verifyAuthToken } from "../_shared/util.ts";

const CLIENT_ID = Deno.env.get("NAVER_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("NAVER_CLIENT_SECRET")!;
const API_BASE = "https://api.commerce.naver.com/external";

// ── 고정 IP 프록시 (네이버 커머스API는 등록된 IP에서만 호출 허용) ──
// NAVER_PROXY_URL 예: http://fixie:비밀번호@ventoux.usefixie.com:80
// Supabase Edge Function의 egress IP는 유동적이라 프록시 없이는 IP 등록이 불가능.
// 네이버 API 호출에만 프록시를 적용한다 (Supabase REST 등 나머지는 직접 연결).
function makeProxyClient(): Deno.HttpClient | undefined {
  const raw = Deno.env.get("NAVER_PROXY_URL");
  if (!raw) return undefined;
  const u = new URL(raw);
  const basicAuth = u.username
    ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
    : undefined;
  u.username = ""; u.password = "";
  // deno-lint-ignore no-explicit-any
  return (Deno as any).createHttpClient({ proxy: { url: u.toString(), basicAuth } });
}
const PROXY_CLIENT = makeProxyClient();

// ── 토큰 발급 (만료 시 재발급, api_tokens 캐시) ──
async function getAccessToken(): Promise<string> {
  const cached = await getToken("naver");
  if (cached?.access_token && cached.expires_at &&
      new Date(cached.expires_at).getTime() - Date.now() > 5 * 60 * 1000) {
    return cached.access_token;
  }

  const timestamp = Date.now();
  const password = `${CLIENT_ID}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, CLIENT_SECRET); // client_secret이 bcrypt salt 형식
  const sign = btoa(hashed);

  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      timestamp: String(timestamp),
      client_secret_sign: sign,
      grant_type: "client_credentials",
      type: "SELF",
    }),
    client: PROXY_CLIENT,
  } as RequestInit);
  const body = await res.json();
  if (!res.ok) throw new Error(`네이버 토큰 발급 실패 ${res.status}: ${JSON.stringify(body)}`);

  const expiresIn = Number(body.expires_in ?? 10800); // 기본 3시간
  await saveToken({
    provider: "naver",
    access_token: String(body.access_token),
    refresh_token: null,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    refresh_expires_at: null,
  });
  return String(body.access_token);
}

async function naverFetch(path: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    client: PROXY_CLIENT,
  } as RequestInit);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`naver ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// KST 기준 ISO 8601 (+09:00) 문자열
function kstISO(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().replace("Z", "").replace(/\.\d+$/, ".000") + "+09:00";
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? "0").replace(/[^\d.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

function deepPick(obj: unknown, keys: string[]): string {
  // 중첩 객체에서 첫 번째로 발견되는 키 값을 반환
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] != null && String(o[k]).trim()) return String(o[k]).trim();
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") {
      const found = deepPick(v, keys);
      if (found) return found;
    }
  }
  return "";
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  // 취소&반품 메뉴는 관리자 전용 — 서버에서도 차단
  const authed = await verifyAuthToken(req);
  if (!authed || authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);

  const url = new URL(req.url);
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  const raw = url.searchParams.get("raw") === "1";
  if (!startDate || !endDate) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);

  try {
    const token = await getAccessToken();

    // ── ① 변경상품주문 수집: last-changed-statuses는 24시간 범위 제한 → 일 단위 루프 ──
    const startMs = new Date(`${startDate}T00:00:00+09:00`).getTime();
    const endMs = Math.min(
      new Date(`${endDate}T23:59:59+09:00`).getTime(),
      Date.now(),
    );

    const productOrderIds = new Set<string>();
    for (let from = startMs; from < endMs; from += 24 * 3600 * 1000) {
      const to = Math.min(from + 24 * 3600 * 1000 - 1000, endMs);
      let moreSequence: string | null = null;
      let moreFrom: string | null = null;

      // 페이지네이션 (more 필드)
      for (let page = 0; page < 50; page++) {
        const params = new URLSearchParams({
          lastChangedFrom: moreFrom ?? kstISO(new Date(from)),
          lastChangedTo: kstISO(new Date(to)),
        });
        // 기본: 클레임(취소/반품/교환) 완료 건. changed_type=ALL이면 필터 없이 전체 변경 건 (디버그용)
        const changedType = url.searchParams.get("changed_type") ?? "CLAIM_COMPLETED";
        if (changedType !== "ALL") params.set("lastChangedType", changedType);
        if (moreSequence) params.set("moreSequence", moreSequence);

        const body = await naverFetch(
          `/v1/pay-order/seller/product-orders/last-changed-statuses?${params}`,
          token,
        );
        const data = (body.data ?? {}) as Record<string, unknown>;
        const list = (data.lastChangeStatuses ?? []) as Record<string, unknown>[];
        for (const s of list) {
          if (s.productOrderId) productOrderIds.add(String(s.productOrderId));
        }
        const more = data.more as Record<string, unknown> | undefined;
        if (!more) break;
        moreSequence = String(more.moreSequence ?? "");
        moreFrom = String(more.moreFrom ?? "");
        if (!moreSequence && !moreFrom) break;
      }
    }

    // ── ② 상세 조회 (300건 단위) 후 취소/반품 분류 집계 ──
    type Bucket = { count: number; amount: number; reasons: Record<string, number> };
    const cancel: Bucket = { count: 0, amount: 0, reasons: {} };
    const ret: Bucket = { count: 0, amount: 0, reasons: {} };

    const ids = [...productOrderIds];
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const body = await naverFetch(`/v1/pay-order/seller/product-orders/query`, token, {
        method: "POST",
        body: JSON.stringify({ productOrderIds: chunk }),
      });
      if (raw && i === 0) return json({ found_ids: ids.length, raw: body });

      const rows = (body.data ?? []) as Record<string, unknown>[];
      for (const row of rows) {
        const po = (row.productOrder ?? row) as Record<string, unknown>;
        const claimType = deepPick(row, ["claimType"]);
        const claimStatus = deepPick(row, ["claimStatus"]);
        const amount = num(po.totalPaymentAmount ?? po.paymentAmount);
        const reason = deepPick(row, ["claimRequestReason", "cancelDetailedReason", "returnDetailedReason", "requestReason"]) || "사유 미기재";

        const isCancel = claimType === "CANCEL" && /CANCEL_DONE|취소/.test(claimStatus || "CANCEL_DONE");
        const isReturn = claimType === "RETURN" && /RETURN_DONE|반품/.test(claimStatus || "RETURN_DONE");

        if (isCancel) {
          cancel.count++; cancel.amount += amount;
          cancel.reasons[reason] = (cancel.reasons[reason] ?? 0) + 1;
        } else if (isReturn) {
          ret.count++; ret.amount += amount;
          ret.reasons[reason] = (ret.reasons[reason] ?? 0) + 1;
        }
      }
    }

    const toRanked = (m: Record<string, number>) =>
      Object.entries(m).map(([reason, cnt]) => ({ reason, cnt }))
        .sort((a, b) => b.cnt - a.cnt);

    return json({
      provider: "naver",
      period: { start: startDate, end: endDate },
      fetched_product_orders: ids.length,
      cancel: { count: cancel.count, amount: Math.round(cancel.amount), reasons: toRanked(cancel.reasons) },
      return: { count: ret.count, amount: Math.round(ret.amount), reasons: toRanked(ret.reasons) },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
