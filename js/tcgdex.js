// TCGdex API 封裝（卡片資料）＋ 匯率。
//
// 選 TCGdex 的原因：免金鑰、允許跨域（純前端才能直接呼叫）、而且是少數
// 同時有繁體中文、日文、英文卡表的來源。
//
// 價格的重要前提：TCGdex 的 pricing 來自 cardmarket（歐洲）與 tcgplayer（美國）。
// 中文卡與日文卡也查得到價，但那是「對應的歐美版商品」的價格，
// 不是台灣蝦皮／露天或日本駿河屋的成交價。這件事必須在畫面上講清楚。

import { cacheGet, cacheSet } from './db.js';

const API = 'https://api.tcgdex.net/v2';
const FX_API = 'https://open.er-api.com/v6/latest/EUR';

const DAY = 86400000;
const TTL_SETS = 7 * DAY;   // 系列表很少變
const TTL_CARD = DAY;       // 價格每天更新一次
const TTL_FX = DAY;

export const LANGS = [
  { code: 'zh-tw', label: '繁中' },
  { code: 'ja', label: '日文' },
  { code: 'en', label: '英文' },
];

/**
 * 先看快取，過期就重抓；抓失敗時回傳過期的快取（離線時還有東西可看）。
 */
async function fetchCached(key, url, ttl) {
  const hit = await cacheGet(key);
  if (hit && hit.age < ttl) return { data: hit.value, stale: false, cached: true };

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    await cacheSet(key, data);
    return { data: data, stale: false, cached: false };
  } catch (err) {
    if (hit) return { data: hit.value, stale: true, cached: true };
    throw err;
  }
}

/** 某語言的全部系列（含 id、名稱、卡數）。 */
export async function getSets(lang) {
  const r = await fetchCached('sets:' + lang, API + '/' + lang + '/sets', TTL_SETS);
  return r.data;
}

/** 單一系列的完整卡表（一次拿到該系列所有卡的 id／卡名／圖網址）。 */
export async function getSet(lang, setId) {
  const r = await fetchCached(
    'set:' + lang + ':' + setId,
    API + '/' + lang + '/sets/' + encodeURIComponent(setId),
    TTL_SETS
  );
  return r.data;
}

/** 單張卡的完整資料（含 pricing）。回傳 {data, stale}。 */
export async function getCard(lang, cardId) {
  return fetchCached(
    'card:' + lang + ':' + cardId,
    API + '/' + lang + '/cards/' + encodeURIComponent(cardId),
    TTL_CARD
  );
}

/** 依卡名搜尋（模糊比對）。中／日／英都可以用該語言的卡名搜。 */
export async function searchByName(lang, name, limit) {
  const url =
    API + '/' + lang + '/cards?name=like:' + encodeURIComponent(name) +
    '&pagination:itemsPerPage=' + (limit || 30);
  const res = await fetch(url);
  if (!res.ok) throw new Error('搜尋失敗 HTTP ' + res.status);
  return res.json();
}

/** 卡片 id 長得像 "SV8-001"：最後一個減號前面是系列 id。 */
export function splitCardId(cardId) {
  const i = String(cardId).lastIndexOf('-');
  if (i < 0) return { setId: '', localId: cardId };
  return { setId: cardId.slice(0, i), localId: cardId.slice(i + 1) };
}

/** 使用者輸入看起來像不像卡片 id（例如 SV8-001、swsh3-136）。 */
export function looksLikeCardId(text) {
  return /^[A-Za-z0-9.]+-[A-Za-z0-9]+$/.test(String(text).trim());
}

/** 組出卡圖網址。TCGdex 的 image 欄位不含副檔名，要自己接品質與格式。 */
export function imageUrl(base, quality, ext) {
  if (!base) return '';
  return base + '/' + (quality || 'high') + '.' + (ext || 'webp');
}

/** 匯率（以 EUR 為基準）。抓不到就用內建的近似值，離線也能換算。 */
export async function getRates() {
  const FALLBACK = { TWD: 37.1, USD: 1.165, EUR: 1, __fallback: true };
  try {
    const r = await fetchCached('fx:EUR', FX_API, TTL_FX);
    const rates = r.data && r.data.rates;
    if (!rates || !rates.TWD) return FALLBACK;
    return {
      TWD: rates.TWD,
      USD: rates.USD,
      EUR: 1,
      updated: r.data.time_last_update_utc,
      stale: r.stale,
    };
  } catch (err) {
    return FALLBACK;
  }
}

/** 把某幣別金額換成台幣。rates 以 EUR 為基準。 */
export function toTWD(amount, unit, rates) {
  if (amount == null || !isFinite(amount)) return null;
  if (unit === 'EUR') return amount * rates.TWD;
  if (unit === 'USD') return (amount / rates.USD) * rates.TWD;
  return null;
}

/**
 * 把 pricing 整理成畫面好顯示的清單。
 *
 * cardmarket 是扁平的（avg/low/trend，另有 -holo 後綴的版本），
 * tcgplayer 則是每個版本一個物件（normal / holofoil / reverse-holofoil）。
 */
export function normalizePricing(pricing) {
  const out = [];
  if (!pricing) return out;

  // cardmarket 對「這張卡沒有這個版本」是回 0 而不是省略欄位。
  // 直接顯示就會變成「閃卡 NT$ 0.0」，看起來像這張卡不值錢——其實是根本沒資料。
  const px = (v) => (typeof v === 'number' && v > 0 ? v : null);

  const cm = pricing.cardmarket;
  if (cm && typeof cm === 'object') {
    const unit = cm.unit || 'EUR';
    const variants = [
      { suffix: '', label: '一般' },
      { suffix: '-holo', label: '閃卡' },
      { suffix: '-reverse', label: 'Reverse' },
    ];
    for (const v of variants) {
      const trend = px(cm['trend' + v.suffix]);
      const low = px(cm['low' + v.suffix]);
      const avg30 = px(cm['avg30' + v.suffix]);
      if (trend == null && low == null && avg30 == null) continue;
      out.push({
        source: 'cardmarket',
        market: '歐洲 cardmarket',
        variant: v.label,
        unit: unit,
        trend: trend,
        low: low,
        avg30: avg30,
        updated: cm.updated,
      });
    }
  }

  const tp = pricing.tcgplayer;
  if (tp && typeof tp === 'object') {
    const unit = tp.unit || 'USD';
    const labels = {
      normal: '一般',
      holofoil: '閃卡',
      'reverse-holofoil': 'Reverse',
      '1st-edition-holofoil': '初版閃卡',
      '1st-edition': '初版',
    };
    for (const key of Object.keys(tp)) {
      const v = tp[key];
      if (!v || typeof v !== 'object') continue;
      const market = px(v.marketPrice);
      const low = px(v.lowPrice);
      const mid = px(v.midPrice);
      if (market == null && low == null && mid == null) continue;
      out.push({
        source: 'tcgplayer',
        market: '美國 tcgplayer',
        variant: labels[key] || key,
        unit: unit,
        trend: market,
        low: low,
        avg30: mid,
        updated: tp.updated,
      });
    }
  }

  return out;
}

/** 外部行情搜尋連結——台／日的真實成交價只能靠這些站自己看。 */
export function marketLinks(cardName, localId, setName) {
  const q = (s) => encodeURIComponent(s);
  const nameOnly = cardName || '';
  const withNo = (nameOnly + ' ' + (localId || '')).trim();
  return [
    { label: '蝦皮', url: 'https://shopee.tw/search?keyword=' + q('寶可夢 卡 ' + withNo) },
    { label: '露天', url: 'https://www.ruten.com.tw/find/?q=' + q('寶可夢 ' + withNo) },
    { label: 'Yahoo 拍賣', url: 'https://tw.bid.yahoo.com/search/auction/product?p=' + q('寶可夢 ' + withNo) },
    { label: '駿河屋', url: 'https://www.suruga-ya.jp/search?category=&search_word=' + q(nameOnly) },
  ];
}
