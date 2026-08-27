// ═══════════════════════════════════════════════════════════════
// 근무관리 키오스크 함수 — 매장 PC 전용, 직원 로그인 없음
//
// ⚠️ anon key는 공개 레포(config.js)에 노출된 값이다 — 절대 인증 수단이 아니다.
//    인증은 ① 기기 토큰(x-kiosk-token, 등록된 매장 PC만) ② PIN 세션(3분)
//    ③ 매장 IP 확인(출퇴근 등록만) 세 겹이다. 이 중 하나라도 "간소화"하면
//    아무나 집에서 출퇴근을 찍을 수 있게 된다.
//
// 액션 10개 — 이 목록은 동결. 키오스크에 기능을 추가하려면 6터치 원칙(이름→PIN 4자리
// →출근/퇴근)을 지킬 수 있는지부터 따질 것.
//   register_device { pairing_code }                  기기 등록 (최초 1회)
//   today           {}                                직원 명단+오늘 상태 (기기)
//   week_leaves     {}                                이번주+다음주 승인 휴가 (기기)
//   verify_pin      { employee_id, pin }              PIN 확인 → 3분 세션 (기기)
//   clock_in        { session, request_id, client_time?, queued? }   (기기+세션+IP)
//   clock_out       { session, request_id, client_time?, queued? }   (기기+세션+IP)
//   my_records      { session }                       내 최근 출퇴근 14건 (기기+세션)
//   my_leaves       { session }                       내 휴가 내역+잔여 연차 (기기+세션)
//   request_edit    { session, attendance_id?, date, requested_clock_in, requested_clock_out?, reason }
//   request_leave   { session, date, end_date?, type, reason?, skip_offdays? }  항상 pending
//
// 직원 ID는 항상 세션 토큰에서 읽는다 — 요청 본문의 employee_id는 verify_pin에서만 쓴다.
// (기존 Express는 clock-in이 PIN을 검증하지 않아 아무나 남의 출퇴근을 찍을 수 있었다)
//
// 세션 토큰은 'wmk:' 접두로 서명해 대시보드 로그인 토큰(x-auth-token)과 서명이
// 절대 호환되지 않는다. 반대 방향도 마찬가지.
// ═══════════════════════════════════════════════════════════════
import bcrypt from 'npm:bcryptjs@2.4.3';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const AUTH_SECRET = Deno.env.get('AUTH_SECRET') ?? '';

// util.ts의 CORS_HEADERS에는 x-kiosk-token이 없어 브라우저 preflight가 거부된다.
// util을 고치면 전 함수 재배포(과거 사고 이력)라, 이 함수는 자체 CORS를 쓴다 — util 미의존.
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-kiosk-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function handleOptions(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS }) : null;
}

const SESSION_TTL = 3 * 60 * 1000;            // PIN 세션 3분
const CLOCK_GRACE = 24 * 3600 * 1000;         // 오프라인 재전송: 출퇴근만 만료 후 24h 유예 (request_id 멱등 전제)
const PIN_LOCK_AFTER = 5;                     // 5회 실패 →
const PIN_LOCK_MS = 5 * 60 * 1000;            // 5분 잠금

async function rest(path: string, init: RequestInit = {}): Promise<any[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

/* 휴가 신청 시 관리자 전원에게 앱 알림 (2026-08-27 사용자 요청 — 마이페이지 신청과 동일하게 맞춤).
   6터치 흐름·응답 형태는 그대로. 알림 실패가 신청 자체를 막지 않도록 호출부에서 try로 감싼다. */
async function notifyAdminsLeave(name: string, dates: string[], type: string, reason?: string | null) {
  const admins = await rest('app_users?role=eq.admin&select=id');
  if (!admins.length || !dates.length) return;
  const label = type === 'annual' ? '연차' : type === 'half' ? '반차' : '여름휴가';
  const when = dates.length > 1 ? `${dates[0]} 외 ${dates.length - 1}일` : dates[0];
  await rest('notifications', {
    method: 'POST',
    body: JSON.stringify(admins.map((a: any) => ({
      user_id: a.id, actor_name: name,
      message: `휴가 신청 — ${when} ${label}${reason ? ` (${reason})` : ''}`,
      link_menu: 'wm', read: false,
    }))),
  });
}

function kstNow(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const D_RE = /^\d{4}-\d{2}-\d{2}$/;

function fmtD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── 세션 토큰: 'wmk:' 접두 서명 (대시보드 토큰과 비호환) ── */
async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('wmk:' + data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function signSession(eid: number, name: string): Promise<{ session: string; exp: number }> {
  const exp = Date.now() + SESSION_TTL;
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ eid, name, exp }))));
  return { session: `${payload}.${await hmac(payload)}`, exp };
}
async function verifySession(token: string, graceMs = 0): Promise<{ eid: number; name: string } | null> {
  const dot = (token || '').lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  if (await hmac(payload) !== token.slice(dot + 1)) return null;
  try {
    const s = JSON.parse(decodeURIComponent(escape(atob(payload))));
    if (!s.exp || s.exp + graceMs < Date.now()) return null;
    return { eid: Number(s.eid), name: String(s.name) };
  } catch { return null; }
}

/* ── 기기 인증 ── */
async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}
async function requireDevice(req: Request): Promise<any | null> {
  const raw = req.headers.get('x-kiosk-token') ?? '';
  if (!raw) return null;
  const hash = await sha256hex(raw);
  const [dev] = await rest(`wm_devices?token_hash=eq.${hash}&active=is.true&select=*`);
  if (!dev) return null;
  // last_seen 갱신 (실패해도 무시)
  rest(`wm_devices?id=eq.${dev.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_seen_at: new Date().toISOString(), last_ip: clientIp(req) }),
  }).catch(() => {});
  return dev;
}

async function log(device_id: string | null, employee_id: number | null, action: string,
  ok: boolean, ip: string, detail: unknown = null, request_id: string | null = null) {
  try {
    await rest('wm_kiosk_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ device_id, employee_id, action, ok, ip, detail, request_id }),
    });
  } catch (_) { /* 로그 실패가 본 동작을 막으면 안 됨 */ }
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  const ip = clientIp(req);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    /* ── 기기 등록 (페어링 코드 → 토큰 발급, 1회용) ── */
    if (action === 'register_device') {
      const code = String(body.pairing_code ?? '').trim();
      if (!/^\d{8}$/.test(code)) return json({ error: '등록 코드는 8자리 숫자입니다' }, 400);
      const [dev] = await rest(`wm_devices?pairing_code=eq.${code}&active=is.true&select=*`);
      if (!dev || !dev.pairing_exp || new Date(dev.pairing_exp).getTime() < Date.now()) {
        await log(null, null, 'register_device', false, ip, { code_prefix: code.slice(0, 2) });
        return json({ error: '등록 코드가 올바르지 않거나 만료되었습니다. 대시보드에서 새 코드를 발급받으세요.' }, 400);
      }
      const raw = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await rest(`wm_devices?id=eq.${dev.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          token_hash: await sha256hex(raw), pairing_code: null, pairing_exp: null,
          allowed_ips: [ip],          // 등록한 곳(매장) IP를 허용 목록에 자동 등재
          last_ip: ip, last_seen_at: new Date().toISOString(),
        }),
      });
      await log(dev.id, null, 'register_device', true, ip, { label: dev.label });
      return json({ device_token: raw, label: dev.label });
    }

    /* ── 이하 전부 기기 토큰 필요 ── */
    const dev = await requireDevice(req);
    if (!dev) return json({ error: 'device_not_registered', message: '등록되지 않은 기기입니다.' }, 401);

    const now = kstNow();
    const today = now.slice(0, 10);

    if (action === 'today') {
      const [emps, att] = await Promise.all([
        rest('wm_employees?select=id,name,type,birthday&active=is.true&order=name'),
        rest(`wm_attendance?date=eq.${today}&select=employee_id,clock_in,clock_out`),
      ]);
      const attMap: Record<number, any> = {};
      for (const r of att) attMap[r.employee_id] = r;
      const mmdd = today.slice(5);
      // 명시적 필드만 — PIN·시급·월급·계좌·생일원본 절대 금지 (기존 유출 버그의 직접 수정)
      const rows = emps.map((e: any) => {
        const r = attMap[e.id];
        return {
          id: e.id, name: e.name, type: e.type,
          status: r?.clock_in && !r?.clock_out ? 'working' : r?.clock_in ? 'done' : 'absent',
          today_in: r?.clock_in ? r.clock_in.substring(11, 16) : null,
          is_birthday: !!(e.birthday && e.birthday.slice(5) === mmdd),
        };
      });
      return json({ server_date: today, server_time: now.slice(11), employees: rows });
    }

    if (action === 'week_leaves') {
      const d = new Date(today + 'T00:00:00');
      const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const end = new Date(mon); end.setDate(mon.getDate() + 13);   // 이번 주 월 ~ 다음 주 일
      const [emps, rows] = await Promise.all([
        rest('wm_employees?select=id,name&limit=100'),
        rest(`wm_leaves?status=eq.approved&date=gte.${fmtD(mon)}&date=lte.${fmtD(end)}&select=id,employee_id,date,type&order=date`),
      ]);
      const nameOf = Object.fromEntries(emps.map((e: any) => [e.id, e.name]));
      // reason은 내보내지 않는다 — 화면에 쓰지도 않고 병가 사유 등이 담길 수 있음
      return json({
        server_date: today,
        this_monday: fmtD(mon),
        leaves: rows.map((r: any) => ({ id: r.id, employee_id: r.employee_id, name: nameOf[r.employee_id], date: r.date, type: r.type })),
      });
    }

    if (action === 'verify_pin') {
      const eid = Number(body.employee_id);
      const pin = String(body.pin ?? '');
      const [emp] = await rest(`wm_employees?id=eq.${eid}&active=is.true&select=id,name,pin_hash,pin_fail_count,pin_locked_until,birthday`);
      if (!emp) return json({ error: '직원 없음' }, 404);
      if (emp.pin_locked_until && new Date(emp.pin_locked_until).getTime() > Date.now()) {
        const remain = Math.ceil((new Date(emp.pin_locked_until).getTime() - Date.now()) / 1000);
        await log(dev.id, eid, 'verify_pin', false, ip, { locked: true });
        return json({ error: `PIN이 잠겼습니다. ${Math.ceil(remain / 60)}분 후 다시 시도하세요.`, locked_seconds: remain }, 429);
      }
      if (!emp.pin_hash) return json({ error: 'PIN이 설정되지 않았습니다. 관리자에게 문의하세요.' }, 403);
      if (!/^\d{4}$/.test(pin) || !bcrypt.compareSync(pin, emp.pin_hash)) {
        const fails = (emp.pin_fail_count || 0) + 1;
        const patch: Record<string, unknown> = { pin_fail_count: fails };
        if (fails >= PIN_LOCK_AFTER) {
          patch.pin_locked_until = new Date(Date.now() + PIN_LOCK_MS).toISOString();
          patch.pin_fail_count = 0;
        }
        await rest(`wm_employees?id=eq.${eid}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
        await log(dev.id, eid, 'verify_pin', false, ip, { fails });
        return json(fails >= PIN_LOCK_AFTER
          ? { error: 'PIN을 5회 잘못 입력해 5분간 잠겼습니다.' }
          : { error: 'PIN이 올바르지 않습니다.' }, 401);
      }
      await rest(`wm_employees?id=eq.${eid}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ pin_fail_count: 0, pin_locked_until: null }),
      });
      const sess = await signSession(emp.id, emp.name);
      await log(dev.id, eid, 'verify_pin', true, ip, null);
      return json({ ...sess, is_birthday: !!(emp.birthday && emp.birthday.slice(5) === today.slice(5)) });
    }

    /* ── 이하 PIN 세션 필요 — 직원 ID는 세션에서만 읽는다 ── */
    const isClock = action === 'clock_in' || action === 'clock_out';
    const sess = await verifySession(String(body.session ?? ''), isClock ? CLOCK_GRACE : 0);
    if (!sess) return json({ error: 'session_expired', message: '확인 시간이 지났어요. PIN을 다시 입력해주세요.' }, 401);
    const eid = sess.eid;

    if (isClock) {
      // ── 매장 IP 확인 (출퇴근 등록에만) ──
      if (dev.enforce_ip !== false) {
        const allowed: string[] = dev.allowed_ips || [];
        if (!allowed.includes(ip)) {
          await log(dev.id, eid, action, false, ip, { reason: 'ip_rejected' });
          return json({
            error: 'store_ip_only', ip,
            message: `매장 네트워크에서만 출퇴근 등록이 가능합니다.\n인터넷 회선이 바뀐 거라면 대시보드 → 근무 관리 → 직원 관리의 기기 목록에서 현재 IP(${ip})를 승인해주세요.`,
          }, 403);
        }
      }
      // ── 멱등성: 같은 request_id 재전송이면 성공으로 응답 (오프라인 큐 재전송 대비) ──
      const reqId = String(body.request_id ?? '');
      if (!/^[0-9a-f-]{36}$/.test(reqId)) return json({ error: 'request_id가 필요합니다' }, 400);
      const [dupLog] = await rest(`wm_kiosk_log?request_id=eq.${reqId}&select=id,ok`);
      if (dupLog) return json({ ok: true, duplicate: true });

      // 시각: 큐 재전송(queued)이면 client_time을 검증해 쓰고, 아니면 서버 KST
      let stamp = now;
      let delayed = false;
      if (body.queued && TS_RE.test(String(body.client_time ?? ''))) {
        const ct = String(body.client_time);
        if (ct.slice(0, 10) === today && ct <= now) stamp = ct;
        else delayed = true;   // 날짜가 넘었거나 미래 → 서버 시각 + 표시
      }
      const date = stamp.slice(0, 10);

      if (action === 'clock_in') {
        const recs = await rest(`wm_attendance?employee_id=eq.${eid}&date=eq.${date}&select=id,clock_in,clock_out`);
        if (recs.find((r: any) => r.clock_in && !r.clock_out)) return json({ error: '이미 출근 중입니다.' }, 400);
        if (recs.find((r: any) => r.clock_in && r.clock_out)) return json({ error: '오늘은 이미 퇴근하셨습니다.' }, 400);
        // 출근시간 고정 (아르바이트 전용) — attendance.js:99-106 이식
        const [emp] = await rest(`wm_employees?id=eq.${eid}&select=type,fixed_clock_in`);
        let clock_in = stamp;
        if (emp?.type === 'parttime' && emp?.fixed_clock_in) {
          if (clock_in.substring(11, 16) < emp.fixed_clock_in) clock_in = `${date} ${emp.fixed_clock_in}:00`;
        }
        const [row] = await rest('wm_attendance', {
          method: 'POST',
          body: JSON.stringify({
            employee_id: eid, date, clock_in, clock_out: null, work_minutes: null,
            note: delayed ? '오프라인 지연 전송 — 시각은 서버 기준' : (body.queued ? '오프라인 전송' : null),
            source: body.queued ? 'offline_queue' : 'kiosk',
          }),
        });
        await log(dev.id, eid, 'clock_in', true, ip, { clock_in, queued: !!body.queued }, reqId);
        return json(row);
      }

      // clock_out — attendance.js:113-125 이식
      const open = (await rest(`wm_attendance?employee_id=eq.${eid}&date=eq.${date}&clock_out=is.null&select=*&order=id.desc`))[0];
      if (!open || !open.clock_in) return json({ error: '출근 기록이 없습니다.' }, 400);
      const clock_out = stamp;
      const work_minutes = Math.floor((new Date(clock_out.replace(' ', 'T')).getTime() - new Date(open.clock_in.replace(' ', 'T')).getTime()) / 60000);
      if (work_minutes < 0) return json({ error: '퇴근 시각이 출근보다 빠릅니다.' }, 400);
      const [row] = await rest(`wm_attendance?id=eq.${open.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          clock_out, work_minutes,
          note: delayed ? ((open.note ? open.note + ' / ' : '') + '퇴근 지연 전송 — 시각은 서버 기준') : open.note,
          source: body.queued && open.source === 'kiosk' ? 'offline_queue' : open.source,
        }),
      });
      await log(dev.id, eid, 'clock_out', true, ip, { clock_out, work_minutes, queued: !!body.queued }, reqId);
      return json(row);
    }

    if (action === 'my_records') {
      return json(await rest(`wm_attendance?employee_id=eq.${eid}&select=id,date,clock_in,clock_out,is_edited&order=date.desc&limit=14`));
    }

    if (action === 'my_leaves') {
      const [emp] = await rest(`wm_employees?id=eq.${eid}&select=type,annual_leave_total`);
      const year = today.slice(0, 4);
      const rows = await rest(`wm_leaves?employee_id=eq.${eid}&select=id,date,type,status,reason&order=date.desc&limit=20`);
      // 잔여 연차 — leaves.js /remaining 이식 (여름휴가·사유 하계휴가/여름휴가는 미차감)
      let remaining = null;
      if (emp?.type === 'employee') {
        const approved = await rest(`wm_leaves?employee_id=eq.${eid}&status=eq.approved&date=gte.${year}-01-01&date=lte.${year}-12-31&select=type,reason`);
        const used = approved.reduce((s: number, l: any) => {
          if (l.type === 'summer') return s;
          if (l.reason && (l.reason.includes('하계휴가') || l.reason.includes('여름휴가'))) return s;
          return s + (l.type === 'annual' ? 1 : 0.5);
        }, 0);
        remaining = { total: emp.annual_leave_total, used, remaining: emp.annual_leave_total - used };
      }
      return json({ rows, remaining });
    }

    if (action === 'request_edit') {
      const { date, requested_clock_in, requested_clock_out, reason } = body;
      if (!date || !requested_clock_in || !reason) return json({ error: '필수 항목 누락' }, 400);
      let attendance: any = null;
      if (body.attendance_id) {
        [attendance] = await rest(`wm_attendance?id=eq.${Number(body.attendance_id)}&select=*`);
        if (attendance && attendance.employee_id !== eid) return json({ error: '본인 기록만 신청할 수 있습니다' }, 403);
      }
      const [row] = await rest('wm_attendance_edits', {
        method: 'POST',
        body: JSON.stringify({
          attendance_id: attendance?.id ?? null, employee_id: eid, date,
          original_clock_in: attendance?.clock_in ?? null, original_clock_out: attendance?.clock_out ?? null,
          requested_clock_in, requested_clock_out: requested_clock_out || null,
          reason, status: 'pending',
        }),
      });
      await log(dev.id, eid, 'request_edit', true, ip, { date });
      return json(row);
    }

    if (action === 'request_leave') {
      // leaves.js POST 이식 — 키오스크는 항상 pending (auto_approve는 관리자 전용)
      const { date, end_date, type, reason, skip_offdays } = body;
      if (!date || !type) return json({ error: '필수 항목 누락' }, 400);
      if (!['annual', 'half', 'summer'].includes(type)) return json({ error: '휴가 종류 오류' }, 400);

      if (end_date && end_date !== date) {
        if (end_date < date) return json({ error: '종료 날짜가 시작 날짜보다 빠릅니다.' }, 400);
        const holidaySet = new Set((await rest('wm_holidays?select=date&limit=2000')).map((h: any) => h.date));
        const dates: string[] = [];
        for (const d = new Date(`${date}T00:00:00`); ; d.setDate(d.getDate() + 1)) {
          const s = fmtD(d);
          if (s > end_date) break;
          if (dates.length >= 62) return json({ error: '기간이 너무 깁니다. (최대 2개월)' }, 400);
          if (skip_offdays && (d.getDay() === 0 || d.getDay() === 6 || holidaySet.has(s))) continue;
          dates.push(s);
        }
        if (!dates.length) return json({ error: '기간 내 등록할 날짜가 없습니다. (주말·공휴일 제외)' }, 400);
        const existing = new Set(
          (await rest(`wm_leaves?employee_id=eq.${eid}&status=neq.rejected&select=date`)).map((r: any) => r.date));
        const toInsert = dates.filter(s => !existing.has(s));
        const skipped = dates.filter(s => existing.has(s));
        if (!toInsert.length) return json({ error: '기간 내 모든 날짜에 이미 신청 내역이 있습니다.' }, 400);
        const rows = await rest('wm_leaves', {
          method: 'POST',
          body: JSON.stringify(toInsert.map(s => ({ employee_id: eid, date: s, type, status: 'pending', reason: reason || null }))),
        });
        await log(dev.id, eid, 'request_leave', true, ip, { from: date, to: end_date, inserted: rows.length });
        try { await notifyAdminsLeave(sess.name, toInsert, type, reason); } catch { /* 알림 실패는 무시 */ }
        return json({ range: true, inserted: rows.length, skipped, rows });
      }

      const dup = await rest(`wm_leaves?employee_id=eq.${eid}&date=eq.${date}&status=neq.rejected&select=id`);
      if (dup.length) return json({ error: '해당 날짜에 이미 신청 내역이 있습니다.' }, 400);
      const [row] = await rest('wm_leaves', {
        method: 'POST',
        body: JSON.stringify({ employee_id: eid, date, type, status: 'pending', reason: reason || null }),
      });
      await log(dev.id, eid, 'request_leave', true, ip, { date, type });
      try { await notifyAdminsLeave(sess.name, [date], type, reason); } catch { /* 알림 실패는 무시 */ }
      return json(row);
    }

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    return json({ error: String(err).slice(0, 400) }, 500);
  }
});
