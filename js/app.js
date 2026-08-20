// 分頁切換、鑑定流程串接、PWA 安裝與快取管理。

import { loadImageFile, warp, imageDataToCanvas, CARD_W, CARD_H } from './imageutil.js';
import { detectCardQuad } from './detect.js';
import { LiveCamera, lightAdvice } from './camera.js';
import { CornerAdjuster } from './capture.js';
import { measureCentering, ratioText, scoreLabel } from './grade.js';
import { drawCenteringOverlay } from './overlay.js';
import { initIdentify } from './identify.js';
import { cacheCount, cacheClear } from './db.js';

const VERSION = '辨識查價 + 置中量測 (2026-08-20)';

const state = {
  src: null,      // 原始照片 canvas
  quad: null,     // 使用者確認的四角
  std: null,      // 標準卡片圖 canvas
  result: null,   // 量測結果
  adjuster: null,
};

const $ = (id) => document.getElementById(id);

// ===== 分頁 =====
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === 'panel-' + name);
  });
  window.scrollTo(0, 0);
}

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    // 離開這一頁就關鏡頭，不然背景一直開著很耗電
    if (b.dataset.tab !== 'grade') closeCamera();
    showTab(b.dataset.tab);
  });
});

// ===== 步驟 =====
function showStep(id) {
  document.querySelectorAll('#panel-grade .step').forEach((s) => {
    s.classList.toggle('active', s.id === id);
  });
  window.scrollTo(0, 0);
}

function busy(on, text) {
  const el = $('busy');
  if (text) $('busy-text').textContent = text;
  el.hidden = !on;
}

/**
 * 讓瀏覽器有機會把忙碌畫面畫出來，再跑吃 CPU 的運算。
 *
 * 這裡刻意不用 requestAnimationFrame：分頁被切到背景時 rAF 根本不會觸發，
 * 使用者按下分析後切去看個訊息回來，就會永遠卡在轉圈圈。setTimeout 在背景仍會跑。
 */
function nextFrame() {
  return new Promise((r) => setTimeout(r, 16));
}

// ===== 拍照 =====

/** 拿到一張照片之後的共同流程：偵測四角 → 進框選畫面。 */
async function useImage(srcCanvas) {
  state.src = srcCanvas;
  state.std = null;
  state.result = null;

  showStep('step-adjust');
  if (!state.adjuster) state.adjuster = new CornerAdjuster($('adjust-canvas'));

  const det = detectCardQuad(state.src);
  state.detConfidence = det.confidence;
  state.adjuster.setImage(state.src, det.quad);
  showDetectNotice(det);
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  busy(true, '讀取照片…');
  try {
    await nextFrame();
    await useImage(await loadImageFile(file));
  } catch (err) {
    alert('讀不到這張照片：' + err.message);
    showStep('step-capture');
  } finally {
    busy(false);
    e.target.value = ''; // 清掉才能重拍同一個檔名
  }
});

// ===== 即時取景 =====
let cam = null;

async function openCamera() {
  if (!cam) cam = new LiveCamera($('cam-video'), $('cam-overlay'));
  try {
    const info = await cam.start();
    $('cam-wrap').hidden = false;
    $('cam-idle').hidden = true;
    $('btn-torch').hidden = !info.torch;

    cam.onUpdate = (i) => {
      const advice = lightAdvice(i.light, cam.hasTorch());
      const el = $('cam-advice');
      const shutter = $('btn-shutter');
      if (advice) {
        el.className = 'cam-advice show ' + advice.level;
        el.textContent = advice.text;
      } else if (i.suspectInner) {
        el.className = 'cam-advice show warn';
        el.textContent = '框可能只抓到卡面內框，拍完請確認四個角';
      } else if (i.confidence < 0.5) {
        el.className = 'cam-advice show hint';
        el.textContent = '找不到卡片輪廓，讓整張卡入鏡、背景單純一點';
      } else if (i.ready) {
        el.className = 'cam-advice show ok';
        el.textContent = '對好了，拿穩…';
      } else {
        el.className = 'cam-advice';
      }
      shutter.classList.toggle('ready', !!i.ready);
    };

    cam.onAutoShot = async (canvas) => {
      closeCamera();
      busy(true, '處理照片…');
      await nextFrame();
      try {
        await useImage(canvas);
      } finally {
        busy(false);
      }
    };
  } catch (err) {
    // HTTPS 之外的環境（區網 http）拿不到相機，退回系統相機
    $('cam-fallback-note').textContent =
      '開不了即時相機（' + err.message + '），改用系統相機拍。';
    $('file-input').click();
  }
}

function closeCamera() {
  if (cam) cam.stop();
  $('cam-wrap').hidden = true;
  $('cam-idle').hidden = false;
  $('cam-advice').className = 'cam-advice';
}

$('btn-open-cam').addEventListener('click', openCamera);
$('btn-cam-close').addEventListener('click', closeCamera);

$('btn-shutter').addEventListener('click', async () => {
  if (!cam) return;
  const canvas = cam.grabFrame(2000);
  if (!canvas) return;
  closeCamera();
  busy(true, '處理照片…');
  await nextFrame();
  try {
    await useImage(canvas);
  } finally {
    busy(false);
  }
});

$('btn-torch').addEventListener('click', async () => {
  if (!cam) return;
  const on = !cam.torchOn;
  const ok = await cam.setTorch(on);
  $('btn-torch').classList.toggle('on', ok && on);
  if (!ok) alert('這支手機（或這個瀏覽器）不支援補燈。iPhone 的 Safari 目前就不支援。');
});

function showDetectNotice(det) {
  const el = $('detect-notice');
  el.className = 'notice show';
  if (det.suspectInner) {
    el.classList.add('warn');
    el.textContent =
      '框到的可能是卡面內框而不是卡片邊緣（桌面顏色跟卡片外框太接近時會這樣）。請把四個角拖到卡片的實體邊緣。';
  } else if (det.confidence >= 0.7) {
    el.classList.add('ok');
    el.textContent =
      '已自動框出卡片（信心度 ' + Math.round(det.confidence * 100) + '%）。不對的話直接拖角點。';
  } else {
    el.classList.add('warn');
    el.textContent =
      det.confidence > 0
        ? '自動偵測不太確定（信心度 ' + Math.round(det.confidence * 100) + '%），請手動把四個角拖到卡片邊緣。'
        : '認不出卡片輪廓。請手動把四個角拖到卡片邊緣，或換個背景重拍。';
  }
}

$('btn-auto').addEventListener('click', () => {
  const det = detectCardQuad(state.src);
  state.detConfidence = det.confidence;
  state.adjuster.setImage(state.src, det.quad);
  showDetectNotice(det);
});

$('btn-redo').addEventListener('click', () => {
  showStep('step-capture');
  openCamera();
});

$('btn-back-adjust').addEventListener('click', () => showStep('step-adjust'));
$('btn-new').addEventListener('click', () => {
  showStep('step-capture');
  openCamera();
});

// ===== 分析 =====
$('btn-analyze').addEventListener('click', async () => {
  busy(true, '校正透視…');
  try {
    await nextFrame();
    state.quad = state.adjuster.getQuad();
    // 使用者手動調過角點就是他自己確認過了，不再受自動偵測信心度限制
    if (state.adjuster.userAdjusted) state.detConfidence = 1;

    const t0 = performance.now();
    const imgData = warp(state.src, state.quad);
    if (!imgData) {
      alert('四個角不能連成一條線，請重新框選。');
      return;
    }
    state.std = imageDataToCanvas(imgData);

    busy(true, '量測置中…');
    await nextFrame();
    state.result = measureCentering(imgData, { detConfidence: state.detConfidence });
    state.result.elapsed = Math.round(performance.now() - t0);

    renderResult();
    showStep('step-result');
  } catch (err) {
    alert('分析失敗：' + err.message);
  } finally {
    busy(false);
  }
});

function renderResult() {
  const r = state.result;
  const warnBox = $('result-warnings');
  warnBox.innerHTML = '';
  (r.warnings || []).forEach((w) => {
    const div = document.createElement('div');
    div.className = 'msg ' + (w.level === 'error' ? 'error' : 'warn');
    div.textContent = (w.level === 'error' ? '⛔ ' : '⚠️ ') + w.text;
    warnBox.appendChild(div);
  });

  const scoreBox = $('score-box');
  const canvas = $('result-canvas');

  if (!r.ok) {
    scoreBox.hidden = true;
    canvas.hidden = true;
    $('measure-table').innerHTML = '';
    $('confidence-line').textContent = '';
    return;
  }
  scoreBox.hidden = false;
  canvas.hidden = false;

  const num = $('score-num');
  if (r.reliable) {
    num.textContent = r.score;
    num.className = 'score-num' + (r.score >= 9 ? '' : r.score >= 7 ? ' mid' : ' low');
    $('score-label').textContent = scoreLabel(r.score);
    $('score-sub').textContent =
      '左右 ' + ratioText(r.lr) + '　上下 ' + ratioText(r.tb) + '　（僅置中一項）';
  } else {
    // 量得出數字不代表數字可信，這時候把分數藏起來比給一個會被誤信的數字好
    num.textContent = '?';
    num.className = 'score-num low';
    $('score-label').textContent = '無法可靠量測';
    $('score-sub').textContent = '下方數值僅供參考，請依上方提示重拍或改用其他方式判斷。';
  }

  drawCenteringOverlay(canvas, state.std, r);

  const mm = r.marginsMm;
  const rows = [
    ['左邊寬', mm.left.toFixed(2) + ' mm'],
    ['右邊寬', mm.right.toFixed(2) + ' mm'],
    ['上邊寬', mm.top.toFixed(2) + ' mm'],
    ['下邊寬', mm.bottom.toFixed(2) + ' mm'],
    ['左右比例', ratioText(r.lr) + '　→ ' + r.scoreLR + ' 分'],
    ['上下比例', ratioText(r.tb) + '　→ ' + r.scoreTB + ' 分'],
    ['取較差者', r.score + ' 分'],
  ];
  $('measure-table').innerHTML = rows
    .map((row) => '<tr><td>' + row[0] + '</td><td></td><td>' + row[1] + '</td></tr>')
    .join('');

  const spread = Math.max(
    r.sides.left.spread, r.sides.right.spread,
    r.sides.top.spread, r.sides.bottom.spread
  );
  $('confidence-line').textContent =
    '量測信心度 ' + Math.round(r.confidence * 100) + '%' +
    '（外框一致性 ' + Math.round(r.border.uniformity * 100) + '%、' +
    '掃描線落差 ±' + spread.toFixed(1) + 'px、耗時 ' + r.elapsed + 'ms）';
}

// ===== 設定頁 =====
$('version-line').textContent = '版本 ' + VERSION + '　標準圖 ' + CARD_W + '×' + CARD_H;

async function refreshStorage() {
  const line = $('storage-line');
  if (!navigator.storage || !navigator.storage.estimate) {
    line.textContent = '這個瀏覽器不支援儲存空間查詢。';
    return;
  }
  const est = await navigator.storage.estimate();
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  let persisted = false;
  if (navigator.storage.persisted) persisted = await navigator.storage.persisted();
  const cached = await cacheCount();
  line.textContent =
    '已用 ' + mb(est.usage || 0) + ' / 可用 ' + mb(est.quota || 0) +
    '　已快取 ' + cached + ' 筆卡片資料' +
    '　持久化：' + (persisted ? '已開啟' : '未開啟');
}
refreshStorage();

$('btn-clear-cache').addEventListener('click', async () => {
  if (!confirm('清除離線快取與已查過的卡片資料，並重新載入？')) return;
  await cacheClear();
  if (window.caches) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  if (navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  location.reload();
});

// ===== PWA =====
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('btn-install').hidden = false;
  $('install-state').textContent = '這個瀏覽器支援直接安裝。';
});

$('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const res = await installPrompt.userChoice;
  $('install-state').textContent = res.outcome === 'accepted' ? '已安裝。' : '已取消安裝。';
  installPrompt = null;
  $('btn-install').hidden = true;
});

if (window.matchMedia('(display-mode: standalone)').matches) {
  $('install-state').textContent = '已經是從主畫面開啟的。';
}

// 辨識查價是主要功能，開 App 就直接進那一頁
initIdentify();

// 註冊 Service Worker。用相對路徑，放到 GitHub Pages 子目錄才不會失效。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service Worker 註冊失敗（http 區網測試時屬正常）:', err.message);
    });
  });
}
