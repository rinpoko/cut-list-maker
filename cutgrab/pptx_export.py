"""CMコンテ用の PPTX を書き出す。

1 ページに 列数 x 行数 のカットを並べる。1カットの構成は上から
  カット番号（絵の外・左上、囲みなし）
  絵
  ナレーション（黒）
  ト書き（ナレーションより 2pt 小さくグレー50%）
  タイムコード / 尺（Premiere と同じ HH:MM:SS:FF）
"""

import math
import os
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

try:
    from PIL import Image
except ImportError:  # Pillow が無くても 16:9 と仮定して動かす
    Image = None

def _jp_font():
    """その PC に確実にある日本語書体を選ぶ。

    PPTX には書体名が埋め込まれるので、無い書体を指定すると開いた側で
    別の書体に置き換わってしまう。作った OS の標準書体を指定しておく。
    """
    if sys.platform == "win32":
        return "Yu Gothic"          # Windows 8.1 以降に標準搭載
    return "Hiragino Kaku Gothic ProN"


JP_FONT = _jp_font()
INK = RGBColor(0x1D, 0x20, 0x26)
MUTED = RGBColor(0x8A, 0x90, 0x9C)
GRAY50 = RGBColor(0x80, 0x80, 0x80)   # ト書き用のグレー50%

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)
MARGIN_X = Inches(0.4)
MARGIN_TOP = Inches(0.78)
MARGIN_BOTTOM = Inches(0.3)
GUTTER_X = Inches(0.18)
GUTTER_Y = Inches(0.26)


def _set_font(run, size, bold=False, color=INK, font=JP_FONT):
    """日本語が游ゴシック等に化けないよう、欧文・和文・記号すべてに書体を指定する。"""
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = font
    rPr = run.font._element
    for tag in ("a:ea", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None:
            el = rPr.makeelement(qn(tag), {})
            rPr.append(el)
        el.set("typeface", font)


def _textbox(slide, left, top, width, height, text, size, bold=False,
             color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    box = slide.shapes.add_textbox(left, top, width, height)
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = Emu(0)
    frame.margin_top = frame.margin_bottom = Emu(0)
    frame.vertical_anchor = anchor
    para = frame.paragraphs[0]
    para.alignment = align
    run = para.add_run()
    run.text = text
    _set_font(run, size, bold=bold, color=color)
    return box


def _image_size(path):
    if Image is not None:
        try:
            with Image.open(path) as img:
                return img.size
        except Exception:
            pass
    return (16, 9)


def _fit(img_w, img_h, box_w, box_h):
    scale = min(box_w / float(img_w), box_h / float(img_h))
    return int(img_w * scale), int(img_h * scale)


def frame_rate(fps):
    """1秒あたりのフレーム数（整数）。23.976 なら 24、29.97 なら 30。"""
    return max(1, int(round(fps))) if fps and fps > 0 else 24


def split_frames(total, fps):
    """総フレーム数を (秒, フレーム) に分ける。

    フレームは 0 から数えて、fps に達したら次の秒に繰り上がる。
    30fps なら「1秒29フレーム」の次が「2秒00フレーム」。
    """
    rate = frame_rate(fps)
    return divmod(max(0, int(total)), rate)


def timecode(total_frames, fps):
    """Premiere Pro と同じ HH:MM:SS:FF 表記にする。"""
    seconds, frames = split_frames(total_frames, fps)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return "%02d:%02d:%02d:%02d" % (hours, minutes, seconds, frames)


def format_timecode(pick, fps):
    """書き出した絵が動画のどの位置かをタイムコードで表す。"""
    index = pick.get("frame_index")
    if index is None:
        index = int(round((pick.get("time") or 0.0) * frame_rate(fps)))
    return timecode(index, fps)


def format_duration(pick, fps):
    """そのカットの長さ（尺）をタイムコードで表す。"""
    total = pick.get("cut_frames")
    if not total:
        total = int(round((pick.get("cut_duration") or 0.0) * frame_rate(fps)))
    return timecode(total, fps)




# ------------------------------------------------------------------ レイアウト計算
def _text_units(text):
    """文字列の見た目の幅を「全角何文字ぶんか」で概算する。

    日本語は 1 文字 ≒ 1em、英数字・記号は ≒ 0.55em として数える。
    """
    total = 0.0
    for ch in text or "":
        total += 0.55 if ord(ch) < 0x2E80 else 1.0
    return total


def _line_count(text, width_inches, point_size):
    """その幅・その文字サイズで何行になるかを返す。空文字なら 0 行。"""
    if not text:
        return 0
    # PowerPoint 側の折り返しが見積もりより 1 行増えて秒数と重ならないよう、
    # 使える幅を少し辛めに見る
    per_line = max(1.0, width_inches * 0.95 / (point_size / 72.0))
    return max(1, int(math.ceil(_text_units(text) / per_line)))


def _row_groups(picks, cols, rows):
    """ページごと・行ごとに picks を並べ直す。"""
    per_page = cols * rows
    pages = []
    for start in range(0, len(picks), per_page):
        chunk = picks[start:start + per_page]
        pages.append([chunk[i:i + cols] for i in range(0, len(chunk), cols)])
    return pages or [[[]]]


class _Metrics(object):
    """ある絵の幅に対して、1カット分の各パーツの高さをまとめたもの。"""

    LINE = 1.32              # 行間（フォントサイズの倍数）
    GAP_UNDER_NUMBER = 0.03
    GAP_UNDER_IMAGE = 0.07
    GAP_BETWEEN_TEXT = 0.09  # ナレーションとト書きのあいだ

    def __init__(self, width_in, aspect):
        self.width = width_in
        self.image_h = width_in * aspect
        # 幅に対して素直に文字サイズを決める（列が細ければ小さく、太ければ大きく）
        self.narration_pt = max(7.0, min(13.0, width_in * 4.7))
        self.direction_pt = max(6.0, self.narration_pt - 2.0)
        self.meta_pt = max(5.5, min(8.0, width_in * 3.1))
        self.number_pt = max(9.0, min(17.0, width_in * 5.4))
        self.number_h = self.number_pt * 1.30 / 72.0 + 0.02
        self.meta_h = self.meta_pt * 1.35 / 72.0 + 0.02

    def line_h(self, point_size):
        return point_size * self.LINE / 72.0

    def row_height(self, row):
        """その行（横並びのカット群）に必要な高さ。

        行の中で一番行数の多いカットに合わせる。誰もナレーションを持っていない行は
        ナレーションの領域そのものを作らないので、そのぶん絵を大きくできる。
        """
        narration_lines = max([_line_count(p.get("narration"), self.width,
                                           self.narration_pt) for p in row] or [0])
        direction_lines = max([_line_count(p.get("direction"), self.width,
                                           self.direction_pt) for p in row] or [0])
        height = self.number_h + self.GAP_UNDER_NUMBER + self.image_h + self.GAP_UNDER_IMAGE
        if narration_lines:
            height += narration_lines * self.line_h(self.narration_pt)
        if direction_lines:
            if narration_lines:
                height += self.GAP_BETWEEN_TEXT
            height += direction_lines * self.line_h(self.direction_pt)
        return height + 0.03 + self.meta_h, narration_lines, direction_lines


def _solve_width(pages, cell_w_in, usable_h_in, gutter_y, aspect, rows):
    """全ページが収まる範囲で、いちばん絵が大きくなる幅を探す。

    文章が短ければ 1 行で済み、そのぶん絵に高さを回せる。
    幅を少しずつ下げながら、最初に収まったところを採用する。
    """
    lowest = cell_w_in * 0.30
    width = cell_w_in
    step = cell_w_in * 0.01
    best = None
    while width >= lowest:
        metrics = _Metrics(width, aspect)
        tallest = 0.0
        for page in pages:
            total = sum(metrics.row_height(row)[0] for row in page)
            total += gutter_y * max(0, len(page) - 1)
            tallest = max(tallest, total)
        if tallest <= usable_h_in:
            best = (metrics, tallest)
            break
        width -= step
    if best is None:
        best = (_Metrics(lowest, aspect), usable_h_in)
    return best


def build_deck(picks, outdir, out_path, title="", cols=4, rows=2, subtitle="", fps=24.0):
    """picks: pipeline が作ったカット情報のリスト。outdir にある画像を貼る。

    レイアウトは固定値ではなく、実際の文章量から解く。
      1. 各カットのナレーション／ト書きが「その列幅で何行になるか」を数える
      2. 行ごとに必要な高さを出す（誰も書いていない要素の領域は作らない）
      3. 全ページが収まる範囲で、絵がいちばん大きくなる幅を探す
      4. 余った縦横の余白は、行間・列間に配って全体を均す
    """
    cols = max(1, int(cols))
    rows = max(1, int(rows))
    per_page = cols * rows

    # 縦長のグリッド（行数 > 列数）のときはスライドも縦向きにする。
    portrait = rows > cols
    slide_w = SLIDE_H if portrait else SLIDE_W
    slide_h = SLIDE_W if portrait else SLIDE_H

    prs = Presentation()
    prs.slide_width = slide_w
    prs.slide_height = slide_h
    blank = prs.slide_layouts[6]

    # 実際の絵の縦横比を使う（16:9 とは限らない）
    aspect = 9.0 / 16.0
    for pick in picks:
        candidate = os.path.join(outdir, pick["file"])
        if os.path.exists(candidate):
            iw, ih = _image_size(candidate)
            aspect = ih / float(iw)
            break

    slide_w_in = slide_w / 914400.0
    slide_h_in = slide_h / 914400.0
    margin_x = MARGIN_X / 914400.0
    margin_top = (0.62 if rows >= 3 else 0.72)
    margin_bottom = 0.22
    gutter_x_min = 0.10
    gutter_y_min = 0.14

    cell_w_in = (slide_w_in - margin_x * 2 - gutter_x_min * (cols - 1)) / cols
    usable_h_in = slide_h_in - margin_top - margin_bottom

    pages = _row_groups(picks, cols, rows)
    metrics, used_h = _solve_width(pages, cell_w_in, usable_h_in,
                                   gutter_y_min, aspect, rows)
    content_w_in = metrics.width

    # 横に余ったぶんは列の間隔に配って、絵をページ全体に散らす
    spare_x = slide_w_in - margin_x * 2 - content_w_in * cols
    gutter_x = min(0.42, spare_x / (cols - 1)) if cols > 1 else 0.0
    gutter_x = max(gutter_x_min, gutter_x)
    grid_w = content_w_in * cols + gutter_x * (cols - 1)
    left_offset = (slide_w_in - grid_w) / 2.0

    content_w = Inches(content_w_in)
    image_box_h = Inches(metrics.image_h)

    pages_count = len(pages)

    for page_index, page in enumerate(pages):
        slide = prs.slides.add_slide(blank)

        head_w = slide_w - MARGIN_X * 2 - Inches(1.4)
        head_pt = 15 if rows <= 2 else 13
        _textbox(slide, MARGIN_X, Inches(0.22), head_w, Inches(0.30),
                 title or "カット表", head_pt, bold=True)
        if subtitle:
            _textbox(slide, MARGIN_X, Inches(0.22 + head_pt * 1.5 / 72.0), head_w,
                     Inches(0.2), subtitle, 8.5, color=MUTED)
        _textbox(slide, slide_w - MARGIN_X - Inches(1.4), Inches(0.24), Inches(1.4),
                 Inches(0.3), "%d / %d" % (page_index + 1, pages_count), 9.5,
                 color=MUTED, align=PP_ALIGN.RIGHT)

        # このページの行の高さを出して、余りを行間に均等に配る
        measured = [metrics.row_height(row) for row in page]
        block_h = sum(m[0] for m in measured)
        slack = usable_h_in - block_h
        gutter_y = gutter_y_min
        if len(page) > 1 and slack > 0:
            gutter_y = min(0.5, gutter_y_min + slack / float(len(page)))
        block_h += gutter_y * max(0, len(page) - 1)
        y = margin_top + max(0.0, (usable_h_in - block_h) / 2.0)

        for row_index, row in enumerate(page):
            row_h, narration_lines, direction_lines = measured[row_index]

            for col_index, pick in enumerate(row):
                cell_x = Inches(left_offset + col_index * (content_w_in + gutter_x))
                cell_y = Inches(y)

                image_y = cell_y + Inches(metrics.number_h + metrics.GAP_UNDER_NUMBER)
                image_path = os.path.join(outdir, pick["file"])
                if os.path.exists(image_path):
                    iw, ih = _image_size(image_path)
                    draw_w, draw_h = _fit(iw, ih, content_w, image_box_h)
                    img_x = cell_x + (content_w - draw_w) // 2
                    slide.shapes.add_picture(image_path, img_x, image_y, draw_w, draw_h)
                else:
                    draw_w, draw_h = content_w, image_box_h
                    img_x = cell_x

                # --- 絵の外・左上にカット番号（囲みなし、数字だけ） ---
                _textbox(slide, img_x, cell_y, content_w, Inches(metrics.number_h),
                         "%02d" % pick["cut"], metrics.number_pt, bold=True,
                         anchor=MSO_ANCHOR.BOTTOM)

                text_y = image_y + draw_h + Inches(metrics.GAP_UNDER_IMAGE)

                # --- ナレーション（黒） ---
                if narration_lines:
                    height = Inches(narration_lines * metrics.line_h(metrics.narration_pt))
                    _textbox(slide, cell_x, text_y, content_w, height,
                             pick.get("narration") or "", metrics.narration_pt, color=INK)
                    text_y += height
                    if direction_lines:
                        text_y += Inches(metrics.GAP_BETWEEN_TEXT)

                # --- ト書き（2pt 小さくグレー50%） ---
                if direction_lines:
                    height = Inches(direction_lines * metrics.line_h(metrics.direction_pt))
                    _textbox(slide, cell_x, text_y, content_w, height,
                             pick.get("direction") or "", metrics.direction_pt, color=GRAY50)
                    text_y += height

                _textbox(slide, cell_x, text_y + Inches(0.03), content_w,
                         Inches(metrics.meta_h),
                         "%s / %s" % (format_timecode(pick, fps), format_duration(pick, fps)),
                         metrics.meta_pt, color=MUTED)

            y += row_h + gutter_y

    prs.save(out_path)
    return out_path
