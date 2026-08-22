// 拍照認卡：把拍到的卡片算成「影像指紋」，跟預先算好的卡片指紋庫比對。
//
// 為什麼不是把幾萬張卡圖下載到手機比對：一張縮圖 15KB，五萬張就是 0.7GB。
// 但指紋每張只要 66 bytes——整個繁中卡庫（8,980 張）壓成不到 600KB，
// 下載一次存起來，之後拍照完全離線就能認。
//
// 指紋由兩部分組成：
//   1. dHash（240 bit）：把卡縮成 16×16 灰階，比較左右相鄰像素誰亮。
//      比的是「亮度變化的方向」而不是絕對亮度，所以光線明暗、曝光高低都不影響。
//   2. 色彩網格（3×4 格的平均 RGB）：寶可夢卡的屬性色是很強的線索。
//      比對前會先做灰階世界白平衡，抵銷偏黃的室內燈或偏藍的日光。
//
// 兩者都算完後加權相加，dHash 佔七成五——結構比顏色可靠，
// 因為相機的色彩還原差異遠大於結構差異。

export const HASH_W = 16;
export const HASH_H = 16;
export const DHASH_BITS = (HASH_W - 1) * HASH_H; // 240
export const DHASH_BYTES = DHASH_BITS / 8;       // 30
export const COLOR_COLS = 3;
export const COLOR_ROWS = 4;
export const COLOR_BYTES = COLOR_COLS * COLOR_ROWS * 3; // 36
export const FP_BYTES = DHASH_BYTES + COLOR_BYTES;      // 66

/**
 * 從一張卡片圖（已裁到卡片邊緣的 canvas 或 ImageData）算出指紋。
 * @returns {Uint8Array} 長度 FP_BYTES
 */
export function fingerprint(source) {
  const canvas = toCanvas(source);
  const fp = new Uint8Array(FP_BYTES);

  // --- dHash ---
  const g = downscaleGray(canvas, HASH_W, HASH_H);
  let bit = 0;
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      const a = g[y * HASH_W + x];
      const b = g[y * HASH_W + x + 1];
      if (a > b) fp[bit >> 3] |= 1 << (bit & 7);
      bit++;
    }
  }

  // --- 色彩網格 ---
  const grid = downscaleRGB(canvas, COLOR_COLS, COLOR_ROWS);
  grayWorld(grid);
  for (let i = 0; i < grid.length; i++) {
    fp[DHASH_BYTES + i] = Math.max(0, Math.min(255, Math.round(grid[i])));
  }
  return fp;
}

function toCanvas(source) {
  if (source instanceof HTMLCanvasElement) return source;
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  c.getContext('2d').putImageData(source, 0, 0);
  return c;
}

/**
 * 面積平均縮放。輸出每一格 = 對應到來源那塊矩形範圍內所有像素的加權平均，
 * 邊界只蓋到一半的像素就只算一半。
 *
 * 為什麼不用 canvas 的 drawImage 縮放：指紋庫是 Python 建的、查詢是瀏覽器算的，
 * 兩邊的縮放演算法不一樣（PIL BOX vs 瀏覽器各自的實作），同一張圖算出來的
 * 指紋距離會到 0.10——而兩張**不同**卡最近才差 0.17，這樣真實照片一失真就會認錯。
 * 自己寫成明確的算術，兩邊才會得到一樣的結果。
 *
 * @returns {Float32Array} 長度 dw*dh*3 的 RGB
 */
function areaResize(canvas, dw, dh) {
  const sw = canvas.width;
  const sh = canvas.height;
  const src = canvas
    .getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, sw, sh).data;
  const out = new Float32Array(dw * dh * 3);

  for (let oy = 0; oy < dh; oy++) {
    const fy0 = (oy * sh) / dh;
    const fy1 = ((oy + 1) * sh) / dh;
    const iy0 = Math.floor(fy0);
    const iy1 = Math.min(sh - 1, Math.ceil(fy1) - 1);

    for (let ox = 0; ox < dw; ox++) {
      const fx0 = (ox * sw) / dw;
      const fx1 = ((ox + 1) * sw) / dw;
      const ix0 = Math.floor(fx0);
      const ix1 = Math.min(sw - 1, Math.ceil(fx1) - 1);

      let r = 0, g = 0, bl = 0, wsum = 0;
      for (let y = iy0; y <= iy1; y++) {
        const wy = Math.min(y + 1, fy1) - Math.max(y, fy0);
        if (wy <= 0) continue;
        for (let x = ix0; x <= ix1; x++) {
          const wx = Math.min(x + 1, fx1) - Math.max(x, fx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (y * sw + x) * 4;
          r += src[o] * w;
          g += src[o + 1] * w;
          bl += src[o + 2] * w;
          wsum += w;
        }
      }
      const o = (oy * dw + ox) * 3;
      if (wsum > 0) {
        out[o] = r / wsum;
        out[o + 1] = g / wsum;
        out[o + 2] = bl / wsum;
      }
    }
  }
  return out;
}

/** 縮到 w×h 的灰階陣列。 */
function downscaleGray(canvas, w, h) {
  const rgb = areaResize(canvas, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = rgb[i * 3] * 0.299 + rgb[i * 3 + 1] * 0.587 + rgb[i * 3 + 2] * 0.114;
  }
  return out;
}

/** 縮到 cols×rows 並回傳 RGB 陣列（長度 cols*rows*3）。 */
function downscaleRGB(canvas, cols, rows) {
  return areaResize(canvas, cols, rows);
}

/**
 * 灰階世界白平衡：假設整張圖的平均應該是灰的，把三個通道各自拉到同一個平均。
 * 室內黃燈拍出來整張偏黃、日光燈偏藍，不校正的話顏色比對會完全失準。
 */
function grayWorld(grid) {
  let sr = 0, sg = 0, sb = 0;
  const n = grid.length / 3;
  for (let i = 0; i < n; i++) {
    sr += grid[i * 3];
    sg += grid[i * 3 + 1];
    sb += grid[i * 3 + 2];
  }
  const mr = sr / n, mg = sg / n, mb = sb / n;
  const mean = (mr + mg + mb) / 3;
  if (mr < 1 || mg < 1 || mb < 1) return;
  const kr = mean / mr, kg = mean / mg, kb = mean / mb;
  for (let i = 0; i < n; i++) {
    grid[i * 3] *= kr;
    grid[i * 3 + 1] *= kg;
    grid[i * 3 + 2] *= kb;
  }
}

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];
}

/** 兩個指紋的距離，0 = 完全一樣，1 = 完全不像。 */
export function fpDistance(a, aOff, b, bOff) {
  let bits = 0;
  for (let i = 0; i < DHASH_BYTES; i++) {
    bits += POPCOUNT[a[aOff + i] ^ b[bOff + i]];
  }
  const structural = bits / DHASH_BITS;

  let colorSum = 0;
  for (let i = DHASH_BYTES; i < FP_BYTES; i++) {
    colorSum += Math.abs(a[aOff + i] - b[bOff + i]);
  }
  const color = colorSum / (COLOR_BYTES * 255);

  // 結構為主：相機的色彩還原差異遠大於結構差異
  return structural * 0.75 + color * 0.25;
}

/**
 * 在指紋庫裡找最像的幾張。
 *
 * @param {Uint8Array} query 查詢指紋
 * @param {{data: Uint8Array, ids: string[]}} db 指紋庫
 * @param {number} topN
 * @returns {Array<{id, index, distance}>}
 */
export function findMatches(query, db, topN) {
  const n = db.ids.length;
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push({ index: i, distance: fpDistance(query, 0, db.data, i * FP_BYTES) });
  }
  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, topN || 5).map((r) => ({
    id: db.ids[r.index],
    name: db.names ? db.names[r.index] : '',
    index: r.index,
    distance: r.distance,
  }));
}

/**
 * 卡片可能拍成上下顛倒，兩個方向都試，取比較像的那一組。
 * @param {HTMLCanvasElement} canvas 已校正的標準卡片圖
 */
export function matchCard(canvas, db, topN) {
  const upright = fingerprint(canvas);
  const flipped = fingerprint(rotate180(canvas));

  const a = findMatches(upright, db, topN);
  const b = findMatches(flipped, db, topN);
  const best = (a[0] ? a[0].distance : 1) <= (b[0] ? b[0].distance : 1) ? a : b;
  best.rotated = best === b;
  return best;
}

// 查詢時要試的縮放比例（以偵測到的四邊形為基準，>1 表示往外擴）。
//
// 為什麼需要這個：實測真卡照片時，邊界偵測會把四邊都往內縮 4~7%——真卡的圖案
// 細節太多，自適應門檻被拉高，卡片自己的外緣反而不算「強邊」。框差這麼多，
// 指紋距離就從 0.02 掉到 0.12，跟不同卡最近的 0.16 已經很接近，辨識率只剩七成。
//
// 與其要求偵測每張都完美，不如查詢時多試幾個比例——反正比對一次只要幾毫秒。
const QUERY_SCALES = [1.0, 1.04, 1.08, 1.12, 0.96];

// 指紋只需要 16×16，校正成全尺寸是浪費。0.334 倍約等於 245×342，
// 跟指紋庫用的官方縮圖（245×337）解析度相當。
const QUERY_WARP = { x: 0, y: 0, w: 734, h: 1024, scale: 0.334 };

/** 以四邊形的中心為原點縮放。 */
function scaleQuad(quad, f) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  return quad.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }));
}

/**
 * 從原始照片與偵測到的四邊形直接比對——會自動試多種縮放與上下顛倒。
 *
 * @param {HTMLCanvasElement} srcCanvas 原始照片
 * @param {Array<{x,y}>} quad 偵測到的卡片四角
 * @param {object} db 指紋庫
 * @param {object} deps { warp, imageDataToCanvas } 由 imageutil 傳進來，避免循環相依
 * @returns {Array} 候選清單，附帶 usedScale / rotated
 */
export function matchFromPhoto(srcCanvas, quad, db, deps, topN) {
  let best = null;
  for (const f of QUERY_SCALES) {
    const q = f === 1 ? quad : scaleQuad(quad, f);
    // 校正成跟官方卡圖差不多的解析度就好（245×337）。
    // 指紋最後只用到 16×16，校正成 734×1024 純粹浪費——實測從 618ms 降到一百多毫秒，
    // 而且解析度跟指紋庫的來源一致，縮放造成的差異更小。
    const imgData = deps.warp(srcCanvas, q, QUERY_WARP);
    if (!imgData) continue;
    const canvas = deps.imageDataToCanvas(imgData);
    const res = matchCard(canvas, db, topN || 5);
    if (!res.length) continue;
    if (!best || res[0].distance < best[0].distance) {
      best = res;
      best.usedScale = f;
      best.rotated = !!res.rotated;
      best.standardCanvas = canvas;
    }
  }
  return best || [];
}

function rotate180(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, c.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(canvas, 0, 0);
  return c;
}
