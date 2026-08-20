// 拍照輸入與四角框選 UI。
//
// 為什麼用 <input capture> 而不是 getUserMedia：
//   1. getUserMedia 需要 HTTPS，區網測試（http://192.168.x.x）用不了
//   2. 原生相機 App 給的是全解析度照片，對之後看邊角磨白很重要
//
// 四角一定要能手動拖：自動偵測在深色卡、深色桌面、有陰影時必定失敗，
// 手動微調是保證能用的底線。

import { autoDetectQuad } from './imageutil.js';

const HANDLE_HIT = 48;   // 手指判定半徑（device px），比視覺上的點大很多
const HANDLE_R = 13;     // 角落圓點視覺半徑
const LOUPE_R = 78;      // 放大鏡半徑
const LOUPE_ZOOM = 5;    // 放大倍率

export class CornerAdjuster {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.src = null;
    this.quad = null;
    this.active = -1;
    this.pointerPos = null;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onResize = this._onResize.bind(this);

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    window.removeEventListener('resize', this._onResize);
  }

  setImage(srcCanvas, quad) {
    this.src = srcCanvas;
    this.quad = quad.map((p) => ({ x: p.x, y: p.y }));
    this._resizeBacking();
    this.draw();
  }

  getQuad() {
    return this.quad.map((p) => ({ x: p.x, y: p.y }));
  }

  autoDetect() {
    if (!this.src) return null;
    const res = autoDetectQuad(this.src);
    this.quad = res.quad;
    this.draw();
    return res;
  }

  _resizeBacking() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  _onResize() {
    if (!this.src) return;
    this._resizeBacking();
    this.draw();
  }

  /** 影像座標 → 畫布座標的縮放與位移（等比置中） */
  _fit() {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const scale = Math.min(cw / this.src.width, ch / this.src.height);
    return {
      scale: scale,
      offX: (cw - this.src.width * scale) / 2,
      offY: (ch - this.src.height * scale) / 2,
    };
  }

  _toCanvasPos(evt) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left) * (this.canvas.width / rect.width),
      y: (evt.clientY - rect.top) * (this.canvas.height / rect.height),
    };
  }

  _onDown(evt) {
    if (!this.src) return;
    const p = this._toCanvasPos(evt);
    const f = this._fit();
    let best = -1;
    let bestD = HANDLE_HIT;
    for (let i = 0; i < 4; i++) {
      const cx = this.quad[i].x * f.scale + f.offX;
      const cy = this.quad[i].y * f.scale + f.offY;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    this.active = best;
    this.pointerPos = p;
    this.canvas.setPointerCapture(evt.pointerId);
    evt.preventDefault();
    this.draw();
  }

  _onMove(evt) {
    if (this.active < 0) return;
    const p = this._toCanvasPos(evt);
    const f = this._fit();
    // 手指位置往上偏一點，不然角點被指頭蓋住看不到
    const lift = 26;
    const ix = (p.x - f.offX) / f.scale;
    const iy = (p.y - lift - f.offY) / f.scale;
    this.quad[this.active] = {
      x: Math.max(0, Math.min(this.src.width, ix)),
      y: Math.max(0, Math.min(this.src.height, iy)),
    };
    this.pointerPos = p;
    evt.preventDefault();
    this.draw();
  }

  _onUp(evt) {
    if (this.active < 0) return;
    this.active = -1;
    this.pointerPos = null;
    try { this.canvas.releasePointerCapture(evt.pointerId); } catch (e) { /* 已釋放 */ }
    this.draw();
  }

  draw() {
    if (!this.src) return;
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const f = this._fit();

    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#0b0d13';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(this.src, f.offX, f.offY, this.src.width * f.scale, this.src.height * f.scale);

    const pts = this.quad.map((p) => ({
      x: p.x * f.scale + f.offX,
      y: p.y * f.scale + f.offY,
    }));

    // 四邊形以外壓暗，視線集中在卡片上
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 8, 14, 0.62)';
    ctx.fill('evenodd');
    ctx.restore();

    // 邊線
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = '#2ecc96';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 角點
    for (let i = 0; i < 4; i++) {
      const isActive = i === this.active;
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, isActive ? HANDLE_R + 5 : HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#2ecc96' : 'rgba(46, 204, 150, 0.85)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#0b0d13';
      ctx.stroke();
    }

    if (this.active >= 0) this._drawLoupe(pts[this.active]);
  }

  /** 放大鏡：手指按著時顯示角點附近的放大畫面，讓使用者對得準卡片邊緣。 */
  _drawLoupe(activePt) {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const f = this._fit();
    const q = this.quad[this.active];

    // 放到離手指最遠的上方角落，避免被手蓋住
    const margin = 16;
    const lx = activePt.x < cw / 2 ? cw - LOUPE_R - margin : LOUPE_R + margin;
    const ly = LOUPE_R + margin;

    const half = LOUPE_R / LOUPE_ZOOM / f.scale; // 對應到原圖的半徑
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, LOUPE_R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = '#0b0d13';
    ctx.fillRect(lx - LOUPE_R, ly - LOUPE_R, LOUPE_R * 2, LOUPE_R * 2);
    ctx.drawImage(
      this.src,
      q.x - half, q.y - half, half * 2, half * 2,
      lx - LOUPE_R, ly - LOUPE_R, LOUPE_R * 2, LOUPE_R * 2
    );
    // 十字準星
    ctx.strokeStyle = 'rgba(46, 204, 150, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(lx - LOUPE_R, ly); ctx.lineTo(lx + LOUPE_R, ly);
    ctx.moveTo(lx, ly - LOUPE_R); ctx.lineTo(lx, ly + LOUPE_R);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(lx, ly, LOUPE_R, 0, Math.PI * 2);
    ctx.strokeStyle = '#2ecc96';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}
