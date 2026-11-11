"""カット（ショット）の切り替わり検出。

ハードカット / フラッシュ / 黒み / ディゾルブ（じわっと変わる転換）を
まとめて拾えるように、3 つの判定を併用している。
"""

import cv2
import numpy as np


def _analysis_stack(frames, width=160):
    """検出用にさらに縮小した HSV スタックを作る。"""
    src_h, src_w = frames[0].shape[:2]
    scale = min(1.0, float(width) / src_w)
    out_w = max(32, int(round(src_w * scale)))
    out_h = max(32, int(round(src_h * scale)))

    hsv = np.empty((len(frames), out_h, out_w, 3), dtype=np.int16)
    gray = np.empty((len(frames), out_h, out_w), dtype=np.uint8)
    for i, frame in enumerate(frames):
        small = cv2.resize(frame, (out_w, out_h), interpolation=cv2.INTER_AREA)
        hsv[i] = cv2.cvtColor(small, cv2.COLOR_BGR2HSV).astype(np.int16)
        gray[i] = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    return hsv, gray


def _pair_score(a, b):
    """2 フレーム間の変化量 (0-255 スケール)。色相は循環を考慮。"""
    dh = np.abs(a[:, :, 0] - b[:, :, 0])
    dh = np.minimum(dh, 180 - dh) * (255.0 / 180.0)
    ds = np.abs(a[:, :, 1] - b[:, :, 1])
    dv = np.abs(a[:, :, 2] - b[:, :, 2])
    return float((dh.mean() + ds.mean() + dv.mean()) / 3.0)


def frame_scores(frames):
    """隣接フレーム間の変化量の配列を返す。scores[i] = frame[i-1] -> frame[i]。"""
    hsv, gray = _analysis_stack(frames)
    n = len(frames)
    scores = np.zeros(n, dtype=np.float32)
    for i in range(1, n):
        scores[i] = _pair_score(hsv[i - 1], hsv[i])

    luma_mean = gray.reshape(n, -1).mean(axis=1)
    luma_std = gray.reshape(n, -1).std(axis=1)
    is_black = (luma_mean < 14.0) & (luma_std < 10.0)
    is_white = (luma_mean > 242.0) & (luma_std < 10.0)
    return scores, hsv, luma_mean, luma_std, is_black | is_white


def _hard_cuts(scores, threshold):
    cuts = set()
    n = len(scores)
    for i in range(1, n):
        if scores[i] >= threshold:
            cuts.add(i)
    return cuts


def _adaptive_cuts(scores, threshold, window=4):
    """周囲と比べて突出したフレームを拾う（動きの多い映像でも取りこぼしにくい）。"""
    cuts = set()
    n = len(scores)
    floor = max(6.0, threshold * 0.35)
    for i in range(2, n - 1):
        if scores[i] < floor:
            continue
        lo = max(1, i - window)
        hi = min(n, i + window + 1)
        neighbours = [scores[j] for j in range(lo, hi) if abs(j - i) > 1]
        if not neighbours:
            continue
        base = float(np.mean(neighbours))
        if scores[i] >= max(3.0 * base, floor):
            cuts.add(i)
    return cuts


def _gradual_cuts(scores, hsv, threshold, fps):
    """ディゾルブ／ワイプなど、数フレームかけて変わる転換を拾う。"""
    n = len(scores)
    span = int(round(max(3, min(12, fps * 0.3))))
    if n < span * 2 + 2:
        return set()

    long_scores = np.zeros(n, dtype=np.float32)
    for i in range(span, n - span):
        long_scores[i] = _pair_score(hsv[i - span], hsv[i + span])

    cuts = set()
    limit = threshold * 0.95
    for i in range(span, n - span):
        if long_scores[i] < limit:
            continue
        window = scores[max(1, i - span):min(n, i + span + 1)]
        if window.size == 0 or window.max() >= threshold:
            continue  # ハードカット側で拾える
        lo = max(span, i - span)
        hi = min(n - span, i + span + 1)
        if long_scores[i] < long_scores[lo:hi].max() - 1e-6:
            continue  # 局所ピークのみ
        cuts.add(i)
    return cuts


def _scene_hist(frames, indices):
    """数フレームぶんの HSV ヒストグラム。位置に依らず「どんな絵か」を表す。"""
    acc = None
    for i in indices:
        small = cv2.resize(frames[i], (96, 54), interpolation=cv2.INTER_AREA)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1, 2], None, [12, 6, 6],
                            [0, 180, 0, 256, 0, 256])
        acc = hist if acc is None else acc + hist
    cv2.normalize(acc, acc, 0, 1, cv2.NORM_MINMAX)
    return acc


def _verify_boundaries(frames, boundaries, scores, blackish, threshold,
                       min_distance=0.24, span=4):
    """境界の前後が「別の絵」になっているかを確かめて、そうでないものを捨てる。

    速いカメラワークや動きの激しいショット、数字がアニメーションするテロップなどでは
    隣接フレーム差分が跳ねるため、1 つのショットが細切れに割れてしまう。
    本物のカットは前後で絵そのものが変わるので、色分布を比べれば見分けられる。
    """
    keep = set()
    n = len(frames)
    for index in sorted(boundaries):
        pre = [j for j in range(max(0, index - span), index) if not blackish[j]]
        post = [j for j in range(index, min(n, index + span)) if not blackish[j]]
        if not pre or not post:
            keep.add(index)          # 黒みがらみは検証せずに残す
            continue
        if scores[index] >= threshold * 2.2:
            keep.add(index)          # 明らかなハードカット
            continue
        distance = cv2.compareHist(_scene_hist(frames, pre), _scene_hist(frames, post),
                                   cv2.HISTCMP_BHATTACHARYYA)
        if distance >= min_distance:
            keep.add(index)
    return keep


def _merge_close(cuts, min_gap):
    """近すぎる境界をまとめる。"""
    merged = []
    for cut in sorted(cuts):
        if merged and cut - merged[-1] < min_gap:
            continue
        merged.append(cut)
    return merged


def detect_cuts(frames, fps, threshold=27.0, min_cut_seconds=0.30):
    """カットのリストを返す。

    戻り値: (cuts, meta)
      cuts: [{"index", "start_frame", "end_frame", "start_time", "end_time", "duration"}, ...]
      meta: {"scores", "black", "luma_mean"}
    """
    n = len(frames)
    scores, hsv, luma_mean, luma_std, blackish = frame_scores(frames)
    min_gap = max(2, int(round(min_cut_seconds * fps)))

    boundaries = set()
    boundaries |= _hard_cuts(scores, threshold)
    boundaries |= _adaptive_cuts(scores, threshold)
    boundaries |= _gradual_cuts(scores, hsv, threshold, fps)

    # 黒み・白味の入り／抜けも境界として扱う
    for i in range(1, n):
        if blackish[i] != blackish[i - 1]:
            boundaries.add(i)

    boundaries = set(b for b in boundaries if 0 < b < n)
    boundaries = _verify_boundaries(frames, boundaries, scores, blackish, threshold)
    ordered = _merge_close(boundaries, min_gap)

    starts = [0] + ordered
    cuts = []
    for idx, start in enumerate(starts):
        end = (starts[idx + 1] - 1) if idx + 1 < len(starts) else (n - 1)
        if end < start:
            continue
        cuts.append([start, end])

    # 黒みだけのカット、極端に短いカットを整理
    cleaned = []
    for start, end in cuts:
        segment = blackish[start:end + 1]
        if segment.size and segment.mean() > 0.8:
            continue  # 全部まっ黒／まっ白 → カットではなく間
        if cleaned and (end - start + 1) < min_gap:
            cleaned[-1][1] = end
            continue
        cleaned.append([start, end])

    if not cleaned:
        cleaned = [[0, n - 1]]

    result = []
    for i, (start, end) in enumerate(cleaned):
        result.append({
            "index": i + 1,
            "start_frame": start,
            "end_frame": end,
            "start_time": start / float(fps),
            "end_time": (end + 1) / float(fps),
            "duration": (end - start + 1) / float(fps),
        })

    meta = {"scores": scores, "black": blackish, "luma_mean": luma_mean, "luma_std": luma_std}
    return result, meta
