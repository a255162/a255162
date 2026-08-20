# -*- coding: utf-8 -*-
"""
產生「難拍」情境的測試卡，用來衡量自動偵測到底有多可靠。

    python tools/make_hard_cases.py

每張圖都記錄卡片四角的真值座標（存成 test/hard_cases.json），
偵測器量出來的角點跟真值差多少，就是它的實際誤差。
沒有這個，「偵測有沒有變好」只能靠感覺。
"""

import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "mtc", os.path.join(os.path.dirname(os.path.abspath(__file__)), "make_test_card.py")
)
mtc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mtc)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "test")
W, H = 990, 1230


def shade(img, poly, factor):
    """把多邊形範圍內壓暗，模擬影子。邊緣做羽化，真實影子不會是硬邊。"""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(14))
    dark = img.point(lambda v: int(v * factor))
    return Image.composite(dark, img, mask)


def gradient_light(img, left_gain, right_gain):
    """左右不均勻的光線，模擬單邊光源。"""
    w, h = img.size
    ramp = Image.new("L", (w, 1))
    px = ramp.load()
    for x in range(w):
        t = x / max(1, w - 1)
        g = left_gain + (right_gain - left_gain) * t
        px[x, 0] = max(0, min(255, int(g * 128)))
    ramp = ramp.resize((w, h))

    out = img.copy()
    op = out.load()
    rp = ramp.load()
    for y in range(h):
        for x in range(w):
            g = rp[x, y] / 128.0
            r, gg, b = op[x, y]
            op[x, y] = (
                max(0, min(255, int(r * g))),
                max(0, min(255, int(gg * g))),
                max(0, min(255, int(b * g))),
            )
    return out


def build():
    card = mtc.make_card()
    quad = [(170, 130), (846, 118), (860, 1152), (150, 1136)]
    cases = []

    def emit(name, img, note, q=quad):
        img.save(os.path.join(OUT_DIR, "hard_%s.png" % name))
        cases.append({"file": "hard_%s.png" % name, "quad": q, "note": note})
        print("  hard_%s.png  %s" % (name, note))

    # 1) 斜向硬影子橫跨卡片——最常見的情況，手或手機擋到光
    base = mtc.place(card, quad, (W, H))
    emit("shadow_diag", shade(base, [(0, 0), (620, 0), (300, H), (0, H)], 0.45),
         "斜影子蓋住左半邊卡片")

    # 2) 影子只落在背景上，且比卡片還暗——顏色分割會把影子誤認成物體
    emit("shadow_bg", shade(mtc.place(card, quad, (W, H)),
                            [(0, 900), (W, 760), (W, H), (0, H)], 0.35),
         "背景有大片暗影，比卡片暗")

    # 3) 卡片邊緣的落影——最難，影子緊貼卡片邊，會被當成卡片的一部分
    emit("shadow_edge", shade(mtc.place(card, quad, (W, H)),
                              [(846, 118), (940, 150), (955, 1190), (860, 1152)], 0.4),
         "卡片右緣有落影，容易被算進卡片")

    # 4) 整體光線不足
    dark = mtc.place(card, quad, (W, H)).point(lambda v: int(v * 0.28))
    emit("lowlight", dark, "整體很暗（模擬室內沒開燈）")

    # 5) 光線不足 + 影子
    emit("lowlight_shadow", shade(dark, [(0, 0), (700, 0), (380, H), (0, H)], 0.5),
         "又暗又有影子")

    # 6) 單邊光源造成的亮度漸層
    emit("gradient", gradient_light(mtc.place(card, quad, (W, H)), 1.75, 0.5),
         "左亮右暗的漸層光")

    # 7) 背景顏色跟卡片外框很接近——顏色分割直接失效
    old_bg = mtc.BG
    mtc.BG = (226, 196, 74)  # 接近黃框的桌面
    emit("lowcontrast", mtc.place(card, quad, (W, H)), "桌面顏色接近黃框")
    mtc.BG = old_bg

    # 8) 反光亮斑打在卡面上
    glare = mtc.place(card, quad, (W, H))
    g = Image.new("L", glare.size, 0)
    ImageDraw.Draw(g).ellipse([420, 260, 800, 640], fill=255)
    g = g.filter(ImageFilter.GaussianBlur(70))
    glare = Image.composite(Image.new("RGB", glare.size, (255, 255, 255)), glare, g.point(lambda v: int(v * 0.75)))
    emit("glare", glare, "卡面有大片反光")

    # 9) 桌面有雜物（另一張卡的一角）
    busy = mtc.place(card, quad, (W, H))
    d = ImageDraw.Draw(busy)
    d.rectangle([0, 0, 220, 300], fill=(200, 60, 60))
    d.rectangle([880, 980, W, H], fill=(40, 90, 60))
    emit("clutter", busy, "桌面有其他卡片/雜物")

    # 10) 深色桌面（常見：黑色桌墊）
    old_bg = mtc.BG
    mtc.BG = (28, 30, 36)
    emit("darkdesk", mtc.place(card, quad, (W, H)), "深色桌墊")
    mtc.BG = old_bg

    with open(os.path.join(OUT_DIR, "hard_cases.json"), "w", encoding="utf-8") as f:
        json.dump(cases, f, ensure_ascii=False, indent=2)
    print("\n共 %d 個困難情境 -> test/hard_cases.json" % len(cases))


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    build()
