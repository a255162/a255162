# -*- coding: utf-8 -*-
"""
產生 PWA 圖示（改自 房屋大師/generate_icon.py）

    python tools/make_icons.py

產生 icons/icon-192.png、icon-512.png、icon-maskable-512.png
maskable 版把圖案縮小置中，避免 Android 圓形遮罩把邊緣切掉。
"""

import os

from PIL import Image, ImageDraw

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(BASE_DIR, "icons")

BG = (18, 20, 28, 255)
CARD = (245, 247, 252, 255)
FRAME = (240, 190, 40, 255)
ART = (58, 132, 214, 255)
ACCENT = (46, 204, 150, 255)


def draw_icon(size, inset_ratio=0.0):
    """畫一張卡片 + 量測框線的圖示。inset_ratio 是 maskable 用的內縮比例。"""
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    s = size / 512.0

    # 可視區域（maskable 要內縮）
    pad = size * inset_ratio
    box = size - pad * 2

    # 卡片本體：2.5 : 3.5 比例
    card_h = box * 0.74
    card_w = card_h * (2.5 / 3.5)
    cx, cy = size / 2, size / 2
    x0, y0 = cx - card_w / 2, cy - card_h / 2
    x1, y1 = cx + card_w / 2, cy + card_h / 2
    r = 18 * s

    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=FRAME)

    # 內框（藝術區）：故意左右不對稱，呼應「置中量測」這件事
    m_l = card_w * 0.13
    m_r = card_w * 0.09
    m_t = card_h * 0.11
    m_b = card_h * 0.20
    d.rounded_rectangle(
        [x0 + m_l, y0 + m_t, x1 - m_r, y1 - m_b], radius=r * 0.45, fill=ART
    )

    # 白色卡面下緣（文字區）
    d.rounded_rectangle(
        [x0 + m_l, y1 - m_b + 6 * s, x1 - m_r, y1 - card_h * 0.05],
        radius=r * 0.3,
        fill=CARD,
    )

    # 量測標線：左右兩條，示意在測邊寬
    lw = max(2, int(6 * s))
    my = y0 + card_h * 0.42
    d.line([x0, my, x0 + m_l, my], fill=ACCENT, width=lw)
    d.line([x1 - m_r, my, x1, my], fill=ACCENT, width=lw)

    # 四角校正點
    dot = 11 * s
    for px, py in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]:
        d.ellipse([px - dot, py - dot, px + dot, py + dot], fill=ACCENT)

    return img


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    outputs = [
        ("icon-192.png", 192, 0.0),
        ("icon-512.png", 512, 0.0),
        ("icon-maskable-512.png", 512, 0.13),
    ]
    for name, size, inset in outputs:
        path = os.path.join(ICON_DIR, name)
        draw_icon(size, inset).save(path)
        print("已產生 %s (%dx%d)" % (name, size, size))
    print("完成，共 %d 個檔案 -> %s" % (len(outputs), ICON_DIR))


if __name__ == "__main__":
    main()
