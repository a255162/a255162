// 即時取景相機：邊看邊自動框卡片，穩定就自動拍。
//
// 為什麼要自己開相機而不是叫系統相機（<input capture>）：
//   1. 補燈：只有拿得到 MediaStreamTrack 才能開手機的閃光燈當持續光源
//   2. 即時回饋：使用者馬上看到框有沒有抓到，不用拍完才發現要重拍
//   3. 光線與影子檢查：在按下快門前就能提醒「太暗」「有影子」
//
// getUserMedia 需要 HTTPS。區網 http 測試時會失敗，所以一定要保留
// <input capture> 這條退路。

import { detectCardQuad } from './detect.js';
import { CARD_ASPECT } from './imageutil.js';

const DETECT_INTERVAL = 260;   // 每隔多久跑一次偵測（毫秒）
const STABLE_FRAMES = 4;       // 連續幾次框都差不多才算穩定
const STABLE_TOL = 0.02;       // 角點位移小於畫面短邊的幾 % 算沒動

export class LiveCamera {
  constructor(videoEl, overlayEl) {
    this.video = videoEl;
    this.overlay = overlayEl;
    this.stream = null;
    this.track = null;
    this.timer = null;
    this.lastQuad = null;
    this.stableCount = 0;
    this.detecting = false;
    this.frameCanvas = document.createElement('canvas');
    this.onUpdate = null;      // (info) => void
    this.onAutoShot = null;    // (canvas) => void
    this.autoShoot = true;
    this.torchOn = false;
    this.showGuide = false;  // 認卡模式打開，量置中模式不需要
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('這個瀏覽器不支援即時相機');
    }
    // 解析度開高一點，邊角細節才留得住；拿不到就讓瀏覽器自己決定
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play();

    this.loop();
    return {
      settings: this.track.getSettings ? this.track.getSettings() : {},
      torch: this.hasTorch(),
    };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.track = null;
    }
    this.video.srcObject = null;
    this.lastQuad = null;
    this.stableCount = 0;
  }

  /** 手機閃光燈能不能當持續光源。iOS Safari 目前不支援。 */
  hasTorch() {
    if (!this.track || !this.track.getCapabilities) return false;
    const caps = this.track.getCapabilities();
    return !!(caps && caps.torch);
  }

  async setTorch(on) {
    if (!this.hasTorch()) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 把目前這一幀畫成 canvas（原生解析度）。 */
  grabFrame(maxW) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = maxW ? Math.min(1, maxW / vw) : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(vw * scale);
    c.height = Math.round(vh * scale);
    c.getContext('2d', { willReadFrequently: true }).drawImage(this.video, 0, 0, c.width, c.height);
    return c;
  }

  loop() {
    const tick = async () => {
      if (!this.stream) return;
      if (!this.detecting) {
        this.detecting = true;
        try {
          await this.analyzeFrame();
        } catch (err) {
          /* 單幀失敗不要停掉整個迴圈 */
        }
        this.detecting = false;
      }
      this.timer = setTimeout(tick, DETECT_INTERVAL);
    };
    this.timer = setTimeout(tick, 300);
  }

  async analyzeFrame() {
    // 預覽用小圖就好，按快門時才用全解析度
    const frame = this.grabFrame(640);
    if (!frame) return;

    const det = detectCardQuad(frame, { fast: true });
    const light = analyzeLight(frame, det.quad);

    // 換算到顯示座標並畫出來
    this.drawOverlay(det, frame);

    // 穩定度：框有沒有停下來
    const shortSide = Math.min(frame.width, frame.height);
    if (this.lastQuad && det.confidence > 0.7) {
      const moved = Math.max(
        ...det.quad.map((p, i) => Math.hypot(p.x - this.lastQuad[i].x, p.y - this.lastQuad[i].y))
      );
      if (moved < shortSide * STABLE_TOL) this.stableCount++;
      else this.stableCount = 0;
    } else {
      this.stableCount = 0;
    }
    this.lastQuad = det.quad;

    const ready = det.confidence > 0.7 && !light.tooDark && !light.shadow;
    const info = {
      confidence: det.confidence,
      suspectInner: det.suspectInner,
      light: light,
      stable: this.stableCount,
      ready: ready,
    };
    if (this.onUpdate) this.onUpdate(info);

    if (this.autoShoot && ready && this.stableCount >= STABLE_FRAMES) {
      this.stableCount = 0;
      const full = this.grabFrame(2000);
      if (full && this.onAutoShot) this.onAutoShot(full);
    }
  }

  /**
   * 對齊框：畫面上固定的卡片形狀外框，使用者把卡片對進去。
   *
   * 為什麼需要它：實測真卡照片時，自動偵測的辨識率只有 81%——真卡的藝術圖
   * 會把找邊的演算法騙進黃框內緣。但只要使用者把卡片對進框裡（就算歪個 4%），
   * 辨識率是 100%。與其追求偵測完美，不如讓使用者花一秒鐘對準。
   *
   * 回傳的是「原始影像座標」的四個角，可以直接餵給 warp()。
   */
  getGuideQuad(frameW, frameH) {
    const rect = this.overlay.getBoundingClientRect();
    const dispW = rect.width || 1;
    const dispH = rect.height || 1;
    // video 是 object-fit: cover，畫面只看得到影像的一部分
    const s = Math.max(dispW / frameW, dispH / frameH);
    const visW = dispW / s;
    const visH = dispH / s;

    let gh = visH * 0.82;
    let gw = gh * CARD_ASPECT;
    if (gw > visW * 0.92) {
      gw = visW * 0.92;
      gh = gw / CARD_ASPECT;
    }
    const cx = frameW / 2;
    const cy = frameH / 2;
    return [
      { x: cx - gw / 2, y: cy - gh / 2 },
      { x: cx + gw / 2, y: cy - gh / 2 },
      { x: cx + gw / 2, y: cy + gh / 2 },
      { x: cx - gw / 2, y: cy + gh / 2 },
    ];
  }

  drawOverlay(det, frame) {
    const cv = this.overlay;
    const rect = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // video 以 object-fit: cover 顯示，畫面會被裁掉一部分，換算要跟著做
    const vw = frame.width, vh = frame.height;
    const scale = Math.max(w / vw, h / vh);
    const offX = (w - vw * scale) / 2;
    const offY = (h - vh * scale) / 2;
    const toDisp = (p) => ({ x: p.x * scale + offX, y: p.y * scale + offY });

    // 對齊框：使用者把卡片對進這個框就好，這是最可靠的取景方式
    if (this.showGuide) {
      const g = this.getGuideQuad(vw, vh).map(toDisp);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.moveTo(g[0].x, g[0].y);
      for (let i = 3; i >= 1; i--) ctx.lineTo(g[i].x, g[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(6, 8, 14, 0.45)';
      ctx.fill('evenodd');
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([]);
      // 只畫四個角，中間留空比較不擋視線
      const corner = Math.min(
        Math.hypot(g[1].x - g[0].x, g[1].y - g[0].y),
        Math.hypot(g[3].x - g[0].x, g[3].y - g[0].y)
      ) * 0.18;
      const seg = [[0,1],[1,2],[2,3],[3,0]];
      for (const [a, b2] of seg) {
        const A = g[a], B = g[b2];
        const len = Math.hypot(B.x - A.x, B.y - A.y);
        const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y); ctx.lineTo(A.x + ux * corner, A.y + uy * corner);
        ctx.moveTo(B.x, B.y); ctx.lineTo(B.x - ux * corner, B.y - uy * corner);
        ctx.stroke();
      }
    }

    if (!det || det.confidence < 0.35) return;
    const pts = det.quad.map(toDisp);

    const good = det.confidence >= 0.7 && !det.suspectInner;
    ctx.strokeStyle = good ? '#2ecc96' : '#f0be28';
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = good ? 'rgba(46,204,150,0.12)' : 'rgba(240,190,40,0.10)';
    ctx.fill();

    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = good ? '#2ecc96' : '#f0be28';
      ctx.fill();
    }
  }
}

/**
 * 光線檢查：太暗、過曝、以及卡片上有沒有明顯影子。
 *
 * 影子的判準是「卡片範圍內的亮度差距太大」。單純看整體亮度不夠——
 * 一半亮一半暗的卡，平均起來可能剛剛好，但那正是最該提醒重拍的情況。
 */
export function analyzeLight(frameCanvas, quad) {
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
  const d = img.data;
  const w = img.width, h = img.height;

  // 只看卡片範圍（用四邊形的外接矩形，夠用了）
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  if (quad && quad.length === 4) {
    for (const p of quad) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(w, Math.round(x1)); y1 = Math.min(h, Math.round(y1));
  if (x1 - x0 < 20 || y1 - y0 < 20) { x0 = 0; y0 = 0; x1 = w; y1 = h; }

  // 切成 4x4 區塊，各自算平均亮度
  const GRID = 4;
  const cells = [];
  let sum = 0, n = 0, over = 0;
  const cw = (x1 - x0) / GRID, ch = (y1 - y0) / GRID;

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let cs = 0, cn = 0;
      const sx0 = Math.round(x0 + gx * cw), sx1 = Math.round(x0 + (gx + 1) * cw);
      const sy0 = Math.round(y0 + gy * ch), sy1 = Math.round(y0 + (gy + 1) * ch);
      for (let y = sy0; y < sy1; y += 2) {
        for (let x = sx0; x < sx1; x += 2) {
          const o = (y * w + x) * 4;
          const lum = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
          cs += lum; cn++;
          sum += lum; n++;
          if (lum > 250) over++;
        }
      }
      if (cn) cells.push(cs / cn);
    }
  }

  const mean = n ? sum / n : 0;
  const cmin = cells.length ? Math.min(...cells) : 0;
  const cmax = cells.length ? Math.max(...cells) : 0;
  // 相對落差：暗的地方只有亮的地方的幾成
  const ratio = cmax > 1 ? cmin / cmax : 1;
  const overFrac = n ? over / n : 0;

  return {
    mean: mean,
    tooDark: mean < 55,
    dim: mean < 90,
    overexposed: overFrac > 0.06,
    shadow: ratio < 0.55,     // 區塊間亮度差一半以上，幾乎都是影子
    evenness: ratio,
  };
}

/** 給畫面用的一句話建議。回傳 null 表示目前狀況沒問題。 */
export function lightAdvice(light, torchAvailable) {
  if (!light) return null;
  if (light.tooDark) {
    return torchAvailable
      ? { level: 'warn', text: '光線太暗，按下方的💡補燈' }
      : { level: 'warn', text: '光線太暗，請找亮一點的地方或開燈' };
  }
  if (light.shadow) {
    return { level: 'warn', text: '卡片上有影子，把手機或手移開擋光處，或改用側面光' };
  }
  if (light.overexposed) {
    return { level: 'warn', text: '反光太強，換個角度或關掉補燈' };
  }
  if (light.dim) {
    return { level: 'hint', text: '有點暗，補個燈會更準' };
  }
  return null;
}
