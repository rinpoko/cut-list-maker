/* 各カットから「良い瞬間」の候補を選んで採点する。cutgrab/score.py の移植。
 *
 * ここは一次選抜。明らかにダメなフレーム（ブレ、露出破綻、転換の途中）を
 * 落として上位だけを AI に渡す。
 * デスクトップ版にあった顔検出（OpenCV の Haar）はブラウザに無いので外した。
 * 最終的な一枚は AI が選ぶので、実用上の差は小さい。
 */

export const SCORE_W = 384;

function toGray(rgba, px) {
  const gray = new Float32Array(px);
  for (let i = 0; i < px; i++) {
    gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return gray;
}

/** ラプラシアンの分散。ピントとブレの指標。 */
function sharpness(gray, w, h) {
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v; sumSq += v * v; count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** 白飛び・黒つぶれ・眠い絵にペナルティ。1.0 が理想。 */
function exposure(gray, px) {
  let hi = 0, lo = 0, sum = 0;
  for (let i = 0; i < px; i++) {
    const v = gray[i];
    if (v > 250) hi++;
    if (v < 5) lo++;
    sum += v;
  }
  const mean = sum / px;
  const meanPenalty = Math.abs(mean - 118) / 118;
  const score = 1
    - Math.min(1, (hi / px) * 2.2)
    - Math.min(1, (lo / px) * 1.4)
    - Math.min(0.7, meanPenalty * 0.7);
  return Math.max(0, score);
}

/** Hasler-Süsstrunk の colorfulness。 */
function colorfulness(rgba, px) {
  let rgSum = 0, rgSq = 0, ybSum = 0, ybSq = 0;
  for (let i = 0; i < px; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const rg = Math.abs(r - g);
    const yb = Math.abs(0.5 * (r + g) - b);
    rgSum += rg; rgSq += rg * rg;
    ybSum += yb; ybSq += yb * yb;
  }
  const rgMean = rgSum / px, ybMean = ybSum / px;
  const rgStd = Math.sqrt(Math.max(0, rgSq / px - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSq / px - ybMean * ybMean));
  return Math.sqrt(rgStd * rgStd + ybStd * ybStd)
       + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean);
}

function gaussianBlur(src, w, h, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v; total += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(w - 1, Math.max(0, x + k));
        acc += src[y * w + sx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[sy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** 勾配ベースの簡易サリエンシー。主題の位置と広がりを見る。 */
function saliency(gray, w, h) {
  const sw = w >= h ? 96 : 54;
  const sh = w >= h ? 54 : 96;
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / sh));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / sw));
      small[y * sw + x] = gray[sy * w + sx];
    }
  }
  const mag = new Float32Array(sw * sh);
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const gx = small[i - sw + 1] + 2 * small[i + 1] + small[i + sw + 1]
               - small[i - sw - 1] - 2 * small[i - 1] - small[i + sw - 1];
      const gy = small[i + sw - 1] + 2 * small[i + sw] + small[i + sw + 1]
               - small[i - sw - 1] - 2 * small[i - sw] - small[i - sw + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  const blurred = gaussianBlur(mag, sw, sh, 3);
  let total = 0, mx = 0, my = 0, left = 0, right = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = blurred[y * sw + x];
      total += v; mx += v * x; my += v * y;
      if (x < sw / 2) left += v; else right += v;
    }
  }
  if (total <= 1e-6) return { cx: 0.5, cy: 0.5, balance: 0, detail: 0 };
  return {
    cx: (mx / total) / Math.max(1, sw - 1),
    cy: (my / total) / Math.max(1, sh - 1),
    balance: 1 - Math.abs(left - right) / Math.max(1e-6, left + right),
    detail: total / (sw * sh),
  };
}

/** 三分割 or 中央に主題があるほど高得点。端に寄りすぎは減点。 */
function composition(cx, cy, balance) {
  const anchors = [[1 / 3, 1 / 3], [2 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 2 / 3],
                   [0.5, 0.5], [0.5, 1 / 3], [0.5, 2 / 3]];
  let dist = Infinity;
  for (const [ax, ay] of anchors) {
    dist = Math.min(dist, Math.hypot(cx - ax, cy - ay));
  }
  const placement = Math.max(0, 1 - dist / 0.42);
  let edge = 0;
  if (cx < 0.12 || cx > 0.88) edge += 0.25;
  if (cy < 0.10 || cy > 0.90) edge += 0.2;
  return Math.max(0, Math.min(1, 0.65 * placement + 0.35 * balance - edge));
}

/** 1 フレーム分の素の指標。 */
export function frameMetrics(rgba, w, h) {
  const px = w * h;
  const gray = toGray(rgba, px);
  const { cx, cy, balance, detail } = saliency(gray, w, h);
  return {
    sharpness: sharpness(gray, w, h),
    exposure: exposure(gray, px),
    colorfulness: colorfulness(rgba, px),
    composition: composition(cx, cy, balance),
    detail,
  };
}

/** そのカットから候補にするフレーム番号を選ぶ。 */
export function candidateIndices(cut, meta, fps, count = 9) {
  const { startFrame: start, endFrame: end } = cut;
  const length = end - start + 1;
  const black = meta.blackish;

  // 転換直後・直前は避ける（残像・モーションブラー・トランジションの途中）
  const pad = Math.round(Math.min(Math.max(1, length * 0.12), Math.max(1, fps * 0.12)));
  let lo = Math.min(start + pad, end);
  let hi = Math.max(end - pad, lo);
  if (hi <= lo) { lo = start; hi = end; }

  let usable = [];
  for (let i = lo; i <= hi; i++) if (!black[i]) usable.push(i);
  if (!usable.length) {
    usable = [];
    for (let i = start; i <= end; i++) usable.push(i);
  }

  const take = Math.max(3, Math.min(count, usable.length));
  if (usable.length <= take) return usable;
  const picked = new Set();
  for (let i = 0; i < take; i++) {
    const at = Math.round(i * (usable.length - 1) / (take - 1));
    picked.add(usable[at]);
  }
  return [...picked].sort((a, b) => a - b);
}

function normalize(values) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 1e-6) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * 1カット分の候補を採点して、良い順に並べ替える。
 * candidates: [{frameIndex, time, metrics, motion, rel}]
 */
export function rankCandidates(candidates) {
  const sharp = normalize(candidates.map((c) => c.metrics.sharpness));
  const color = normalize(candidates.map((c) => c.metrics.colorfulness));
  const detail = normalize(candidates.map((c) => c.metrics.detail));
  const motion = normalize(candidates.map((c) => c.motion));

  candidates.forEach((c, i) => {
    // カットの真ん中〜やや後ろが「決まった瞬間」になりやすい
    const position = Math.exp(-Math.pow(c.rel - 0.52, 2) / (2 * 0.30 * 0.30));
    c.position = position;
    c.localScore = 0.26 * sharp[i]
                 + 0.20 * c.metrics.composition
                 + 0.16 * c.metrics.exposure
                 + 0.10 * detail[i]
                 + 0.08 * color[i]
                 + 0.10 * position
                 - 0.12 * motion[i];
  });
  return [...candidates].sort((a, b) => b.localScore - a.localScore);
}
