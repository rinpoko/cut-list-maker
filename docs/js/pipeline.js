/* 処理全体の流れ。1 本の動画 → カット検出 → ベストフレーム選定 →
 * ト書き → ナレーション → 書き出し。cutgrab/pipeline.py の移植。
 *
 * ブラウザのメモリに全フレームの原寸を置くことはできないので、デコードを
 * 3 回に分けている（WebCodecs はハードウェア再生なので速い）。
 *   1 回目  160px に縮めて全フレーム  … カット検出
 *   2 回目  候補フレームだけ 384px   … 採点とコンタクトシート
 *   3 回目  採用フレームだけ原寸      … 書き出し
 */

import { decodeFrames } from './decode.js';
import { FrameStore, detectCuts, ANALYSIS_W } from './detect.js';
import { candidateIndices, frameMetrics, rankCandidates, SCORE_W } from './score.js';
import { candidateSheet, blobToBase64, resultSheet } from './sheet.js';
import { extractAudioWav, toBase64 } from './audio.js';
import { assignNarration } from './narration.js';
import * as gemini from './gemini.js';

const SHEET_TILE_W = 440;
const DIRECTION_W = 896;

function makeCanvas(w, h) {
  const canvas = new OffscreenCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}

function frameSize(frame) {
  return {
    width: frame.displayWidth || frame.codedWidth || frame.width,
    height: frame.displayHeight || frame.codedHeight || frame.height,
  };
}

function scaled(width, height, target) {
  const w = Math.max(2, Math.round(target));
  const h = Math.max(2, Math.round(target * height / width));
  return [w, h];
}

export async function processVideo(file, cfg, { log = () => {}, progress = () => {} } = {}) {
  const started = performance.now();
  const report = (fraction, message) => progress(Math.max(0, Math.min(1, fraction)), message);

  log(`■ ${file.name}`);

  /* ---------- 1回目：全フレームを縮小して読み込み、カットを検出 ---------- */
  report(0.02, '動画を読み込み中…');
  let store = null;
  let small = null;
  const times = [];

  const info = await decodeFrames(file, {
    onProgress: (p) => report(0.02 + 0.30 * p, '動画を読み込み中…'),
    onFrame: (index, time, frame) => {
      const { width, height } = frameSize(frame);
      if (!small) {
        const [w, h] = scaled(width, height, ANALYSIS_W);
        small = makeCanvas(w, h);
        store = new FrameStore(w, h, 1);
      }
      if (store.count * store.stride >= store.data.length) {
        const grown = new Uint8Array(Math.max(store.data.length * 2, store.stride * 64));
        grown.set(store.data);
        store.data = grown;
      }
      small.ctx.drawImage(frame, 0, 0, small.canvas.width, small.canvas.height);
      store.push(small.ctx.getImageData(0, 0, small.canvas.width, small.canvas.height).data);
      times.push(time);
    },
  });

  if (!store || !store.count) throw new Error('フレームを取り出せませんでした');
  const fps = info.fps;
  log(`  ${info.width}x${info.height} / ${fps.toFixed(2)} fps / ${info.duration.toFixed(2)} 秒 / ${info.codec}`);
  log(`  解析用フレーム: ${store.count} 枚 (${store.width}x${store.height})`);

  report(0.34, 'カットの切り替わりを検出中…');
  const { cuts, meta } = detectCuts(store, times, fps, {
    threshold: Number(cfg.sensitivity) || 27,
    minCutSeconds: Number(cfg.minCutSeconds) || 0.3,
  });
  log(`  → ${cuts.length} カットを検出`);
  store.data = null;   // 検出が終わったら解放（黒み判定だけ meta に残る）

  /* ---------- 2回目：候補フレームを採点 ---------- */
  report(0.36, '各カットの候補フレームを採点中…');
  const perCut = cuts.map((cut) => ({
    cut,
    indices: candidateIndices(cut, meta, fps, Number(cfg.candidatesPerCut) || 9),
    candidates: [],
  }));
  const wanted = new Set();
  const owner = new Map();
  perCut.forEach((entry) => {
    for (const index of entry.indices) { wanted.add(index); owner.set(index, entry); }
  });

  let scoreCanvas = null;
  let sheetCanvas = null;
  let done = 0;
  await decodeFrames(file, {
    wanted,
    onProgress: (p) => report(0.36 + 0.16 * p, '候補を採点中…'),
    onFrame: async (index, time, frame) => {
      const entry = owner.get(index);
      if (!entry) return;
      const { width, height } = frameSize(frame);
      if (!scoreCanvas) {
        scoreCanvas = makeCanvas(...scaled(width, height, SCORE_W));
        sheetCanvas = makeCanvas(...scaled(width, height, SHEET_TILE_W));
      }
      scoreCanvas.ctx.drawImage(frame, 0, 0, scoreCanvas.canvas.width, scoreCanvas.canvas.height);
      const image = scoreCanvas.ctx.getImageData(0, 0, scoreCanvas.canvas.width, scoreCanvas.canvas.height);

      sheetCanvas.ctx.drawImage(frame, 0, 0, sheetCanvas.canvas.width, sheetCanvas.canvas.height);
      const thumb = await sheetCanvas.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });

      const length = entry.cut.endFrame - entry.cut.startFrame + 1;
      const lo = Math.max(1, index - 2), hi = Math.min(meta.scores.length, index + 3);
      let motion = 0;
      for (let j = lo; j < hi; j++) motion += meta.scores[j];
      motion /= Math.max(1, hi - lo);

      entry.candidates.push({
        frameIndex: index,
        time,
        metrics: frameMetrics(image.data, image.width, image.height),
        motion,
        rel: (index - entry.cut.startFrame) / Math.max(1, length - 1),
        thumb,
      });
      done++;
      if (done % 10 === 0) report(0.36 + 0.16 * (done / wanted.size), `候補を採点中… (${done}/${wanted.size})`);
    },
  });

  perCut.forEach((entry) => { entry.candidates = rankCandidates(entry.candidates); });

  /* ---------- AI による最終選定 ---------- */
  const shortlistSize = Math.max(2, Number(cfg.aiShortlist) || 6);
  const apiKey = (cfg.apiKey || '').trim();
  const useAi = cfg.useAi !== false && !!apiKey;
  const aiState = {};
  let aiModel = '';
  let aiChoice = {};

  perCut.forEach((entry) => {
    entry.shortlist = entry.candidates.slice(0, shortlistSize)
      .sort((a, b) => a.frameIndex - b.frameIndex);
  });

  if (useAi) {
    report(0.54, 'AI にベストな瞬間を判定してもらっています…');
    try {
      aiModel = cfg.model || gemini.DEFAULT_MODEL;
      log(`  AI 判定: ${aiModel}`);
      const shots = [];
      for (const entry of perCut) {
        const bitmaps = await Promise.all(entry.shortlist.map((c) => createImageBitmap(c.thumb)));
        shots.push({
          cut: entry.cut.index,
          count: bitmaps.length,
          jpegBase64: await candidateSheet(bitmaps),
        });
        bitmaps.forEach((b) => b.close());
      }
      aiChoice = await gemini.selectBestFrames(apiKey, aiModel, shots, log, aiState);
      aiModel = aiState.model || aiModel;
      log(`  → AI が ${Object.keys(aiChoice).length} カット分を選定`);
    } catch (err) {
      log(`  ⚠ AI 判定をスキップしました: ${err.message}`);
      aiChoice = {};
    }
  } else if (!apiKey) {
    log('  （API キー未設定のため、ローカル判定のみで選定します）');
  }

  /* ---------- 3回目：採用フレームを原寸で書き出し ---------- */
  report(0.66, '画像を書き出し中…');
  const ext = cfg.imageFormat === 'jpg' ? 'jpg' : 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = ext === 'jpg' ? (Number(cfg.jpegQuality) || 95) / 100 : undefined;

  const picks = [];
  const chosenByFrame = new Map();
  for (const entry of perCut) {
    let chosen = entry.candidates[0];
    let source = 'local';
    let reason = '';
    const sel = aiChoice[entry.cut.index];
    if (sel && Number.isInteger(sel.best) && sel.best >= 1 && sel.best <= entry.shortlist.length) {
      chosen = entry.shortlist[sel.best - 1];
      source = 'ai';
      reason = sel.reason || '';
    }
    const pick = {
      cut: entry.cut.index,
      time: chosen.time,
      frameIndex: chosen.frameIndex,
      cutStart: entry.cut.startTime,
      cutEnd: entry.cut.endTime,
      cutDuration: entry.cut.duration,
      cutFrames: entry.cut.endFrame - entry.cut.startFrame + 1,
      chosenBy: source,
      reason,
      direction: '',
      narration: '',
      localScore: Math.round(chosen.localScore * 1e4) / 1e4,
    };
    picks.push(pick);
    chosenByFrame.set(chosen.frameIndex, pick);
  }

  let fullCanvas = null;
  let directionCanvas = null;
  await decodeFrames(file, {
    wanted: new Set(chosenByFrame.keys()),
    onProgress: (p) => report(0.66 + 0.14 * p, '画像を書き出し中…'),
    onFrame: async (index, time, frame) => {
      const pick = chosenByFrame.get(index);
      if (!pick) return;
      const { width, height } = frameSize(frame);
      if (!fullCanvas || fullCanvas.canvas.width !== width) fullCanvas = makeCanvas(width, height);
      fullCanvas.ctx.drawImage(frame, 0, 0, width, height);
      pick.blob = await fullCanvas.canvas.convertToBlob({ type: mime, quality });
      pick.file = `cut${String(pick.cut).padStart(2, '0')}_${pick.time.toFixed(2).padStart(6, '0')}s.${ext}`;
      pick.width = width;
      pick.height = height;

      if (!directionCanvas) directionCanvas = makeCanvas(...scaled(width, height, DIRECTION_W));
      directionCanvas.ctx.drawImage(frame, 0, 0, directionCanvas.canvas.width, directionCanvas.canvas.height);
      pick.previewBlob = await directionCanvas.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    },
  });

  const written = picks.filter((p) => p.blob);
  for (const pick of picks) {
    if (!pick.blob) log(`  ⚠ カット${String(pick.cut).padStart(2, '0')} を書き出せませんでした`);
  }

  /* ---------- ト書き ---------- */
  let directions = {};
  if (useAi && cfg.writeDirections !== false && written.length) {
    report(0.82, '各カットのト書きを書いています…');
    try {
      const shots = [];
      for (const pick of written) {
        shots.push({
          cut: pick.cut,
          duration: pick.cutDuration,
          jpegBase64: await blobToBase64(pick.previewBlob),
        });
      }
      directions = await gemini.writeDirections(apiKey, aiModel, shots, log, aiState);
      aiModel = aiState.model || aiModel;
      written.forEach((pick) => { pick.direction = directions[pick.cut] || ''; });
      log(`  → ${Object.keys(directions).length} カット分のト書きを生成`);
    } catch (err) {
      log(`  ⚠ ト書きの生成をスキップしました: ${err.message}`);
    }
  }

  /* ---------- ナレーション ---------- */
  let segments = [];
  if (useAi && cfg.transcribeNarration !== false && written.length) {
    report(0.88, 'ナレーションを聞き取っています…');
    try {
      const wav = await extractAudioWav(file);
      if (wav) {
        log(`  ナレーションを聞き取り中（音声 ${(wav.length / 1048576).toFixed(1)} MB）…`);
        segments = await gemini.transcribe(apiKey, aiModel, toBase64(wav), 'audio/wav', log, aiState);
        aiModel = aiState.model || aiModel;
        assignNarration(segments, written);
        const spoken = written.filter((p) => p.narration).length;
        log(`  → ${segments.length} 箇所を聞き取り、${spoken} カットに割り当てました`);
      } else {
        log('  （音声トラックが無いため、ナレーションは付けません）');
      }
    } catch (err) {
      log(`  ⚠ ナレーションの聞き取りをスキップしました: ${err.message}`);
    }
  }

  /* ---------- 一覧シート ---------- */
  let overview = null;
  if (cfg.saveContactSheet !== false && written.length) {
    const entries = [];
    for (const pick of written) {
      entries.push({
        bitmap: await createImageBitmap(pick.previewBlob),
        label: `CUT ${String(pick.cut).padStart(2, '0')}   ${pick.time.toFixed(2)}s`,
      });
    }
    overview = await resultSheet(entries);
    entries.forEach((e) => e.bitmap.close());
  }

  const elapsed = (performance.now() - started) / 1000;
  log(`  ✓ ${written.length} 枚を書き出しました（${elapsed.toFixed(1)} 秒）`);
  report(0.92, '書き出しの準備ができました');

  return {
    name: file.name,
    stem: file.name.replace(/\.[^.]+$/, ''),
    info, fps, picks: written, overview, segments,
    aiUsed: Object.keys(aiChoice).length > 0,
    aiModel,
    directionsUsed: Object.keys(directions).length > 0,
    elapsed,
  };
}
