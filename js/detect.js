// 卡片邊界偵測。
//
// 第一版用「顏色跟背景不一樣」找卡片，10 個困難情境只過 2 個：影子會被當成
// 卡片的一部分、桌面雜物會被連進去、暗一點就整個失效，而且失敗時信心度還很高。
//
// 這一版換兩個關鍵做法：
//
// 1. 用「色度梯度」而不是亮度找邊緣。
//    影子的本質是把 RGB 三個通道**等比例**壓暗，所以 R/(R+G+B) 這種正規化色度
//    在影子內外幾乎一樣——影子邊界在色度圖上會直接消失，但卡片邊緣（黃框對灰桌面）
//    是真正的顏色改變，依然很明顯。亮度只給很小的權重並設上限，
//    避免一道強影子的亮度落差蓋過真正的邊。
//
// 2. 用 Hough 直線找四條邊，再用「邊緣支持度」挑最好的組合。
//    卡片是矩形，四條長直線是很強的先驗。支持度＝沿著四邊取樣、有多少比例
//    真的看得到邊緣——這個數字同時拿來選候選框**和**當信心度，
//    所以框錯的時候信心度會自己掉下來，不會再出現「0.99 但偏 200px」。

import { CARD_ASPECT, refineQuad, defaultQuad, autoDetectQuad } from './imageutil.js';

const WORK_W = 400;        // 搜尋用的工作解析度
const THETA_BINS = 180;    // Hough 角度解析度（1 度）
const RHO_STEP = 2;
const TOP_LINES = 7;       // 每個方向family取幾條線去組合
const EDGE_PCTL = 0.90;    // 梯度前 10% 才算邊緣點
// 支持度差多少以內算「差不多」，之後改用面積大的（外框）。
// 太小的話真正的卡片外緣（訊號通常比內框弱）會被排除在外，又回去鎖內框。
const NEAR_TOL = 0.12;

/** 縮到工作解析度並取像素。 */
function toWorking(srcCanvas, workW) {
  const w = workW || WORK_W;
  const h = Math.max(1, Math.round((srcCanvas.height / srcCanvas.width) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0, w, h);
  const img = c.getContext('2d').getImageData(0, 0, w, h);
  return { d: img.data, w: w, h: h, kx: srcCanvas.width / w, ky: srcCanvas.height / h };
}

/**
 * 抗影子的邊緣強度圖。
 * 色度為主、亮度為輔且設上限，這樣強影子不會蓋過真正的材質邊界。
 */
function edgeMap(d, w, h) {
  const n = w * h;
  const cr = new Float32Array(n);
  const cg = new Float32Array(n);
  const lum = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const R = d[o], G = d[o + 1], B = d[o + 2];
    const s = R + G + B + 1;
    cr[i] = (R / s) * 255;
    cg[i] = (G / s) * 255;
    lum[i] = (R * 0.299 + G * 0.587 + B * 0.114);
  }

  const mag = new Float32Array(n);
  const LUM_CAP = 55;   // 亮度梯度的上限，強影子超過也只算這麼多
  const LUM_W = 0.45;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let acc = 0;
      // 色度兩個分量各做一次 Sobel，取平方和
      for (const ch of [cr, cg]) {
        const gx =
          -ch[i - w - 1] - 2 * ch[i - 1] - ch[i + w - 1] +
          ch[i - w + 1] + 2 * ch[i + 1] + ch[i + w + 1];
        const gy =
          -ch[i - w - 1] - 2 * ch[i - w] - ch[i - w + 1] +
          ch[i + w - 1] + 2 * ch[i + w] + ch[i + w + 1];
        acc += gx * gx + gy * gy;
      }
      const chroma = Math.sqrt(acc) / 4;

      const lx =
        -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] +
        lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const ly =
        -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] +
        lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      const l = Math.min(Math.sqrt(lx * lx + ly * ly) / 4, LUM_CAP);

      mag[i] = chroma + l * LUM_W;
    }
  }
  return mag;
}

/** 取第 p 百分位的門檻值。 */
function percentile(arr, p) {
  const sample = [];
  const stride = Math.max(1, Math.floor(arr.length / 20000));
  for (let i = 0; i < arr.length; i += stride) sample.push(arr[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(sample.length * p))] || 0;
}

/** Hough 直線偵測。回傳 [{rho, theta, votes}]，已做非極大值抑制。 */
function houghLines(mag, w, h) {
  const thr = Math.max(6, percentile(mag, EDGE_PCTL));
  const diag = Math.ceil(Math.hypot(w, h));
  const rhoBins = Math.ceil((2 * diag) / RHO_STEP) + 1;
  const acc = new Float32Array(THETA_BINS * rhoBins);

  const cos = new Float32Array(THETA_BINS);
  const sin = new Float32Array(THETA_BINS);
  for (let t = 0; t < THETA_BINS; t++) {
    const a = (t * Math.PI) / THETA_BINS;
    cos[t] = Math.cos(a);
    sin[t] = Math.sin(a);
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const m = mag[y * w + x];
      if (m < thr) continue;
      for (let t = 0; t < THETA_BINS; t++) {
        const rho = x * cos[t] + y * sin[t];
        const ri = ((rho + diag) / RHO_STEP) | 0;
        acc[t * rhoBins + ri] += m;
      }
    }
  }

  // 非極大值抑制後取峰值
  const peaks = [];
  const NMS_T = 4;
  const NMS_R = 6;
  for (let t = 0; t < THETA_BINS; t++) {
    for (let ri = 1; ri < rhoBins - 1; ri++) {
      const v = acc[t * rhoBins + ri];
      if (v <= 0) continue;
      let isMax = true;
      for (let dt = -NMS_T; dt <= NMS_T && isMax; dt++) {
        const tt = (t + dt + THETA_BINS) % THETA_BINS;
        for (let dr = -NMS_R; dr <= NMS_R; dr++) {
          const rr = ri + dr;
          if (rr < 0 || rr >= rhoBins) continue;
          if (acc[tt * rhoBins + rr] > v) { isMax = false; break; }
        }
      }
      if (isMax) {
        peaks.push({
          theta: (t * Math.PI) / THETA_BINS,
          rho: ri * RHO_STEP - diag,
          votes: v,
        });
      }
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  return peaks.slice(0, 60);
}

/** 兩條線的交點。線以 (rho, theta) 表示：x·cosθ + y·sinθ = rho。 */
function lineIntersect(l1, l2) {
  const a1 = Math.cos(l1.theta), b1 = Math.sin(l1.theta);
  const a2 = Math.cos(l2.theta), b2 = Math.sin(l2.theta);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.rho * b2 - l2.rho * b1) / det,
    y: (a1 * l2.rho - a2 * l1.rho) / det,
  };
}

/** 把線分成兩個方向群（卡片的兩組對邊）。 */
function groupByAngle(lines) {
  if (!lines.length) return null;
  const base = lines[0].theta;
  const A = [], B = [];
  for (const l of lines) {
    // 角度差取模 π，再看接近 0 還是接近 π/2
    let d = Math.abs(l.theta - base) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    (d < Math.PI / 4 ? A : B).push(l);
  }
  if (A.length < 2 || B.length < 2) return null;
  return [pickCandidates(A), pickCandidates(B)];
}

/**
 * 從一個方向群挑候選線。
 *
 * 不能只取票數前幾名：卡片下半部的文字列每一條都會產生兩條又長又直的強線，
 * 票數輕鬆蓋過卡片真正的底邊，結果底邊根本進不了候選，框就少了一邊。
 * 卡片的四個邊必定是**最外側**的線，所以外側的線一定要保留。
 */
function pickCandidates(family) {
  const byVotes = family.slice(0, TOP_LINES).slice();
  const byRho = family.slice().sort((a, b) => signedRho(a) - signedRho(b));
  const outer = byRho.slice(0, 3).concat(byRho.slice(-3));

  const seen = new Set();
  const out = [];
  for (const l of outer.concat(byVotes)) {
    const key = Math.round(l.rho) + ':' + Math.round(l.theta * 1000);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= 12) break;
  }
  return out;
}

/** rho 的正負會隨 theta 落在哪半邊而翻轉，統一過再比較才有「內外」的意義。 */
function signedRho(l) {
  return l.theta > Math.PI / 2 ? -l.rho : l.rho;
}

/**
 * 沿著四邊取樣，看有多少比例真的看得到邊緣。
 * 這個值同時用來挑候選框與當作信心度——框錯了它自然會低。
 */
function edgeSupport(mag, w, h, quad, thr) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  let hits = 0;
  let total = 0;

  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 8) return 0;
    const steps = Math.max(8, Math.min(40, Math.round(len / 4)));

    // 邊的法線，朝外
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((cx - mx) * nx + (cy - my) * ny > 0) { nx = -nx; ny = -ny; }

    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      total++;
      // 邊緣不會剛好落在數學上的線上，往內外各找一點點
      let best = 0;
      for (let k = -2; k <= 2; k++) {
        const sx = Math.round(px + nx * k);
        const sy = Math.round(py + ny * k);
        if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) continue;
        const m = mag[sy * w + sx];
        if (m > best) best = m;
      }
      if (best >= thr) hits++;
    }
  }
  return total ? hits / total : 0;
}

/** 四邊形是否合理：凸、面積夠大、長寬比接近卡片。 */
function quadPlausible(quad, w, h) {
  for (const p of quad) {
    if (!isFinite(p.x) || !isFinite(p.y)) return 0;
    if (p.x < -w * 0.15 || p.x > w * 1.15 || p.y < -h * 0.15 || p.y > h * 1.15) return 0;
  }
  // 凸性：四個外積同號
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(cross);
    if (s === 0) return 0;
    if (sign === 0) sign = s;
    else if (s !== sign) return 0;
  }

  const wAvg = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const hAvg = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  if (wAvg < w * 0.15 || hAvg < h * 0.15) return 0;

  const area = wAvg * hAvg;
  if (area < w * h * 0.06) return 0;

  const aspect = wAvg / hAvg;
  const err = Math.abs(aspect - CARD_ASPECT) / CARD_ASPECT;
  if (err > 0.4) return 0;
  return 1 - err / 0.4; // 越接近卡片比例分數越高
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 檢查框的外面是不是還平行地藏著另一圈邊。
 *
 * 如果有，很可能我們框到的是黃框的內緣而不是卡片本身——桌面顏色接近卡片外框時
 * 就會這樣。這種情況幾何上救不回來（外緣的訊號真的太弱），但至少不能還宣稱
 * 九成九的信心，要讓使用者知道該手動確認一下。
 *
 * 只在「整條邊幾乎都有」時才算數，斜切過去的影子邊界不會滿足這個條件。
 */
function outerRingDistances(mag, w, h, quad, thr) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const shortSide = Math.min(
    dist(quad[0], quad[1]), dist(quad[1], quad[2]),
    dist(quad[2], quad[3]), dist(quad[3], quad[0])
  );
  const maxOut = Math.max(4, Math.round(shortSide * 0.16));
  let edgesWithOuter = 0;
  const dists = [0, 0, 0, 0];

  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 8) continue;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((cx - mx) * nx + (cy - my) * ny > 0) { nx = -nx; ny = -ny; }

    // 對每個往外的距離，看整條邊有多少比例都出現邊緣
    let bestFrac = 0;
    let bestD = 0;
    for (let d = 5; d <= maxOut; d++) {
      let hit = 0, tot = 0;
      for (let s = 2; s < 18; s++) {
        const t = s / 19;
        const px = a.x + (b.x - a.x) * t + nx * d;
        const py = a.y + (b.y - a.y) * t + ny * d;
        const sx = Math.round(px), sy = Math.round(py);
        if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) continue;
        tot++;
        if (mag[sy * w + sx] >= thr) hit++;
      }
      if (tot >= 10 && hit / tot > bestFrac) { bestFrac = hit / tot; bestD = d; }
    }
    dists[e] = bestFrac >= 0.75 ? bestD : 0;
    if (dists[e]) edgesWithOuter++;
  }
  return { count: edgesWithOuter, dists: dists };
}

/** 把四邊各自往外推 dists[e] 個像素，重新求四個角。 */
function expandQuad(quad, dists) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const lines = [];
  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 8) return null;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((cx - mx) * nx + (cy - my) * ny > 0) { nx = -nx; ny = -ny; }
    const d = dists[e] || 0;
    const p1 = { x: a.x + nx * d, y: a.y + ny * d };
    const p2 = { x: b.x + nx * d, y: b.y + ny * d };
    // 直線以兩點表示，之後求相鄰兩邊的交點
    lines.push({ p1: p1, p2: p2 });
  }
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4];
    const l2 = lines[i];
    const p = segIntersect(l1, l2);
    if (!p) return null;
    pts.push(p);
  }
  return pts;
}

function segIntersect(l1, l2) {
  const a1 = l1.p2.y - l1.p1.y, b1 = l1.p1.x - l1.p2.x;
  const c1 = a1 * l1.p1.x + b1 * l1.p1.y;
  const a2 = l2.p2.y - l2.p1.y, b2 = l2.p1.x - l2.p2.x;
  const c2 = a2 * l2.p1.x + b2 * l2.p1.y;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (b2 * c1 - b1 * c2) / det, y: (a1 * c2 - a2 * c1) / det };
}

/** 依左上、右上、右下、左下排序四個點。 */
function orderQuad(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const withAngle = pts.map((p) => ({ p: p, a: Math.atan2(p.y - cy, p.x - cx) }));
  withAngle.sort((u, v) => u.a - v.a);
  const ordered = withAngle.map((u) => u.p);
  // 由 atan2 排序後是逆時針從 -π 開始，找出最像左上的當起點
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = ordered[i].x + ordered[i].y;
    if (s < best) { best = s; start = i; }
  }
  return [0, 1, 2, 3].map((i) => ordered[(start + i) % 4]);
}

/**
 * 主要入口：偵測卡片四角。
 *
 * @returns {{quad, confidence, method, support}}
 *   confidence 是實際量到的邊緣支持度，不是猜的——框錯時它會低。
 */
export function detectCardQuad(srcCanvas, opts) {
  const o = opts || {};
  // 即時預覽時每秒要跑好幾次，用較低的工作解析度並跳過顏色法，
  // 換來的誤差在預覽階段無所謂——按下快門時才會用完整精度重算一次。
  const fast = !!o.fast;
  const wk = toWorking(srcCanvas, fast ? 240 : WORK_W);
  const mag = edgeMap(wk.d, wk.w, wk.h);
  const thr = Math.max(6, percentile(mag, EDGE_PCTL));

  const candidates = [];

  const lines = houghLines(mag, wk.w, wk.h);
  const groups = groupByAngle(lines);
  if (groups) {
    const [A, B] = groups;
    for (let i = 0; i < A.length; i++) {
      for (let j = i + 1; j < A.length; j++) {
        for (let k = 0; k < B.length; k++) {
          for (let l = k + 1; l < B.length; l++) {
            const pts = [
              lineIntersect(A[i], B[k]), lineIntersect(A[i], B[l]),
              lineIntersect(A[j], B[l]), lineIntersect(A[j], B[k]),
            ];
            if (pts.some((p) => !p)) continue;
            const quad = orderQuad(pts);
            const plaus = quadPlausible(quad, wk.w, wk.h);
            if (!plaus) continue;
            const support = edgeSupport(mag, wk.w, wk.h, quad, thr);
            const wAvg = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
            const hAvg = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
            candidates.push({
              quad: quad, support: support, plaus: plaus,
              area: wAvg * hAvg, method: 'hough',
            });
          }
        }
      }
    }
  }

  // 舊的顏色分割法也丟進來當候選。
  //
  // 它在乾淨背景下抓透視變形的卡很準（誤差 <1.5px），但遇到影子就整個失效；
  // Hough 剛好相反。兩邊都產生候選、用同一個 edgeSupport 評分，
  // 就不必事先決定「這張照片該用哪種方法」——分數自己會選。
  try {
    if (fast) throw new Error('fast mode: 跳過顏色法');
    const legacy = autoDetectQuad(srcCanvas);
    const inWork = legacy.quad.map((p) => ({ x: p.x / wk.kx, y: p.y / wk.ky }));
    const plaus = quadPlausible(inWork, wk.w, wk.h);
    if (plaus) {
      const wAvg = (dist(inWork[0], inWork[1]) + dist(inWork[3], inWork[2])) / 2;
      const hAvg = (dist(inWork[0], inWork[3]) + dist(inWork[1], inWork[2])) / 2;
      candidates.push({
        quad: inWork,
        support: edgeSupport(mag, wk.w, wk.h, inWork, thr),
        plaus: plaus,
        area: wAvg * hAvg,
        method: 'color',
        alreadyRefined: true,
      });
    }
  } catch (err) {
    /* 顏色法失敗就只靠 Hough */
  }

  if (!candidates.length) {
    const quad = defaultQuad(wk.w, wk.h);
    return {
      quad: quad.map((p) => ({ x: p.x * wk.kx, y: p.y * wk.ky })),
      confidence: 0,
      support: 0,
      method: 'fallback',
    };
  }

  // 支持度為主、比例合理性為輔
  const score = (c) => c.support * 0.85 + c.plaus * 0.15;
  candidates.sort((a, b) => score(b) - score(a));

  // 支持度差不多時取「最外圈」的那個。
  //
  // 卡片的黃框內緣（黃→藍）色差比外緣（桌面→黃框）還強，Hough 票數更高，
  // 所以最高分的常常是藝術區的矩形而不是卡片本身——量出來的置中就會整個錯掉。
  // 卡片外框在幾何上必定包住藝術區，所以支持度接近時挑面積大的那個就對了。
  const top = score(candidates[0]);
  const near = candidates.filter((c) => score(c) >= top - NEAR_TOL);
  near.sort((a, b) => b.area - a.area);
  const best = near[0];

  // 換算回原圖座標，再用全解析度把四邊貼齊真正的卡緣
  let quad = best.quad.map((p) => ({
    x: Math.max(0, Math.min(srcCanvas.width, p.x * wk.kx)),
    y: Math.max(0, Math.min(srcCanvas.height, p.y * wk.ky)),
  }));
  quad = refineQuad(srcCanvas, quad, Math.max(8, wk.kx * 3));

  // 框外面還有一圈平行邊 = 很可能框到的是黃框內緣而不是卡片邊緣。
  // 既然找得到那圈邊在哪，就別只是警告——把四邊推過去、重新評分，
  // 推出來的框如果同樣站得住腳就採用它。
  const ring = outerRingDistances(mag, wk.w, wk.h, best.quad, thr);
  let workQuad = best.quad;
  let support = best.support;
  let corrected = false;

  if (ring.count >= 2) {
    const expanded = expandQuad(best.quad, ring.dists);
    if (expanded && quadPlausible(expanded, wk.w, wk.h)) {
      const expSupport = edgeSupport(mag, wk.w, wk.h, expanded, thr);
      // 外緣的訊號本來就比內框弱，所以不要求一樣高，站得住腳就好
      if (expSupport >= Math.max(0.6, support * 0.8)) {
        workQuad = expanded;
        support = expSupport;
        corrected = true;
        quad = refineQuad(
          srcCanvas,
          expanded.map((p) => ({
            x: Math.max(0, Math.min(srcCanvas.width, p.x * wk.kx)),
            y: Math.max(0, Math.min(srcCanvas.height, p.y * wk.ky)),
          })),
          Math.max(8, wk.kx * 3)
        );
      }
    }
  }

  // 推完之後再檢查一次；還是有外圈就真的說不準了
  const after = corrected
    ? outerRingDistances(mag, wk.w, wk.h, workQuad, thr)
    : ring;
  const suspectInner = after.count >= 2;
  let confidence = Math.max(0, Math.min(1, support));
  if (suspectInner) confidence = Math.min(confidence, 0.55);

  return {
    quad: quad,
    confidence: confidence,
    support: support,
    method: best.method + (corrected ? '+expand' : ''),
    suspectInner: suspectInner,
  };
}
