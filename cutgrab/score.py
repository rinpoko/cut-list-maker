"""各カットの中から「良い瞬間」の候補を選び、ローカル指標で採点する。

AI に渡す前の一次選抜。ここで明らかにダメなフレーム
（ブレ、露出破綻、転換の途中、モーションブラー）を落としておく。
"""

import cv2
import numpy as np

_FACE_CASCADE = None
_PROFILE_CASCADE = None


def _face_cascades():
    global _FACE_CASCADE, _PROFILE_CASCADE
    if _FACE_CASCADE is None:
        base = cv2.data.haarcascades
        try:
            _FACE_CASCADE = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
            _PROFILE_CASCADE = cv2.CascadeClassifier(base + "haarcascade_profileface.xml")
        except Exception:
            _FACE_CASCADE = cv2.CascadeClassifier()
            _PROFILE_CASCADE = cv2.CascadeClassifier()
    return _FACE_CASCADE, _PROFILE_CASCADE


def _sharpness(gray):
    lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    return float(lap.var())


def _exposure(gray):
    """白飛び・黒つぶれ・眠い絵にペナルティ。1.0 が理想。"""
    total = gray.size
    clipped_hi = float((gray > 250).sum()) / total
    clipped_lo = float((gray < 5).sum()) / total
    mean = float(gray.mean())
    mean_pen = abs(mean - 118.0) / 118.0
    score = 1.0 - min(1.0, clipped_hi * 2.2) - min(1.0, clipped_lo * 1.4) - min(0.7, mean_pen * 0.7)
    return max(0.0, score)


def _colorfulness(bgr):
    b, g, r = cv2.split(bgr.astype(np.float32))
    rg = np.abs(r - g)
    yb = np.abs(0.5 * (r + g) - b)
    value = np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
    return float(value)


def _saliency(gray):
    """勾配ベースの簡易サリエンシー。主題の位置と広がりを見る。"""
    small = cv2.resize(gray, (96, 54) if gray.shape[1] >= gray.shape[0] else (54, 96),
                       interpolation=cv2.INTER_AREA)
    gx = cv2.Sobel(small, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(small, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.GaussianBlur(cv2.magnitude(gx, gy), (0, 0), 3.0)
    total = float(mag.sum())
    if total <= 1e-6:
        return 0.5, 0.5, 0.0, 0.0

    h, w = mag.shape
    ys, xs = np.mgrid[0:h, 0:w]
    cx = float((mag * xs).sum() / total) / max(1, w - 1)
    cy = float((mag * ys).sum() / total) / max(1, h - 1)

    left = float(mag[:, : w // 2].sum())
    right = float(mag[:, w - w // 2:].sum())
    balance = 1.0 - abs(left - right) / max(1e-6, left + right)

    detail = float(mag.mean())
    return cx, cy, balance, detail


def _composition(cx, cy, balance):
    """三分割 or 中央に主題があるほど高得点。端に寄りすぎは減点。"""
    anchors = [(1 / 3.0, 1 / 3.0), (2 / 3.0, 1 / 3.0), (1 / 3.0, 2 / 3.0),
               (2 / 3.0, 2 / 3.0), (0.5, 0.5), (0.5, 1 / 3.0), (0.5, 2 / 3.0)]
    dist = min(((cx - ax) ** 2 + (cy - ay) ** 2) ** 0.5 for ax, ay in anchors)
    placement = max(0.0, 1.0 - dist / 0.42)
    edge_pen = 0.0
    if cx < 0.12 or cx > 0.88:
        edge_pen += 0.25
    if cy < 0.10 or cy > 0.90:
        edge_pen += 0.2
    return max(0.0, min(1.0, 0.65 * placement + 0.35 * balance - edge_pen))


def _faces(gray):
    front, profile = _face_cascades()
    h, w = gray.shape
    scale = 320.0 / max(1, w)
    small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) \
        if scale < 1.0 else gray
    small = cv2.equalizeHist(small)
    boxes = []
    for cascade in (front, profile):
        if cascade is None or cascade.empty():
            continue
        try:
            found = cascade.detectMultiScale(small, scaleFactor=1.12, minNeighbors=5,
                                             minSize=(24, 24))
        except cv2.error:
            found = []
        for (x, y, fw, fh) in found:
            boxes.append((x, y, fw, fh))
    if not boxes:
        return 0.0, 0
    area = float(max(fw * fh for (_, _, fw, fh) in boxes))
    ratio = area / float(small.shape[0] * small.shape[1])
    # 顔が大きすぎても小さすぎても構図的にはピークではない
    quality = min(1.0, (ratio / 0.10) ** 0.5) if ratio < 0.10 else max(0.35, 1.0 - (ratio - 0.10) * 1.6)
    return float(max(0.0, min(1.0, quality))), len(boxes)


def _norm(values):
    arr = np.asarray(values, dtype=np.float32)
    lo, hi = float(arr.min()), float(arr.max())
    if hi - lo < 1e-6:
        return np.ones_like(arr) * 0.5
    return (arr - lo) / (hi - lo)


def pick_candidates(frames, cut, meta, fps, count=9):
    """1 カットからフレーム候補を選び、ローカル採点して降順で返す。"""
    start, end = cut["start_frame"], cut["end_frame"]
    length = end - start + 1
    scores = meta["scores"]
    black = meta["black"]

    # 転換直後・直前は避ける（残像・モーションブラー・トランジションの途中）
    pad = int(round(min(max(1, length * 0.12), max(1, fps * 0.12))))
    lo = min(start + pad, end)
    hi = max(end - pad, lo)
    if hi <= lo:
        lo, hi = start, end

    usable = [i for i in range(lo, hi + 1) if not black[i]]
    if not usable:
        usable = list(range(start, end + 1))

    n_take = int(max(3, min(count, len(usable))))
    if len(usable) <= n_take:
        indices = usable
    else:
        picks = np.linspace(0, len(usable) - 1, n_take)
        indices = sorted(set(usable[int(round(p))] for p in picks))

    raw = []
    for idx in indices:
        frame = frames[idx]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        cx, cy, balance, detail = _saliency(gray)
        face_q, face_n = _faces(gray)

        window = scores[max(1, idx - 2):min(len(scores), idx + 3)]
        motion = float(window.mean()) if window.size else 0.0

        rel = (idx - start) / float(max(1, length - 1))
        # カットの真ん中〜やや後ろが「決まった瞬間」になりやすい
        position = float(np.exp(-((rel - 0.52) ** 2) / (2 * 0.30 ** 2)))

        raw.append({
            "frame_index": idx,
            "time": (idx + 0.5) / float(fps),
            "sharpness": _sharpness(gray),
            "exposure": _exposure(gray),
            "colorfulness": _colorfulness(frame),
            "composition": _composition(cx, cy, balance),
            "detail": detail,
            "face_quality": face_q,
            "face_count": face_n,
            "motion": motion,
            "position": position,
            "rel": rel,
        })

    sharp_n = _norm([c["sharpness"] for c in raw])
    color_n = _norm([c["colorfulness"] for c in raw])
    detail_n = _norm([c["detail"] for c in raw])
    motion_n = _norm([c["motion"] for c in raw])

    for i, cand in enumerate(raw):
        face_bonus = 0.18 * cand["face_quality"] if cand["face_count"] else 0.0
        cand["local_score"] = float(
            0.26 * sharp_n[i]
            + 0.20 * cand["composition"]
            + 0.16 * cand["exposure"]
            + 0.10 * detail_n[i]
            + 0.08 * color_n[i]
            + 0.10 * cand["position"]
            - 0.12 * motion_n[i]
            + face_bonus
        )

    raw.sort(key=lambda c: c["local_score"], reverse=True)
    return raw
