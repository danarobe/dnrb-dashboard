// 구글 드라이브 지정 폴더에서 사진 가져오기 (GIF 만들기 · 카드뉴스 화면)
//   GMDrive.open({ onPick(files), title? })  — 고른 사진을 File 목록으로 넘겨 준다(폴더에 보이는 순서 = 이름 순서).
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
.gdv-folders { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; margin-bottom: 18px; }
.gdv-folder { display: flex; align-items: center; gap: 8px; border: 1px solid #e2e0da; background: #fff; border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 13px; color: #1a1816; cursor: pointer; text-align: left; min-width: 0; }
.gdv-folder:hover { border-color: #e8500a; background: #fff8f4; }
.gdv-folder span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gdv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; }
.gdv-item { position: relative; border: 2px solid transparent; border-radius: 10px; background: #f4f2ed; padding: 0; cursor: pointer; overflow: hidden; font: inherit; text-align: left; }
.gdv-item:hover { border-color: #d9d6cf; }
.gdv-item[aria-pressed="true"] { border-color: #e8500a; }
.gdv-item:focus-visible, .gdv-folder:focus-visible, .gdv-btn:focus-visible, .gdv-crumb:focus-visible { outline: 2px solid #1a1816; outline-offset: 2px; }
.gdv-thumb { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: #ebe8e1; }
.gdv-name { display: block; padding: 5px 7px 6px; font-size: 11px; color: #5a5652; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: #fff; }
.gdv-check { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(255,255,255,.92); border: 1.5px solid #b8b4ac; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: transparent; }
.gdv-item[aria-pressed="true"] .gdv-check { background: #e8500a; border-color: #e8500a; color: #fff; }
.gdv-foot { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid #ece9e2; background: #faf9f6; flex-wrap: wrap; }
.gdv-count { flex: 1; min-width: 120px; color: #5a5652; font-size: 12.5px; }
.gdv-count.err { color: #dc2626; font-weight: 600; }
@media (max-width: 600px) { .gdv-back { padding: 0; } .gdv { border-radius: 0; height: 100%; } .gdv-grid { grid-template-columns: repeat(3, 1fr); gap: 6px; } }
`;
  const MAX_PICK = 200;
  const LAST_KEY = 'gm_drive_last';
  let styled = false;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
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
  const qs = o => Object.keys(o).map(k => k + '=' + encodeURIComponent(o[k])).join('&');

  function open(opts) {
    if (!styled) { const st = el('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; }
    const onPick = (opts && opts.onPick) || (() => {});
    const thumbGate = gate(6), fileGate = gate(4);
    const thumbUrls = [];              // 닫을 때 지울 미리보기 주소
    const got = new Map();             // 받아 둔 원본 (다시 시도할 때 또 받지 않게)
    let stack = [];                    // 지금 위치: [{id, name, k}, …] (맨 앞 = 지정 폴더)
    let roots = [];
    let images = [];                   // 지금 폴더의 사진
    let picked = new Set();            // 고른 사진 id
    let lastIdx = -1;                  // Shift로 범위 고르기용
    let busy = false, closed = false, seq = 0;
    let io = null;

    const back = el('div', 'gdv-back');
    const box = el('div', 'gdv'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', (opts && opts.title) || '구글 드라이브에서 가져오기');
    const head = el('div', 'gdv-head');
    head.append(el('div', 'gdv-title', (opts && opts.title) || '구글 드라이브에서 가져오기'));
    const xBtn = el('button', 'gdv-x', '닫기'); xBtn.type = 'button';
    head.append(xBtn);
    const crumbs = el('div', 'gdv-crumbs');
    const body = el('div', 'gdv-body');
    const foot = el('div', 'gdv-foot');
    const count = el('div', 'gdv-count'); count.setAttribute('role', 'status');
    const allBtn = el('button', 'gdv-btn', '전체 선택'); allBtn.type = 'button';
    const goBtn = el('button', 'gdv-btn pri', '가져오기'); goBtn.type = 'button';
    foot.append(count, allBtn, goBtn);
    box.append(head, crumbs, body, foot);
    back.append(box);
    document.body.appendChild(back);

    function close() {
      if (closed) return;
      closed = true; seq++;
      if (io) io.disconnect();
      thumbUrls.forEach(u => URL.revokeObjectURL(u));
      document.removeEventListener('keydown', onKey);
      back.remove();
    }
    function onKey(ev) { if (ev.key === 'Escape' && !busy) close(); }
    document.addEventListener('keydown', onKey);
    xBtn.onclick = () => { if (!busy) close(); };
    back.addEventListener('pointerdown', ev => { if (ev.target === back && !busy) close(); });

    function message(html) {
      body.innerHTML = '';
      const m = el('div', 'gdv-msg'); m.innerHTML = html;
      body.appendChild(m);
      return m;
    }
    function syncFoot(note, isErr) {
      const sel = images.filter(im => picked.has(im.id));
      const size = sel.reduce((a, im) => a + (im.size || 0), 0);
      count.classList.toggle('err', !!isErr);
      count.textContent = note != null ? note
        : !images.length ? ''
        : sel.length ? `${sel.length}장 선택 · ${mb(size)}` : `사진 ${images.length}장 · 누르면 선택돼요 (Shift를 누른 채 누르면 사이 사진까지)`;
      allBtn.style.display = images.length ? '' : 'none';
      allBtn.textContent = sel.length && sel.length === Math.min(images.length, MAX_PICK) ? '선택 해제' : '전체 선택';
      goBtn.style.display = images.length ? '' : 'none';
      goBtn.disabled = busy || !sel.length;
      goBtn.textContent = busy ? goBtn.textContent : sel.length ? `${sel.length}장 가져오기` : '가져오기';
      allBtn.disabled = busy;
    }
    function drawCrumbs() {
      crumbs.innerHTML = '';
      const add = (label, onClick, cur) => {
        if (crumbs.childNodes.length) crumbs.append(el('span', 'gdv-sep', '›'));
        const b = el('button', 'gdv-crumb' + (cur ? ' cur' : ''), label); b.type = 'button'; b.title = label;
        if (cur) b.setAttribute('aria-current', 'true'); else b.onclick = () => { if (!busy) onClick(); };
        crumbs.append(b);
      };
      if (roots.length > 1) add('지정 폴더', () => showRoots(), !stack.length);
      stack.forEach((f, i) => add(f.name, () => { stack = stack.slice(0, i + 1); load(); }, i === stack.length - 1));
    }
    function remember() { try { localStorage.setItem(LAST_KEY, JSON.stringify(stack)); } catch {} }

    function showRoots() {
      stack = []; images = []; picked = new Set(); seq++;
      drawCrumbs();
      body.innerHTML = '';
      body.append(el('div', 'gdv-sec', '지정 폴더'));
      const wrap = el('div', 'gdv-folders');
      roots.forEach(f => wrap.append(folderBtn(f)));
      body.append(wrap);
      syncFoot();
    }
    function folderBtn(f) {
      const b = el('button', 'gdv-folder'); b.type = 'button'; b.title = f.name;
      b.append(el('span', null, '📁'), el('span', null, f.name));
      b.onclick = () => { if (busy) return; stack.push({ id: f.id, name: f.name, k: f.k }); load(); };
      return b;
    }

    // 미리보기는 화면에 보일 때 받는다
    function watchThumb(img, im) {
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
              thumbUrls.push(url);
              en.target.src = url;
            } catch {}
          });
        });
      }, { root: body, rootMargin: '200px' });
      img._im = im;
      io.observe(img);
    }

    function toggle(i, ev) {
      if (busy) return;
      const im = images[i];
      const turnOn = !picked.has(im.id);
      const range = ev && ev.shiftKey && lastIdx >= 0 ? [Math.min(lastIdx, i), Math.max(lastIdx, i)] : [i, i];
      for (let x = range[0]; x <= range[1]; x++) {
        if (turnOn) { if (picked.size < MAX_PICK) picked.add(images[x].id); }
        else picked.delete(images[x].id);
      }
      lastIdx = i;
      paintPicked();
      syncFoot(turnOn && picked.size >= MAX_PICK ? `한 번에 ${MAX_PICK}장까지 가져올 수 있어요` : null);
    }
    function paintPicked() {
      body.querySelectorAll('.gdv-item').forEach((b, i) => b.setAttribute('aria-pressed', picked.has(images[i].id) ? 'true' : 'false'));
    }

    async function load() {
      const mySeq = ++seq;
      const cur = stack[stack.length - 1];
      images = []; picked = new Set(); lastIdx = -1;
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
      images = d.images || [];
      body.innerHTML = '';
      if (d.folders && d.folders.length) {
        body.append(el('div', 'gdv-sec', `폴더 ${d.folders.length}개`));
        const wrap = el('div', 'gdv-folders');
        d.folders.forEach(f => wrap.append(folderBtn(f)));
        body.append(wrap);
      }
      if (images.length) {
        body.append(el('div', 'gdv-sec', `사진 ${images.length}장`));
        const grid = el('div', 'gdv-grid');
        images.forEach((im, i) => {
          const b = el('button', 'gdv-item'); b.type = 'button'; b.title = im.name; b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', im.name);
          const img = el('img', 'gdv-thumb'); img.alt = ''; img.decoding = 'async';
          img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
          watchThumb(img, im);
          b.append(img, el('span', 'gdv-check', '✓'), el('span', 'gdv-name', im.name));
          b.onclick = ev => toggle(i, ev);
          grid.append(b);
        });
        body.append(grid);
      }
      if (!images.length && !(d.folders && d.folders.length)) {
        message(d.other ? `이 폴더에는 가져올 수 있는 사진이 없어요.<br>(사진이 아닌 파일 ${Number(d.other) || 0}개)` : '이 폴더는 비어 있어요.');
      } else if (d.other) {
        body.append(el('div', 'gdv-sec', `사진이 아닌 파일 ${d.other}개는 보이지 않아요`));
        body.lastChild.style.marginTop = '14px';
      }
      body.scrollTop = 0;
      syncFoot();
    }

    function fail(e) {
      images = []; picked = new Set();
      const code = (e && e.code) || '';
      if (code === 'drive_not_configured' || code === 'drive_bad_key') {
        message('<b>구글 드라이브가 아직 연결되지 않았어요.</b><br>관리자가 서버에 구글 연결 키를 넣으면 바로 쓸 수 있어요.');
      } else if (e && e.status === 403) {
        message('<b>이 계정으로는 쓸 수 없어요.</b>');
      } else if (code === 'drive_auth') {
        message('<b>구글에 연결하지 못했어요.</b><br>구글 연결 키가 만료되었거나 바뀌었을 수 있어요. 관리자에게 알려 주세요.');
      } else {
        const m = message('<b>드라이브를 불러오지 못했어요.</b><br>인터넷 연결을 확인한 뒤 다시 시도해주세요.<br>');
        const b = el('button', 'gdv-btn', '다시 시도'); b.type = 'button'; b.style.marginTop = '12px';
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
          const cp = el('button', null, '복사'); cp.type = 'button';
          cp.onclick = async () => { try { await navigator.clipboard.writeText(d.shareEmail); cp.textContent = '복사됨'; setTimeout(() => { cp.textContent = '복사'; }, 1500); } catch {} };
          box2.append(cp); m.append(box2);
        }
        return;
      }
      // 지난번에 보던 폴더가 지금도 지정 폴더 아래면 거기서 시작한다
      let last = [];
      try { last = JSON.parse(localStorage.getItem(LAST_KEY)) || []; } catch {}
      const okLast = Array.isArray(last) && last.length && last.every(f => f && typeof f.id === 'string' && typeof f.k === 'string' && typeof f.name === 'string')
        && roots.some(r => r.id === last[0].id);
      if (okLast) { stack = last.map(f => ({ id: f.id, name: f.name, k: f.k })); return load(); }
      if (roots.length === 1) { stack = [{ id: roots[0].id, name: roots[0].name, k: roots[0].k }]; return load(); }
      showRoots();
    }

    allBtn.onclick = () => {
      if (busy) return;
      const cap = Math.min(images.length, MAX_PICK);
      if (picked.size === cap) picked = new Set();
      else picked = new Set(images.slice(0, MAX_PICK).map(im => im.id));
      lastIdx = -1;
      paintPicked();
      syncFoot(images.length > MAX_PICK && picked.size ? `앞에서부터 ${MAX_PICK}장을 골랐어요 (한 번에 ${MAX_PICK}장까지)` : null);
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
      const sel = images.filter(im => picked.has(im.id));   // 폴더에 보이는 순서
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
