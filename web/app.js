"use strict";

// ============================================================
// 日本株（yfinance）スクリーニング結果ビューア（依存なし・vanilla JS）
// data.json を読み、日付切替・ソート・絞り込み・列選択・業種RSを表示する。
// ============================================================

// CSV の列名（build_site.py / yf_screener.py の save_*_csv と一致）
const COL = {
  TICKER: "コード",
  NAME: "銘柄名",
  MARKET: "市場",
  SECTOR17: "業種(17)",
  INDUSTRY: "業種(33)",
  CHANGE: "前日比(%)",
  LOW52: "52週安値乖離(%)",
  CLOSE: "終値(円)",
  VOL: "当日出来高",
  AVGVOL: "20日平均出来高",
  RS: "RS",
  RANK: "Industry Rank",
  GRADE: "Grade",
};

// 既定で表示する列（その日のデータに存在するものだけ採用）
const DEFAULT_COLS = [
  COL.TICKER, COL.NAME, COL.CHANGE, COL.CLOSE, COL.RS, COL.INDUSTRY, COL.GRADE, "HV",
  COL.VOL, COL.LOW52, COL.MARKET,
];

// 文字列として扱う（=数値ソート・右寄せしない）列
const TEXT_COLS = new Set([
  COL.TICKER, COL.NAME, COL.MARKET, COL.SECTOR17, COL.INDUSTRY, COL.GRADE,
]);

// ヘッダ表示ラベル（CSV列名は変えず、表記を英語に統一）。Industry=業種(33)/細, Sector=業種(17)/大
const COL_LABEL = {
  [COL.INDUSTRY]: "Industry",
  [COL.SECTOR17]: "Sector",
};
function colLabel(col) { return COL_LABEL[col] || col; }

const state = {
  data: null,
  day: null,          // 現在表示中の day オブジェクト
  visibleCols: [],    // 表示する列名
  sortCol: COL.RS,
  sortDir: -1,        // 1=昇順, -1=降順
  filterText: "",
  rsMin: 0,
  trend: null,            // {dates, industries} 全期間横断（init時に1度だけ構築）
};

// ---- 数値パース（build_site.py の to_int と同等の寛容さ） ----
function parseNum(val) {
  if (val == null) return NaN;
  let s = String(val).replace(/[%$,]/g, "").trim().toUpperCase();
  if (s === "" || s === "-") return NaN;
  const mult = { B: 1e9, M: 1e6, K: 1e3 };
  const suf = s.slice(-1);
  if (mult[suf]) {
    const n = parseFloat(s.slice(0, -1));
    return isNaN(n) ? NaN : n * mult[suf];
  }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

function gradeFromRS(rs) {
  if (rs == null || isNaN(rs)) return "NA";
  if (rs >= 80) return "A";
  if (rs >= 60) return "B";
  if (rs >= 40) return "C";
  if (rs >= 20) return "D";
  return "E";
}

// "30/33" → 30（業種順位の数値部分。ソート用）
function rankNum(val) {
  if (val == null) return NaN;
  const m = String(val).match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// SVG用の要素生成（namespace付き）
function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ============================================================
// 初期化
// ============================================================
async function init() {
  let resp;
  try {
    resp = await fetch("data.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error(resp.status);
    state.data = await resp.json();
  } catch (e) {
    document.querySelector("main").innerHTML =
      '<p class="empty">data.json を読み込めませんでした。サーバー経由で開いているか確認してください（file:// 直開きは不可）。</p>';
    return;
  }

  document.getElementById("screening-summary").textContent =
    "条件: " + (state.data.screening_summary || "");
  document.getElementById("generated-at").textContent =
    "生成: " + (state.data.generated_at || "");

  const days = state.data.days || [];
  const sel = document.getElementById("day-select");
  days.forEach((d, i) => {
    sel.appendChild(el("option", { value: String(i) },
      `${d.date}（${d.count}銘柄）`));
  });
  sel.addEventListener("change", () => selectDay(Number(sel.value)));

  bindControls();

  if (days.length === 0) {
    document.querySelector("main").innerHTML = '<p class="empty">データがまだありません。</p>';
    return;
  }
  selectDay(0);

  // 業種RSトレンドは全期間横断なので1度だけ構築して描画する
  state.trend = buildIndustryTrend();
  renderTrend();

  // 高出来高パネル（high_volume があれば描画、無ければ自動で隠れる）
  renderHighVolume();
}

function bindControls() {
  const filter = document.getElementById("filter");
  filter.addEventListener("input", () => {
    state.filterText = filter.value.trim().toLowerCase();
    renderTable();
  });
  const rsMin = document.getElementById("rs-min");
  rsMin.addEventListener("input", () => {
    state.rsMin = Number(rsMin.value) || 0;
    renderTable();
  });
  document.getElementById("copy-tv").addEventListener("click", copyTradingView);

  const myRun = document.getElementById("mylist-run");
  if (myRun) myRun.addEventListener("click", runMyList);
  const myCopy = document.getElementById("mylist-copy");
  if (myCopy) myCopy.addEventListener("click", copyMyList);

  const tf = document.getElementById("trend-filter");
  tf.addEventListener("input", renderTrend);
  document.getElementById("trend-gran").addEventListener("change", renderTrend);
  document.getElementById("trend-mode").addEventListener("change", renderTrend);
  document.getElementById("trend-sort").addEventListener("change", renderTrend);
  document.getElementById("trend-limit").addEventListener("change", renderTrend);

  const hvf = document.getElementById("hv-filter");
  if (hvf) hvf.addEventListener("input", renderHighVolume);
  const hvs = document.getElementById("hv-sort");
  if (hvs) hvs.addEventListener("change", renderHighVolume);
}

// ============================================================
// 日付選択
// ============================================================
function selectDay(index) {
  const day = state.data.days[index];
  state.day = day;
  document.getElementById("screen-meta").textContent = `${day.date}・${day.count}銘柄`;

  // 表示列: 既定セットのうち存在するもの。維持できるなら現在の選択を尊重
  const present = new Set(day.columns);
  const keep = state.visibleCols.filter((c) => present.has(c));
  state.visibleCols = keep.length
    ? keep
    : DEFAULT_COLS.filter((c) => present.has(c));

  if (!day.columns.includes(state.sortCol)) {
    state.sortCol = day.columns.includes(COL.RS) ? COL.RS : day.columns[0];
    state.sortDir = -1;
  }

  buildColMenu();
  renderInsights();
  renderTable();
}

// ============================================================
// 列選択メニュー
// ============================================================
function buildColMenu() {
  const box = document.getElementById("col-checkboxes");
  box.innerHTML = "";
  for (const col of state.day.columns) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = state.visibleCols.includes(col);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        // 元の列順を保つ
        state.visibleCols = state.day.columns.filter(
          (c) => c === col || state.visibleCols.includes(c));
      } else {
        state.visibleCols = state.visibleCols.filter((c) => c !== col);
      }
      renderTable();
    });
    box.appendChild(el("label", {}, cb, colLabel(col)));
  }
}

// ============================================================
// 示唆カード
// ============================================================
function renderInsights() {
  const root = document.getElementById("insights");
  root.innerHTML = "";
  const ins = state.day.insights || {};

  // RS分布
  root.appendChild(el("div", { class: "card" },
    el("h3", {}, "銘柄RS 高位"),
    el("div", { class: "big" }, String(ins.rs_ge_80 ?? 0)),
    el("div", { class: "sub" }, `RS≥80（うち RS≥90: ${ins.rs_ge_90 ?? 0}）`),
  ));

  // Top業種（抽出銘柄が属する業種を、業種RS順位の上位5つまで）
  const topCard = el("div", { class: "card" },
    el("h3", { title: "抽出銘柄が属するIndustryをIndustry RS順位の上位5つまで表示。順位はその日のIndustry RS全体での順位なので、抽出銘柄が無いIndustryは飛ぶことがあります。" },
      "🏆 Top Industry"));
  const tops = ins.top_industries || [];
  if (tops.length) {
    const ul = el("ul");
    for (const t of tops) {
      ul.appendChild(el("li", {},
        el("span", {}, t.name), el("span", { class: "v" }, `${t.rank}位`)));
    }
    topCard.appendChild(ul);
    if (ins.total_industries) topCard.appendChild(el("div", { class: "sub" }, `全${ins.total_industries} Industry中`));
  } else {
    topCard.appendChild(el("div", { class: "sub" }, "—"));
  }
  root.appendChild(topCard);

  // 集中業種
  const concCard = el("div", { class: "card" }, el("h3", {}, "🔥 集中Industry（3銘柄以上）"));
  const concList = el("ul");
  (ins.concentrated || []).forEach(([ind, c]) => {
    concList.appendChild(el("li", {}, el("span", {}, ind), el("span", { class: "v" }, `${c}`)));
  });
  concCard.appendChild((ins.concentrated && ins.concentrated.length) ? concList : el("div", { class: "sub" }, "—"));
  root.appendChild(concCard);

  // 乖離銘柄
  const divCard = el("div", { class: "card" }, el("h3", {}, "💎 乖離（強い銘柄×弱いIndustry）"));
  const divList = el("ul");
  (ins.divergent || []).forEach((d) => {
    divList.appendChild(el("li", {},
      el("span", {}, d.ticker),
      el("span", { class: "v" }, `RS${d.rs} / Industry${d.ind_rank}位`)));
  });
  divCard.appendChild((ins.divergent && ins.divergent.length) ? divList : el("div", { class: "sub" }, "—"));
  root.appendChild(divCard);
}

// ============================================================
// 抽出リスト・テーブル
// ============================================================
function filteredSortedRows() {
  const cols = state.day.columns;
  const iRS = cols.indexOf(COL.RS);
  let rows = state.day.rows;

  if (state.filterText) {
    const idxs = [COL.TICKER, COL.NAME, COL.SECTOR17, COL.INDUSTRY]
      .map((c) => cols.indexOf(c)).filter((i) => i >= 0);
    rows = rows.filter((r) =>
      idxs.some((i) => String(r[i]).toLowerCase().includes(state.filterText)));
  }
  if (state.rsMin > 0 && iRS >= 0) {
    rows = rows.filter((r) => {
      const v = parseNum(r[iRS]);
      return !isNaN(v) && v >= state.rsMin;
    });
  }

  const sc = cols.indexOf(state.sortCol);
  if (sc >= 0) {
    const numeric = !TEXT_COLS.has(state.sortCol);
    rows = rows.slice().sort((a, b) => {
      let av = a[sc], bv = b[sc];
      if (numeric) {
        av = parseNum(av); bv = parseNum(bv);
        const aNan = isNaN(av), bNan = isNaN(bv);
        if (aNan && bNan) return 0;
        if (aNan) return 1;      // 欠損は常に末尾
        if (bNan) return -1;
        return (av - bv) * state.sortDir;
      }
      return String(av).localeCompare(String(bv), "ja") * state.sortDir;
    });
  }
  return rows;
}

function renderTable() {
  const cols = state.visibleCols;
  const headRow = document.getElementById("screen-head");
  const body = document.getElementById("screen-body");
  headRow.innerHTML = "";
  body.innerHTML = "";

  // ヘッダ
  for (const col of cols) {
    const isNum = !TEXT_COLS.has(col);
    const th = el("th", { class: isNum ? "num" : "" });
    th.appendChild(document.createTextNode(colLabel(col)));
    if (col === state.sortCol) {
      th.appendChild(el("span", { class: "arrow" }, state.sortDir === 1 ? " ▲" : " ▼"));
    }
    th.addEventListener("click", () => {
      if (state.sortCol === col) state.sortDir *= -1;
      else { state.sortCol = col; state.sortDir = isNum ? -1 : 1; }
      renderTable();
    });
    headRow.appendChild(th);
  }

  const rows = filteredSortedRows();
  document.getElementById("table-empty").hidden = rows.length > 0;

  const allCols = state.day.columns;
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = el("tr");
    for (const col of cols) {
      const idx = allCols.indexOf(col);
      const raw = idx >= 0 ? row[idx] : "";
      tr.appendChild(renderCell(col, raw));
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

function renderCell(col, raw) {
  // コード → kabutan（株探）の個別銘柄ページ
  if (col === COL.TICKER) {
    const td = el("td", { class: "ticker" });
    td.appendChild(el("a", {
      href: `https://kabutan.jp/stock/?code=${encodeURIComponent(raw)}`,
      target: "_blank", rel: "noopener",
    }, raw));
    return td;
  }
  // RS（銘柄RS）→ グレード色付きバッジ
  if (col === COL.RS) {
    const v = parseNum(raw);
    const td = el("td", { class: "num" });
    if (isNaN(v)) { td.textContent = raw || "—"; return td; }
    td.appendChild(el("span", { class: `grade grade-${gradeFromRS(v)}` }, String(Math.round(v))));
    return td;
  }
  // Grade（業種グレード A〜E）→ 文字をそのままバッジ表示
  if (col === COL.GRADE) {
    const g = String(raw || "").trim().toUpperCase();
    const td = el("td", {});
    const cls = ["A", "B", "C", "D", "E"].includes(g) ? g : "NA";
    td.appendChild(el("span", { class: `grade grade-${cls}` }, g || "—"));
    return td;
  }
  // Industry Rank（"28/33"）→ 分母を外し順位のみ
  if (col === COL.RANK) {
    const r = rankNum(raw);
    const td = el("td", { class: "num" });
    td.textContent = isNaN(r) ? (raw || "—") : String(r);
    return td;
  }
  // 前日比(%) → 騰落色
  if (col === COL.CHANGE) {
    const v = parseNum(raw);
    const td = el("td", { class: "num " + (v > 0 ? "up" : v < 0 ? "down" : "") });
    td.textContent = raw || "—";
    return td;
  }
  // HV（高出来高フラグ）→ 色付きバッジ。該当なしは空欄。
  if (col === "HV") {
    const td = el("td", { class: "hv-cell" });
    if (raw) td.appendChild(el("span", { class: `hv-badge hv-${raw}` }, raw));
    return td;
  }
  const isNum = !TEXT_COLS.has(col);
  const td = el("td", { class: isNum ? "num" : "" });
  td.textContent = (raw === "" || raw == null) ? "—" : raw;
  return td;
}

// ============================================================
// TradingView コピー
// ============================================================
// TradingView 取込テキスト（yf_screener.py の TV_SECTION_DEFS と同形式）。
// 業種グレード(Grade列)別にセクション分け、TSE: 接頭辞付きで連結。
function buildTradingViewText() {
  const cols = state.day.columns;
  const iT = cols.indexOf(COL.TICKER);
  const iGrade = cols.indexOf(COL.GRADE);
  const iRS = cols.indexOf(COL.RS);
  const iRank = cols.indexOf(COL.RANK);
  if (iT < 0) return "";

  const sections = [
    ["Ind Grade A", new Set(["A"])],
    ["Ind Grade B", new Set(["B"])],
    ["Ind Grade C", new Set(["C"])],
    ["Ind Grade D/E/NA", new Set(["D", "E", "NA"])],
  ];
  const items = state.day.rows.map((r) => {
    const g = String(iGrade >= 0 ? r[iGrade] : "").trim().toUpperCase();
    return {
      ticker: r[iT],
      grade: ["A", "B", "C", "D", "E"].includes(g) ? g : "NA",
      rs: iRS >= 0 ? parseNum(r[iRS]) : NaN,
      rank: iRank >= 0 ? rankNum(r[iRank]) : NaN,
    };
  });

  const parts = [];
  for (const [name, keys] of sections) {
    const group = items.filter((it) => keys.has(it.grade));
    if (!group.length) continue;
    // 業種順位 昇順（=業種RS降順）→ 銘柄RS降順 → コード順
    group.sort((a, b) =>
      (isNaN(a.rank) ? 1e9 : a.rank) - (isNaN(b.rank) ? 1e9 : b.rank) ||
      (isNaN(b.rs) ? -1 : b.rs) - (isNaN(a.rs) ? -1 : a.rs) ||
      String(a.ticker).localeCompare(String(b.ticker)));
    parts.push("###" + name, ...group.map((it) => "TSE:" + it.ticker));
  }
  return parts.join(",");
}

async function copyTradingView() {
  const text = buildTradingViewText();
  const btn = document.getElementById("copy-tv");
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = "コピーしました ✓";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    window.prompt("コピーできませんでした。手動でコピーしてください:", text);
  }
}

// ============================================================
// マイリスト → TVリスト（任意コードをグレード別ブロック＋銘柄RS降順に）
// ============================================================
let universeCache = null;  // {date, tickers:{コード:[rs,irs]}} / "error" / null(未取得)

async function ensureUniverse() {
  if (universeCache && universeCache !== "error") return universeCache;
  try {
    const resp = await fetch("universe.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error(resp.status);
    universeCache = await resp.json();
  } catch (e) {
    universeCache = "error";
  }
  return universeCache;
}

function parseMyTickers(text) {
  // 改行/カンマ/スペース/セミコロン区切り。TSE: 等の接頭辞と .T/.JP サフィックスを除去・
  // 大文字化・重複排除（順序保持）。
  const seen = new Set();
  const out = [];
  for (let tok of String(text).split(/[\s,;]+/)) {
    tok = tok.trim().toUpperCase();
    if (!tok) continue;
    const c = tok.indexOf(":");
    if (c >= 0) tok = tok.slice(c + 1);     // 例: TSE:7203 -> 7203
    tok = tok.replace(/\.(T|JP)$/, "");      // 例: 7203.T -> 7203
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

async function runMyList() {
  const input = document.getElementById("mylist-input");
  const output = document.getElementById("mylist-output");
  const status = document.getElementById("mylist-status");
  const unmatchedEl = document.getElementById("mylist-unmatched");
  const copyBtn = document.getElementById("mylist-copy");

  const tickers = parseMyTickers(input.value);
  if (!tickers.length) {
    status.textContent = "コードを入力してください";
    output.value = "";
    copyBtn.disabled = true;
    unmatchedEl.hidden = true;
    return;
  }

  status.textContent = "RSデータを読み込み中…";
  const uni = await ensureUniverse();
  if (uni === "error" || !uni || !uni.tickers) {
    status.textContent = "universe.json を読み込めませんでした（サーバー経由で開いているか確認）";
    return;
  }

  const sections = [
    ["Ind Grade A", new Set(["A"])],
    ["Ind Grade B", new Set(["B"])],
    ["Ind Grade C", new Set(["C"])],
    ["Ind Grade D/E/NA", new Set(["D", "E", "NA"])],
  ];

  const items = [];
  const unmatched = [];
  for (const t of tickers) {
    const rec = uni.tickers[t];
    if (!rec) unmatched.push(t);
    const rs = rec ? rec[0] : null;
    const irs = rec ? rec[1] : null;
    items.push({
      ticker: t,
      rs: rs == null ? NaN : rs,
      irs: irs == null ? NaN : irs,
      grade: gradeFromRS(irs == null ? NaN : irs),
    });
  }

  const parts = [];
  for (const [name, keys] of sections) {
    const group = items.filter((it) => keys.has(it.grade));
    if (!group.length) continue;
    // 銘柄RS降順 → Industry RS降順 → コード順
    group.sort((a, b) =>
      (isNaN(b.rs) ? -1 : b.rs) - (isNaN(a.rs) ? -1 : a.rs) ||
      (isNaN(b.irs) ? -1 : b.irs) - (isNaN(a.irs) ? -1 : a.irs) ||
      String(a.ticker).localeCompare(String(b.ticker)));
    parts.push("###" + name, ...group.map((it) => "TSE:" + it.ticker));
  }

  output.value = parts.join(",");
  copyBtn.disabled = parts.length === 0;

  const matched = tickers.length - unmatched.length;
  status.textContent =
    `${tickers.length}銘柄を変換（ヒット ${matched} / 未ヒット ${unmatched.length}）｜RS基準日 ${uni.date || "—"}`;
  if (unmatched.length) {
    unmatchedEl.hidden = false;
    unmatchedEl.textContent =
      `未ヒット（RSデータ無し→D/E/NAブロックに収容）: ${unmatched.join(", ")}`;
  } else {
    unmatchedEl.hidden = true;
  }
}

async function copyMyList() {
  const output = document.getElementById("mylist-output");
  const btn = document.getElementById("mylist-copy");
  const text = output.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = "コピーしました ✓";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    output.select();
    window.prompt("コピーできませんでした。手動でコピーしてください:", text);
  }
}

// ============================================================
// 高出来高（HVE / HV1）パネル
// ============================================================
function hvBadge(label) {
  return label ? el("span", { class: `hv-badge hv-${label}` }, label) : document.createTextNode("");
}
function hvFmt(v, nd) {
  return (v == null || isNaN(v)) ? "—" : Number(v).toFixed(nd);
}

function renderHighVolume() {
  const panel = document.getElementById("hv-panel");
  if (!panel) return;
  const hv = state.data.high_volume;
  if (!hv || !hv.rows || !hv.rows.length) { panel.hidden = true; return; }
  panel.hidden = false;

  // メタ（対象期間・件数・更新日）
  const meta = hv.meta || {};
  const parts = [];
  if (meta.window_start && meta.window_end) parts.push(`${meta.window_start}〜${meta.window_end}`);
  parts.push(`${hv.rows.length}銘柄`);
  if (meta.generated_at) parts.push(`更新 ${String(meta.generated_at).slice(0, 10)}`);
  document.getElementById("hv-meta").textContent = parts.join(" / ");

  const q = (document.getElementById("hv-filter").value || "").trim().toLowerCase();
  const sortBy = document.getElementById("hv-sort").value;

  let rows = hv.rows.slice();
  if (q) rows = rows.filter((r) =>
    r.ticker.toLowerCase().includes(q) ||
    (r.name || "").toLowerCase().includes(q) ||
    (r.industry || "").toLowerCase().includes(q));

  const n = (v) => (v == null || isNaN(v) ? -Infinity : v);
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  if (sortBy === "gap") rows.sort((a, b) => n(b.gap) - n(a.gap));
  else if (sortBy === "since") rows.sort((a, b) => n(b.since) - n(a.since));
  else if (sortBy === "relvol") rows.sort((a, b) => n(b.relvol) - n(a.relvol));
  else if (sortBy === "type") rows.sort((a, b) => ((b.type === "HVE") - (a.type === "HVE")) || byDateDesc(a, b));
  else rows.sort(byDateDesc); // recent

  const head = document.getElementById("hv-head");
  const body = document.getElementById("hv-body");
  head.innerHTML = ""; body.innerHTML = "";

  const cols = [
    ["コード", ""], ["銘柄名", ""], ["種別", ""], ["HV日", ""],
    ["Gap%", "num"], ["Range%", "num"], ["RelVol", "num"], ["Since%", "num"],
    ["Industry", ""], ["売買代金(百万)", "num"],
  ];
  const htr = el("tr");
  for (const [label, cls] of cols) htr.appendChild(el("th", { class: cls }, label));
  head.appendChild(htr);

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = el("tr");
    const tdT = el("td", { class: "ticker" });
    tdT.appendChild(el("a", {
      href: `https://kabutan.jp/stock/?code=${encodeURIComponent(r.ticker)}`,
      target: "_blank", rel: "noopener",
    }, r.ticker));
    tr.appendChild(tdT);
    const tdN = el("td", { class: "col-narrow" });
    tdN.appendChild(el("span", { class: "trunc", title: r.name || "" }, r.name || "—"));
    tr.appendChild(tdN);
    tr.appendChild(el("td", {}, hvBadge(r.type)));
    tr.appendChild(el("td", {}, r.date || "—"));
    tr.appendChild(el("td", { class: "num " + (r.gap > 0 ? "up" : r.gap < 0 ? "down" : "") }, hvFmt(r.gap, 2)));
    tr.appendChild(el("td", { class: "num" }, hvFmt(r.close_range, 0)));
    tr.appendChild(el("td", { class: "num" }, hvFmt(r.relvol, 1)));
    tr.appendChild(el("td", { class: "num " + (r.since > 0 ? "up" : r.since < 0 ? "down" : "") }, hvFmt(r.since, 1)));
    const tdI = el("td", { class: "col-narrow" });
    tdI.appendChild(el("span", { class: "trunc", title: r.industry || "" }, r.industry || "—"));
    tr.appendChild(tdI);
    tr.appendChild(el("td", { class: "num" }, r.turnover == null ? "—" : Math.round(r.turnover).toLocaleString()));
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  document.getElementById("hv-empty").hidden = rows.length > 0;
}

// ============================================================
// 業種RSトレンド（ヒートマップ + 推移）
// ============================================================

// 全日の industry_rs を「業種 × 日付」の時系列に組み替える。
// industry_trend（SC無しの日も含む全業種RS）を優先し、無ければ days からフォールバック。
function buildIndustryTrend() {
  const src = (state.data.industry_trend && state.data.industry_trend.length)
    ? state.data.industry_trend
    : (state.data.days || []);
  const days = src
    .filter((d) => d.industry_rs && d.industry_rs.length)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1)); // 古い→新しい

  const dates = days.map((d) => d.date);
  const map = new Map(); // industry -> {industry, sector, byDate:{date:{rs,rank}}}
  for (const d of days) {
    for (const r of d.industry_rs) {
      if (!r.industry) continue;
      if (!map.has(r.industry)) {
        map.set(r.industry, { industry: r.industry, sector: r.sector || "", byDate: {} });
      }
      map.get(r.industry).byDate[d.date] = { rs: r.rs, rank: r.rank, count: r.count, grade: r.grade };
    }
  }
  return { dates, industries: Array.from(map.values()) };
}

// 日付列を粒度(日次/週次)に応じて束ねる。週次は月曜起点でグルーピングし、
// 各週はその週内で最も新しい営業日のスナップショットを代表値にする（IBD流の週末値）。
function mondayKey(dateStr) {
  const dt = new Date(dateStr + "T00:00:00Z");
  const day = dt.getUTCDay();                       // 0=日 .. 6=土
  dt.setUTCDate(dt.getUTCDate() - (day === 0 ? 6 : day - 1));
  return dt.toISOString().slice(0, 10);
}
function buildColumns(dates, gran) {
  if (gran === "week") {
    const groups = new Map();
    for (const d of dates) {
      const wk = mondayKey(d);
      if (!groups.has(wk)) groups.set(wk, []);
      groups.get(wk).push(d);
    }
    return Array.from(groups.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, ds]) => {
        ds.sort();
        const last = ds[ds.length - 1];
        return { label: mmdd(last), title: `週 ${ds[0]}〜${last}`, days: ds };
      });
  }
  return dates.map((d) => ({ label: mmdd(d), title: d, days: [d] }));
}
// その業種の、列(日 or 週)における代表セル。週次は週内の最新営業日を採る。
function cellAt(ind, col) {
  for (let i = col.days.length - 1; i >= 0; i--) {
    const c = ind.byDate[col.days[i]];
    if (c) return c;
  }
  return null;
}
function lastCell(ind, cols) {
  for (let i = cols.length - 1; i >= 0; i--) { const v = cellAt(ind, cols[i]); if (v) return v; }
  return null;
}
// 直近 TREND_LOOKBACK 期の順位を線形回帰した傾き。単一期間比のノイズを抑える。
// 値は1期あたりの順位改善数で、+ = 順位が上昇傾向（rank が減少）になるよう符号を反転。
const TREND_LOOKBACK = 4;
function rankSlope(ind, cols) {
  const recent = cols.slice(-TREND_LOOKBACK);
  const pts = [];
  recent.forEach((c, i) => {
    const cell = cellAt(ind, c);
    if (cell && cell.rank != null) pts.push([i, cell.rank]);
  });
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  if (den === 0) return null;
  return -(num / den);
}

// RS(1-99) → 緑(高)〜赤(低) の背景色
function rsColor(rs) {
  if (rs == null || isNaN(rs)) return null;
  const hue = Math.max(0, Math.min(120, (rs / 99) * 120)); // 0=赤, 120=緑
  return `hsl(${hue}, 55%, 32%)`;
}

function mmdd(date) { return date.slice(5).replace("-", "/"); }

function renderTrend() {
  const { dates, industries } = state.trend || { dates: [], industries: [] };
  const head = document.getElementById("heatmap-head");
  const body = document.getElementById("heatmap-body");
  const movers = document.getElementById("trend-movers");
  const empty = document.getElementById("trend-empty");
  head.innerHTML = ""; body.innerHTML = ""; movers.innerHTML = "";

  const mode = document.getElementById("trend-mode").value;   // rs | rank
  const sortBy = document.getElementById("trend-sort").value; // latest | delta | name
  const limit = Number(document.getElementById("trend-limit").value) || 0;
  const q = document.getElementById("trend-filter").value.trim().toLowerCase();
  const gran = document.getElementById("trend-gran").value;   // day | week

  const cols = buildColumns(dates, gran);

  if (cols.length < 2) {
    empty.textContent = gran === "week"
      ? "週次表示には2週以上のデータが必要です（現在は1週間分のみ）。"
      : "Industry RSの時系列データが足りません（2日以上必要）。";
    empty.hidden = false;
    document.querySelector("#heatmap").hidden = true;
    return;
  }
  empty.hidden = true;
  document.querySelector("#heatmap").hidden = false;

  // 絞り込み
  let list = industries;
  if (q) {
    list = list.filter((it) =>
      it.industry.toLowerCase().includes(q) || it.sector.toLowerCase().includes(q));
  }

  // 並び替え
  const latestRS = (it) => { const l = lastCell(it, cols); return l && l.rs != null ? l.rs : -1; };
  if (sortBy === "name") {
    list = list.slice().sort((a, b) => a.industry.localeCompare(b.industry, "ja"));
  } else if (sortBy === "delta") {
    list = list.slice().sort((a, b) => {
      const da = rankSlope(a, cols), db = rankSlope(b, cols);
      return (db == null ? -1e9 : db) - (da == null ? -1e9 : da);
    });
  } else {
    list = list.slice().sort((a, b) => latestRS(b) - latestRS(a));
  }
  if (limit > 0) list = list.slice(0, limit);

  // 上昇/下降 movers（全業種から、絞り込み前の母集団で算出）
  renderMovers(movers, industries, cols);

  // ヘッダ: 業種 | 最新RS | 推移 | 各列(日 or 週) | 傾き
  const htr = el("tr");
  htr.appendChild(el("th", { class: "ind-h" }, "Industry"));
  htr.appendChild(el("th", { class: "latest-rs-h", title: "最新のIndustry RS" }, "最新RS"));
  htr.appendChild(el("th", { class: "spark-h", title: "Industry RSの推移（左=古い, 右=新しい / 上=高い）" }, "推移"));
  for (const c of cols) htr.appendChild(el("th", { title: c.title }, c.label));
  htr.appendChild(el("th", { title: "直近数期の順位の傾き（+=上昇傾向 / 1期あたりの改善数）" }, "傾き"));
  head.appendChild(htr);

  const frag = document.createDocumentFragment();
  for (const it of list) {
    const tr = el("tr");
    const latest = lastCell(it, cols);
    const grade = (latest && latest.grade) ? latest.grade : gradeFromRS(latest ? latest.rs : null);

    const th = el("th", { class: "ind", title: it.industry });
    const top = el("div", { class: "ind-top" });
    top.appendChild(el("span", { class: `grade grade-${grade || "NA"}` }, grade || "—"));
    top.appendChild(el("span", { class: "ind-name" }, it.industry));
    th.appendChild(top);
    const sub = el("div", { class: "ind-sub" });
    if (it.sector) sub.appendChild(el("span", { class: "sec" }, it.sector));
    if (latest && latest.count != null) sub.appendChild(el("span", { class: "ind-count" }, latest.count + "銘柄"));
    th.appendChild(sub);
    tr.appendChild(th);

    // 最新RS（スパークラインの左）
    tr.appendChild(el("td", { class: "latest-rs" },
      latest && latest.rs != null ? String(latest.rs) : "—"));

    // 業種名とヒートマップの間に推移スパークライン
    tr.appendChild(el("td", { class: "spark" }, sparklineSVG(it, cols, mode)));

    for (const c of cols) {
      const cell = cellAt(it, c);
      if (!cell || cell.rs == null) {
        tr.appendChild(el("td", { class: "cell na" }, "—"));
        continue;
      }
      const td = el("td", {
        class: "cell",
        title: `${c.title}  RS ${cell.rs} / ${cell.rank != null ? cell.rank + "位" : "—"}`,
      }, String(mode === "rank" && cell.rank != null ? cell.rank : cell.rs));
      const bg = rsColor(cell.rs);
      if (bg) td.style.background = bg;
      tr.appendChild(td);
    }

    const slope = rankSlope(it, cols);
    let dcell;
    if (slope == null) dcell = el("td", { class: "delta" }, "—");
    else if (slope > 0.05) dcell = el("td", { class: "delta delta-up" }, "▲" + slope.toFixed(1));
    else if (slope < -0.05) dcell = el("td", { class: "delta delta-down" }, "▼" + Math.abs(slope).toFixed(1));
    else dcell = el("td", { class: "delta" }, "±0");
    tr.appendChild(dcell);

    frag.appendChild(tr);
  }
  body.appendChild(frag);
}

function renderMovers(root, industries, cols) {
  const scored = industries
    .map((it) => ({ it, d: rankSlope(it, cols) }))
    .filter((x) => x.d != null && Math.abs(x.d) > 0.05);
  const up = scored.slice().sort((a, b) => b.d - a.d).slice(0, 5);
  const down = scored.slice().sort((a, b) => a.d - b.d).slice(0, 5);
  const recent = cols.slice(-TREND_LOOKBACK);
  const span = `直近${recent.length}期`;

  const group = (label, items, cls, sign) => {
    const g = el("div", { class: "mv-group" }, el("span", { class: "mv-label" }, label));
    if (!items.length) { g.appendChild(el("span", { class: "mv-label" }, "—")); return g; }
    for (const x of items) {
      g.appendChild(el("span", { class: "mv" },
        x.it.industry + " ",
        el("span", { class: "d " + cls }, sign + Math.abs(x.d).toFixed(1))));
    }
    return g;
  };
  root.appendChild(group(`🔼 上昇 (${span})`, up, "delta-up", "▲"));
  root.appendChild(group(`🔽 下降 (${span})`, down, "delta-down", "▼"));
}

// 各業種行のインライン・スパークライン（業種RS値のミニ折れ線）。
// 行ごとに自身のRSレンジでオートスケールし、上=高RSとなるよう描く。
function sparklineSVG(ind, cols, mode) {
  const useRank = mode === "rank";
  const W = 110, H = 26, pad = 3;
  const pts = cols.map((c) => {
    const cell = cellAt(ind, c);
    if (!cell) return null;
    const v = useRank ? cell.rank : cell.rs;
    return v != null ? { rs: cell.rs, v } : null;
  });
  const vals = pts.filter((p) => p).map((p) => p.v);
  const svg = svgEl("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  if (vals.length === 0) return svg;

  let vmin = Math.min(...vals), vmax = Math.max(...vals);
  if (vmin === vmax) { vmin -= 1; vmax += 1; }
  const n = cols.length;
  const xAt = (i) => pad + (n <= 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (n - 1));
  // 上=良い方: RSは高い値、順位は小さい値が上になるよう向きを反転
  const yAt = useRank
    ? (v) => pad + ((v - vmin) / (vmax - vmin)) * (H - 2 * pad)
    : (v) => pad + ((vmax - v) / (vmax - vmin)) * (H - 2 * pad);

  let seg = [];
  const flush = () => {
    if (seg.length >= 2) svg.appendChild(svgEl("polyline", { class: "spark-line", points: seg.join(" ") }));
    seg = [];
  };
  pts.forEach((p, i) => { if (!p) { flush(); return; } seg.push(`${xAt(i)},${yAt(p.v)}`); });
  flush();

  let lastIdx = -1;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i]) { lastIdx = i; break; }
  if (lastIdx >= 0) {
    const last = pts[lastIdx];
    svg.appendChild(svgEl("circle",
      { cx: xAt(lastIdx), cy: yAt(last.v), r: 2.5, fill: rsColor(last.rs) || "#4ea1ff" }));
  }
  const unit = useRank ? "順位" : "RS";
  svg.appendChild(svgEl("title", {}, `${ind.industry}\n${unit} ${vals[0]} → ${vals[vals.length - 1]}`));
  return svg;
}

init();
