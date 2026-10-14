// ═══════════════════════════════════════════════════════════════
// 알바 채용·면접비 — 관리자 + 물류팀(원래 역할 logistics) + 허용 목록(hire_users — 관리자가 직원 관리 화면에서 지정, 2026-10-14)
//
//   POST { action, ... }  — x-auth-token 검증 후 hireRoleOk
//
//   list        {}                         사람 목록(주민번호·계좌는 가린 값) + 지급 기록
//   reveal      { id }                     주민번호·계좌 전체 (감사 로그 남김)
//   upsert      { id?, kind?, name, phone, rrn?, bank_name?, account?, bank_holder?, status?, interview_date?, memo? }   kind = applicant(채용됨 — 2026-10-14 이름 바꿈, 옛 채용 지원자)|daily(일일알바 — 새 등록의 기본). 채용 처리하면 applicant로 옮겨진다
//                                          ⚠ 부분 수정 — rrn·account는 보냈을 때만 바뀜(빈 문자열 = 지우기)
//   delete      { id }                     사람 + 지급 기록 삭제(파기). 지급 기록이 있으면 관리자만
//   hire        { id, hourly_rate }        채용 처리 → 근무관리 알바(wm_employees, type=parttime) 생성·연결
//   pay_upsert  { id?, hire_id, work_date, start_time?, end_time?, minutes, hourly_rate, fixed_amount?, emp_ins?, note? }
//                                          금액은 서버 calcPay로 계산 (화면 값 무시)
//   pay_paid    { id, paid_on|null }       입금 완료 표시/취소
//   pay_delete  { id }
//   export      { ym, kind? }              그 달(근무일 기준) 지급 내역 — kind 주면 그 구분만. 주민번호·계좌 전체 포함 (감사 로그)
//
// 비밀값: HIRE_ENC_KEY = base64 32바이트 (openssl rand -base64 32). 바꾸면 기존 암호문을 못 푼다.
// ═══════════════════════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from '../_shared/util.ts';
import { calcPay, normAccount, normPhone, parseRrn } from './calc.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

// ── 권한: 관리자 또는 원래 역할 logistics (verifyAuthToken이 logistics→cs로 합쳐 CS팀과 구분이 안 돼 다시 읽음 — cafe24-analytics soldoutRoleOk와 같은 방식)
async function hireRoleOk(me: { id: string; role: string }): Promise<boolean> {
  if (['sales-agent', 'cron', 'npm-sync'].includes(me.id)) return false;
  if (me.role === 'admin') return true;
  if (me.role === 'cs') {
    const [row] = await rest(`app_users?id=eq.${encodeURIComponent(me.id)}&select=role`);
    if (String(row?.role ?? '') === 'logistics') return true;
  }
  // 그 밖의 직원(MD·마케터·CS팀)은 허용 목록에 있을 때만 (2026-10-14 사용자 요청) — 허용되면 물류팀과 같은 범위
  const [al] = await rest(`hire_users?user_id=eq.${encodeURIComponent(me.id)}&select=user_id`);
  return !!al;
}

// ── 암호화 (AES-256-GCM) + 중복 확인용 해시 (HMAC-SHA256, 암호화 키에서 파생한 별도 키) ──
let keys: Promise<{ aes: CryptoKey; mac: CryptoKey }> | null = null;
function getKeys() {
  return keys ??= (async () => {
    const raw = Uint8Array.from(atob(Deno.env.get('HIRE_ENC_KEY') ?? ''), c => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error('HIRE_ENC_KEY 미설정 또는 32바이트 아님 — 주민번호 저장 불가');
    const macRaw = await crypto.subtle.digest('SHA-256', new Uint8Array([...raw, ...new TextEncoder().encode('wm-hire:rrn-hash')]));
    return {
      aes: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
      mac: await crypto.subtle.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    };
  })().catch(e => { keys = null; throw e; });
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
async function enc(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, (await getKeys()).aes, new TextEncoder().encode(text)));
  return 'v1.' + b64(new Uint8Array([...iv, ...ct]));
}
async function dec(s: string | null): Promise<string | null> {
  if (!s) return null;
  const all = Uint8Array.from(atob(s.slice(3)), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, (await getKeys()).aes, all.slice(12)));
}
async function rrnHash(digits: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', (await getKeys()).mac, new TextEncoder().encode(digits))));
}
const maskRrn = (d: string | null) => d ? `${d.slice(0, 6)}-${d[6]}******` : null;
const maskAcct = (a: string | null) => a ? '••••' + a.replace(/\D/g, '').slice(-4) : null;
const fmtRrn = (d: string | null) => d ? `${d.slice(0, 6)}-${d.slice(6)}` : '';

async function audit(me: { id: string; name: string }, action: string, detail: unknown) {
  try {
    await rest('wm_kiosk_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ actor: me.id, action: 'hire_' + action, detail: { by: me.name, ...detail as object } }) });
  } catch (_) { /* 로그 실패가 본 동작을 막으면 안 됨 */ }
}

const D_RE = /^\d{4}-\d{2}-\d{2}$/;
const T_RE = /^\d{2}:\d{2}$/;
const STATUSES = ['interview', 'hired', 'rejected'];
const KINDS = ['applicant', 'daily'];
const PAY_COLS = 'id,hire_id,work_date,start_time,end_time,minutes,hourly_rate,fixed_amount,emp_ins,gross,income_tax,local_tax,emp_ins_amt,net,paid_on,note';
const int = (v: unknown) => Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN;

async function hireRow(id: number) {
  const [h] = await rest(`wm_hires?id=eq.${id}&select=*`);
  return h ?? null;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const me = await verifyAuthToken(req);
  if (!me) return json({ error: '로그인이 필요합니다' }, 401);

  try {
    if (!(await hireRoleOk(me))) return json({ error: '접근 권한이 없습니다' }, 403);
    const b = await req.json().catch(() => ({})) as Record<string, any>;
    const action = String(b.action ?? '');
    const id = Number(b.id);
    // (이식 시 추가 2026-10-12) id·hire_id는 양의 정수만 — 숫자가 아닌 값이 DB 조회 주소에 들어가 500이 나지 않게
    if (b.id != null && b.id !== '' && !(Number.isInteger(id) && id > 0)) return json({ error: 'id가 올바르지 않아요' }, 400);
    if (b.hire_id != null && !(Number.isInteger(Number(b.hire_id)) && Number(b.hire_id) > 0)) return json({ error: 'hire_id가 올바르지 않아요' }, 400);
    if (['reveal', 'delete', 'hire', 'pay_paid', 'pay_delete'].includes(action) && !(Number.isInteger(id) && id > 0)) return json({ error: 'id가 필요해요' }, 400);

    if (action === 'list') {
      const [hires, pays] = await Promise.all([
        rest('wm_hires?select=*&order=id.desc'),
        rest(`wm_hire_pays?select=${PAY_COLS}&order=work_date.desc,id.desc`),
      ]);
      const out = [];
      for (const h of hires) {
        out.push({
          id: h.id, kind: h.kind, name: h.name, phone: h.phone, birth: h.birth, bank_name: h.bank_name, bank_holder: h.bank_holder,
          status: h.status, interview_date: h.interview_date, memo: h.memo, employee_id: h.employee_id,
          created_by: h.created_by, created_at: h.created_at,
          rrn_mask: maskRrn(await dec(h.rrn_enc)), account_mask: maskAcct(await dec(h.account_enc)),
          pays: pays.filter(p => p.hire_id === h.id),
        });
      }
      return json({ hires: out, can_delete_paid: me.role === 'admin' });
    }

    if (action === 'reveal') {
      const h = await hireRow(id);
      if (!h) return json({ error: '없는 사람이에요' }, 404);
      await audit(me, 'reveal', { hire_id: id, name: h.name });
      return json({ rrn: fmtRrn(await dec(h.rrn_enc)), account: await dec(h.account_enc) ?? '' });
    }

    if (action === 'upsert') {
      const row: Record<string, unknown> = {};
      const name = String(b.name ?? '').trim();
      if (!name || name.length > 40) return json({ error: '이름을 입력해 주세요' }, 400);
      const phone = normPhone(b.phone);
      if (!phone) return json({ error: '휴대폰 번호가 올바르지 않아요 (예: 010-1234-5678)' }, 400);
      Object.assign(row, { name, phone });
      if ('rrn' in b) {
        if (String(b.rrn ?? '').trim() === '') Object.assign(row, { rrn_enc: null, rrn_hash: null, birth: null });
        else {
          const r = parseRrn(b.rrn);
          if ('error' in r) return json({ error: r.error }, 400);
          const hash = await rrnHash(r.digits);
          const [dup] = await rest(`wm_hires?rrn_hash=eq.${encodeURIComponent(hash)}&select=id,name`);
          if (dup && dup.id !== id) return json({ error: `이미 등록된 주민번호예요 (${dup.name}님) — 그 사람의 지급 기록에 추가해 주세요` }, 409);
          Object.assign(row, { rrn_enc: await enc(r.digits), rrn_hash: hash, birth: r.birth });
        }
      }
      if ('account' in b) {
        if (String(b.account ?? '').trim() === '') row.account_enc = null;
        else {
          const a = normAccount(b.account);
          if (!a) return json({ error: '계좌번호는 숫자 8~20자리예요' }, 400);
          row.account_enc = await enc(a);
        }
      }
      for (const k of ['bank_name', 'bank_holder', 'memo'] as const) if (k in b) row[k] = String(b[k] ?? '').trim().slice(0, 500) || null;
      if ('kind' in b) {
        if (!KINDS.includes(b.kind)) return json({ error: '구분 값이 올바르지 않아요' }, 400);
        row.kind = b.kind;
      }
      if ('status' in b) {
        if (!STATUSES.includes(b.status)) return json({ error: '상태 값이 올바르지 않아요' }, 400);
        row.status = b.status;
      }
      if ('interview_date' in b) {
        if (b.interview_date && !D_RE.test(b.interview_date)) return json({ error: '면접일 형식 오류' }, 400);
        row.interview_date = b.interview_date || null;
      }
      if (b.id) {
        if (!(await hireRow(id))) return json({ error: '없는 사람이에요' }, 404);
        const [h] = await rest(`wm_hires?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(row) });
        await audit(me, 'update', { hire_id: id, fields: Object.keys(row) });
        return json({ id: h.id });
      }
      row.created_by = me.name;
      const [h] = await rest('wm_hires', { method: 'POST', body: JSON.stringify(row) });
      await audit(me, 'create', { hire_id: h.id, name });
      return json({ id: h.id });
    }

    if (action === 'delete') {
      const h = await hireRow(id);
      if (!h) return json({ error: '없는 사람이에요' }, 404);
      const pays = await rest(`wm_hire_pays?hire_id=eq.${id}&select=id`);
      // 지급 기록 = 원천징수 증빙(5년 보관) — 실수로 지우지 않게 관리자만
      if (pays.length && me.role !== 'admin') return json({ error: '지급 기록이 있는 사람은 관리자만 삭제할 수 있어요' }, 403);
      await rest(`wm_hires?id=eq.${id}`, { method: 'DELETE' });   // 지급 기록은 on delete cascade
      await audit(me, 'delete', { hire_id: id, name: h.name, pays: pays.length });
      return json({ ok: true });
    }

    if (action === 'hire') {
      const h = await hireRow(id);
      if (!h) return json({ error: '없는 사람이에요' }, 404);
      if (h.employee_id) return json({ error: '이미 근무관리에 연결된 사람이에요' }, 409);
      const rate = int(b.hourly_rate);
      if (!(rate > 0)) return json({ error: '시급을 입력해 주세요' }, 400);
      // 근무관리 '알바 추가'와 같은 모양 — type은 parttime 고정. PIN·출퇴근은 근무관리에서.
      const [emp] = await rest('wm_employees', {
        method: 'POST',
        body: JSON.stringify({
          name: h.name, type: 'parttime', hourly_rate: rate, birthday: h.birth,
          hire_date: h.interview_date ?? null,   // 면접일(첫 출근일) = 입사일 (2026-10-13 채용 지원자 → 2026-10-14 일일알바도 첫 출근일을 적으니 둘 다)   // 채용 지원자는 면접일 = 입사일 (2026-10-13 사용자 요청). 일일알바는 면접일이 없어 비워 둠
          annual_leave_total: 0,   // (이식 시 추가) 근무 관리의 기존 알바 행은 모두 0 — 표 기본값 15가 들어가지 않게
          bank_name: h.bank_name, bank_account: await dec(h.account_enc), bank_holder: h.bank_holder,
        }),
      });
      // 채용 처리하면 '채용됨' 탭으로 옮긴다(kind = applicant) — 2026-10-14 사용자 요청 "일일알바에서 채용 처리를 누르면 채용됨으로 이동"
      await rest(`wm_hires?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'hired', employee_id: emp.id, kind: 'applicant' }) });
      await audit(me, 'hire', { hire_id: id, employee_id: emp.id, name: h.name });
      return json({ employee_id: emp.id });
    }

    if (action === 'pay_upsert') {
      const hireId = Number(b.hire_id);
      if (!b.id && !(await hireRow(hireId))) return json({ error: '없는 사람이에요' }, 404);
      if (!D_RE.test(b.work_date ?? '')) return json({ error: '근무일을 입력해 주세요' }, 400);
      for (const k of ['start_time', 'end_time']) if (b[k] && !T_RE.test(b[k])) return json({ error: '시간 형식 오류 (HH:MM)' }, 400);
      const minutes = int(b.minutes ?? 0), hourly_rate = int(b.hourly_rate ?? 0);
      const fixed_amount = b.fixed_amount === '' || b.fixed_amount == null ? null : int(b.fixed_amount);
      if (Number.isNaN(minutes) || Number.isNaN(hourly_rate) || Number.isNaN(fixed_amount as number)) return json({ error: '시간·시급·금액은 0 이상 정수예요' }, 400);
      if (fixed_amount == null && !(minutes > 0 && hourly_rate > 0)) return json({ error: '근무 시간과 시급을 넣거나 정액 금액을 넣어 주세요' }, 400);
      const emp_ins = b.emp_ins === true;
      const row = {
        work_date: b.work_date, start_time: b.start_time || null, end_time: b.end_time || null,
        minutes, hourly_rate, fixed_amount, emp_ins,
        ...calcPay({ minutes, hourly_rate, fixed_amount, emp_ins }),
        note: String(b.note ?? '').trim().slice(0, 500) || null,
      };
      if (b.id) {
        const [p] = await rest(`wm_hire_pays?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(row) });
        if (!p) return json({ error: '없는 지급 기록이에요' }, 404);
        await audit(me, 'pay_update', { pay_id: id, gross: row.gross });
        return json(p);
      }
      const [p] = await rest('wm_hire_pays', { method: 'POST', body: JSON.stringify({ ...row, hire_id: hireId, created_by: me.name }) });
      await audit(me, 'pay_create', { pay_id: p.id, hire_id: hireId, gross: row.gross });
      return json(p);
    }

    if (action === 'pay_paid') {
      if (b.paid_on != null && !D_RE.test(b.paid_on)) return json({ error: '날짜 형식 오류' }, 400);
      const [p] = await rest(`wm_hire_pays?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ paid_on: b.paid_on ?? null }) });
      if (!p) return json({ error: '없는 지급 기록이에요' }, 404);
      await audit(me, 'pay_paid', { pay_id: id, paid_on: b.paid_on ?? null });
      return json(p);
    }

    if (action === 'pay_delete') {
      await rest(`wm_hire_pays?id=eq.${id}`, { method: 'DELETE' });
      await audit(me, 'pay_delete', { pay_id: id });
      return json({ ok: true });
    }

    if (action === 'export') {
      const ym = String(b.ym ?? '');
      if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: '연월 형식 오류' }, 400);
      const [y, m] = ym.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      if (b.kind != null && !KINDS.includes(b.kind)) return json({ error: '구분 값이 올바르지 않아요' }, 400);
      const all = await rest(`wm_hire_pays?work_date=gte.${ym}-01&work_date=lt.${next}&select=${PAY_COLS}&order=work_date,id`);
      const ids = [...new Set(all.map(p => p.hire_id))];
      const hires = (ids.length ? await rest(`wm_hires?id=in.(${ids.join(',')})&select=*`) : []).filter(h => b.kind == null || h.kind === b.kind);
      const byId = new Map<number, any>();
      for (const h of hires) byId.set(h.id, { kind: h.kind, name: h.name, phone: h.phone, bank_name: h.bank_name, bank_holder: h.bank_holder, rrn: fmtRrn(await dec(h.rrn_enc)), account: await dec(h.account_enc) ?? '' });
      const pays = all.filter(p => byId.has(p.hire_id));
      await audit(me, 'export', { ym, kind: b.kind ?? 'all', rows: pays.length });
      return json({ rows: pays.map(p => ({ ...p, ...byId.get(p.hire_id) })) });
    }

    return json({ error: `알 수 없는 action: ${action}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
