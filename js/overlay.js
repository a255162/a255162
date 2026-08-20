// 把量測結果直接畫在標準卡片圖上。
// 數字光用文字列出來很難判斷對錯，畫在卡上使用者一眼就能看出框有沒有抓歪。

import { PX_PER_MM } from './grade.js';

const GREEN = '#2ecc96';
const AMBER = '#f0be28';
const FONT_SIZE = 30;
const PAD = 8;

/**
 * @param {HTMLCanvasElement} canvas 目標畫布
 * @param {HTMLCanvasElement} stdCanvas 標準卡片圖
 * @param {object} result measureCentering() 的回傳值
 */
export function drawCenteringOverlay(canvas, stdCanvas, result) {
  const w = stdCanvas.width;
  const h = stdCanvas.height;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(stdCanvas, 0, 0);

  if (!result || !result.ok) return;

  const m = result.margins;
  const inner = result.innerRect;

  // 偵測到的內框
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 3;
  ctx.strokeRect(inner.x, inner.y, inner.w, inner.h);

  // 完美置中時內框該在的位置（虛線），跟實線的落差就是偏移量
  const idealX = (m.left + m.right) / 2;
  const idealY = (m.top + m.bottom) / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 12]);
  ctx.strokeRect(idealX, idealY, inner.w, inner.h);
  ctx.setLineDash([]);

  // 四邊的量測線
  const midY = h / 2;
  const midX = w / 2;
  measureLine(ctx, 0, midY, m.left, midY, true);
  measureLine(ctx, w - m.right, midY, w, midY, true);
  measureLine(ctx, midX, 0, midX, m.top, false);
  measureLine(ctx, midX, h - m.bottom, midX, h, false);

  // 標籤一律往卡片內側放：邊寬只有 40~55px，110px 寬的標籤放在邊上一定會被畫布切掉。
  const mm = (px) => (px / PX_PER_MM).toFixed(2) + 'mm';
  label(ctx, w, h, m.left + 12, midY - 44, mm(m.left), 'left', 'middle');
  label(ctx, w, h, w - m.right - 12, midY - 44, mm(m.right), 'right', 'middle');
  label(ctx, w, h, midX, m.top / 2, mm(m.top), 'center', 'middle');
  label(ctx, w, h, midX, h - m.bottom / 2, mm(m.bottom), 'center', 'middle');

  // 比例摘要放在藝術區左上角，跟上邊的標籤（置中在上緣）錯開
  const lr = Math.round(result.lr.a) + '/' + Math.round(result.lr.b);
  const tb = Math.round(result.tb.a) + '/' + Math.round(result.tb.b);
  label(ctx, w, h, m.left + 12, m.top + 34, '左右 ' + lr + '　上下 ' + tb, 'left', 'middle');
}

function measureLine(ctx, x1, y1, x2, y2, horizontal) {
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // 端點小橫槓，標示量測的起訖
  const cap = 9;
  ctx.beginPath();
  if (horizontal) {
    ctx.moveTo(x1, y1 - cap); ctx.lineTo(x1, y1 + cap);
    ctx.moveTo(x2, y2 - cap); ctx.lineTo(x2, y2 + cap);
  } else {
    ctx.moveTo(x1 - cap, y1); ctx.lineTo(x1 + cap, y1);
    ctx.moveTo(x2 - cap, y2); ctx.lineTo(x2 + cap, y2);
  }
  ctx.stroke();
}

/** 畫帶底色的文字標籤，並確保整塊都留在畫布內（超出就往內推）。 */
function label(ctx, cw, ch, x, y, text, align, baseline) {
  ctx.font = '600 ' + FONT_SIZE + 'px system-ui, -apple-system, "Noto Sans TC", sans-serif';
  const tw = ctx.measureText(text).width;
  const boxW = tw + PAD * 2;
  const boxH = FONT_SIZE + PAD * 2;

  let bx;
  if (align === 'center') bx = x - boxW / 2;
  else if (align === 'right') bx = x - boxW;
  else bx = x;

  let by = baseline === 'middle' ? y - boxH / 2 : y;

  // 貼齊畫布邊界，寧可位置偏一點也不要被切掉看不見數字
  bx = Math.max(2, Math.min(cw - boxW - 2, bx));
  by = Math.max(2, Math.min(ch - boxH - 2, by));

  ctx.fillStyle = 'rgba(8, 10, 16, 0.85)';
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + PAD, by + boxH / 2);
}
