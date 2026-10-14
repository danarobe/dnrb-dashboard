// 알바 채용·면접비(#hire) 자동 점검 — 실제 supabase/functions/wm-hire/index.ts 를 Node(24+, TS 그대로 실행)에서 돌리고 DB는 메모리 가짜 PostgREST.
//   node tools/hire_check.mjs      → 계산식(서버 calc.ts == 화면 hireCalc == 엑셀 ROUNDDOWN 식)·권한·암호화·중복·채용 연결·내보내기
// 원본: 메뉴를 만들어 보낸 친구의 dev/dev-server.mjs(2026-10-12 이식). 저장소 구조에 맞게 경로만 바꿨다 —
//   서버 = supabase/functions/wm-hire, 공용 = supabase/functions/_shared/util.ts(복사하지 않고 그대로), 화면 = index.html 안의 '알바 채용·면접비 (#hire)' 블록.
//   실제 DB·비밀키는 쓰지 않는다(아래 env는 시험용 가짜 값). wm-hire·calc.ts·화면 hireCalc 를 고치면 배포 전에 돌릴 것.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN = path.join(ROOT, 'supabase/functions');
function clientJs() {   // index.html에서 #hire 스크립트 블록만 꺼낸다
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = html.indexOf('   알바 채용·면접비 (#hire) — 관리자 + 물류팀'), b = html.indexOf('/* ══ 알바 채용·면접비 끝 ══ */');
  assert.ok(a > 0 && b > a, 'index.html에서 #hire 스크립트 블록을 찾지 못함');
  return html.slice(html.lastIndexOf('/*', a), b);
}

// ── 가짜 DB (PostgREST 문법 중 wm-hire·util이 쓰는 것만) ──
const db = {
  app_users: [
    { id: 'admin1', name: '대표', role: 'admin', login_blocked: false },
    { id: 'log1', name: '물류담당', role: 'logistics', login_blocked: false },
    { id: 'cs1', name: 'CS직원', role: 'cs', login_blocked: false },
    { id: 'md1', name: 'MD직원', role: 'staff', login_blocked: false },
  ],
  hire_users: [],   // 접근 허용 목록 (2026-10-14)
  wm_hires: [], wm_hire_pays: [], wm_employees: [], wm_kiosk_log: [],
};
const seq = {};
function fakeRest(url, init = {}) {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const rows = db[table];
  const filters = [];
  for (const [k, v] of u.searchParams) {
    if (['select', 'order'].includes(k)) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    filters.push(r => {
      const x = r[k];
      if (op === 'eq') return String(x) === val;
      if (op === 'gte') return String(x) >= val;
      if (op === 'lt') return String(x) < val;
      if (op === 'in') return val.slice(1, -1).split(',').includes(String(x));
      throw new Error('filter ' + v);
    });
  }
  const hit = rows.filter(r => filters.every(f => f(r)));
  const method = init.method ?? 'GET';
  const ok = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === 'GET') {
    const o = u.searchParams.get('order');
    if (o) { const [col, dir] = o.split(',')[0].split('.'); hit.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
    return ok(hit);
  }
  const body = init.body ? JSON.parse(init.body) : {};
  if (method === 'POST') {
    if (table === 'wm_hires' && body.rrn_hash && rows.some(r => r.rrn_hash === body.rrn_hash)) return ok({ message: 'duplicate key' }, 409);
    const row = { id: (seq[table] = (seq[table] ?? 0) + 1), created_at: new Date().toISOString(), paid_on: null, employee_id: null, ...(table === 'wm_hires' ? { kind: 'applicant', status: 'interview' } : {}), ...body };
    rows.push(row); return ok([row], 201);
  }
  if (method === 'PATCH') { hit.forEach(r => Object.assign(r, body)); return ok(hit); }
  if (method === 'DELETE') {
    db[table] = rows.filter(r => !hit.includes(r));
    if (table === 'wm_hires') db.wm_hire_pays = db.wm_hire_pays.filter(p => !hit.some(h => h.id === p.hire_id));   // on delete cascade
    return ok(hit);
  }
}

// ── Deno 흉내 + fetch 가로채기 → 실제 함수 코드 불러오기 ──
const env = { SUPABASE_URL: 'http://fake-db', SUPABASE_SERVICE_ROLE_KEY: 'x', AUTH_SECRET: 'dev-secret', HIRE_ENC_KEY: Buffer.alloc(32, 7).toString('base64') };
let handler;
globalThis.Deno = { env: { get: k => env[k] }, serve: h => { handler = h; } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).startsWith('http://fake-db/rest/v1/') ? fakeRest(String(url), init) : realFetch(url, init);
const { signAuthToken } = await import(path.join(FN, '_shared/util.ts'));
await import(path.join(FN, 'wm-hire/index.ts'));
const calc = await import(path.join(FN, 'wm-hire/calc.ts'));
const token = async id => { const u = db.app_users.find(x => x.id === id); return signAuthToken({ id, name: u.name, role: u.role, exp: Date.now() + 3600e3, iat: Date.now() }); };
async function call(as, body) {
  const res = await handler(new Request('http://x/functions/v1/wm-hire', { method: 'POST', headers: as ? { 'x-auth-token': await token(as) } : {}, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

{
  // 1) 계산식: 서버 calcPay == 화면 hireCalc, 그리고 손으로 확인한 값
  const ctx = vm.createContext({ Intl, Math, Number, String, Date });
  vm.runInContext(clientJs(), ctx);
  for (let gross = 0; gross <= 400000; gross += 37) {
    for (const ins of [false, true]) assert.deepEqual({ ...calc.calcPay({ minutes: 0, hourly_rate: 0, fixed_amount: gross, emp_ins: ins }) }, { ...ctx.hireCalc(0, 0, gross, ins) });
  }
  for (const [m, r] of [[180, 10320], [95, 10320], [1, 9999], [600, 12345]]) assert.deepEqual({ ...calc.calcPay({ minutes: m, hourly_rate: r }) }, { ...ctx.hireCalc(m, r, null, false) });
  // 사용자 엑셀: 사업소득세 =ROUNDDOWN(B4*3%,-1), 지방소득세 =ROUNDDOWN(B4*0.3%,-1)
  assert.deepEqual(calc.calcPay({ minutes: 0, hourly_rate: 0, fixed_amount: 31500 }), { gross: 31500, income_tax: 940, local_tax: 90, emp_ins_amt: 0, net: 30470 });
  assert.deepEqual(calc.calcPay({ minutes: 180, hourly_rate: 10320 }), { gross: 30960, income_tax: 920, local_tax: 90, emp_ins_amt: 0, net: 29950 });
  for (let g = 0; g <= 400000; g += 7) {   // 엑셀 식을 소수 그대로 흉내 낸 값과 비교 (경계 오차는 1e-9로 흡수)
    const rd = x => Math.floor(x / 10 + 1e-9) * 10, c = calc.calcPay({ minutes: 0, hourly_rate: 0, fixed_amount: g });
    assert.deepEqual([c.income_tax, c.local_tax], [rd(g * 0.03), rd(g * 0.003)], `세전 ${g}`);
  }
  assert.deepEqual(calc.calcPay({ minutes: 480, hourly_rate: 10320, emp_ins: true }), { gross: 82560, income_tax: 2470, local_tax: 240, emp_ins_amt: 743, net: 79107 });
  assert.equal(calc.parseRrn('900101-1234567').birth, '1990-01-01');
  assert.equal(calc.parseRrn('0802294123456').birth, '2008-02-29');
  assert.ok('error' in calc.parseRrn('900230-1234567'));
  assert.ok('error' in calc.parseRrn('900101-9234567'));
  assert.equal(calc.normPhone('01012345678'), '010-1234-5678');
  assert.equal(calc.normPhone('02-123-4567'), null);

  // 2) 권한
  assert.equal((await call(null, { action: 'list' })).status, 401);
  assert.equal((await call('cs1', { action: 'list' })).status, 403);
  assert.equal((await call('log1', { action: 'list' })).status, 200);
  // 허용 목록 (2026-10-14): MD·CS팀은 목록에 있을 때만 — 넣으면 열리고 빼면 바로 막힘, 남의 허용은 내 것이 아님
  assert.equal((await call('md1', { action: 'list' })).status, 403);
  db.hire_users.push({ user_id: 'md1' });
  assert.equal((await call('md1', { action: 'list' })).status, 200);
  assert.equal((await call('cs1', { action: 'list' })).status, 403);
  db.hire_users.push({ user_id: 'cs1' });
  assert.equal((await call('cs1', { action: 'list' })).status, 200);
  db.hire_users.length = 0;
  assert.equal((await call('md1', { action: 'list' })).status, 403);
  assert.equal((await call('cs1', { action: 'list' })).status, 403);

  // 3) 등록 → DB엔 암호문만, 목록엔 가린 값, reveal은 전체 + 감사 로그
  const a = await call('log1', { action: 'upsert', name: '김알바', phone: '01012345678', rrn: '0503154123456', bank_name: '국민', account: '123-45-678901', status: 'interview', interview_date: '2026-10-12' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const raw = JSON.stringify(db.wm_hires);
  assert.ok(!raw.includes('0503154123456') && !raw.includes('678901'), '평문이 DB에 남음');
  let l = (await call('log1', { action: 'list' })).body.hires[0];
  assert.equal(l.rrn_mask, '050315-4******'); assert.equal(l.account_mask, '••••8901'); assert.equal(l.birth, '2005-03-15');
  assert.deepEqual((await call('log1', { action: 'reveal', id: a.body.id })).body, { rrn: '050315-4123456', account: '123-45-678901' });
  assert.ok(db.wm_kiosk_log.some(x => x.action === 'hire_reveal'));
  // 수정 시 rrn을 안 보내면 그대로
  await call('log1', { action: 'upsert', id: a.body.id, name: '김알바', phone: '010-1234-5678', memo: '포장 경험' });
  assert.equal((await call('log1', { action: 'reveal', id: a.body.id })).body.rrn, '050315-4123456');

  // 4) 중복 주민번호·잘못된 입력
  assert.equal((await call('log1', { action: 'upsert', name: '중복', phone: '01099998888', rrn: '050315-4123456' })).status, 409);
  assert.equal((await call('log1', { action: 'upsert', name: 'x', phone: '0101234' })).status, 400);
  assert.equal((await call('log1', { action: 'upsert', name: 'x', phone: '01011112222', account: '12' })).status, 400);

  // 5) 지급: 서버가 금액 계산(화면이 보낸 gross 무시), 입금 표시
  const p = await call('log1', { action: 'pay_upsert', hire_id: a.body.id, work_date: '2026-10-12', start_time: '13:00', end_time: '16:00', minutes: 180, hourly_rate: 10320, gross: 999999 });
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.gross, 30960); assert.equal(p.body.net, 29950);
  const p2 = await call('log1', { action: 'pay_upsert', hire_id: a.body.id, work_date: '2026-10-13', minutes: 0, hourly_rate: 0, fixed_amount: 50000, emp_ins: true });
  assert.deepEqual([p2.body.income_tax, p2.body.local_tax, p2.body.emp_ins_amt, p2.body.net], [1500, 150, 450, 47900]);
  assert.equal((await call('log1', { action: 'pay_upsert', hire_id: a.body.id, work_date: '2026-10-13', minutes: 0, hourly_rate: 10320 })).status, 400);
  assert.equal((await call('log1', { action: 'pay_paid', id: p.body.id, paid_on: '2026-10-12' })).body.paid_on, '2026-10-12');

  // 6) 일일알바 구분 + 내보내기: 그 달만, 구분별, 주민번호·계좌 전체
  const d = await call('log1', { action: 'upsert', kind: 'daily', name: '최일당', phone: '01077778888', rrn: '9901011000000', account: '9876543210' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  await call('log1', { action: 'pay_upsert', hire_id: d.body.id, work_date: '2026-10-05', minutes: 0, hourly_rate: 0, fixed_amount: 31500 });
  assert.equal((await call('log1', { action: 'upsert', kind: 'weekly', name: 'x', phone: '01011112222' })).status, 400);
  const lk = (await call('log1', { action: 'list' })).body.hires;
  assert.deepEqual(lk.map(h => h.kind).sort(), ['applicant', 'daily']);
  const exd = (await call('log1', { action: 'export', ym: '2026-10', kind: 'daily' })).body.rows;
  assert.deepEqual(exd.map(r => [r.name, r.gross, r.income_tax, r.local_tax, r.net]), [['최일당', 31500, 940, 90, 30470]]);
  assert.equal((await call('log1', { action: 'export', ym: '2026-10', kind: 'applicant' })).body.rows.length, 2);
  assert.equal((await call('log1', { action: 'export', ym: '2026-10' })).body.rows.length, 3);
  const ex = (await call('log1', { action: 'export', ym: '2026-10', kind: 'applicant' })).body.rows;
  assert.equal(ex[0].rrn, '050315-4123456'); assert.equal(ex[0].account, '123-45-678901');
  assert.equal((await call('log1', { action: 'export', ym: '2026-11' })).body.rows.length, 0);

  // 7) 지급 기록 있는 사람 삭제는 관리자만, 채용 처리 → 근무관리 알바 생성
  assert.equal((await call('log1', { action: 'delete', id: a.body.id })).status, 403);
  const h = await call('log1', { action: 'hire', id: a.body.id, hourly_rate: 10500 });
  assert.equal(h.status, 200);
  assert.deepEqual(db.wm_employees[0], { ...db.wm_employees[0], name: '김알바', type: 'parttime', hourly_rate: 10500, birthday: '2005-03-15', bank_account: '123-45-678901' });
  assert.equal(db.wm_employees[0].annual_leave_total, 0);   // (이식 시 추가) 알바 연차 총량 0
  assert.equal(db.wm_employees[0].hire_date, '2026-10-12');  // 채용 지원자: 면접일 = 입사일 (2026-10-13)
  const hd = await call('log1', { action: 'hire', id: d.body.id, hourly_rate: 10500 });   // 첫 출근일을 안 적은 일일알바 → 입사일 비움
  assert.equal(hd.status, 200); assert.equal(db.wm_employees[1].hire_date, null);
  assert.equal(db.wm_hires.find(h => h.id === d.body.id).kind, 'applicant');   // 채용 처리하면 '채용됨'(applicant)으로 옮김 (2026-10-14)
  assert.equal(db.wm_hires.find(h => h.id === d.body.id).status, 'hired');
  const e = await call('log1', { action: 'upsert', kind: 'daily', name: '박첫출근', phone: '01055556666', interview_date: '2026-10-05' });
  assert.equal((await call('log1', { action: 'hire', id: e.body.id, hourly_rate: 10500 })).status, 200);
  assert.equal(db.wm_employees[2].hire_date, '2026-10-05');   // 일일알바의 첫 출근일 = 입사일
  assert.equal((await call('log1', { action: 'hire', id: a.body.id, hourly_rate: 10500 })).status, 409);
  for (const bad of [{ action: 'reveal', id: 'abc' }, { action: 'pay_delete' }, { action: 'delete', id: 1.5 }, { action: 'pay_upsert', hire_id: 'x', work_date: '2026-10-12', fixed_amount: 1000 }]) assert.equal((await call('log1', bad)).status, 400, JSON.stringify(bad));   // (이식 시 추가) id는 양의 정수만
  assert.equal((await call('admin1', { action: 'delete', id: a.body.id })).status, 200);
  assert.equal(db.wm_hire_pays.length, 1);   // 일일알바 기록만 남음
  console.log('✓ 전부 통과');
  process.exit(0);
}
