// GIF 메이커(워크스페이스 내장) — 모든 도구 화면이 맨 먼저 부르는 공용 스크립트.
//  · 워크스페이스 로그인(localStorage dnrb_session)을 그대로 쓴다. 카카오 로그인·기존 GIF 메이커와는 무관하다.
//  · 도구 화면의 '/api/…' 호출을 워크스페이스 서버(gif 함수)로 돌리고 로그인 증표를 붙인다.
//  · 쓸 수 있는 사람(관리자·MD/컨텐츠)이 아니면 화면 대신 안내를 보여 준다. 진짜 차단은 서버가 한다.
(function () {
  'use strict';
  var CFG = window.DNRB_CONFIG || {};
  var FN = (CFG.SUPABASE_URL || '') + '/functions/v1/gif';
  var ANON = CFG.SUPABASE_ANON_KEY || '';
  var OK_ROLES = ['admin', 'staff', 'marketer'];

  function session() {
    try {
      var s = JSON.parse(localStorage.getItem('dnrb_session'));
      if (s && s.token && s.exp > Date.now()) return s;
    } catch (e) {}
    return null;
  }

  // 안내 화면 (로그인 안 됨 · 쓸 수 없는 역할)
  function block(title, desc) {
    var show = function () {
      var b = document.body;
      if (!b) return;
      b.innerHTML = '';
      b.style.cssText = 'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0efe9;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR",sans-serif;color:#1a1816;';
      var box = document.createElement('div');
      box.style.cssText = 'max-width:360px;margin:24px;padding:28px 24px;background:#fff;border:1px solid #e2e0da;border-radius:16px;text-align:center;';
      var h = document.createElement('div'); h.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:8px;'; h.textContent = title;
      var p = document.createElement('div'); p.style.cssText = 'font-size:13px;line-height:1.6;color:#5a5652;'; p.textContent = desc;
      box.appendChild(h); box.appendChild(p);
      if (window.top === window.self) {
        var a = document.createElement('a'); a.href = '../#gif'; a.textContent = '워크스페이스로 가기';
        a.style.cssText = 'display:inline-block;margin-top:16px;padding:9px 16px;border-radius:9px;background:#1a1816;color:#fff;font-size:13px;font-weight:600;text-decoration:none;';
        box.appendChild(a);
      }
      b.appendChild(box);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  var s0 = session();
  var blocked = false;
  if (!s0) { blocked = true; block('로그인이 필요해요', '워크스페이스에 로그인한 뒤 다시 열어 주세요.'); }
  else if (OK_ROLES.indexOf(s0.role) < 0) { blocked = true; block('사용할 수 없는 메뉴예요', 'GIF 메이커는 관리자와 MD/컨텐츠 팀 계정만 쓸 수 있어요.'); }

  var origFetch = window.fetch.bind(window);
  function apiFetch(path, init) {
    var s = session();
    var h = new Headers((init && init.headers) || {});
    h.set('apikey', ANON);
    h.set('Authorization', 'Bearer ' + ANON);
    h.set('x-auth-token', s ? s.token : '');
    var o = Object.assign({}, init || {}, { headers: h, credentials: 'omit' });
    return origFetch(FN + path, o).then(function (r) {
      if (r.status === 401 && !blocked) {   // 로그인이 끝났다(3일) → 안내
        blocked = true;
        block('로그인이 끝났어요', '워크스페이스에 다시 로그인한 뒤 열어 주세요. 저장하지 않은 작업은 사라질 수 있어요.');
      }
      return r;
    });
  }
  // 도구 화면이 쓰는 '/api/…' 주소는 워크스페이스 서버로 보낸다
  window.fetch = function (input, init) {
    if (typeof input === 'string' && input.indexOf('/api/') === 0) return apiFetch(input, init);
    return origFetch(input, init);
  };

  var mep = null;
  window.GMWS = {
    blocked: blocked,
    session: session,
    fetch: apiFetch,
    // 내 권한: { id, name, admin, proj: 'write' | 'read' | 'none', drive: 드라이브 연결 여부 }
    me: function (fresh) {
      if (!mep || fresh) {
        mep = apiFetch('/api/me').then(function (r) { if (!r.ok) throw new Error('me_' + r.status); return r.json(); });
        mep.catch(function () { mep = null; });
      }
      return mep;
    },
  };

  // 화면을 열 때마다 서버에 한 번 확인한다 — 저장값을 꾸며 넣어도(가짜 로그인) 서버가 모르는 사람이면 화면을 닫는다.
  // 인터넷이 잠깐 끊긴 경우는 막지 않는다(서버가 '아니다'라고 답한 경우만).
  if (!blocked) {
    apiFetch('/api/me').then(function (r) {
      if (r.status === 403 && !blocked) {
        blocked = true; window.GMWS.blocked = true;
        block('사용할 수 없는 메뉴예요', 'GIF 메이커는 관리자와 MD/컨텐츠 팀 계정만 쓸 수 있어요.');
      }
    }).catch(function () {});
  }
})();
