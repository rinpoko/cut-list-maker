/* カット（ショット）の切り替わり検出。cutgrab/detect.py の移植。
 *
 * ハードカット / フラッシュ / 黒み / ディゾルブ をまとめて拾ったうえで、
 * 「境界の前後が本当に別の絵か」を色分布で確かめ、同じショット内の
 * 動きで割れたものを捨てる。
 */

export const ANALYSIS_W = 160;

/** OpenCV と同じ BGR2HSV（H:0-179, S/V:0-255）。入力は RGB。 */
function rgbToHsv(r, g, b, out, at) {
  const v = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const delta = v - min;
  let h = 0;
  if (delta !== 0) {
    if (v === r) h = 60 * (g - b) / delta;
    else if (v === g) h = 120 + 60 * (b - r) / delta;
    else h = 240 + 60 * (r - g) / delta;
    if (h < 0) h += 360;
  }
  out[at] = Math.round(h / 2);
  out[at + 1] = v === 0 ? 0 : Math.round(delta * 255 / v);
  out[at + 2] = v;
}

/** 解析用に縮小した RGB フレームをためておく入れ物。 */
export class FrameStore {
  constructor(width, height, capacity) {
    this.width = width;
    this.height = height;
    this.stride = width * height * 3;
    this.data = new Uint8Array(this.stride * capacity);
    this.count = 0;
    this.lumaMean = [];
    this.lumaStd = [];
  }

  /** RGBA の ImageData を 1 枚受け取って RGB で保存する。 */
  push(rgba) {
    const base = this.stride * this.count;
    const px = this.width * this.height;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < px; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      this.data[base + i * 3] = r;
      this.data[base + i * 3 + 1] = g;
      this.data[base + i * 3 + 2] = b;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += y; sumSq += y * y;
    }
    const mean = sum / px;
    this.lumaMean.push(mean);
    this.lumaStd.push(Math.sqrt(Math.max(0, sumSq / px - mean * mean)));
    this.count++;
  }

  hsv(index, out) {
    const base = this.stride * index;
    const px = this.width * this.height;
    for (let i = 0; i < px; i++) {
      rgbToHsv(this.data[base + i * 3], this.data[base + i * 3 + 1],
               this.data[base + i * 3 + 2], out, i * 3);
    }
    return out;
  }

  newHsvBuffer() {
    return new Uint8Array(this.width * this.height * 3);
  }
}

/** 2 フレーム間の変化量（0-255）。色相は循環を考慮する。 */
function pairScore(a, b, px) {
  let dh = 0, ds = 0, dv = 0;
  for (let i = 0; i < px; i++) {
    let d = Math.abs(a[i * 3] - b[i * 3]);
    if (d > 90) d = 180 - d;
    dh += d;
    ds += Math.abs(a[i * 3 + 1] - b[i * 3 + 1]);
    dv += Math.abs(a[i * 3 + 2] - b[i * 3 + 2]);
  }
  return ((dh * (255 / 180)) + ds + dv) / (3 * px);
}

/** 隣接フレーム間の変化量と、黒み／白味の判定。 */
export function frameScores(store) {
  const n = store.count;
  const px = store.width * store.height;
  const scores = new Float32Array(n);
  let prev = store.newHsvBuffer();
  let curr = store.newHsvBuffer();
  if (n > 0) store.hsv(0, prev);
  for (let i = 1; i < n; i++) {
    store.hsv(i, curr);
    scores[i] = pairScore(prev, curr, px);
    const swap = prev; prev = curr; curr = swap;
  }
  const blackish = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = store.lumaMean[i], s = store.lumaStd[i];
    blackish[i] = ((m < 14 && s < 10) || (m > 242 && s < 10)) ? 1 : 0;
  }
  return { scores, blackish };
}

function hardCuts(scores, threshold, into) {
  for (let i = 1; i < scores.length; i++) if (scores[i] >= threshold) into.add(i);
}

/** 周囲と比べて突出したフレーム。動きの多い映像で取りこぼしにくくする。 */
function adaptiveCuts(scores, threshold, into, window = 4) {
  const n = scores.length;
  const floor = Math.max(6, threshold * 0.35);
  for (let i = 2; i < n - 1; i++) {
    if (scores[i] < floor) continue;
    const lo = Math.max(1, i - window), hi = Math.min(n, i + window + 1);
    let sum = 0, count = 0;
    for (let j = lo; j < hi; j++) {
      if (Math.abs(j - i) > 1) { sum += scores[j]; count++; }
    }
    if (!count) continue;
    if (scores[i] >= Math.max(3 * (sum / count), floor)) into.add(i);
  }
}

/** ディゾルブ／ワイプなど、数フレームかけて変わる転換。 */
function gradualCuts(store, scores, threshold, fps, into) {
  const n = scores.length;
  const px = store.width * store.height;
  const span = Math.round(Math.max(3, Math.min(12, fps * 0.3)));
  if (n < span * 2 + 2) return;

  const longScores = new Float32Array(n);
  const a = store.newHsvBuffer(), b = store.newHsvBuffer();
  for (let i = span; i < n - span; i++) {
    store.hsv(i - span, a);
    store.hsv(i + span, b);
    longScores[i] = pairScore(a, b, px);
  }
  const limit = threshold * 0.95;
  for (let i = span; i < n - span; i++) {
    if (longScores[i] < limit) continue;
    let peak = 0;
    for (let j = Math.max(1, i - span); j < Math.min(n, i + span + 1); j++) {
      if (scores[j] > peak) peak = scores[j];
    }
    if (peak >= threshold) continue;   // ハードカット側で拾える
    let localMax = 0;
    for (let j = Math.max(span, i - span); j < Math.min(n - span, i + span + 1); j++) {
      if (longScores[j] > localMax) localMax = longScores[j];
    }
    if (longScores[i] < localMax - 1e-6) continue;
    into.add(i);
  }
}

/* -------- 境界の前後が本当に別の絵かを色分布で確かめる -------- */

const HIST_W = 96, HIST_H = 54;
const H_BINS = 12, S_BINS = 6, V_BINS = 6;

function sceneHist(store, indices) {
  const bins = new Float64Array(H_BINS * S_BINS * V_BINS);
  const sw = store.width, sh = store.height;
  for (const index of indices) {
    const base = store.stride * index;
    for (let y = 0; y < HIST_H; y++) {
      const sy = Math.min(sh - 1, Math.floor(y * sh / HIST_H));
      for (let x = 0; x < HIST_W; x++) {
        const sx = Math.min(sw - 1, Math.floor(x * sw / HIST_W));
        const at = base + (sy * sw + sx) * 3;
        const tmp = new Uint8Array(3);
        rgbToHsv(store.data[at], store.data[at + 1], store.data[at + 2], tmp, 0);
        const hb = Math.min(H_BINS - 1, Math.floor(tmp[0] * H_BINS / 180));
        const sb = Math.min(S_BINS - 1, Math.floor(tmp[1] * S_BINS / 256));
        const vb = Math.min(V_BINS - 1, Math.floor(tmp[2] * V_BINS / 256));
        bins[(hb * S_BINS + sb) * V_BINS + vb] += 1;
      }
    }
  }
  let min = Infinity, max = -Infinity;
  for (const v of bins) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min;
  if (range > 0) for (let i = 0; i < bins.length; i++) bins[i] = (bins[i] - min) / range;
  return bins;
}

/** cv2.compareHist の HISTCMP_BHATTACHARYYA と同じ式。 */
function bhattacharyya(h1, h2) {
  let sum1 = 0, sum2 = 0, cross = 0;
  for (let i = 0; i < h1.length; i++) { sum1 += h1[i]; sum2 += h2[i]; }
  const n = h1.length;
  const mean1 = sum1 / n, mean2 = sum2 / n;
  for (let i = 0; i < n; i++) cross += Math.sqrt(h1[i] * h2[i]);
  const denom = Math.sqrt(mean1 * mean2 * n * n);
  if (denom <= 0) return 1;
  return Math.sqrt(Math.max(0, 1 - cross / denom));
}

function verifyBoundaries(store, boundaries, scores, blackish, threshold,
                          minDistance = 0.24, span = 4) {
  const keep = new Set();
  const n = store.count;
  for (const index of [...boundaries].sort((a, b) => a - b)) {
    const pre = [], post = [];
    for (let j = Math.max(0, index - span); j < index; j++) if (!blackish[j]) pre.push(j);
    for (let j = index; j < Math.min(n, index + span); j++) if (!blackish[j]) post.push(j);
    if (!pre.length || !post.length) { keep.add(index); continue; }
    if (scores[index] >= threshold * 2.2) { keep.add(index); continue; }
    const distance = bhattacharyya(sceneHist(store, pre), sceneHist(store, post));
    if (distance >= minDistance) keep.add(index);
  }
  return keep;
}

function mergeClose(cuts, minGap) {
  const merged = [];
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (merged.length && cut - merged[merged.length - 1] < minGap) continue;
    merged.push(cut);
  }
  return merged;
}

/**
 * カットのリストを返す。
 * [{index, startFrame, endFrame, startTime, endTime, duration}, ...]
 */
export function detectCuts(store, times, fps, { threshold = 27, minCutSeconds = 0.3 } = {}) {
  const n = store.count;
  const { scores, blackish } = frameScores(store);
  const minGap = Math.max(2, Math.round(minCutSeconds * fps));

  const boundaries = new Set();
  hardCuts(scores, threshold, boundaries);
  adaptiveCuts(scores, threshold, boundaries);
  gradualCuts(store, scores, threshold, fps, boundaries);
  for (let i = 1; i < n; i++) if (blackish[i] !== blackish[i - 1]) boundaries.add(i);

  const inRange = new Set([...boundaries].filter((b) => b > 0 && b < n));
  const verified = verifyBoundaries(store, inRange, scores, blackish, threshold);
  const ordered = mergeClose(verified, minGap);

  const starts = [0, ...ordered];
  const raw = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : n - 1;
    if (end >= start) raw.push([start, end]);
  }

  const cleaned = [];
  for (const [start, end] of raw) {
    let black = 0;
    for (let i = start; i <= end; i++) black += blackish[i];
    if (end >= start && black / (end - start + 1) > 0.8) continue;   // まっ黒／まっ白な間
    if (cleaned.length && (end - start + 1) < minGap) {
      cleaned[cleaned.length - 1][1] = end;
      continue;
    }
    cleaned.push([start, end]);
  }
  if (!cleaned.length) cleaned.push([0, n - 1]);

  const frameDuration = 1 / fps;
  const timeAt = (i) => (times && times[i] != null ? times[i] : i / fps);
  return {
    cuts: cleaned.map(([start, end], i) => ({
      index: i + 1,
      startFrame: start,
      endFrame: end,
      startTime: timeAt(start),
      endTime: timeAt(end) + frameDuration,
      duration: timeAt(end) + frameDuration - timeAt(start),
    })),
    meta: { scores, blackish },
  };
}
