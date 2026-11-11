"""コンタクトシート（候補一覧 / 結果一覧）の生成。"""

import math

import cv2
import numpy as np


def _fit(frame, tile_w, tile_h):
    h, w = frame.shape[:2]
    scale = min(tile_w / float(w), tile_h / float(h))
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.full((tile_h, tile_w, 3), 22, dtype=np.uint8)
    y0 = (tile_h - new_h) // 2
    x0 = (tile_w - new_w) // 2
    canvas[y0:y0 + new_h, x0:x0 + new_w] = resized
    return canvas


def _badge(tile, text, color=(30, 30, 235)):
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = tile.shape[0] / 150.0
    thickness = max(2, int(round(scale * 2)))
    (tw, th), _ = cv2.getTextSize(text, font, scale, thickness)
    pad = int(round(scale * 8))
    cv2.rectangle(tile, (0, 0), (tw + pad * 2, th + pad * 2), color, -1)
    cv2.putText(tile, text, (pad, th + pad), font, scale, (255, 255, 255), thickness, cv2.LINE_AA)
    return tile


def file_jpeg(path, width=896, quality=85):
    """書き出し済みの画像を読み込んで、AI に見せる用の JPEG にする。

    解析用の縮小フレームではなく元解像度の書き出し画像を使うので、
    ト書きを書かせるときに細部（商品・表情・文字）まで見える。
    """
    frame = cv2.imread(path, cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("画像を読み込めませんでした: %s" % path)
    h, w = frame.shape[:2]
    if w > width:
        scale = width / float(w)
        frame = cv2.resize(frame, (width, max(1, int(round(h * scale)))),
                           interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("画像の JPEG 化に失敗しました")
    return buf.tobytes()


def frame_jpeg(frames, index, width=768, quality=85):
    """1 フレームを JPEG バイト列にする（フォールバック用）。"""
    frame = frames[max(0, min(index, len(frames) - 1))]
    h, w = frame.shape[:2]
    if w > width:
        scale = width / float(w)
        frame = cv2.resize(frame, (width, max(1, int(round(h * scale)))),
                           interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("フレームの JPEG 化に失敗しました")
    return buf.tobytes()


def candidate_sheet(frames, candidates, tile_width=440, cols=3):
    """AI に渡す候補コンタクトシート（JPEG bytes）を作る。候補には 1 始まりの番号を振る。"""
    ratio = frames[0].shape[0] / float(frames[0].shape[1])
    tile_h = int(round(tile_width * ratio))
    cols = min(cols, max(1, len(candidates)))
    rows = int(math.ceil(len(candidates) / float(cols)))
    gap = 8

    sheet = np.full((rows * tile_h + gap * (rows + 1),
                     cols * tile_width + gap * (cols + 1), 3), 245, dtype=np.uint8)

    for i, cand in enumerate(candidates):
        tile = _fit(frames[cand["frame_index"]], tile_width, tile_h)
        _badge(tile, str(i + 1))
        r, c = divmod(i, cols)
        y = gap + r * (tile_h + gap)
        x = gap + c * (tile_width + gap)
        sheet[y:y + tile_h, x:x + tile_width] = tile

    ok, buf = cv2.imencode(".jpg", sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        raise RuntimeError("コンタクトシートの生成に失敗しました")
    return buf.tobytes()


def result_sheet(frames, picks, out_path, tile_width=420, cols=4):
    """書き出し結果の一覧シートを PNG/JPG で保存する。"""
    if not picks:
        return None
    ratio = frames[0].shape[0] / float(frames[0].shape[1])
    tile_h = int(round(tile_width * ratio))
    cols = min(cols, len(picks))
    rows = int(math.ceil(len(picks) / float(cols)))
    gap = 10
    label_h = int(round(tile_h * 0.13))

    sheet = np.full((rows * (tile_h + label_h) + gap * (rows + 1),
                     cols * tile_width + gap * (cols + 1), 3), 250, dtype=np.uint8)

    font = cv2.FONT_HERSHEY_SIMPLEX
    for i, pick in enumerate(picks):
        tile = _fit(frames[pick["frame_index"]], tile_width, tile_h)
        r, c = divmod(i, cols)
        y = gap + r * (tile_h + label_h + gap)
        x = gap + c * (tile_width + gap)
        sheet[y:y + tile_h, x:x + tile_width] = tile

        text = "CUT %02d   %.2fs" % (pick["cut"], pick["time"])
        scale = tile_width / 520.0
        cv2.putText(sheet, text, (x + 4, y + tile_h + int(label_h * 0.62)),
                    font, scale, (40, 40, 40), max(1, int(round(scale * 2))), cv2.LINE_AA)

    if out_path.lower().endswith(".png"):
        cv2.imwrite(out_path, sheet)
    else:
        cv2.imwrite(out_path, sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    return out_path
