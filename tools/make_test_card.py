# -*- coding: utf-8 -*-
"""
產生合成測試卡，用來驗證置中量測準不準。

    python tools/make_test_card.py

重點是「已知答案」：外框寬度是我們自己畫的，所以量出來的比例對不對可以直接對答案。

真值（GROUND TRUTH）：
    左 46px  右 34px -> 左右 57.5 / 42.5 -> 9 分
    上 43px  下 37px -> 上下 53.75 / 46.25 -> 10 分
    取較差者 -> 9 分
"""

import os
import random

from PIL import Image, ImageDraw, ImageFilter

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "test")

CARD_W, CARD_H = 630, 880        # 10 px/mm
MARGIN_L, MARGIN_R = 46, 34      # 刻意左右不對稱
MARGIN_T, MARGIN_B = 43, 37

BORDER = (232, 191, 46)          # 寶可夢卡的黃框
ART = (46, 104, 168)
TEXTBOX = (238, 240, 235)
BG = (176, 180, 188)             # 桌面：灰色，跟黃框差夠多


def make_card():
    card = Image.new("RGB", (CARD_W, CARD_H), BORDER)
    d = ImageDraw.Draw(card)

    # 藝術區
    x0, y0 = MARGIN_L, MARGIN_T
    x1, y1 = CARD_W - MARGIN_R, CARD_H - MARGIN_B
    d.rectangle([x0, y0, x1, y1], fill=ART)

    # 內容：圖框、文字框，讓畫面不是一片純色
    d.rectangle([x0 + 30, y0 + 60, x1 - 30, y0 + 430], fill=(120, 170, 210))
    d.rectangle([x0 + 24, y1 - 300, x1 - 24, y1 - 40], fill=TEXTBOX)
    for i in range(6):
        yy = y1 - 280 + i * 40
        d.rectangle([x0 + 44, yy, x1 - 60, yy + 14], fill=(70, 70, 76))

    # 輕微雜訊，模擬真實拍攝
    px = card.load()
    random.seed(7)
    for _ in range(int(CARD_W * CARD_H * 0.04)):
        x = random.randrange(CARD_W)
        y = random.randrange(CARD_H)
        r, g, b = px[x, y]
        n = random.randint(-9, 9)
        px[x, y] = (
            max(0, min(255, r + n)),
            max(0, min(255, g + n)),
            max(0, min(255, b + n)),
        )
    return card


def solve_coeffs(dst, src):
    """求 PIL PERSPECTIVE 係數：輸出座標 dst -> 輸入座標 src。"""
    A = []
    b = []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -x * u, -y * u])
        b.append(u)
        A.append([0, 0, 0, x, y, 1, -x * v, -y * v])
        b.append(v)

    n = len(b)
    m = [row + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        p = m[col][col]
        for r in range(n):
            if r == col:
                continue
            f = m[r][col] / p
            if f:
                for c in range(col, n + 1):
                    m[r][c] -= f * m[col][c]
    return [m[i][n] / m[i][i] for i in range(n)]


def place(card, quad, out_size, blur=0.6):
    """把卡片貼到背景上的指定四邊形位置（可含透視）。"""
    W, H = out_size
    scene = Image.new("RGB", (W, H), BG)

    # 卡片四角 -> 場景四角
    coeffs = solve_coeffs(
        quad,
        [(0, 0), (CARD_W, 0), (CARD_W, CARD_H), (0, CARD_H)],
    )
    warped = card.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)

    # 遮罩：只有卡片範圍才貼上去
    mask = Image.new("L", (CARD_W, CARD_H), 255)
    mask_w = mask.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)

    scene.paste(warped, (0, 0), mask_w)
    if blur:
        scene = scene.filter(ImageFilter.GaussianBlur(blur))
    return scene


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    card = make_card()

    # 1) 正拍：完全沒有透視，用來驗證量測本身
    flat = place(card, [(120, 90), (870, 90), (870, 1140), (120, 1140)], (990, 1230))
    flat.save(os.path.join(OUT_DIR, "card_flat.png"))

    # 2) 斜拍：明顯的梯形透視，用來驗證 warp 有沒有把形狀救回來
    tilt = place(card, [(190, 150), (830, 96), (900, 1120), (140, 1050)], (990, 1230))
    tilt.save(os.path.join(OUT_DIR, "card_tilt.png"))

    # 3) 重複性測試：同一張卡「拍」很多次，角度、位置、曝光都不一樣。
    #    正確的程式應該每次都量到幾乎相同的比例——分數飄來飄去就沒有實用價值。
    variants = [
        ("v1_slight",   [(160, 120), (852, 132), (838, 1160), (146, 1142)], 1.0),
        ("v2_rot",      [(230,  96), (884, 236), (816, 1180), (162, 1040)], 1.0),
        ("v3_strong",   [(140, 210), (790,  80), (930, 1058), (196, 1188)], 1.0),
        ("v4_dark",     [(175, 140), (845, 118), (862, 1150), (152, 1128)], 0.55),
        ("v5_bright",   [(175, 140), (845, 118), (862, 1150), (152, 1128)], 1.45),
        ("v6_far",      [(330, 330), (700, 318), (708, 940), (338, 952)],   1.0),
    ]
    for name, quad, gain in variants:
        img = place(card, quad, (990, 1230))
        if gain != 1.0:
            img = img.point(lambda v: max(0, min(255, int(v * gain))))
        img.save(os.path.join(OUT_DIR, "card_%s.png" % name))
    print("另外產生 %d 張重複性測試圖" % len(variants))

    lr = MARGIN_L / (MARGIN_L + MARGIN_R) * 100
    tb = MARGIN_T / (MARGIN_T + MARGIN_B) * 100
    print("已產生 test/card_flat.png 與 test/card_tilt.png")
    print("真值：左右 %.2f / %.2f，上下 %.2f / %.2f" % (lr, 100 - lr, tb, 100 - tb))
    print("真值：左 %.2fmm 右 %.2fmm 上 %.2fmm 下 %.2fmm"
          % (MARGIN_L / 10, MARGIN_R / 10, MARGIN_T / 10, MARGIN_B / 10))


if __name__ == "__main__":
    main()
