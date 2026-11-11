"""カット表の Excel (.xlsx) を書き出す。

カット数ぶんの行が上から下に並び、左から順に
  カット番号 / キャプチャ画像 / ナレーション / ト書き / タイムコード /
  クライアントFB / 修正ポイント / 備考・素材など
が入る。後ろの3列は書き込んでもらうための空欄。
"""

import os

import xlsxwriter

from .pptx_export import format_duration, format_timecode

try:
    from PIL import Image
except ImportError:  # Pillow が無くても 16:9 と仮定して動かす
    Image = None

INK = "#1D2026"
MUTED = "#8A909C"
HEAD_BG = "#2C3242"
INPUT_BG = "#FFFDF5"      # 記入してもらう列はうっすら色を付けて区別する
BORDER = "#D5D8DE"

# 游ゴシックは macOS・Windows のどちらにも入っているので、
# クライアントに渡しても書体が置き換わらない
JP_FONT = "Yu Gothic"

IMAGE_WIDTH_PX = 260      # 画像列に入れる絵の幅
CELL_PAD_PX = 6

COLUMNS = [
    ("カット番号", 9.0),
    ("キャプチャ画像", IMAGE_WIDTH_PX / 7.0),
    ("ナレーション", 30.0),
    ("ト書き", 30.0),
    ("タイムコード", 15.0),
    ("クライアントFB", 30.0),
    ("修正ポイント", 30.0),
    ("備考・素材など", 30.0),
]
INPUT_FROM = 5            # ここから右は記入用の空欄


def _image_size(path):
    if Image is not None:
        try:
            with Image.open(path) as img:
                return img.size
        except Exception:
            pass
    return (16, 9)


def build_sheet(picks, outdir, out_path, title="", subtitle="", fps=24.0):
    """picks: pipeline が作ったカット情報。outdir にある画像を貼り込む。"""
    book = xlsxwriter.Workbook(out_path, {"constant_memory": False})
    sheet = book.add_worksheet("カット表")

    base = {"font_name": JP_FONT, "valign": "vcenter", "border": 1,
            "border_color": BORDER}
    f_title = book.add_format({"font_name": JP_FONT, "bold": True, "font_size": 14,
                               "font_color": INK, "valign": "vcenter"})
    f_sub = book.add_format({"font_name": JP_FONT, "font_size": 9,
                             "font_color": MUTED, "valign": "vcenter"})
    f_head = book.add_format(dict(base, bold=True, font_size=10, align="center",
                                  font_color="#FFFFFF", bg_color=HEAD_BG))
    f_num = book.add_format(dict(base, bold=True, font_size=13, align="center",
                                 font_color=INK))
    f_text = book.add_format(dict(base, font_size=10, text_wrap=True, align="left",
                                  font_color=INK))
    f_dim = book.add_format(dict(base, font_size=9, text_wrap=True, align="left",
                                 font_color="#808080"))
    f_code = book.add_format(dict(base, font_size=9, align="center",
                                  text_wrap=True, font_color=MUTED))
    f_input = book.add_format(dict(base, font_size=10, text_wrap=True, align="left",
                                   valign="top", bg_color=INPUT_BG))
    f_cell = book.add_format(dict(base))

    for index, (name, width) in enumerate(COLUMNS):
        sheet.set_column(index, index, width)

    sheet.write(0, 0, title or "カット表", f_title)
    if subtitle:
        sheet.write(1, 0, subtitle, f_sub)
    sheet.set_row(0, 22)
    sheet.set_row(1, 16)

    header_row = 3
    for index, (name, _width) in enumerate(COLUMNS):
        sheet.write(header_row, index, name, f_head)
    sheet.set_row(header_row, 24)

    # 画像の縦横比は素材から取る（16:9 とは限らない）
    aspect = 9.0 / 16.0
    for pick in picks:
        candidate = os.path.join(outdir, pick["file"])
        if os.path.exists(candidate):
            iw, ih = _image_size(candidate)
            aspect = ih / float(iw)
            break
    image_h_px = IMAGE_WIDTH_PX * aspect

    for offset, pick in enumerate(picks):
        row = header_row + 1 + offset
        sheet.set_row(row, (image_h_px + CELL_PAD_PX * 2) * 0.75)  # px → pt

        sheet.write(row, 0, pick["cut"], f_num)
        sheet.write_blank(row, 1, None, f_cell)
        sheet.write(row, 2, pick.get("narration") or "", f_text)
        sheet.write(row, 3, pick.get("direction") or "", f_dim)
        sheet.write(row, 4, "%s\n%s" % (format_timecode(pick, fps),
                                        format_duration(pick, fps)), f_code)
        for column in range(INPUT_FROM, len(COLUMNS)):
            sheet.write_blank(row, column, None, f_input)

        image_path = os.path.join(outdir, pick["file"])
        if os.path.exists(image_path):
            iw, ih = _image_size(image_path)
            scale = IMAGE_WIDTH_PX / float(iw)
            sheet.insert_image(row, 1, image_path, {
                "x_offset": CELL_PAD_PX,
                "y_offset": CELL_PAD_PX,
                "x_scale": scale,
                "y_scale": scale,
                # 行や列を動かしても絵が伸び縮みしないようにする
                "object_position": 2,
            })

    # 見出しを固定して、スクロールしても項目名が見えるようにする
    sheet.freeze_panes(header_row + 1, 0)
    sheet.set_landscape()
    sheet.fit_to_pages(1, 0)
    sheet.repeat_rows(header_row)

    book.close()
    return out_path
