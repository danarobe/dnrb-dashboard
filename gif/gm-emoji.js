// 이모지 넣기 패널 — GIF 만들기의 '프로젝트로 저장' 칸과 프로젝트 화면이 함께 쓴다.
// GMEmoji.attach({ button, panel, fields }): button을 누르면 panel이 열리고, 고른 이모지가
// 마지막으로 커서를 둔 fields 중 하나의 커서 위치에 들어간다.
(function () {
  'use strict';
  const EMOJIS = {
    '자주 쓰는': '✨ 🤍 🖤 🩶 🤎 💛 ❤️ 🩷 💙 💚 🔥 ⭐️ 🌟 💫 ✔️ ☑️ ✅ ❗️ ‼️ ❓ 💯 👍 👏 🙌 👀 💬 📌 🔖 🎀 🎁',
    '인스타 유행': '🫶 🥹 🫠 🫧 🩵 🩷 🤍 🤎 🎀 🍒 🍓 🧸 🪞 🕯️ 🌷 🪻 💐 🥐 🍰 ☕️ ☁️ 🌙 🦢 🐻 🐰 💌 📍 🪄 🎧 📷 🛼 🧺 🗓️ 💭 🍂 🧶',
    '꾸밈 기호': '⋆ ˚ ｡ ✧ ✦ ✩ ✶ ⟡ ✿ ❀ ♡ ♥︎ ☾ ☼ ⊹ ˖ ⁺ ₊ ‧ ° ・ ⌇ ⸝⸝ ᐟ ⤷ ➝ ✓ ❝ ❞ 〰︎ ୨୧ ♪',
    '꾸밈 조합': '⋆˚✿˖° ₊˚⊹♡ ‧₊˚✧ ✧˖° ⋆｡°✩ ⋆⁺₊⋆ ☾⋆⁺₊ ˚₊‧♡‧₊˚ ✿.｡.:* ⟡˖ ˗ˏˋ♡ˎˊ˗ ⋆.˚ ✧･ﾟ ♡ᐟ ୨♡୧',
    '안내·기호': '👉 👈 👆 👇 ➡️ ⬅️ ⬆️ ⬇️ ▶️ ◀️ 🔺 🔻 ⚠️ 🚨 📢 🔔 ⏰ ⌛️ 📅 🆕 🆓 🔝 ➕ ➖ ✖️ ♥️ ◾️ ◽️ ▪️ ▫️',
    '쇼핑·배송': '🛍️ 🛒 💸 💰 💳 🏷️ 📦 🚚 ✈️ 🎉 🎊 🏆 🥇 👑 💎 🧾 📝 📷 📸 🎬',
    '패션': '👗 👚 👕 👖 🧥 🧣 🧤 🧦 👠 👢 👟 🥿 👜 👛 🎒 🧢 👒 🕶️ 💍 💄',
    '표정': '😊 😍 🥰 😘 😎 🤩 🥹 😭 🤭 🫶 🙏 💖 💕 💗 💝 🤗 😉 😆 🥳 🤔',
    '계절·분위기': '🌸 🌷 🌿 🍃 ☀️ 🌤️ 🌙 ⛄️ ❄️ 🍂 🍁 ☕️ 🧸 🕯️ 🎄 🌈 🌊 🫧 🍀 🌹',
  };
  const CSS = `
.gm-emo-panel { margin-top: 6px; border: 1px solid #e2e0da; border-radius: 6px; padding: 8px; background: #fff; max-height: 190px; overflow-y: auto; }
.gm-emo-panel[hidden] { display: none; }
.gm-emo-group { font-size: 10px; font-weight: 700; color: #9a9690; margin: 6px 0 3px; }
.gm-emo-group:first-child { margin-top: 0; }
.gm-emo-grid { display: flex; flex-wrap: wrap; gap: 2px; }
.gm-emo { width: 30px; height: 30px; border: none; background: none; border-radius: 5px; font-size: 19px; line-height: 1; cursor: pointer; padding: 0;
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif; }
.gm-emo:hover { background: #f2f0ec; }
@media (max-width: 700px) { .gm-emo { width: 36px; height: 36px; font-size: 22px; } }`;
  let styled = false;

  // scope: 이 안에서 나중에 생기는 입력 칸도 '마지막으로 누른 칸'으로 친다
  // onPick(e): true 를 돌려주면 글자 칸에 넣지 않는다 (카드뉴스의 '별개로 넣기')
  function attach({ button, panel, fields, scope, onPick }) {
    if (!styled) {
      const st = document.createElement('style');
      st.textContent = CSS;
      document.head.appendChild(st);
      styled = true;
    }
    let last = fields[fields.length - 1];
    fields.forEach(f => ['focus', 'pointerdown', 'keydown'].forEach(ev => f.addEventListener(ev, () => { last = f; })));
    if (scope) scope.addEventListener('focusin', ev => {
      const el = ev.target;
      if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search' || !el.getAttribute('type'))))) last = el;
    });
    panel.classList.add('gm-emo-panel');
    panel.hidden = true;
    Object.entries(EMOJIS).forEach(([name, list]) => {
      const h = document.createElement('div'); h.className = 'gm-emo-group'; h.textContent = name;
      const g = document.createElement('div'); g.className = 'gm-emo-grid';
      list.split(' ').forEach(e => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'gm-emo'; b.textContent = e;
        b.onmousedown = ev => ev.preventDefault(); // 입력 칸의 커서 위치를 유지
        b.onclick = () => {
          if (onPick && onPick(e) === true) return;
          const a = last.selectionStart != null ? last.selectionStart : last.value.length;
          const z = last.selectionEnd != null ? last.selectionEnd : a;
          last.value = last.value.slice(0, a) + e + last.value.slice(z);
          last.focus();
          last.selectionStart = last.selectionEnd = a + e.length;
          last.dispatchEvent(new Event('input', { bubbles: true }));
        };
        g.appendChild(b);
      });
      panel.append(h, g);
    });
    button.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  }

  window.GMEmoji = { attach };
})();
