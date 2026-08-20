// 共用像素運算：載圖、四角自動偵測、反透視校正、顏色統計
// 所有分析都建立在這裡的 warp() 之上——先把歪斜的照片拉正成標準卡片圖，
// 後面量置中、看邊角才有意義。

// 標準卡片圖尺寸。實體卡 63×88mm，2.5:3.5 英吋比。
// 734×1024 約等於 11.6 px/mm，量置中綽綽有餘。
export const CARD_W = 734;
export const CARD_H = 1024;
export const CARD_ASPECT = 2.5 / 3.5;

// 原始照片最長邊上限。太大手機記憶體會爆（4000px 的 ImageData 就要 60MB），
// 太小又會失去邊角細節。2000px 對 63mm 的卡約 30 px/mm，夠用。
export const MAX_SRC_DIM = 2000;

/** 從 <input type="file"> 的檔案載入圖片，自動套用 EXIF 旋轉並縮到上限內。 */
export async function loadImageFile(file) {
  let bitmap;
  try {
    // imageOrientation:'from-image' 讓直拍的照片不會躺著
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    bitmap = await createImageBitmap(file);
  }
  const scale = Math.min(1, MAX_SRC_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  return canvas;
}

/** 解 8 個單應性係數，把 (x,y) 映到 (u,v)。四組對應點。 */
export function solveHomography(from, to) {
  // u = (h0x + h1y + h2) / (h6x + h7y + 1)
  // v = (h3x + h4y + h5) / (h6x + h7y + 1)
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const x = from[i].x;
    const y = from[i].y;
    const u = to[i].x;
    const v = to[i].y;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  return gaussSolve(A, b);
}

/** 高斯消去法解 8×8 線性方程組（含部分樞紐選擇）。 */
function gaussSolve(A, b) {
  const n = b.length;
  const m = A.map((row, i) => row.concat([b[i]]));

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null; // 退化：四點共線
    const tmp = m[col];
    m[col] = m[pivot];
    m[pivot] = tmp;

    const p = m[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / m[i][i]);
}

/**
 * 反透視校正：把照片中的四邊形 quad 拉成正矩形。
 *
 * @param {HTMLCanvasElement} srcCanvas 原始照片
 * @param {Array<{x:number,y:number}>} quad 四角（左上、右上、右下、左下）
 * @param {object} [region] 只取標準圖的一小塊並放大，用來看邊角細節。
 *        {x, y, w, h} 以標準圖 (CARD_W×CARD_H) 為座標系，scale 為放大倍率。
 * @returns {ImageData|null}
 */
export function warp(srcCanvas, quad, region) {
  const r = region || { x: 0, y: 0, w: CARD_W, h: CARD_H, scale: 1 };
  const scale = r.scale || 1;
  const outW = Math.round(r.w * scale);
  const outH = Math.round(r.h * scale);

  // 標準圖四角 → 照片四角
  const H = solveHomography(
    [
      { x: 0, y: 0 },
      { x: CARD_W, y: 0 },
      { x: CARD_W, y: CARD_H },
      { x: 0, y: CARD_H },
    ],
    quad
  );
  if (!H) return null;

  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;

  const out = new ImageData(outW, outH);
  const od = out.data;
  const h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3];
  const h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7];

  // 用像素「中心」(ox+0.5) 而不是索引 ox 去對應原圖。
  // 差這半格的話，輸出會被拉伸 outW/(outW-1) 倍——聽起來微不足道，
  // 但在 1024px 的另一端就是 1.4px，換算成卡片是 0.12mm，剛好吃掉一個置中級距。
  for (let oy = 0; oy < outH; oy++) {
    const y = r.y + (oy + 0.5) / scale;
    for (let ox = 0; ox < outW; ox++) {
      const x = r.x + (ox + 0.5) / scale;
      const denom = h6 * x + h7 * y + 1;
      const u = (h0 * x + h1 * y + h2) / denom;
      const v = (h3 * x + h4 * y + h5) / denom;
      const o = (oy * outW + ox) * 4;

      // 雙線性取樣
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        od[o] = 0;
        od[o + 1] = 0;
        od[o + 2] = 0;
        od[o + 3] = 255;
        continue;
      }
      const fx = u - x0;
      const fy = v - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        od[o + c] =
          sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

/** 預設四邊形：畫面正中央、卡片比例、佔 78% 高。自動偵測失敗時的退路。 */
export function defaultQuad(w, h) {
  const ch = h * 0.78;
  const cw = Math.min(w * 0.86, ch * CARD_ASPECT);
  const x0 = (w - cw) / 2;
  const y0 = (h - ch) / 2;
  return [
    { x: x0, y: y0 },
    { x: x0 + cw, y: y0 },
    { x: x0 + cw, y: y0 + ch },
    { x: x0, y: y0 + ch },
  ];
}

/**
 * 自動偵測卡片四角：假設卡片放在與卡面顏色不同的背景上。
 * 一定會有失敗的時候，所以回傳值帶 confidence，讓 UI 提醒使用者手動微調。
 */
export function autoDetectQuad(srcCanvas) {
  const W = srcCanvas.width;
  const H = srcCanvas.height;
  const fallback = { quad: defaultQuad(W, H), confidence: 0, reason: 'auto-failed' };

  // 縮到 160px 寬再算，速度快且雜訊自然被平均掉
  const sw = 160;
  const sh = Math.max(1, Math.round((H / W) * sw));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(srcCanvas, 0, 0, sw, sh);
  const img = sctx.getImageData(0, 0, sw, sh);
  const d = img.data;

  // 背景色 = 照片外框一圈的中位數顏色
  const bg = borderMedianColor(d, sw, sh, 2);

  // 前景遮罩：跟背景差異夠大的像素
  const mask = new Uint8Array(sw * sh);
  let count = 0;
  for (let i = 0; i < sw * sh; i++) {
    const o = i * 4;
    const delta = Math.max(
      Math.abs(d[o] - bg[0]),
      Math.abs(d[o + 1] - bg[1]),
      Math.abs(d[o + 2] - bg[2])
    );
    if (delta > 45) {
      mask[i] = 1;
      count++;
    }
  }
  const ratio = count / (sw * sh);
  if (ratio < 0.08 || ratio > 0.97) return fallback; // 背景跟卡片分不開

  // 取最大連通區域，濾掉背景上的雜物
  const comp = largestComponent(mask, sw, sh);
  if (!comp || comp.size / (sw * sh) < 0.06) return fallback;

  // 從該區域找四個極值點當角落
  let tl = null, tr = null, br = null, bl = null;
  let tlV = Infinity, trV = -Infinity, brV = -Infinity, blV = Infinity;
  for (let k = 0; k < comp.pixels.length; k++) {
    const idx = comp.pixels[k];
    const x = idx % sw;
    const y = (idx / sw) | 0;
    const sum = x + y;
    const diff = x - y;
    if (sum < tlV) { tlV = sum; tl = { x: x, y: y }; }
    if (sum > brV) { brV = sum; br = { x: x, y: y }; }
    if (diff > trV) { trV = diff; tr = { x: x, y: y }; }
    if (diff < blV) { blV = diff; bl = { x: x, y: y }; }
  }
  if (!tl || !tr || !br || !bl) return fallback;

  const kx = W / sw;
  const ky = H / sh;
  let quad = [tl, tr, br, bl].map((p) => ({
    x: Math.min(W, Math.max(0, (p.x + 0.5) * kx)),
    y: Math.min(H, Math.max(0, (p.y + 0.5) * ky)),
  }));

  // 縮圖上的一個像素等於原圖好幾個像素，直接拿來量置中會系統性偏小。
  // 回到原圖把四邊貼齊真正的卡片邊緣。
  quad = refineQuad(srcCanvas, quad, Math.max(8, kx * 2.5));

  // 比例合理性檢查：寬高比應該接近 0.71
  const wAvg = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const hAvg = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  if (wAvg < 20 || hAvg < 20) return fallback;
  const aspect = wAvg / hAvg;
  const aspectErr = Math.abs(aspect - CARD_ASPECT) / CARD_ASPECT;

  let confidence = 1 - Math.min(1, aspectErr / 0.35);
  // 填滿度：卡片是矩形，最大連通區域應該幾乎填滿它的外接四邊形
  const fill = comp.size / Math.max(1, (wAvg / kx) * (hAvg / ky));
  if (fill < 0.75) confidence *= fill / 0.75;

  return {
    quad: quad,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: aspectErr > 0.35 ? 'aspect-off' : 'ok',
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 雙線性取樣，回傳 [r,g,b]。超出範圍回 null。 */
function sampleAt(sd, sw, sh, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) return null;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * sw + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + sw * 4;
  const i11 = i01 + 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy, w11 = fx * fy;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
  }
  return out;
}

/**
 * 全解析度精修四角。
 *
 * 粗偵測是在 160px 縮圖上做的，一個縮圖像素等於原圖好幾個像素，卡片邊緣會被吃掉
 * 零點幾 mm——而置中量的就是零點幾 mm 的差異，這個誤差不能留。
 *
 * 做法：沿著每一邊取樣多個點，在原圖上沿法線方向找「顏色變化最劇烈」的位置
 * （拋物線內插到次像素），再用總體最小平方法擬合成直線，最後四條線兩兩相交得角點。
 * 擬合能吃掉個別取樣點的誤判，比單獨修四個角穩得多。
 */
export function refineQuad(srcCanvas, quad, searchRadius) {
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;

  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  const shortSide = Math.min(
    dist(quad[0], quad[1]), dist(quad[1], quad[2]),
    dist(quad[2], quad[3]), dist(quad[3], quad[0])
  );
  const R = searchRadius || Math.max(6, Math.min(28, shortSide * 0.04));

  const SAMPLES = 17;
  const lines = [];

  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 8) return quad;

    // 邊的法線，方向朝向卡片中心
    let nx = -ey / len;
    let ny = ex / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }

    const pts = [];
    for (let s = 0; s < SAMPLES; s++) {
      // 只取中間 70%，圓角區的邊緣位置本來就不是直線
      const t = 0.15 + (0.7 * s) / (SAMPLES - 1);
      const px = a.x + ex * t;
      const py = a.y + ey * t;

      const prof = [];
      let maxG = 0;
      for (let d = -R; d <= R; d += 1) {
        const c1 = sampleAt(sd, sw, sh, px + nx * (d - 1), py + ny * (d - 1));
        const c2 = sampleAt(sd, sw, sh, px + nx * (d + 1), py + ny * (d + 1));
        if (!c1 || !c2) { prof.push(0); continue; }
        const g = Math.max(
          Math.abs(c2[0] - c1[0]), Math.abs(c2[1] - c1[1]), Math.abs(c2[2] - c1[2])
        );
        prof.push(g);
        if (g > maxG) maxG = g;
      }
      if (maxG < 18) continue; // 這條線上找不到明確的邊

      // 取「最外側」的邊，不是最強的那個。
      // 卡片拍得小的時候，黃框→藝術區的內緣落差比桌面→黃框的外緣還大，
      // 取最強會讓整條線黏到內框上，量出來的置中就完全錯了。
      const thresh = Math.max(18, maxG * 0.45);
      let bestT = null;
      for (let i = 1; i < prof.length - 1; i++) {
        if (prof[i] >= thresh && prof[i] > prof[i - 1] && prof[i] >= prof[i + 1]) {
          bestT = i - R;
          break;
        }
      }
      if (bestT === null) continue;

      // 拋物線內插求次像素峰值
      const i = bestT + R;
      let sub = bestT;
      if (i > 0 && i < prof.length - 1) {
        const y0 = prof[i - 1], y1 = prof[i], y2 = prof[i + 1];
        const denom = y0 - 2 * y1 + y2;
        if (Math.abs(denom) > 1e-6) {
          sub = bestT + (0.5 * (y0 - y2)) / denom;
        }
      }
      pts.push({ x: px + nx * sub, y: py + ny * sub });
    }

    if (pts.length < 6) return quad; // 精修不可靠，維持原本的框
    lines.push(fitLineRobust(pts));
  }

  const refined = [];
  for (let i = 0; i < 4; i++) {
    // 第 i 個角 = 第 i-1 條邊與第 i 條邊的交點
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return quad;
    // 精修不該把角點搬到天邊去，跑太遠就是出錯了
    if (dist(p, quad[i]) > R * 3) return quad;
    refined.push({
      x: Math.max(0, Math.min(sw, p.x)),
      y: Math.max(0, Math.min(sh, p.y)),
    });
  }
  return refined;
}

/**
 * 穩健版直線擬合：先擬合一次，把離群點丟掉再擬合一次。
 * 卡片邊上偶爾會有一兩個取樣點被陰影或髒污帶偏，一個離群點就足以讓角點跑掉好幾 px。
 */
function fitLineRobust(pts) {
  let line = fitLine(pts);
  const res = pts.map((p) => Math.abs(line.a * p.x + line.b * p.y - line.c));
  const m = median(res);
  const spread = Math.max(1.2, median(res.map((v) => Math.abs(v - m))) * 2.5);
  const kept = pts.filter((p, i) => Math.abs(res[i] - m) <= spread);
  if (kept.length >= 6 && kept.length < pts.length) line = fitLine(kept);
  return line;
}

/** 總體最小平方法擬合直線，回傳 {a,b,c}（ax+by=c，a²+b²=1）。 */
function fitLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length;
  my /= pts.length;

  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  // 最小特徵值對應的特徵向量就是法線方向
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const a = -Math.sin(theta);
  const b = Math.cos(theta);
  return { a: a, b: b, c: a * mx + b * my };
}

function intersect(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-9) return null; // 兩邊平行
  return {
    x: (l1.c * l2.b - l2.c * l1.b) / det,
    y: (l1.a * l2.c - l2.a * l1.c) / det,
  };
}

/** 用洪水填充找最大的連通區域（4 連通）。 */
function largestComponent(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null;

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const pixels = [];
    while (sp > 0) {
      const idx = stack[--sp];
      pixels.push(idx);
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && mask[idx - w] && !seen[idx - w]) { seen[idx - w] = 1; stack[sp++] = idx - w; }
      if (y < h - 1 && mask[idx + w] && !seen[idx + w]) { seen[idx + w] = 1; stack[sp++] = idx + w; }
    }
    if (!best || pixels.length > best.size) best = { size: pixels.length, pixels: pixels };
  }
  return best;
}

/** 影像最外圈的中位數顏色。 */
export function borderMedianColor(data, w, h, thickness) {
  const rs = [], gs = [], bs = [];
  const push = (x, y) => {
    const o = (y * w + x) * 4;
    rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
  };
  for (let t = 0; t < thickness; t++) {
    for (let x = 0; x < w; x++) { push(x, t); push(x, h - 1 - t); }
    for (let y = 0; y < h; y++) { push(t, y); push(w - 1 - t, y); }
  }
  return [median(rs), median(gs), median(bs)];
}

export function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 中位數絕對離差，用來判斷量測結果穩不穩。 */
export function mad(arr) {
  if (!arr.length) return 0;
  const m = median(arr);
  return median(arr.map((v) => Math.abs(v - m)));
}

/** 通道最大差，比歐氏距離更能抓到單一通道的劇變（黃框→藍圖）。 */
export function colorDelta(d, offset, c) {
  return Math.max(
    Math.abs(d[offset] - c[0]),
    Math.abs(d[offset + 1] - c[1]),
    Math.abs(d[offset + 2] - c[2])
  );
}

/** 把 ImageData 畫成 canvas，方便顯示。 */
export function imageDataToCanvas(imgData) {
  const c = document.createElement('canvas');
  c.width = imgData.width;
  c.height = imgData.height;
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c;
}
