"""アプリアイコン (.icns) を生成する。build_app.sh から呼ばれる。"""

import os
import subprocess
import sys

from PIL import Image, ImageDraw

SIZE = 1024
BG_TOP = (26, 30, 44)
BG_BOTTOM = (44, 52, 78)
ACCENT = (255, 108, 60)
FRAME = (232, 236, 245)
DIM = (96, 104, 128)


def rounded_gradient(size):
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / float(size - 1)
        draw.line(
            [(0, y), (size, y)],
            fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)),
        )
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def build():
    img = rounded_gradient(SIZE)
    draw = ImageDraw.Draw(img)

    # フィルムストリップ（左右にパーフォレーション）
    strip_x0, strip_x1 = int(SIZE * 0.13), int(SIZE * 0.87)
    strip_y0, strip_y1 = int(SIZE * 0.24), int(SIZE * 0.76)
    hole_w, hole_h = int(SIZE * 0.045), int(SIZE * 0.032)
    for i in range(6):
        y = strip_y0 + int(SIZE * 0.035) + i * int(SIZE * 0.081)
        for x in (strip_x0 - int(SIZE * 0.075), strip_x1 + int(SIZE * 0.03)):
            draw.rounded_rectangle([x, y, x + hole_w, y + hole_h],
                                   radius=int(SIZE * 0.008), fill=DIM)

    # 3 コマ：真ん中が「選ばれた 1 枚」
    gap = int(SIZE * 0.022)
    total_h = strip_y1 - strip_y0
    frame_h = (total_h - gap * 2) // 3
    for i in range(3):
        y0 = strip_y0 + i * (frame_h + gap)
        chosen = (i == 1)
        fill = FRAME if not chosen else (255, 255, 255)
        draw.rounded_rectangle([strip_x0, y0, strip_x1, y0 + frame_h],
                               radius=int(SIZE * 0.018), fill=fill)
        if chosen:
            draw.rounded_rectangle([strip_x0 - int(SIZE * 0.016), y0 - int(SIZE * 0.016),
                                    strip_x1 + int(SIZE * 0.016), y0 + frame_h + int(SIZE * 0.016)],
                                   radius=int(SIZE * 0.03), outline=ACCENT,
                                   width=int(SIZE * 0.022))
            # 三分割グリッド
            for k in (1, 2):
                gx = strip_x0 + (strip_x1 - strip_x0) * k // 3
                gy = y0 + frame_h * k // 3
                draw.line([(gx, y0), (gx, y0 + frame_h)], fill=(214, 220, 232), width=4)
                draw.line([(strip_x0, gy), (strip_x1, gy)], fill=(214, 220, 232), width=4)
            r = int(SIZE * 0.055)
            cx = strip_x0 + (strip_x1 - strip_x0) * 2 // 3
            cy = y0 + frame_h // 3
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
        else:
            for k in (1, 2):
                gx = strip_x0 + (strip_x1 - strip_x0) * k // 3
                draw.line([(gx, y0), (gx, y0 + frame_h)], fill=(206, 212, 224), width=3)
    return img


def main(out_icns):
    img = build()
    iconset = out_icns.replace(".icns", ".iconset")
    if os.path.isdir(iconset):
        subprocess.run(["rm", "-rf", iconset], check=False)
    os.makedirs(iconset, exist_ok=True)
    for size in (16, 32, 64, 128, 256, 512):
        img.resize((size, size), Image.LANCZOS).save(
            os.path.join(iconset, "icon_%dx%d.png" % (size, size)))
        img.resize((size * 2, size * 2), Image.LANCZOS).save(
            os.path.join(iconset, "icon_%dx%d@2x.png" % (size, size)))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out_icns], check=True)
    subprocess.run(["rm", "-rf", iconset], check=False)
    print("icon:", out_icns)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "app.icns")
