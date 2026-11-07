// 서비스 키 자동 전환 (2026-11-07 — Supabase가 함수에 넣어 주는 서비스 키를 새 방식(sb_secret_…)으로 바꿨는데
// DB API가 그 키를 'PGRST303 JWT issued at future'로 거부해 전원 로그인이 막힌 사고 뒤).
//
// 하는 일: 이 함수가 우리 Supabase(SUPABASE_URL)로 보내는 요청에 서비스 키가 실려 있으면, 그 키가 거부될 때
// (401 + 키 문제 표시) 다른 서비스 키로 같은 요청을 한 번씩 다시 보낸다. 마지막에 통한 키를 기억해 다음 요청부터 먼저 쓴다.
// 후보 = SB_SERVICE_KEY(우리가 넣은 예전 service_role 키) → SUPABASE_SERVICE_ROLE_KEY(플랫폼이 넣는 값) → SUPABASE_SECRET_KEYS(새 키들).
// → 예전 키가 꺼지면(연말 예정) 새 키로, 새 키가 고장이면 예전 키로 저절로 넘어간다. 둘 다 안 되면 원래 응답 그대로.
// 키 거부로 난 401은 DB가 요청을 실행하기 전이라 쓰기 요청을 다시 보내도 두 번 반영되지 않는다.
// util.ts / agent.ts 맨 위에서 불러 모든 함수에 걸린다(새 함수도 util을 쓰면 자동). 같은 파일이 ~/dnrb-agents에도 있다 — 고치면 둘 다.

const env = (n: string) => (Deno.env.get(n) ?? "").trim();

function newKeys(): string[] {
  const raw = env("SUPABASE_SECRET_KEYS");
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.map(String);
    if (v && typeof v === "object") return Object.values(v).map(String);
  } catch { /* 글자 하나일 수 있음 */ }
  return raw.startsWith("sb_secret_") ? [raw] : [];
}

export const SB_KEYS: string[] = [...new Set([env("SB_SERVICE_KEY"), env("SUPABASE_SERVICE_ROLE_KEY"), ...newKeys()].filter(Boolean))];
const SB_HOST = (() => { try { return new URL(env("SUPABASE_URL")).host; } catch { return ""; } })();
// 키 때문에 거부됐다는 표시들(게이트웨이·PostgREST·Storage)
const KEY_FAIL = /PGRST30[0-3]|Invalid API key|Legacy API keys are disabled|Unregistered API key|API key.*(disabled|revoked|invalid)|invalid.*api.?key|JWT issued at future|JWSError|invalid signature/i;
function swapKey(h: Headers, from: string, to: string) {
  h.set("apikey", to);
  // 예전 키(JWT)는 Authorization에도 있어야 서비스 권한이 된다 — apikey만 있으면 일반 방문자(anon)로 처리됨(2026-11-07 실서버 확인).
  // 새 방식 키(sb_secret_)는 JWT가 아니라 Authorization에 실으면 안 됨 — apikey만.
  const a = h.get("authorization") ?? "";
  const carriesKey = !a || a.replace(/^Bearer\s+/i, "") === from;   // 사용자 토큰이 실린 요청이면 건드리지 않음
  if (!carriesKey) return;
  if (to.startsWith("eyJ")) h.set("authorization", `Bearer ${to}`); else h.delete("authorization");
}

// 전환 로직 본체 — keys 순서대로 시도, 마지막에 통한 키를 기억(시험 함수도 이걸 그대로 부른다)
export function makeKeyFailoverFetch(keys: string[], host: string, realFetch: typeof fetch): typeof fetch {
  let good = 0;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let base: Request;
    try { base = new Request(input, init); } catch { return realFetch(input, init); }
    let h0 = "";
    try { h0 = new URL(base.url).host; } catch { /* 무시 */ }
    if (h0 !== host) return realFetch(base);
    const sent = base.headers.get("apikey") ?? (base.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (keys.indexOf(sent) < 0) return realFetch(base);   // 서비스 키가 아닌 요청(anon·사용자 토큰)은 그대로
    const order = [good, ...keys.map((_, i) => i).filter((i) => i !== good)];
    let last: Response | null = null;
    for (const i of order) {
      const r = base.clone();
      const h = new Headers(r.headers);
      swapKey(h, sent, keys[i]);
      const res = await realFetch(new Request(r, { headers: h }));
      if (res.status === 401) {
        const t = await res.clone().text().catch(() => "");
        if (KEY_FAIL.test(t)) {
          console.warn(`[sbkey] 서비스 키 ${i + 1}번 거부: ${t.slice(0, 120)}`);
          last = res;
          continue;
        }
      }
      if (i !== good) { console.warn(`[sbkey] 서비스 키 ${good + 1}번 → ${i + 1}번으로 전환`); good = i; }
      return res;
    }
    return last as Response;
  };
}

const g = globalThis as unknown as { __sbkeyFetch?: boolean; fetch: typeof fetch };
if (!g.__sbkeyFetch && SB_HOST && SB_KEYS.length > 1) {
  g.__sbkeyFetch = true;
  g.fetch = makeKeyFailoverFetch(SB_KEYS, SB_HOST, g.fetch.bind(globalThis));
}
