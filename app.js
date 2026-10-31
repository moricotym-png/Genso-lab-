// ===== 元素ラボ アプリ本体 =====
(function () {
  const E = window.ELEMENTS, CAT = window.CATEGORIES, GROUPS = window.GROUP_GORO;
  const QUESTIONS_PER_ROUND = 10;
  const STORE_KEY = "genso-lab-v1";

  // ---------- クイズの種類（ここに追加すれば新モードになります） ----------
  const MODES = [
    { id: "sym2name", label: "記号 → 名前", desc: "Fe は何の元素？", kind: "choice" },
    { id: "name2sym", label: "名前 → 記号", desc: "金の記号は？", kind: "choice" },
    { id: "use2el",   label: "使い道 → 元素", desc: "10円玉に使われているのは？", kind: "choice" },
    { id: "goro2el",  label: "ゴロ → 元素", desc: "覚え方から当てる", kind: "choice" },
    { id: "num2el",   label: "原子番号", desc: "8番の元素は？", kind: "choice" },
    { id: "type",     label: "記号を入力", desc: "キーボードで答える", kind: "type" },
  ];

  // ---------- 保存（この端末のブラウザ内） ----------
  function load() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY)); if (v) return v; } catch (e) {}
    return { history: [], mastery: {} };
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
  let state = load();

  const $ = (s, r = document) => r.querySelector(s);
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const catColor = c => `var(${CAT[c].color})`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function level(sym) {
    const m = state.mastery[sym];
    if (!m || !m.a) return "new";
    const r = m.c / m.a;
    if (m.c >= 3 && r >= 0.8) return "master";
    if (r >= 0.5) return "learning";
    return "weak";
  }
  const LEVEL_LABEL = { new: "まだ", weak: "苦手", learning: "練習中", master: "習得" };

  function tile(el, extra = "") {
    return `<button class="tile ${extra}" data-sym="${el.s}" style="--cat:${catColor(el.cat)}" aria-label="${el.name} ${el.s}">
      <span class="t-num">${el.n}</span><span class="t-sym">${el.s}</span><span class="t-name">${el.name}</span></button>`;
  }

  // ---------- タブ ----------
  function showTab(id) {
    document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === id));
    document.querySelectorAll(".view").forEach(v => v.hidden = v.id !== "view-" + id);
    if (id === "growth") renderGrowth();
    if (id === "learn") renderLearn();
    if (id === "quiz" && !quiz) renderQuizHome();
    window.scrollTo(0, 0);
  }

  // ---------- 学ぶ ----------
  let filter = "all";
  function renderLearn() {
    $("#groups").innerHTML = GROUPS.map(g => `
      <div class="group"><div class="g-range">${g.range}</div>
      <div class="g-goro">${esc(g.goro)}</div><div class="g-sym">${g.symbols}</div></div>`).join("");
    const cats = ["all", ...Object.keys(CAT).filter(k => E.some(e => e.cat === k))];
    $("#chips").innerHTML = cats.map(k => `<button class="chip" aria-pressed="${filter === k}" data-cat="${k}"
      ${k !== "all" ? `style="--cat:${catColor(k)}"` : ""}>${k === "all" ? "すべて" : CAT[k].label}</button>`).join("");
    $("#grid").innerHTML = E.filter(e => filter === "all" || e.cat === filter)
      .map(e => tile(e, "lv-" + level(e.s))).join("");
  }
  function openDetail(sym) {
    const el = E.find(e => e.s === sym); if (!el) return;
    const m = state.mastery[sym] || { c: 0, a: 0 };
    $("#detail-body").innerHTML = `
      <div class="d-head" style="--cat:${catColor(el.cat)}">
        <div class="d-tile"><span class="t-num">${el.n}</span><span class="d-sym">${el.s}</span></div>
        <div><div class="d-name">${el.name}</div><div class="d-en">${el.en} · ${CAT[el.cat].label}</div></div>
      </div>
      <h4>覚え方</h4><p class="d-goro">${esc(el.goro)}</p>
      ${el.origin ? `<h4>記号の由来</h4><p>${esc(el.origin)}</p>` : ""}
      <h4>身近なところで</h4><ul>${el.uses.map(u => `<li>${esc(u)}</li>`).join("")}</ul>
      <p class="d-stat">クイズ成績：${m.a ? `${m.c}/${m.a} 正解（${LEVEL_LABEL[level(sym)]}）` : "まだ出題されていません"}</p>`;
    $("#detail").hidden = false;
    $("#detail-close").focus();
  }

  // ---------- クイズ ----------
  let quiz = null;
  function renderQuizHome() {
    quiz = null;
    const best = id => Math.max(0, ...state.history.filter(h => h.mode === id).map(h => h.score));
    $("#quiz-area").innerHTML = `
      <p class="lead">モードを選んでください。1回 ${QUESTIONS_PER_ROUND} 問、苦手な元素ほど多く出ます。連続正解でボーナス。</p>
      <div class="modes">${MODES.map(m => `
        <button class="mode" data-mode="${m.id}"><span class="m-label">${m.label}</span>
        <span class="m-desc">${m.desc}</span><span class="m-best">ベスト ${best(m.id)} 点</span></button>`).join("")}
        <button class="mode mix" data-mode="mix"><span class="m-label">ミックス</span>
        <span class="m-desc">全モードからランダム</span><span class="m-best">ベスト ${best("mix")} 点</span></button>
      </div>`;
  }

  function pickTargets(n, filterFn = () => true) {
    const pool = E.filter(filterFn);
    const w = el => ({ new: 3, weak: 4, learning: 2, master: 0.6 }[level(el.s)]);
    const out = [];
    const cand = pool.slice();
    while (out.length < n && cand.length) {
      const total = cand.reduce((s, e) => s + w(e), 0);
      let r = Math.random() * total, i = 0;
      for (; i < cand.length; i++) { r -= w(cand[i]); if (r <= 0) break; }
      out.push(cand.splice(Math.min(i, cand.length - 1), 1)[0]);
    }
    return out;
  }
  function distractors(target, k = 3) {
    const same = shuffle(E.filter(e => e !== target && e.cat === target.cat));
    const other = shuffle(E.filter(e => e !== target && e.cat !== target.cat));
    return [...same.slice(0, 2), ...other].slice(0, k);
  }

  function buildQuestion(mode, el) {
    const opts = shuffle([el, ...distractors(el)]);
    const hideName = s => s.replaceAll(el.name, "○○");
    switch (mode) {
      case "sym2name": return { el, prompt: `<span class="big-sym">${el.s}</span>`, sub: "この記号の元素は？", opts, show: o => o.name };
      case "name2sym": return { el, prompt: `<span class="big-name">${el.name}</span>`, sub: "元素記号は？", opts, show: o => o.s, mono: true };
      case "use2el": {
        const u = el.uses[Math.random() * el.uses.length | 0];
        return { el, prompt: `<span class="q-text">${esc(hideName(u))}</span>`, sub: "に使われている元素は？", opts, show: o => `${o.name}（${o.s}）` };
      }
      case "goro2el": return { el, prompt: `<span class="q-text">${esc(hideName(el.goro).replaceAll(el.s, "□"))}</span>`, sub: "この覚え方の元素は？", opts, show: o => `${o.name}（${o.s}）` };
      case "num2el": return { el, prompt: `<span class="big-sym">${el.n}</span>`, sub: "番の元素は？", opts, show: o => `${o.name}（${o.s}）` };
      case "type": return { el, prompt: `<span class="big-name">${el.name}</span>`, sub: "元素記号を入力", type: true };
    }
  }

  function startQuiz(modeId) {
    const ids = MODES.map(m => m.id);
    const targets = pickTargets(QUESTIONS_PER_ROUND);
    quiz = {
      mode: modeId, i: 0, score: 0, correct: 0, streak: 0, wrong: [],
      qs: targets.map(el => buildQuestion(modeId === "mix" ? ids[Math.random() * ids.length | 0] : modeId, el)),
    };
    renderQuestion();
  }

  function renderQuestion() {
    const q = quiz.qs[quiz.i];
    const pct = quiz.i / quiz.qs.length * 100;
    $("#quiz-area").innerHTML = `
      <div class="q-bar"><div class="q-prog"><span style="width:${pct}%"></span></div>
        <span class="q-count">${quiz.i + 1}/${quiz.qs.length}</span><span class="q-score">${quiz.score} 点</span></div>
      <div class="q-card"><div class="q-prompt">${q.prompt}</div><div class="q-sub">${q.sub}</div></div>
      ${q.type
        ? `<form id="type-form" class="type-form"><input id="type-input" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="3" aria-label="元素記号"><button class="btn primary" type="submit">答える</button></form>`
        : `<div class="opts">${q.opts.map((o, k) => `<button class="opt ${q.mono ? "mono" : ""}" data-k="${k}">${esc(q.show(o))}</button>`).join("")}</div>`}
      <div id="feedback" class="feedback" hidden></div>
      ${quiz.streak >= 2 ? `<p class="streak">${quiz.streak} 連続正解中</p>` : ""}`;
    if (q.type) $("#type-input").focus();
  }

  function answer(ok, chosenBtn) {
    const q = quiz.qs[quiz.i], el = q.el;
    const m = state.mastery[el.s] || (state.mastery[el.s] = { c: 0, a: 0 });
    m.a++;
    let gained = 0;
    if (ok) { m.c++; quiz.correct++; quiz.streak++; gained = 10 + Math.min(quiz.streak - 1, 5) * 2; quiz.score += gained; }
    else { quiz.streak = 0; quiz.wrong.push(el); }
    save();
    document.querySelectorAll(".opt").forEach((b, k) => {
      b.disabled = true;
      if (q.opts && q.opts[k] === el) b.classList.add("right");
    });
    if (chosenBtn && !ok) chosenBtn.classList.add("miss");
    const inp = $("#type-input"); if (inp) inp.disabled = true;
    const fb = $("#feedback");
    fb.className = "feedback " + (ok ? "ok" : "ng");
    fb.innerHTML = `
      <div class="fb-head">${ok ? `正解！ +${gained}` : `正解は ${el.name}（${el.s}）`}</div>
      <div class="fb-body"><b>覚え方</b> ${esc(el.goro)}<br><b>身近に</b> ${esc(el.uses.join("、"))}</div>
      <button class="btn primary" id="next">${quiz.i + 1 < quiz.qs.length ? "次へ" : "結果を見る"}</button>`;
    fb.hidden = false;
    $("#next").focus();
  }

  function finish() {
    const prevBest = Math.max(0, ...state.history.filter(h => h.mode === quiz.mode).map(h => h.score));
    state.history.push({ t: Date.now(), mode: quiz.mode, score: quiz.score, correct: quiz.correct, total: quiz.qs.length });
    save();
    const isBest = quiz.score > prevBest;
    const uniqWrong = [...new Set(quiz.wrong)];
    $("#quiz-area").innerHTML = `
      <div class="result">
        <div class="r-score">${quiz.score}<small>点</small></div>
        <div class="r-sub">${quiz.correct} / ${quiz.qs.length} 正解${isBest ? `<span class="badge">自己ベスト更新</span>` : ""}</div>
        ${uniqWrong.length ? `<h4>復習しよう</h4><div class="mini-grid">${uniqWrong.map(e => tile(e)).join("")}</div>` : `<p class="perfect">全問正解です。</p>`}
        <div class="r-actions"><button class="btn primary" data-mode="${quiz.mode}">もう一度</button>
        <button class="btn" id="back-modes">モード選択へ</button></div>
      </div>`;
    quiz = null;
  }

  // ---------- 成長 ----------
  function renderGrowth() {
    const h = state.history;
    const mastered = E.filter(e => level(e.s) === "master").length;
    const totalA = Object.values(state.mastery).reduce((s, m) => s + m.a, 0);
    const totalC = Object.values(state.mastery).reduce((s, m) => s + m.c, 0);
    $("#stats").innerHTML = `
      <div class="stat"><span class="s-val">${h.length}</span><span class="s-lab">プレイ回数</span></div>
      <div class="stat"><span class="s-val">${mastered}<small>/${E.length}</small></span><span class="s-lab">習得した元素</span></div>
      <div class="stat"><span class="s-val">${totalA ? Math.round(totalC / totalA * 100) : 0}<small>%</small></span><span class="s-lab">通算正答率</span></div>
      <div class="stat"><span class="s-val">${Math.max(0, ...h.map(x => x.score))}</span><span class="s-lab">最高得点</span></div>`;
    $("#chart-note").textContent = h.length ? `直近 ${Math.min(h.length, 20)} 回の正答率と得点` : "クイズを1回やると、ここにグラフが出ます。";
    drawChart(h.slice(-20));
    const counts = { master: 0, learning: 0, weak: 0, new: 0 };
    E.forEach(e => counts[level(e.s)]++);
    $("#legend").innerHTML = ["master", "learning", "weak", "new"].map(k =>
      `<span class="lg"><i class="sw lv-${k}"></i>${LEVEL_LABEL[k]} ${counts[k]}</span>`).join("");
    $("#mastery-grid").innerHTML = E.map(e => tile(e, "heat lv-" + level(e.s))).join("");
    $("#history").innerHTML = h.slice(-8).reverse().map(x => {
      const d = new Date(x.t), md = MODES.find(m => m.id === x.mode);
      return `<li><span>${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</span>
        <span>${md ? md.label : "ミックス"}</span><span class="num">${x.correct}/${x.total}</span><span class="num">${x.score}点</span></li>`;
    }).join("") || `<li class="empty">まだ記録がありません</li>`;
  }

  function drawChart(data) {
    const cv = $("#chart"), ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 200;
    cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr);
    const cs = getComputedStyle(document.documentElement), tok = n => cs.getPropertyValue(n).trim();
    ctx.clearRect(0, 0, W, H);
    const L = 34, R = 12, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    ctx.font = "11px 'IBM Plex Mono', monospace"; ctx.fillStyle = tok("--muted"); ctx.strokeStyle = tok("--line");
    ctx.lineWidth = 1; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    [0, 50, 100].forEach(v => {
      const y = T + ph - v / 100 * ph;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillText(v + "%", L - 6, y);
    });
    if (!data.length) return;
    const x = i => L + (data.length === 1 ? pw / 2 : i / (data.length - 1) * pw);
    const y = v => T + ph - v * ph;
    const acc = data.map(d => d.correct / d.total);
    // 得点（最大は 10問×(10+10)=200 未満なので 200 で正規化）
    ctx.fillStyle = tok("--accent-soft");
    const bw = Math.max(4, Math.min(18, pw / data.length * 0.5));
    data.forEach((d, i) => { const hh = d.score / 200 * ph; ctx.fillRect(x(i) - bw / 2, T + ph - hh, bw, hh); });
    // 正答率の線
    ctx.strokeStyle = tok("--accent"); ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.beginPath();
    acc.forEach((a, i) => i ? ctx.lineTo(x(i), y(a)) : ctx.moveTo(x(i), y(a))); ctx.stroke();
    acc.forEach((a, i) => { ctx.beginPath(); ctx.arc(x(i), y(a), i === acc.length - 1 ? 5 : 3, 0, 7); ctx.fillStyle = tok("--accent"); ctx.fill(); });
    ctx.fillStyle = tok("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("1", x(0), H - B + 8);
    if (data.length > 1) ctx.fillText(String(data.length), x(data.length - 1), H - B + 8);
  }

  // ---------- イベント ----------
  document.addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.classList.contains("tab")) return showTab(t.dataset.tab);
    if (t.dataset.mode) return startQuiz(t.dataset.mode);
    if (t.classList.contains("chip")) { filter = t.dataset.cat; return renderLearn(); }
    if (t.classList.contains("tile")) return openDetail(t.dataset.sym);
    if (t.classList.contains("opt") && quiz) { const q = quiz.qs[quiz.i]; return answer(q.opts[+t.dataset.k] === q.el, t); }
    if (t.id === "next") { quiz.i++; return quiz.i < quiz.qs.length ? renderQuestion() : finish(); }
    if (t.id === "back-modes") return renderQuizHome();
    if (t.id === "detail-close") return ($("#detail").hidden = true);
    if (t.id === "reset-ask") { $("#reset-confirm").hidden = false; return; }
    if (t.id === "reset-no") { $("#reset-confirm").hidden = true; return; }
    if (t.id === "reset-yes") { state = { history: [], mastery: {} }; save(); $("#reset-confirm").hidden = true; return renderGrowth(); }
  });
  document.addEventListener("submit", e => {
    if (e.target.id !== "type-form") return;
    e.preventDefault();
    const inp = $("#type-input"); if (inp.disabled) return;
    const v = inp.value.trim(); if (!v) return;
    const norm = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
    answer(norm === quiz.qs[quiz.i].el.s);
  });
  $("#detail").addEventListener("click", e => { if (e.target.id === "detail") $("#detail").hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") $("#detail").hidden = true; });
  window.addEventListener("resize", () => { if (!$("#view-growth").hidden) drawChart(state.history.slice(-20)); });

  $("#el-count").textContent = E.length;
  showTab("learn");
})();
