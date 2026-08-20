// 品相分析。M1 先做「置中」——這是四個子項裡唯一能真正量得準的，
// 因為它量的是幾何距離，不像刮痕那樣被反光和亮面卡干擾。
//
// 輸入一定是 imageutil.warp() 產出的標準卡片圖（734×1024，已裁到卡片實體邊緣）。

import { CARD_W, CARD_H, median, mad } from './imageutil.js';

// 實體卡 63×88mm，用來把 px 換算成 mm 顯示
export const PX_PER_MM = CARD_W / 63;

// 掃描參數
const SKIP_EDGE = 4;        // 最外圈跳過，避開校正誤差與圓角
const RING_DEPTH = 14;      // 取樣外框顏色的深度
const SCAN_LINES = 41;      // 每邊掃描線數，取中位數抗雜訊
const SCAN_SPAN = 0.7;      // 掃描線分布在該邊中間 70%，避開圓角
const MAX_DEPTH = 0.3;      // 最多往內找到 30%，超過就是沒找到內框
const EDGE_THRESHOLD = 26;  // 判定「顏色劇變」的距離（以色度為主）
const RUN_LEN = 5;          // 要連續幾個像素都劇變才算數，濾掉雜點
const UNIFORM_TOL = 20;     // 外框顏色算不算一致的容許距離

/**
 * 取像素的「色度 + 有上限的亮度」特徵。
 *
 * 影子會把 RGB 三個通道等比例壓暗，所以正規化色度 R/(R+G+B) 在影子內外幾乎一樣。
 * 直接比 RGB 的話，一道影子橫過黃框就會讓程式以為外框顏色不一致而放棄量測
 * （實測影子那張的一致性只有 53%，直接顯示「無法量測」）。
 * 亮度仍保留一點權重並設上限，這樣黑框配深色圖這種「色度接近、只差明暗」的卡也分得出來。
 */
function feat(d, o) {
  const R = d[o], G = d[o + 1], B = d[o + 2];
  const s = R + G + B + 1;
  return [
    (R / s) * 255,
    (G / s) * 255,
    Math.min(R * 0.299 + G * 0.587 + B * 0.114, 200) * 0.30,
  ];
}

/** 兩個特徵向量的距離。 */
function featDist(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], dl = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + dl * dl);
}

/**
 * PSA 置中容差對照（正面）。傳入偏移較大那側的百分比。
 * 例如 56/44 就傳 56。背面容差寬鬆，用 backTable。
 */
export function centeringScore(maxPct, isBack) {
  const table = isBack
    ? [[75, 10], [80, 9], [85, 8], [90, 7], [95, 6], [100, 5]]
    : [[55, 10], [60, 9], [65, 8], [70, 7], [75, 6], [80, 5], [85, 4], [90, 3], [100, 2]];
  for (const [limit, score] of table) {
    if (maxPct <= limit + 1e-9) return score;
  }
  return 1;
}

/**
 * 取外框顏色。除了整體的中位數，也回傳每一邊各自的中位數。
 *
 * 為什麼要分邊：影子壓在卡片某一側時，那一側的取樣值會被拉走，
 * 用整體中位數去比就會在那一邊的最外緣立刻誤判成「顏色變了」，
 * 量出 0.34mm 的荒謬邊寬。每邊各自比自己的顏色就不受其他邊影響。
 */
function sampleBorder(data, w, h) {
  const perSide = { left: [], right: [], top: [], bottom: [] };
  const all = [];

  const collect = (side, x, y) => {
    const f = feat(data, (y * w + x) * 4);
    perSide[side].push(f);
    all.push(f);
  };

  // 只取每邊中間 70%，圓角區不算
  const xLo = Math.round(w * 0.15), xHi = Math.round(w * 0.85);
  const yLo = Math.round(h * 0.15), yHi = Math.round(h * 0.85);
  for (let d = SKIP_EDGE; d < RING_DEPTH; d++) {
    for (let x = xLo; x < xHi; x += 2) {
      collect('top', x, d);
      collect('bottom', x, h - 1 - d);
    }
    for (let y = yLo; y < yHi; y += 2) {
      collect('left', d, y);
      collect('right', w - 1 - d, y);
    }
  }

  const med = (list) => [
    median(list.map((f) => f[0])),
    median(list.map((f) => f[1])),
    median(list.map((f) => f[2])),
  ];

  const color = med(all);
  const sides = {};
  for (const k of Object.keys(perSide)) sides[k] = med(perSide[k]);

  // 一致性也要分邊算。影子橫過整張卡時，四邊各自其實都很一致，
  // 只是彼此不同——用整體去算會誤判成「這張卡沒有單色外框」而放棄量測。
  const sideUniformity = {};
  for (const k of Object.keys(perSide)) {
    const list = perSide[k];
    let inRange = 0;
    for (const f of list) if (featDist(f, sides[k]) <= UNIFORM_TOL) inRange++;
    sideUniformity[k] = list.length ? inRange / list.length : 0;
  }
  const uniformity = median(Object.values(sideUniformity));

  return {
    color: color,
    sideColors: sides,
    sideUniformity: sideUniformity,
    uniformity: uniformity,
  };
}

/**
 * 從某一邊往內掃，找外框內緣的位置。
 * @returns {{depth:number, spread:number, hitRate:number}} depth 單位為標準圖 px
 */
function scanSide(data, w, h, side, borderColor) {
  const isVertical = side === 'left' || side === 'right';
  const along = isVertical ? h : w;      // 掃描線分布的方向
  const across = isVertical ? w : h;     // 往內找的方向
  const maxDepth = Math.round(across * MAX_DEPTH);

  const lo = Math.round(along * (0.5 - SCAN_SPAN / 2));
  const hi = Math.round(along * (0.5 + SCAN_SPAN / 2));
  const step = Math.max(1, Math.round((hi - lo) / SCAN_LINES));

  const depths = [];
  let attempts = 0;

  for (let a = lo; a < hi; a += step) {
    attempts++;
    let run = 0;
    let found = -1;
    for (let d = SKIP_EDGE; d < maxDepth; d++) {
      let x, y;
      if (side === 'left') { x = d; y = a; }
      else if (side === 'right') { x = w - 1 - d; y = a; }
      else if (side === 'top') { x = a; y = d; }
      else { x = a; y = h - 1 - d; }

      const o = (y * w + x) * 4;
      if (featDist(feat(data, o), borderColor) > EDGE_THRESHOLD) {
        run++;
        if (run >= RUN_LEN) { found = d - RUN_LEN + 1; break; }
      } else {
        run = 0;
      }
    }
    // 一掃就中代表最外緣的像素本身就不像外框——通常是影子邊界壓在卡緣上，
    // 或四角沒框準。這種值不是「邊框很窄」，是量錯了，不能當成有效數據。
    if (found > SKIP_EDGE + 1) depths.push(found);
  }

  return {
    depth: depths.length ? median(depths) : NaN,
    spread: depths.length ? mad(depths) : NaN,
    hitRate: attempts ? depths.length / attempts : 0,
  };
}

/**
 * 量測置中。
 * @param {ImageData} img 標準卡片圖
 * @param {{isBack?:boolean}} [opts]
 */
export function measureCentering(img, opts) {
  const isBack = !!(opts && opts.isBack);
  // 四角框得準不準，決定了這張標準圖有沒有意義。
  // 框歪了還宣稱量測可信，就是把錯誤包裝成確定的數字。
  const detConfidence = opts && typeof opts.detConfidence === 'number'
    ? opts.detConfidence : 1;
  const d = img.data;
  const w = img.width;
  const h = img.height;
  const warnings = [];

  const border = sampleBorder(d, w, h);

  // 全圖卡／無框卡：外框顏色雜亂，置中量不準，這時候寧可講清楚也不要給假分數
  if (border.uniformity < 0.62) {
    warnings.push({
      level: 'error',
      text: '這張卡的外圈顏色不一致（可能是全圖卡、無框卡，或照片邊緣沒框準）。置中量測在這種卡上不可靠。',
    });
  }

  const sides = {
    left: scanSide(d, w, h, 'left', border.sideColors.left),
    right: scanSide(d, w, h, 'right', border.sideColors.right),
    top: scanSide(d, w, h, 'top', border.sideColors.top),
    bottom: scanSide(d, w, h, 'bottom', border.sideColors.bottom),
  };

  const missing = Object.keys(sides).filter(
    (k) => !isFinite(sides[k].depth) || sides[k].hitRate < 0.5
  );
  if (missing.length) {
    warnings.push({
      level: 'error',
      text: '有 ' + missing.length + ' 側找不到外框內緣，無法計算置中。請確認四角有框準卡片實體邊緣，並避免陰影蓋住邊框。',
    });
    return {
      ok: false,
      warnings: warnings,
      border: border,
      sides: sides,
    };
  }

  // 掃描線之間差異太大 → 通常是陰影或反光造成，分數要打折
  const spreads = ['left', 'right', 'top', 'bottom'].map((k) => sides[k].spread);
  const worstSpread = Math.max.apply(null, spreads);
  if (worstSpread > 6) {
    warnings.push({
      level: 'warn',
      text: '各條掃描線量到的邊寬落差較大（±' + worstSpread.toFixed(1) + 'px），可能有陰影或反光。建議換均勻光線重拍一次比對。',
    });
  }

  const L = sides.left.depth;
  const R = sides.right.depth;
  const T = sides.top.depth;
  const B = sides.bottom.depth;

  const lrTotal = L + R;
  const tbTotal = T + B;
  const lr = { a: (L / lrTotal) * 100, b: (R / lrTotal) * 100 };
  const tb = { a: (T / tbTotal) * 100, b: (B / tbTotal) * 100 };

  const lrMax = Math.max(lr.a, lr.b);
  const tbMax = Math.max(tb.a, tb.b);
  const scoreLR = centeringScore(lrMax, isBack);
  const scoreTB = centeringScore(tbMax, isBack);
  const score = Math.min(scoreLR, scoreTB);

  // 信心度：外框一致性 + 掃描穩定度
  let confidence = border.uniformity;
  confidence *= Math.max(0.3, 1 - worstSpread / 20);
  confidence = Math.max(0, Math.min(1, confidence));

  // 量得出數字，不代表數字可信。全圖卡、框歪了、光線亂七八糟的時候，
  // 這裡照樣會吐出一組比例——但那組比例是錯的。
  // 與其把一個大大的分數擺在畫面正中央讓人誤信，不如明講「這張量不準」。
  const reliable =
    border.uniformity >= 0.62 &&
    worstSpread <= 12 &&
    confidence >= 0.3 &&
    detConfidence >= 0.6;

  if (detConfidence < 0.6) {
    warnings.push({
      level: 'error',
      text: '四角自動框選的信心度只有 ' + Math.round(detConfidence * 100) +
            '%，這張標準圖可能整個歪掉。請回上一步手動把四角拖到卡片實體邊緣。',
    });
  }

  return {
    ok: true,
    reliable: reliable,
    isBack: isBack,
    warnings: warnings,
    border: border,
    sides: sides,
    margins: { left: L, right: R, top: T, bottom: B },
    marginsMm: {
      left: L / PX_PER_MM,
      right: R / PX_PER_MM,
      top: T / PX_PER_MM,
      bottom: B / PX_PER_MM,
    },
    lr: lr,
    tb: tb,
    scoreLR: scoreLR,
    scoreTB: scoreTB,
    score: score,
    confidence: confidence,
    detConfidence: detConfidence,
    // 給畫面畫內框用
    innerRect: { x: L, y: T, w: w - L - R, h: h - T - B },
  };
}

/** 把 56.3 這種數字排成 "56 / 44" 的顯示格式。 */
export function ratioText(pair) {
  return Math.round(pair.a) + ' / ' + Math.round(pair.b);
}

/** 分數對應的評語。刻意不寫成「PSA 10」這種會被誤會的字。 */
export function scoreLabel(score) {
  if (score >= 10) return '置中極佳';
  if (score >= 9) return '置中良好';
  if (score >= 8) return '置中尚可';
  if (score >= 7) return '置中偏移可見';
  if (score >= 6) return '置中明顯偏移';
  return '置中嚴重偏移';
}
