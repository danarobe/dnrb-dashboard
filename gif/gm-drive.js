// 구글 드라이브 지정 폴더에서 사진 가져오기 (GIF 만들기 · 카드뉴스 화면)
//   GMDrive.open({ onPick(files), title? })
//   GMDrive.open({ title?, folder: { label?, onSave(folder, ui) } })  — 저장할 폴더 고르기(사진은 보기만). 관리자의 [구글 드라이브에 저장]용.
//       folder = { id, k, name, path }, ui.note(글) = 아래 줄에 진행 상황. onSave 가 true 를 돌려주면 창을 닫고, 글자를 돌려주면 그 글을 빨갛게 보여 준다.
//   고른 사진을 File 목록으로 넘겨 준다. 순서 = 먼저 고르기 시작한 폴더부터, 폴더 안에서는 보이는 순서(이름 순서).
//   사진을 누르면 크게 보기(← → 이동 · Space 선택), 왼쪽 위 동그라미를 누르면 선택. 폴더를 옮겨도 선택은 그대로 남는다(여러 폴더에서 골라 한 번에).
//   서버(gif 함수 /api/drive/…)가 서비스 계정으로 지정 폴더만 읽어 준다. 사진은 고른 것만 이 브라우저로 받는다.
(function () {
  'use strict';

  const CSS = `
.gdv-back { position: fixed; inset: 0; z-index: 9000; background: rgba(20,18,16,.45); display: flex; align-items: center; justify-content: center; padding: 20px; }
.gdv { width: min(980px, 100%); height: min(760px, 100%); background: #fff; border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.25); font-size: 13px; color: #1a1816; }
.gdv-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid #ece9e2; }
.gdv-title { font-size: 15px; font-weight: 700; flex: 1; min-width: 0; }
.gdv-x { border: none; background: none; font-size: 13px; color: #5a5652; cursor: pointer; padding: 6px 10px; border-radius: 8px; }
.gdv-x:hover { background: #f2f0ec; }
.gdv-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 8px 14px; border-bottom: 1px solid #ece9e2; background: #faf9f6; min-height: 38px; }
.gdv-crumb { border: none; background: none; font: inherit; font-size: 12.5px; color: #5a5652; cursor: pointer; padding: 4px 6px; border-radius: 6px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gdv-crumb:hover { background: #ece9e2; }
.gdv-crumb.cur { color: #1a1816; font-weight: 700; cursor: default; }
.gdv-crumb.cur:hover { background: none; }
.gdv-sep { color: #b8b4ac; font-size: 11px; }
.gdv-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; }
.gdv-msg { padding: 48px 20px; text-align: center; color: #5a5652; line-height: 1.7; }
.gdv-msg b { color: #1a1816; }
.gdv-mail { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 7px 10px; background: #f7f6f2; border: 1px solid #e2e0da; border-radius: 8px; font-size: 12px; word-break: break-all; }
.gdv-mail button, .gdv-btn { border: 1px solid #d9d6cf; background: #fff; border-radius: 8px; font: inherit; font-size: 12.5px; font-weight: 600; color: #1a1816; padding: 7px 12px; cursor: pointer; }
.gdv-mail button:hover, .gdv-btn:hover { border-color: #1a1816; }
.gdv-btn.pri { background: #e8500a; border-color: #e8500a; color: #fff; }
.gdv-btn.pri:hover { background: #c93f00; border-color: #c93f00; }
.gdv-btn:disabled { opacity: .45; cursor: default; }
.gdv-sec { font-size: 11.5px; font-weight: 700; color: #6b6660; margin: 2px 0 8px; display: flex; align-items: center; gap: 8px; }
.gdv-sec + .gdv-grid { margin-bottom: 18px; }
.gdv-folders { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; margin-bottom: 18px; }
.gdv-folder { display: flex; align-items: center; gap: 8px; border: 1px solid #e2e0da; background: #fff; border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 13px; color: #1a1816; cursor: pointer; text-align: left; min-width: 0; }
.gdv-folder:hover { border-color: #e8500a; background: #fff8f4; }
.gdv-folder span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gdv-folder .gdv-fbadge { flex: none; margin-left: auto; padding: 2px 7px; border-radius: 999px; background: #e8500a; color: #fff; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
.gdv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; }
.gdv-item { position: relative; border: 2px solid transparent; border-radius: 10px; background: #f4f2ed; overflow: hidden; }
.gdv-item:hover { border-color: #d9d6cf; }
.gdv-item[data-on="true"] { border-color: #e8500a; }
.gdv-open { display: block; width: 100%; border: none; background: none; padding: 0; font: inherit; text-align: left; color: inherit; cursor: zoom-in; }
.gdv-open:focus-visible, .gdv-check:focus-visible { outline: 2px solid #1a1816; outline-offset: -2px; }
.gdv-folder:focus-visible, .gdv-btn:focus-visible, .gdv-crumb:focus-visible { outline: 2px solid #1a1816; outline-offset: 2px; }
.gdv-thumb { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: #ebe8e1; }
.gdv-name { display: block; padding: 5px 7px 6px; font-size: 11px; color: #5a5652; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: #fff; }
.gdv-check { position: absolute; top: 0; left: 0; width: 38px; height: 38px; border: none; background: none; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; border-radius: 10px; }
.gdv-check span { width: 24px; height: 24px; border-radius: 50%; background: rgba(255,255,255,.94); border: 1.5px solid #8a857c; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: transparent; }
.gdv-check:hover span { border-color: #e8500a; color: #e8500a; }
.gdv-check[aria-pressed="true"] span { background: #e8500a; border-color: #e8500a; color: #fff; }
.gdv-foot { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid #ece9e2; background: #faf9f6; flex-wrap: wrap; }
.gdv-count { flex: 1; min-width: 120px; color: #5a5652; font-size: 12.5px; }
.gdv-count.err { color: #dc2626; font-weight: 600; }
.gdv-view { position: absolute; inset: 0; z-index: 2; background: rgba(16,14,12,.95); display: flex; flex-direction: column; color: #fff; font-size: 13px; }
.gdv-view [hidden] { display: none !important; }
.gdv-vtop { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
.gdv-vname { font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 46%; }
.gdv-vmeta { flex: 1; min-width: 0; color: #c9c5bd; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gdv-vpos { flex: none; color: #e7e4de; font-variant-numeric: tabular-nums; }
.gdv-vx { flex: none; border: 1px solid rgba(255,255,255,.4); background: none; color: #fff; border-radius: 8px; font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 12px; cursor: pointer; }
.gdv-vx:hover { background: rgba(255,255,255,.12); }
.gdv-vstage { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; padding: 0 68px; }
.gdv-vimg { display: block; width: 100%; height: 100%; object-fit: contain; }
.gdv-vimg.soft { filter: blur(5px); }
.gdv-vnav { position: absolute; top: 50%; transform: translateY(-50%); width: 46px; height: 68px; border: none; border-radius: 10px; background: rgba(255,255,255,.14); color: #fff; font-size: 28px; line-height: 1; cursor: pointer; }
.gdv-vnav:hover { background: rgba(255,255,255,.26); }
.gdv-vnav:disabled { opacity: .22; cursor: default; background: rgba(255,255,255,.14); }
.gdv-vnav.prev { left: 12px; } .gdv-vnav.next { right: 12px; }
.gdv-vload { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,.6); padding: 5px 11px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
.gdv-vbot { display: flex; align-items: center; gap: 10px; padding: 12px 16px; flex-wrap: wrap; }
.gdv-vhint { flex: 1; min-width: 150px; color: #c9c5bd; font-size: 12px; }
.gdv-vsel { border: 1.5px solid #fff; background: none; color: #fff; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 700; padding: 8px 16px; min-width: 132px; cursor: pointer; }
.gdv-vsel:hover { background: rgba(255,255,255,.12); }
.gdv-vsel[aria-pressed="true"] { background: #fff; border-color: #fff; color: #1a1816; }
.gdv-vsel[aria-pressed="true"]:hover { background: #ece9e2; }
.gdv-vsel:disabled { opacity: .45; cursor: default; }
.gdv-view button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@media (max-width: 600px) { .gdv-back { padding: 0; } .gdv { border-radius: 0; height: 100%; } .gdv-grid { grid-template-columns: repeat(3, 1fr); gap: 6px; } .gdv-vstage { padding: 0 6px; } .gdv-vnav { width: 38px; height: 56px; } .gdv-vnav.prev { left: 4px; } .gdv-vnav.next { right: 4px; } .gdv-vmeta { display: none; } .gdv-vname { max-width: none; flex: 1; } }
`;
  const MAX_PICK = 200;
  const LAST_KEY = 'gm_drive_last', LAST_SAVE_KEY = 'gm_drive_save_last';
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  let styled = false;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b; };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mb = n => (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + 'MB';

  // 한 번에 몇 개씩만 서버에 보낸다
  function gate(max) {
    let n = 0; const q = [];
    return async fn => {
      if (n >= max) await new Promise(r => q.push(r));
      n++;
      try { return await fn(); } finally { n--; const next = q.shift(); if (next) next(); }
    };
  }
  async function api(path) {
    const r = await fetch(path);
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((j && j.error) || ('http_' + r.status)); e.status = r.status; e.code = (j && j.error) || ''; throw e; }
    return j;
  }
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((j && j.error) || ('http_' + r.status)); e.status = r.status; e.code = (j && j.error) || ''; throw e; }
    return j;
  }
  const qs = o => Object.keys(o).map(k => k + '=' + encodeURIComponent(o[k])).join('&');

  function open(opts) {
    if (!styled) { const st = el('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; }
    const onPick = (opts && opts.onPick) || (() => {});
    const FM = (opts && opts.folder) || null;          // 저장할 폴더 고르기
    const LAST = FM ? LAST_SAVE_KEY : LAST_KEY;
    const thumbGate = gate(6), fileGate = gate(4);
    const urls = [];                   // 닫을 때 지울 사진 주소
    const thumbCache = new Map();      // 사진 id → 작은 미리보기 주소 (폴더를 오가도 다시 받지 않게)
    const bigCache = new Map();        // 사진 id → 큰 미리보기 주소를 주는 약속
    const got = new Map();             // 받아 둔 원본 (다시 시도할 때 또 받지 않게)
    let stack = [];                    // 지금 위치: [{id, name, k}, …] (맨 앞 = 지정 폴더)
    let roots = [];
    let items = [];                    // 지금 화면에 보이는 사진: [{im, fid, chain, path, ord}]
    let picked = new Map();            // 고른 사진: id → {im, fid, chain, path, ord, seq} — 폴더를 옮겨도 남는다
    let pickSeq = 0;
    let view = 'folder';               // 'folder' = 폴더 보기 · 'picked' = 선택한 사진 모아 보기
    let lastIdx = -1;                  // Shift로 범위 고르기용
    let busy = false, closed = false, seq = 0;
    let io = null;
    let vw = null;                     // 크게 보기 창

    const title = (opts && opts.title) || '구글 드라이브에서 가져오기';
    const back = el('div', 'gdv-back');
    const box = el('div', 'gdv'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
    const head = el('div', 'gdv-head');
    head.append(el('div', 'gdv-title', title));
    const xBtn = btn('gdv-x', '닫기');
    head.append(xBtn);
    const crumbs = el('div', 'gdv-crumbs');
    const body = el('div', 'gdv-body');
    const foot = el('div', 'gdv-foot');
    const count = el('div', 'gdv-count'); count.setAttribute('role', 'status');
    const viewBtn = btn('gdv-btn', '선택한 사진 보기');
    const allBtn = btn('gdv-btn', '전체 선택');
    const goBtn = btn('gdv-btn pri', '가져오기');
    foot.append(count, viewBtn, allBtn, goBtn);
    box.append(head, crumbs, body, foot);
    back.append(box);
    document.body.appendChild(back);

    function close() {
      if (closed) return;
      closed = true; seq++;
      if (io) io.disconnect();
      urls.forEach(u => URL.revokeObjectURL(u));
      document.removeEventListener('keydown', onKey, true);
      back.remove();
    }
    // 캡처 단계에서 받아, 크게 보기 중의 방향키·Space가 뒤 화면(카드 이동 등)으로 새지 않게 한다
    function onKey(ev) {
      if (vw) {
        const k = ev.key;
        if (k === 'Escape') { ev.preventDefault(); ev.stopPropagation(); viewerClose(); }
        else if (k === 'ArrowRight' || k === 'ArrowLeft') { ev.preventDefault(); ev.stopPropagation(); viewerMove(k === 'ArrowRight' ? 1 : -1); }
        else if (k === 'Home' || k === 'End') { ev.preventDefault(); ev.stopPropagation(); viewerShow(k === 'Home' ? 0 : items.length - 1); }
        else if (k === ' ' || k === 'Spacebar') {
          ev.stopPropagation();
          const a = document.activeElement;
          if (!(a && a.tagName === 'BUTTON' && vw.root.contains(a))) { ev.preventDefault(); if (!FM) toggle(vw.i); }   // 버튼 위에서는 그 버튼이 눌린다(기본 = 선택 버튼)
        }
        return;
      }
      if (ev.key === 'Escape' && !busy) close();
    }
    document.addEventListener('keydown', onKey, true);
    xBtn.onclick = () => { if (!busy) close(); };
    back.addEventListener('pointerdown', ev => { if (ev.target === back && !busy) close(); });

    function message(html) {
      body.innerHTML = '';
      const m = el('div', 'gdv-msg'); m.innerHTML = html;
      body.appendChild(m);
      return m;
    }
    // 가져오는 순서: 먼저 고르기 시작한 폴더부터, 폴더 안에서는 보이는 순서
    function pickedList() {
      const rank = new Map();
      picked.forEach(p => { const r = rank.get(p.fid); if (r == null || p.seq < r) rank.set(p.fid, p.seq); });
      return [...picked.values()].sort((a, b) => (rank.get(a.fid) - rank.get(b.fid)) || (a.ord - b.ord));
    }
    const pickedSize = () => { let s = 0; picked.forEach(p => { s += p.im.size || 0; }); return s; };
    const sizeTxt = () => { const s = pickedSize(); return s ? ' · ' + mb(s) : ''; };
    const pickedUnder = fid => { let n = 0; picked.forEach(p => { if (p.chain.includes(fid)) n++; }); return n; };

    function syncFoot(note, isErr) {
      if (FM) {
        count.classList.toggle('err', !!isErr);
        count.textContent = note != null ? note : stack.length ? '저장할 곳: ' + stack.map(f => f.name).join(' › ') : '저장할 폴더를 골라 주세요';
        viewBtn.style.display = 'none';
        allBtn.style.display = stack.length ? '' : 'none'; allBtn.textContent = '새 폴더'; allBtn.disabled = busy;
        goBtn.style.display = ''; goBtn.disabled = busy || !stack.length;
        if (!busy) goBtn.textContent = FM.label || '이 폴더에 저장';
        return;
      }
      const n = picked.size;
      const here = items.filter(it => picked.has(it.im.id)).length;
      count.classList.toggle('err', !!isErr);
      count.textContent = note != null ? note
        : view === 'picked' ? (n ? `선택한 사진 ${n}장${sizeTxt()} · 이 순서대로 가져와요` : '선택한 사진이 없어요')
        : n ? `${n}장 선택${sizeTxt()}` + (n - here > 0 ? ` (다른 폴더 ${n - here}장 포함)` : '')
        : items.length ? `사진 ${items.length}장 · 사진을 누르면 크게 보고, 왼쪽 위 동그라미를 누르면 선택돼요` : '';
      viewBtn.style.display = view === 'picked' || n ? '' : 'none';
      viewBtn.textContent = view === 'picked' ? '폴더로 돌아가기' : '선택한 사진 보기';
      viewBtn.disabled = busy;
      if (view === 'picked') { allBtn.style.display = n ? '' : 'none'; allBtn.textContent = '모두 선택 해제'; }
      else { allBtn.style.display = items.length ? '' : 'none'; allBtn.textContent = items.length && here === items.length ? '이 폴더 선택 해제' : '이 폴더 전체 선택'; }
      allBtn.disabled = busy;
      goBtn.style.display = n || items.length ? '' : 'none';
      goBtn.disabled = busy || !n;
      if (!busy) goBtn.textContent = n ? `${n}장 가져오기` : '가져오기';
      if (vw) viewerPaint();
    }
    function drawCrumbs() {
      crumbs.innerHTML = '';
      const add = (label, onClick, cur) => {
        if (crumbs.childNodes.length) crumbs.append(el('span', 'gdv-sep', '›'));
        const b = btn('gdv-crumb' + (cur ? ' cur' : ''), label); b.title = label;
        if (cur) b.setAttribute('aria-current', 'true'); else b.onclick = () => { if (!busy) onClick(); };
        crumbs.append(b);
      };
      const inFolder = view === 'folder';
      if (roots.length > 1) add('지정 폴더', () => showRoots(), inFolder && !stack.length);
      stack.forEach((f, i) => add(f.name, () => { stack = stack.slice(0, i + 1); load(); }, inFolder && i === stack.length - 1));
      if (!inFolder) add('선택한 사진', null, true);
    }
    function remember() { try { localStorage.setItem(LAST, JSON.stringify(stack)); } catch {} }

    function showRoots() {
      stack = []; items = []; view = 'folder'; lastIdx = -1; seq++;
      if (io) { io.disconnect(); io = null; }
      drawCrumbs();
      body.innerHTML = '';
      body.append(el('div', 'gdv-sec', '지정 폴더'));
      const wrap = el('div', 'gdv-folders');
      roots.forEach(f => wrap.append(folderBtn(f)));
      body.append(wrap);
      syncFoot();
    }
    function folderBtn(f) {
      const b = btn('gdv-folder'); b.title = f.name;
      b.append(el('span', null, '📁'), el('span', null, f.name));
      const n = FM ? 0 : pickedUnder(f.id);
      if (n) { const g = el('span', 'gdv-fbadge', n + '장'); g.title = `이 폴더에서 ${n}장 선택함`; b.append(g); b.setAttribute('aria-label', `${f.name} — ${n}장 선택함`); }
      b.onclick = () => { if (busy) return; stack.push({ id: f.id, name: f.name, k: f.k }); load(); };
      return b;
    }

    // 미리보기는 화면에 보일 때 받는다
    function watchThumb(img, im) {
      const had = thumbCache.get(im.id);
      if (had) { img.src = had; return; }
      if (!im.t) return;
      if (!io) io = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          const it = en.target._im, mySeq = seq;
          thumbGate(async () => {
            if (closed || mySeq !== seq) return;
            try {
              const r = await fetch('/api/drive/thumb?' + qs({ u: it.t, k: it.tk }));
              if (!r.ok) return;
              const url = URL.createObjectURL(await r.blob());
              urls.push(url); thumbCache.set(it.id, url);
              if (closed) return;
              en.target.src = url;
            } catch {}
          });
        });
      }, { root: body, rootMargin: '200px' });
      img._im = im;
      io.observe(img);
    }

    function setPick(it, on) {
      const id = it.im.id;
      if (!on) { picked.delete(id); return true; }
      if (picked.has(id)) return true;
      if (picked.size >= MAX_PICK) return false;
      picked.set(id, { im: it.im, fid: it.fid, chain: it.chain, path: it.path, ord: it.ord, seq: ++pickSeq });
      return true;
    }
    function toggle(i, ev) {
      if (busy || FM || !items[i]) return;
      const turnOn = !picked.has(items[i].im.id);
      const range = ev && ev.shiftKey && lastIdx >= 0 ? [Math.min(lastIdx, i), Math.max(lastIdx, i)] : [i, i];
      let full = false;
      for (let x = range[0]; x <= range[1]; x++) if (!setPick(items[x], turnOn)) full = true;
      lastIdx = i;
      paintPicked();
      syncFoot(full ? `한 번에 ${MAX_PICK}장까지 가져올 수 있어요` : null);
    }
    function paintPicked() {
      body.querySelectorAll('.gdv-item').forEach(n => {
        const it = items[+n.dataset.i]; if (!it) return;
        const on = picked.has(it.im.id);
        n.dataset.on = on ? 'true' : 'false';
        const c = n.querySelector('.gdv-check'); if (c) c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    // 사진 칸: 사진을 누르면 크게 보기, 왼쪽 위 동그라미를 누르면 선택
    function itemEl(i) {
      const im = items[i].im, on = picked.has(im.id);
      const wrap = el('div', 'gdv-item'); wrap.dataset.i = i; wrap.dataset.on = on ? 'true' : 'false'; wrap.title = im.name;
      const o = btn('gdv-open'); o.setAttribute('aria-label', im.name + ' 크게 보기');
      const img = el('img', 'gdv-thumb'); img.alt = ''; img.decoding = 'async'; img.src = BLANK;
      watchThumb(img, im);
      o.append(img, el('span', 'gdv-name', im.name));
      o.onclick = () => viewerOpen(i);
      wrap.append(o);
      if (!FM) {
        const c = btn('gdv-check'); c.setAttribute('aria-label', im.name + ' 선택'); c.setAttribute('aria-pressed', on ? 'true' : 'false');
        c.append(el('span', null, '✓'));
        c.onclick = ev => toggle(i, ev);
        wrap.append(c);
      }
      return wrap;
    }

    async function load() {
      const mySeq = ++seq;
      const cur = stack[stack.length - 1];
      items = []; view = 'folder'; lastIdx = -1;
      if (io) { io.disconnect(); io = null; }
      drawCrumbs(); syncFoot();
      message('불러오는 중…');
      let d;
      try { d = await api('/api/drive/list?' + qs({ folder: cur.id, k: cur.k })); }
      catch (e) {
        if (mySeq !== seq || closed) return;
        if (stack.length > 1 && (e.status === 404 || e.status === 400)) { stack = stack.slice(0, 1); return load(); }   // 지워졌거나 옮겨진 폴더
        return fail(e);
      }
      if (mySeq !== seq || closed) return;
      remember();
      const chain = stack.map(f => f.id), path = stack.map(f => f.name).join(' › ');
      items = (d.images || []).map((im, ord) => ({ im, fid: cur.id, chain, path, ord }));
      body.innerHTML = '';
      if (d.folders && d.folders.length) {
        body.append(el('div', 'gdv-sec', `폴더 ${d.folders.length}개`));
        const wrap = el('div', 'gdv-folders');
        d.folders.forEach(f => wrap.append(folderBtn(f)));
        body.append(wrap);
      }
      if (items.length) {
        body.append(el('div', 'gdv-sec', FM ? `이 폴더에 있는 사진 ${items.length}장` : `사진 ${items.length}장`));
        const grid = el('div', 'gdv-grid');
        items.forEach((it, i) => grid.append(itemEl(i)));
        body.append(grid);
      }
      if (!items.length && !(d.folders && d.folders.length)) {
        message(FM ? '이 폴더는 비어 있어요. 여기에 저장할 수 있어요.' : d.other ? `이 폴더에는 가져올 수 있는 사진이 없어요.<br>(사진이 아닌 파일 ${Number(d.other) || 0}개)` : '이 폴더는 비어 있어요.');
      } else if (d.other) {
        body.append(el('div', 'gdv-sec', `사진이 아닌 파일 ${d.other}개는 보이지 않아요`));
        body.lastChild.style.marginTop = '14px';
      }
      body.scrollTop = 0;
      syncFoot();
    }

    // 선택한 사진 모아 보기 — 여러 폴더에서 고른 사진을 가져올 순서대로, 폴더별로 묶어 보여 준다
    function showPicked() {
      seq++;
      view = 'picked'; lastIdx = -1;
      if (io) { io.disconnect(); io = null; }
      items = pickedList().map(p => ({ im: p.im, fid: p.fid, chain: p.chain, path: p.path, ord: p.ord }));
      drawCrumbs();
      body.innerHTML = '';
      if (!items.length) { message('선택한 사진이 없어요.'); syncFoot(); return; }
      let grid = null, fid = null;
      items.forEach((it, i) => {
        if (it.fid !== fid) {
          fid = it.fid;
          body.append(el('div', 'gdv-sec', `${it.path} · ${items.filter(x => x.fid === fid).length}장`));
          grid = el('div', 'gdv-grid'); body.append(grid);
        }
        grid.append(itemEl(i));
      });
      body.scrollTop = 0;
      syncFoot();
    }
    viewBtn.onclick = () => {
      if (busy || FM) return;
      if (view === 'picked') return stack.length ? load() : showRoots();
      showPicked();
    };

    // ── 크게 보기 ── 사진을 누르면 열린다. ← → 로 앞뒤 사진, Space(또는 [선택] 버튼)로 선택, Esc 로 닫기
    function loadBig(im) {
      if (bigCache.has(im.id)) return bigCache.get(im.id);
      const p = (async () => {
        if (im.t) {
          try {
            const r = await fetch('/api/drive/thumb?' + qs({ u: im.t, k: im.tk, big: 1 }));
            if (r.ok) { const url = URL.createObjectURL(await r.blob()); urls.push(url); return url; }
          } catch {}
        }
        const url = URL.createObjectURL(await download(im));   // 큰 미리보기가 없으면 원본
        urls.push(url);
        return url;
      })();
      bigCache.set(im.id, p);
      p.catch(() => bigCache.delete(im.id));
      return p;
    }
    function viewerOpen(i) {
      if (busy || vw || !items[i]) return;
      const root = el('div', 'gdv-view'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', '사진 크게 보기');
      const top = el('div', 'gdv-vtop');
      const name = el('div', 'gdv-vname'), meta = el('div', 'gdv-vmeta'), pos = el('div', 'gdv-vpos');
      const x = btn('gdv-vx', '닫기');
      top.append(name, meta, pos, x);
      const stage = el('div', 'gdv-vstage');
      const prev = btn('gdv-vnav prev', '‹'); prev.setAttribute('aria-label', '이전 사진');
      const next = btn('gdv-vnav next', '›'); next.setAttribute('aria-label', '다음 사진');
      const img = el('img', 'gdv-vimg'); img.alt = '';
      const load = el('div', 'gdv-vload', '불러오는 중…'); load.setAttribute('role', 'status');
      stage.append(prev, img, next, load);
      const bot = el('div', 'gdv-vbot');
      const hint = el('div', 'gdv-vhint', FM ? '← → 키로 앞뒤 사진 · Esc 닫기' : '← → 키로 앞뒤 사진 · Space 키로 선택 · Esc 닫기');
      const sel = btn('gdv-vsel', '선택');
      const go = btn('gdv-btn pri', '가져오기');
      bot.append(hint);
      if (!FM) bot.append(sel, go);
      root.append(top, stage, bot);
      vw = { root, name, meta, pos, img, load, prev, next, sel, go, x, i: -1, tick: 0 };
      const refocus = () => { if (vw) (FM ? x : sel).focus(); };
      x.onclick = () => viewerClose();
      prev.onclick = () => { viewerMove(-1); refocus(); };
      next.onclick = () => { viewerMove(1); refocus(); };
      stage.onclick = ev => { if (ev.target === stage) viewerClose(); };
      sel.onclick = () => toggle(vw.i);
      go.onclick = () => { viewerClose(); goBtn.click(); };
      box.inert = true;
      back.append(root);
      viewerShow(i);
      refocus();
    }
    function viewerShow(i) {
      if (!vw || !items[i]) return;
      vw.i = i;
      const it = items[i], im = it.im, my = ++vw.tick;
      vw.name.textContent = im.name; vw.name.title = im.name;
      vw.meta.textContent = [it.path, im.w && im.h ? `${im.w}×${im.h}` : '', im.size ? mb(im.size) : ''].filter(Boolean).join(' · ');
      vw.pos.textContent = `${i + 1} / ${items.length}`;
      vw.prev.disabled = i <= 0; vw.next.disabled = i >= items.length - 1;
      vw.img.src = thumbCache.get(im.id) || BLANK; vw.img.classList.add('soft');   // 큰 사진이 올 때까지 작은 미리보기를 흐리게
      vw.load.textContent = '불러오는 중…'; vw.load.hidden = false;
      loadBig(im).then(url => {
        if (!vw || vw.tick !== my) return;
        vw.img.src = url; vw.img.classList.remove('soft'); vw.load.hidden = true;
      }, () => {
        if (!vw || vw.tick !== my) return;
        vw.load.textContent = '사진을 불러오지 못했어요';
      });
      [i + 1, i - 1].forEach(j => { if (items[j]) loadBig(items[j].im).catch(() => {}); });   // 앞뒤 사진은 미리 받아 둔다
      viewerPaint();
    }
    function viewerMove(d) { if (vw) viewerShow(Math.max(0, Math.min(items.length - 1, vw.i + d))); }
    function viewerPaint() {
      if (!vw || FM || !items[vw.i]) return;
      const on = picked.has(items[vw.i].im.id), n = picked.size;
      vw.sel.setAttribute('aria-pressed', on ? 'true' : 'false');
      vw.sel.textContent = on ? '✓ 선택됨 · 해제' : '선택';
      vw.sel.disabled = busy || (!on && n >= MAX_PICK);
      vw.go.textContent = n ? `${n}장 가져오기` : '가져오기';
      vw.go.disabled = busy || !n;
    }
    function viewerClose() {
      if (!vw) return;
      const i = vw.i;
      vw.root.remove(); vw = null;
      box.inert = false;
      const n = body.querySelector(`.gdv-item[data-i="${i}"]`);
      if (n) { n.scrollIntoView({ block: 'nearest' }); const o = n.querySelector('.gdv-open'); if (o) o.focus({ preventScroll: true }); }
    }

    function fail(e) {
      items = [];
      const code = (e && e.code) || '';
      if (code === 'drive_not_configured' || code === 'drive_bad_key') {
        message('<b>구글 드라이브가 아직 연결되지 않았어요.</b><br>관리자가 서버에 구글 연결 키를 넣으면 바로 쓸 수 있어요.');
      } else if (e && e.status === 403) {
        message('<b>이 계정으로는 쓸 수 없어요.</b>');
      } else if (code === 'drive_auth') {
        message('<b>구글에 연결하지 못했어요.</b><br>구글 연결 키가 만료되었거나 바뀌었을 수 있어요. 관리자에게 알려 주세요.');
      } else {
        const m = message('<b>드라이브를 불러오지 못했어요.</b><br>인터넷 연결을 확인한 뒤 다시 시도해주세요.<br>');
        const b = btn('gdv-btn', '다시 시도'); b.style.marginTop = '12px';
        b.onclick = () => (stack.length ? load() : start());
        m.append(b);
      }
      syncFoot();
    }

    async function start() {
      const mySeq = ++seq;
      message('불러오는 중…'); syncFoot();
      let d;
      try { d = await api('/api/drive/list'); } catch (e) { if (mySeq === seq && !closed) fail(e); return; }
      if (mySeq !== seq || closed) return;
      roots = d.roots || [];
      if (!roots.length) {
        const name = esc((d.rootNames || []).map(n => `"${n}"`).join(', '));
        const m = message(`<b>${name} 폴더가 아직 연결되지 않았어요.</b><br>구글 드라이브에서 이 폴더를 아래 주소에 <b>뷰어</b>로 공유하면 여기에 나타나요.<br>`);
        if (d.shareEmail) {
          const box2 = el('span', 'gdv-mail'); box2.append(el('span', null, d.shareEmail));
          const cp = btn(null, '복사');
          cp.onclick = async () => { try { await navigator.clipboard.writeText(d.shareEmail); cp.textContent = '복사됨'; setTimeout(() => { cp.textContent = '복사'; }, 1500); } catch {} };
          box2.append(cp); m.append(box2);
        }
        return;
      }
      // 지난번에 보던 폴더가 지금도 지정 폴더 아래면 거기서 시작한다
      let last = [];
      try { last = JSON.parse(localStorage.getItem(LAST)) || []; } catch {}
      const okLast = Array.isArray(last) && last.length && last.every(f => f && typeof f.id === 'string' && typeof f.k === 'string' && typeof f.name === 'string')
        && roots.some(r => r.id === last[0].id);
      if (okLast) { stack = last.map(f => ({ id: f.id, name: f.name, k: f.k })); return load(); }
      if (roots.length === 1) { stack = [{ id: roots[0].id, name: roots[0].name, k: roots[0].k }]; return load(); }
      showRoots();
    }

    // 저장할 폴더 고르기: [새 폴더]
    async function newFolder() {
      const cur = stack[stack.length - 1];
      if (!cur) return;
      const name = (prompt(`"${cur.name}" 안에 만들 새 폴더 이름을 적어 주세요`) || '').trim();
      if (!name) return;
      busy = true; syncFoot('폴더를 만드는 중…');
      try {
        const f = await post('/api/gdrive/mkdir', { folder: cur.id, k: cur.k, name });
        busy = false;
        if (closed) return;
        stack.push({ id: f.id, name: f.name, k: f.k });
        await load();
        if (f.existed) syncFoot(`"${f.name}" 폴더가 이미 있어서 그 폴더를 열었어요`);
      } catch (e) {
        busy = false;
        if (closed) return;
        syncFoot(saveErr(e, '폴더를 만들지 못했어요.'), true);
      }
    }
    function saveErr(e, fallback) {
      const c = (e && e.code) || '';
      return c === 'gdrive_not_connected' ? '구글 계정이 연결되어 있지 않아요. 창을 닫고 [구글 계정 연결]을 먼저 해 주세요.'
        : c === 'gdrive_expired' ? '구글 계정 연결이 끊겼어요. 창을 닫고 다시 연결해 주세요.'
        : c === 'gdrive_no_edit' ? '연결한 구글 계정에 이 폴더의 편집 권한이 없어요.'
        : c === 'gdrive_no_folder' ? '연결한 구글 계정으로는 이 폴더가 보이지 않아요.'
        : c === 'gdrive_quota' ? '구글 드라이브 저장 공간이 부족해요.'
        : c === 'bad_name' ? '쓸 수 없는 이름이에요. 다른 이름으로 적어 주세요.'
        : c === 'many' ? '같은 이름의 파일이 여러 개 있어서 바꿀 수 없어요. 드라이브에서 정리하거나 다른 이름으로 저장해 주세요.'
        : c === 'too_big' ? 'GIF가 너무 커요. 40MB까지 저장할 수 있어요.'
        : c === 'not_gif' ? 'GIF 파일만 저장할 수 있어요.'
        : c === 'gdrive_not_configured' ? '서버에 구글 연결 설정이 아직 없어요.'
        : (e && e.status === 403) ? '관리자만 할 수 있어요.'
        : fallback + ' 잠시 뒤 다시 시도해주세요.';
    }

    allBtn.onclick = () => {
      if (FM) { if (!busy) newFolder(); return; }
      if (busy) return;
      lastIdx = -1;
      if (view === 'picked') { picked = new Map(); paintPicked(); syncFoot(); return; }
      let full = false;
      if (items.length && items.every(it => picked.has(it.im.id))) items.forEach(it => setPick(it, false));
      else items.forEach(it => { if (!setPick(it, true)) full = true; });
      paintPicked();
      syncFoot(full ? `한 번에 ${MAX_PICK}장까지라, 앞에서부터 들어가는 만큼만 골랐어요` : null);
    };

    // 원본 한 장 (실패하면 두 번 더)
    async function download(im) {
      if (got.has(im.id)) return got.get(im.id);
      let lastErr = null;
      for (let t = 0; t < 3; t++) {
        try {
          const r = await fetch('/api/drive/file?' + qs({ id: im.id, k: im.k }));
          if (!r.ok) { const e = new Error('http_' + r.status); e.status = r.status; throw e; }
          const blob = await r.blob();
          if (im.size && blob.size !== im.size) throw new Error('size');
          const f = new File([blob], im.name, { type: blob.type || 'image/jpeg' });
          got.set(im.id, f);
          return f;
        } catch (e) {
          lastErr = e;
          if (e.status === 401 || e.status === 403 || e.status === 413 || e.status === 415) break;
          await new Promise(r => setTimeout(r, 600 * (t + 1)));
        }
      }
      throw lastErr;
    }

    goBtn.onclick = async () => {
      if (busy) return;
      if (FM) {
        const cur = stack[stack.length - 1];
        if (!cur) return;
        busy = true; goBtn.textContent = '저장 중…'; syncFoot('저장하는 중…');
        let out;
        try { out = await FM.onSave({ id: cur.id, k: cur.k, name: cur.name, path: stack.map(f => f.name).join(' › ') }, { note: t => { if (!closed) count.textContent = t; }, errText: saveErr }); }
        catch (e) { console.error(e); out = saveErr(e, '저장하지 못했어요.'); }
        busy = false;
        if (closed) return;
        if (out === true) return close();
        syncFoot(typeof out === 'string' && out ? out : null, typeof out === 'string' && !!out);
        return;
      }
      const sel = pickedList().map(p => p.im);   // 먼저 고르기 시작한 폴더부터, 폴더 안에서는 보이는 순서
      if (!sel.length) return;
      busy = true;
      let done = 0;
      const tick = () => { goBtn.textContent = `받는 중… (${done}/${sel.length})`; };
      tick(); syncFoot(`원본 사진을 받고 있어요 (${done}/${sel.length})`);
      const results = await Promise.all(sel.map(im => fileGate(async () => {
        if (closed) return null;
        try { const f = await download(im); done++; tick(); count.textContent = `원본 사진을 받고 있어요 (${done}/${sel.length})`; return f; }
        catch (e) { return null; }
      })));
      busy = false;
      if (closed) return;
      const failed = results.filter(f => !f).length;
      if (failed) {
        // 일부만 넣지 않는다 — 받은 사진은 보관해 두었으니 다시 누르면 못 받은 것만 받는다
        syncFoot(`${failed}장을 받지 못했어요. [가져오기]를 다시 눌러 주세요 (받은 사진은 다시 받지 않아요)`, true);
        return;
      }
      close();
      try { await onPick(results); } catch (e) { console.error(e); }
    };

    start();
  }

  window.GMDrive = { open };
})();
