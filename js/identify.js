// 「辨識與查價」分頁。
//
// 兩條查詢路徑：
//   1. 打卡名（中／日／英）——最直覺
//   2. 打卡號或選系列＋卡號——最準，卡片右下角就印著
//
// 價格一律標明來源市場，並附上蝦皮／露天／駿河屋的搜尋連結，
// 因為台灣與日本的實際成交價沒有可用的免費 API，只能讓使用者自己去看。

import {
  LANGS, getSets, getCard, searchByName, splitCardId, looksLikeCardId,
  imageUrl, getRates, toTWD, normalizePricing, marketLinks,
} from './tcgdex.js';
import { warp, imageDataToCanvas, CARD_W, CARD_H } from './imageutil.js';
import { detectCardQuad } from './detect.js';
import { matchFromPhoto, FP_BYTES } from './match.js';
import { cacheGet, cacheSet } from './db.js';

const $ = (id) => document.getElementById(id);
const LANG_KEY = 'pokecard.lang';

const state = {
  lang: localStorage.getItem(LANG_KEY) || 'zh-tw',
  sets: null,       // 目前語言的系列表
  setMap: null,     // setId -> 系列資料
  rates: null,
  results: [],
  lastQuery: '',
};

// 指紋庫：拍照認卡用。每張卡 66 bytes，繁中全庫約 600KB。
const fpDb = { lang: null, data: null, ids: null, names: null, loading: null };

/** 相片與比對距離的判讀門檻。實測值：對齊良好時 <0.1，對不準時 0.14 上下。 */
const MATCH_SURE = 0.13;      // 低於這個就算認得很有把握
const MATCH_MAYBE = 0.22;     // 高於這個就明講不確定

let host = {};   // app.js 傳進來的相機控制

export function initIdentify(deps) {
  host = deps || {};
  const sel = $('lang-select');
  sel.innerHTML = LANGS.map(
    (l) => '<option value="' + l.code + '">' + l.label + '</option>'
  ).join('');
  sel.value = state.lang;
  sel.addEventListener('change', async () => {
    state.lang = sel.value;
    localStorage.setItem(LANG_KEY, state.lang);
    state.sets = null;
    state.setMap = null;
    fpDb.lang = null;   // 換語言就要換指紋庫
    fpDb.data = null;
    await loadSets();
    if (state.lastQuery) doSearch(state.lastQuery);
  });

  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    doSearch($('search-input').value);
  });

  $('btn-back-search').addEventListener('click', showSearch);
  $('set-go').addEventListener('click', goBySetNumber);

  $('btn-scan').addEventListener('click', startScan);
  $('btn-scan-again').addEventListener('click', startScan);

  loadSets();
  getRates().then((r) => {
    state.rates = r;
    updateRateLine();
  });
}

function updateRateLine() {
  const r = state.rates;
  if (!r) return;
  const el = $('rate-line');
  if (!el) return;
  el.textContent = r.__fallback
    ? '匯率：抓不到即時匯率，改用內建近似值 1 EUR ≈ 37.1 TWD'
    : '匯率：1 EUR ≈ ' + r.TWD.toFixed(2) + ' TWD　1 USD ≈ ' + (r.TWD / r.USD).toFixed(2) +
      ' TWD（' + (r.stale ? '離線快取' : '每日更新') + '）';
}

async function loadSets() {
  const sel = $('set-select');
  sel.innerHTML = '<option>載入中…</option>';
  try {
    const sets = await getSets(state.lang);
    // 新系列排前面，通常在找的是新卡
    state.sets = sets.slice().reverse();
    state.setMap = {};
    for (const s of sets) state.setMap[s.id] = s;
    sel.innerHTML = state.sets
      .map((s) => '<option value="' + s.id + '">' + esc(s.name) + '（' + s.id + '）</option>')
      .join('');
  } catch (err) {
    sel.innerHTML = '<option>載入失敗</option>';
  }
}

function setName(cardId) {
  const setId = splitCardId(cardId).setId;
  const s = state.setMap && state.setMap[setId];
  return s ? s.name : setId;
}

// ===== 搜尋 =====
async function doSearch(raw) {
  const q = String(raw || '').trim();
  if (!q) return;
  state.lastQuery = q;
  showSearch();
  status('搜尋中…');
  $('search-results').innerHTML = '';

  try {
    // 打的是卡號就直接開那張卡，省一次選擇
    if (looksLikeCardId(q)) {
      status('');
      await openCard(q.toUpperCase() === q ? q : q);
      return;
    }
    const list = await searchByName(state.lang, q, 40);
    state.results = list;
    if (!list.length) {
      status('找不到「' + q + '」。可能這張卡沒有出過這個語言的版本，換個語言或改用卡號試試。');
      return;
    }
    status('找到 ' + list.length + ' 張');
    renderResults(list);
  } catch (err) {
    status('搜尋失敗：' + err.message + '（沒網路的話，只有查過的卡才找得到）');
  }
}

function renderResults(list) {
  const html = list
    .map((c) => {
      const img = c.image ? imageUrl(c.image, 'low', 'webp') : '';
      return (
        '<button class="result-row" data-id="' + esc(c.id) + '">' +
        (img
          // crossorigin：assets.tcgdex.net 有送 CORS 標頭，帶上之後回應才是
          // 正常的 200 而不是 opaque，Service Worker 才存得進離線快取
          ? '<img loading="lazy" crossorigin="anonymous" src="' + esc(img) + '" alt="">'
          : '<span class="noimg">無圖</span>') +
        '<span class="result-text"><b>' + esc(c.name || '(無名稱)') + '</b>' +
        '<small>' + esc(setName(c.id)) + '　' + esc(c.localId || '') + '</small></span>' +
        '</button>'
      );
    })
    .join('');
  const box = $('search-results');
  box.innerHTML = html;
  box.querySelectorAll('.result-row').forEach((b) => {
    b.addEventListener('click', () => openCard(b.dataset.id));
  });
}

async function goBySetNumber() {
  const setId = $('set-select').value;
  const num = $('num-input').value.trim();
  if (!setId || !num) {
    alert('請選系列並輸入卡號');
    return;
  }
  // 卡號通常補到 3 位（001），但也有 2 位或帶字母的，兩種都試
  const candidates = [setId + '-' + num, setId + '-' + num.padStart(3, '0')];
  for (const id of candidates) {
    try {
      await openCard(id, true);
      return;
    } catch (err) {
      /* 換下一個 */
    }
  }
  alert('查不到 ' + setId + ' 的第 ' + num + ' 號卡。請確認卡號，或改用卡名搜尋。');
}

// ===== 卡片詳情 =====
async function openCard(cardId, throwOnFail) {
  status('讀取卡片…');
  try {
    const r = await getCard(state.lang, cardId);
    renderCard(r.data, r.stale);
    status('');
  } catch (err) {
    if (throwOnFail) throw err;
    status('讀不到這張卡（' + cardId + '）：' + err.message);
  }
}

function renderCard(card, stale) {
  $('search-view').hidden = true;
  $('card-detail').hidden = false;
  window.scrollTo(0, 0);

  const img = card.image ? imageUrl(card.image, 'high', 'png') : '';
  $('detail-img').src = img;
  $('detail-img').hidden = !img;
  $('detail-name').textContent = card.name || '(無名稱)';

  const set = card.set || {};
  const total = set.cardCount && set.cardCount.official;
  const meta = [
    ['系列', set.name || setName(card.id)],
    ['卡號', (card.localId || '') + (total ? ' / ' + total : '')],
    ['稀有度', card.rarity || '—'],
    ['插畫師', card.illustrator || '—'],
    ['規則標記', card.regulationMark || '—'],
    ['卡片 ID', card.id],
  ];
  $('detail-meta').innerHTML = meta
    .map((m) => '<tr><td>' + esc(m[0]) + '</td><td></td><td>' + esc(String(m[1])) + '</td></tr>')
    .join('');

  renderPrices(card, stale);

  const links = marketLinks(card.name, card.localId, set.name);
  $('market-links').innerHTML = links
    .map(
      (l) =>
        '<a class="btn" target="_blank" rel="noopener noreferrer" href="' +
        esc(l.url) + '">' + esc(l.label) + '</a>'
    )
    .join('');
}

function renderPrices(card, stale) {
  const rows = normalizePricing(card.pricing);
  const headline = $('price-headline');
  const table = $('price-table');

  if (!rows.length) {
    // 中文卡大約有一半查不到價——SP、SK、SVAW 這類是中文限定系列，
    // 歐美市場沒有對應商品，換語言也救不回來（同卡號在日／英版根本不存在）。
    // 這時候與其讓使用者往下捲找連結，不如直接把連結擺在他正在看的位置。
    const links = marketLinks(card.name, card.localId, (card.set || {}).name);
    headline.innerHTML =
      '<div class="msg warn">⚠️ 查不到參考價。這張卡在歐美市場沒有對應商品，' +
      '中文限定的系列（SP／SK／SVAW 等）大多如此。直接查台／日行情：</div>' +
      '<div class="link-row">' +
      links
        .map(
          (l) =>
            '<a class="btn" target="_blank" rel="noopener noreferrer" href="' +
            esc(l.url) + '">' + esc(l.label) + '</a>'
        )
        .join('') +
      '</div>';
    table.innerHTML = '';
    $('price-updated').textContent = '';
    return;
  }

  const rates = state.rates || { TWD: 37.1, USD: 1.165 };

  // 主打價格刻意顯示「區間」而不是單一數字。
  //
  // 一開始是挑一列當代表（依卡片的 variants 猜是閃卡還一般），結果初代噴火龍
  // 被挑到 NT$4,589，但同一張卡 cardmarket 一般價 NT$15,200、tcgplayer NT$27,257。
  // cardmarket 的 holo 後綴語意本來就不明確，猜錯就是給一個看起來很確定的錯價。
  // 與其猜，不如把差異攤開來講——價差本身就是有用的資訊。
  const twds = rows
    .map((r) => toTWD(r.trend, r.unit, rates))
    .filter((v) => v != null && v > 0)
    .sort((a, b) => a - b);

  if (!twds.length) {
    headline.innerHTML = '<div class="price-main">—</div>' +
      '<div class="price-sub">有價格欄位但沒有有效數字</div>';
  } else {
    const lo = twds[0];
    const hi = twds[twds.length - 1];
    const spread = hi / lo;
    const money = (v) => 'NT$ ' + fmt(v, v < 100 ? 1 : 0);

    if (twds.length === 1 || spread <= 1.35) {
      const mid = twds[Math.floor(twds.length / 2)];
      headline.innerHTML =
        '<div class="price-main">' + money(mid) + '</div>' +
        '<div class="price-sub">' + twds.length + ' 個報價來源，差異不大' +
        (stale ? '　<b>離線快取</b>' : '') + '</div>';
    } else {
      headline.innerHTML =
        '<div class="price-main">' + money(lo) + ' – ' + money(hi) + '</div>' +
        '<div class="price-sub">不同市場與版本的價差達 ' + spread.toFixed(1) +
        ' 倍，實際值多少要看是哪個版本與品相，請看下表' +
        (stale ? '　<b>離線快取</b>' : '') + '</div>';
    }
  }

  const head =
    '<tr><th>市場</th><th>版本</th><th>參考價</th></tr>';
  table.innerHTML =
    head +
    rows
      .map((r) => {
        const t = toTWD(r.trend, r.unit, rates);
        const lo = toTWD(r.low, r.unit, rates);
        const parts = [];
        if (t != null) parts.push('NT$ ' + fmt(t, t < 100 ? 1 : 0));
        if (lo != null) parts.push('<small>最低 ' + fmt(lo, lo < 100 ? 1 : 0) + '</small>');
        return (
          '<tr><td>' + esc(r.source) + '</td><td>' + esc(r.variant) + '</td><td>' +
          (parts.join('<br>') || '—') + '</td></tr>'
        );
      })
      .join('');

  const upd = rows[0].updated ? rows[0].updated.slice(0, 10) : '未知';
  $('price-updated').textContent = '價格更新日：' + upd;
}

function showSearch() {
  $('card-detail').hidden = true;
  $('search-view').hidden = false;
}

function status(text) {
  $('search-status').textContent = text || '';
}

function fmt(n, digits) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== 拍照認卡 =====

/**
 * 載入指紋庫。第一次要下載，之後存在 IndexedDB 離線也能用。
 */
async function loadFingerprints(lang) {
  if (fpDb.lang === lang && fpDb.data) return fpDb;
  if (fpDb.loading) return fpDb.loading;

  fpDb.loading = (async () => {
    const key = 'fp:' + lang;
    const hit = await cacheGet(key);
    if (hit && hit.value && hit.value.ids && hit.value.buf) {
      fpDb.lang = lang;
      fpDb.ids = hit.value.ids;
      fpDb.names = hit.value.names;
      fpDb.data = new Uint8Array(hit.value.buf);
      fpDb.loading = null;
      return fpDb;
    }

    const [metaRes, binRes] = await Promise.all([
      fetch('./data/fp-' + lang + '.json'),
      fetch('./data/fp-' + lang + '.bin'),
    ]);
    if (!metaRes.ok || !binRes.ok) {
      fpDb.loading = null;
      throw new Error('這個語言的指紋庫還沒建好');
    }
    const meta = await metaRes.json();
    const buf = new Uint8Array(await binRes.arrayBuffer());
    if (buf.length !== meta.count * FP_BYTES) {
      fpDb.loading = null;
      throw new Error('指紋庫大小不符，可能下載不完整');
    }

    fpDb.lang = lang;
    fpDb.ids = meta.ids;
    fpDb.names = meta.names;
    fpDb.data = buf;
    // 存進 IndexedDB（ArrayBuffer 可以直接存），下次離線也能認卡
    await cacheSet(key, { ids: meta.ids, names: meta.names, buf: buf.buffer });
    fpDb.loading = null;
    return fpDb;
  })();
  return fpDb.loading;
}

function startScan() {
  if (!host.openCamera) {
    alert('相機還沒準備好');
    return;
  }
  $('scan-result').hidden = true;
  host.openCamera({
    guide: true,
    title: '把卡片對進框裡，填滿框、四邊對齊',
    busyText: '辨識中…',
    onShot: handleScanShot,
    onFallback: () => {
      alert('開不了相機。請確認已允許相機權限，且是用 https 網址開啟。');
    },
  });
}

/**
 * 拍到照片之後：決定用哪個框 → 校正 → 比對 → 列出候選。
 *
 * 用哪個框很關鍵。實測結果：
 *   - 自動偵測真卡：辨識率只有 81%（真卡的藝術圖會把找邊演算法騙進黃框內緣）
 *   - 使用者對齊框：就算對歪 4%，辨識率 100%
 * 所以以對齊框為準；只有在自動偵測「很有把握，而且結果跟對齊框差不多」時，
 * 才採用它的框（它能修掉輕微的透視傾斜）。
 */
export async function handleScanShot(canvas, guideQuad) {
  let db;
  try {
    db = await loadFingerprints(state.lang);
  } catch (err) {
    alert('讀不到指紋庫：' + err.message);
    return;
  }

  let quad = guideQuad;
  let usedDetection = false;
  try {
    const det = detectCardQuad(canvas);
    if (det.confidence >= 0.75 && guideQuad && quadsSimilar(det.quad, guideQuad, canvas)) {
      quad = det.quad;
      usedDetection = true;
    }
  } catch (err) {
    /* 偵測失敗就用對齊框，那本來就是主要依據 */
  }
  if (!quad) return;

  const t0 = performance.now();
  const matches = matchFromPhoto(canvas, quad, db, { warp, imageDataToCanvas }, 5);
  const ms = Math.round(performance.now() - t0);
  renderScanResult(canvas, quad, matches, { ms: ms, usedDetection: usedDetection });
}

/** 兩個四邊形是不是差不多（角點差距都在畫面短邊的 12% 以內）。 */
function quadsSimilar(a, b, canvas) {
  const tol = Math.min(canvas.width, canvas.height) * 0.12;
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > tol) return false;
  }
  return true;
}

function renderScanResult(canvas, quad, matches, info) {
  const box = $('scan-result');
  box.hidden = false;
  $('search-results').innerHTML = '';
  status('');

  // 把校正後的卡片圖顯示出來，使用者一眼就知道有沒有對準
  const imgData = warp(canvas, quad);
  if (imgData) {
    const std = imageDataToCanvas(imgData);
    $('scan-shot').src = std.toDataURL('image/jpeg', 0.8);
  }

  const st = $('scan-status-text');
  if (!matches.length) {
    st.innerHTML = '<b>認不出來</b><br><small>指紋庫裡找不到相近的卡</small>';
    $('scan-candidates').innerHTML = '';
    return;
  }

  const best = matches[0];
  const gap = matches[1] ? matches[1].distance - best.distance : 1;
  let verdict;
  if (best.distance <= MATCH_SURE && gap > 0.03) {
    verdict = '<b class="ok-text">應該是這張</b>';
  } else if (best.distance <= MATCH_MAYBE) {
    verdict = '<b class="warn-textline">不太確定</b><br><small>請從下面挑對的那張</small>';
  } else {
    verdict = '<b class="warn-textline">很不確定</b><br><small>對齊框沒對準，或這張卡不在指紋庫裡。' +
              '重拍一次，或改用卡名搜尋。</small>';
  }
  st.innerHTML = verdict + '<br><small>比對 ' + fpDb.ids.length.toLocaleString('zh-TW') +
                 ' 張，' + info.ms + 'ms' + (info.usedDetection ? '・自動校正' : '') + '</small>';

  $('scan-candidates').innerHTML = matches
    .map((m, i) => {
      const sim = Math.max(0, Math.round((1 - m.distance / 0.35) * 100));
      return (
        '<button class="result-row" data-id="' + esc(m.id) + '">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="result-text"><b>' + esc(m.name || m.id) + '</b>' +
        '<small>' + esc(setName(m.id)) + '　' + esc(splitCardId(m.id).localId) +
        '　相似度 ' + sim + '%</small></span></button>'
      );
    })
    .join('');

  $('scan-candidates').querySelectorAll('.result-row').forEach((b) => {
    b.addEventListener('click', () => openCard(b.dataset.id));
  });
}
