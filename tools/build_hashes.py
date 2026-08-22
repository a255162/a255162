# -*- coding: utf-8 -*-
"""
建立卡片影像指紋庫，給「拍照認卡」用。

    python tools/build_hashes.py zh-tw            # 建繁中全部系列
    python tools/build_hashes.py zh-tw --sets SV8 # 只建指定系列（測試用）

原理：每張卡的官方縮圖算成 66 bytes 的指紋，八千多張卡壓成不到 600KB，
手機下載一次就能離線比對。指紋演算法必須跟 js/match.js 完全一致。

輸出：
    data/fp-<lang>.bin    連續的 66 bytes 指紋
    data/fp-<lang>.json   對應的卡片 id 與卡名

會把已下載的指紋存進 .cache 續傳，中斷後重跑不用重抓。
"""

import io
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(BASE_DIR, ".cache")
API = "https://api.tcgdex.net/v2"

# 必須跟 js/match.js 的常數一致
HASH_W, HASH_H = 16, 16
DHASH_BITS = (HASH_W - 1) * HASH_H          # 240
DHASH_BYTES = DHASH_BITS // 8               # 30
COLOR_COLS, COLOR_ROWS = 3, 4
COLOR_BYTES = COLOR_COLS * COLOR_ROWS * 3   # 36
FP_BYTES = DHASH_BYTES + COLOR_BYTES        # 66

WORKERS = 4


def get_json(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pokecard-build/1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if i == retries - 1:
                return None
            time.sleep(1.5 * (i + 1))
    return None


def get_bytes(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pokecard-build/1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception:
            if i == retries - 1:
                return None
            time.sleep(2.5 * (i + 1))
    return None


def area_resize(px, sw, sh, dw, dh):
    """
    面積平均縮放，回傳長度 dw*dh*3 的 RGB list。

    這段算術必須跟 js/match.js 的 areaResize() 一模一樣。原本兩邊各自用內建的
    縮放（PIL BOX vs 瀏覽器 drawImage），同一張圖算出的指紋距離高達 0.10，
    而兩張不同卡最近才差 0.17——真實照片一失真就會認錯。寫成明確的算術才沒有歧義。
    """
    out = [0.0] * (dw * dh * 3)
    for oy in range(dh):
        fy0 = oy * sh / dh
        fy1 = (oy + 1) * sh / dh
        iy0 = int(fy0)
        iy1 = min(sh - 1, math.ceil(fy1) - 1)
        for ox in range(dw):
            fx0 = ox * sw / dw
            fx1 = (ox + 1) * sw / dw
            ix0 = int(fx0)
            ix1 = min(sw - 1, math.ceil(fx1) - 1)

            r = g = b = wsum = 0.0
            for y in range(iy0, iy1 + 1):
                wy = min(y + 1, fy1) - max(y, fy0)
                if wy <= 0:
                    continue
                for x in range(ix0, ix1 + 1):
                    wx = min(x + 1, fx1) - max(x, fx0)
                    if wx <= 0:
                        continue
                    w = wx * wy
                    pr, pg, pb = px[x, y]
                    r += pr * w
                    g += pg * w
                    b += pb * w
                    wsum += w
            o = (oy * dw + ox) * 3
            if wsum > 0:
                out[o] = r / wsum
                out[o + 1] = g / wsum
                out[o + 2] = b / wsum
    return out


def fingerprint(img):
    """跟 js/match.js 的 fingerprint() 對應：16×16 dHash + 3×4 色彩網格。"""
    rgb = img.convert("RGB")
    sw, sh = rgb.size
    px = rgb.load()

    # --- dHash：整張縮成 16×16（不管長寬比，所有卡比例都一樣）---
    small = area_resize(px, sw, sh, HASH_W, HASH_H)
    gray = [
        small[i * 3] * 0.299 + small[i * 3 + 1] * 0.587 + small[i * 3 + 2] * 0.114
        for i in range(HASH_W * HASH_H)
    ]
    fp = bytearray(FP_BYTES)
    bit = 0
    for y in range(HASH_H):
        for x in range(HASH_W - 1):
            if gray[y * HASH_W + x] > gray[y * HASH_W + x + 1]:
                fp[bit >> 3] |= 1 << (bit & 7)
            bit += 1

    # --- 色彩網格 + 灰階世界白平衡 ---
    vals = area_resize(px, sw, sh, COLOR_COLS, COLOR_ROWS)

    n = len(vals) // 3
    mr = sum(vals[0::3]) / n
    mg = sum(vals[1::3]) / n
    mb = sum(vals[2::3]) / n
    mean = (mr + mg + mb) / 3
    if mr >= 1 and mg >= 1 and mb >= 1:
        kr, kg, kb = mean / mr, mean / mg, mean / mb
        for i in range(n):
            vals[i * 3] *= kr
            vals[i * 3 + 1] *= kg
            vals[i * 3 + 2] *= kb

    for i, v in enumerate(vals):
        fp[DHASH_BYTES + i] = max(0, min(255, int(round(v))))
    return bytes(fp)


def card_image_url(image_base):
    return image_base + "/low.webp"


FAILS = {"no_image": 0, "download": 0, "decode": 0}


def process_card(card):
    """下載縮圖並算指紋。回傳 (id, name, fp) 或 None。"""
    img_base = card.get("image")
    if not img_base:
        FAILS["no_image"] += 1
        return None
    cache_path = os.path.join(CACHE_DIR, card["id"].replace("/", "_") + ".fp")
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            data = f.read()
        if len(data) == FP_BYTES:
            return (card["id"], card.get("name") or "", data)

    raw = get_bytes(card_image_url(img_base))
    if not raw:
        FAILS["download"] += 1
        return None
    try:
        img = Image.open(io.BytesIO(raw))
        fp = fingerprint(img)
    except Exception:
        FAILS["decode"] += 1
        return None

    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cache_path, "wb") as f:
        f.write(fp)
    return (card["id"], card.get("name") or "", fp)


def build(lang, only_sets=None):
    sets = get_json("%s/%s/sets" % (API, lang))
    if not sets:
        print("抓不到系列清單")
        return
    if only_sets:
        sets = [s for s in sets if s["id"] in only_sets]

    cards = []
    print("讀取 %d 個系列的卡表…" % len(sets))
    for i, s in enumerate(sets):
        detail = get_json("%s/%s/sets/%s" % (API, lang, s["id"]))
        if detail and detail.get("cards"):
            cards.extend(detail["cards"])
        if (i + 1) % 20 == 0:
            print("  %d/%d 個系列，累計 %d 張" % (i + 1, len(sets), len(cards)))

    # 同一張卡可能在多個系列列表重複，去掉
    seen = set()
    uniq = []
    for c in cards:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        uniq.append(c)
    cards = uniq
    print("共 %d 張卡，開始算指紋（%d 條連線）…" % (len(cards), WORKERS))

    results = []
    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for res in ex.map(process_card, cards):
            done += 1
            if res:
                results.append(res)
            if done % 250 == 0:
                el = time.time() - t0
                rate = done / max(el, 0.001)
                left = (len(cards) - done) / max(rate, 0.001)
                print("  %d/%d  成功 %d  %.0f 張/秒  剩約 %.0f 分"
                      % (done, len(cards), len(results), rate, left / 60))

    os.makedirs(DATA_DIR, exist_ok=True)
    bin_path = os.path.join(DATA_DIR, "fp-%s.bin" % lang)
    json_path = os.path.join(DATA_DIR, "fp-%s.json" % lang)
    with open(bin_path, "wb") as f:
        for _id, _name, fp in results:
            f.write(fp)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "lang": lang,
                "count": len(results),
                "fpBytes": FP_BYTES,
                "ids": [r[0] for r in results],
                "names": [r[1] for r in results],
            },
            f,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    print()
    print("失敗原因：無卡圖 %d、下載失敗 %d、解碼失敗 %d"
          % (FAILS["no_image"], FAILS["download"], FAILS["decode"]))
    print("完成：%d 張" % len(results))
    print("  %s  (%.0f KB)" % (bin_path, os.path.getsize(bin_path) / 1024))
    print("  %s  (%.0f KB)" % (json_path, os.path.getsize(json_path) / 1024))


if __name__ == "__main__":
    lang = sys.argv[1] if len(sys.argv) > 1 else "zh-tw"
    only = None
    if "--sets" in sys.argv:
        only = set(sys.argv[sys.argv.index("--sets") + 1].split(","))
    build(lang, only)
