/* 動画のデコード。
 *
 * WebCodecs (VideoDecoder) + mp4box.js で、MP4 / MOV のフレームを
 * 1枚ずつ取り出す。ffmpeg と違って「フレーム番号 ↔ 時刻」がコンテナの
 * タイムスタンプそのものなので、ズレが起きない。
 *
 * WebCodecs が使えない／コンテナが読めない場合は、<video> をシークしながら
 * 取り込むやり方に切り替える（遅いが大抵の形式で動く）。
 */

const READ_CHUNK = 8 * 1024 * 1024;

/* ブラウザは裏に回ったタブの setTimeout を 1 秒に制限するので、
 * 画面を切り替えた瞬間に解析が止まってしまう。MessageChannel は
 * その制限を受けないので、処理の合間に挟む待ちはこちらを使う。 */
const yielder = (() => {
  if (typeof MessageChannel === 'undefined') {
    return () => new Promise((resolve) => setTimeout(resolve, 0));
  }
  const waiting = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { const next = waiting.shift(); if (next) next(); };
  channel.port1.start();
  return () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
})();

export function nextTask() { return yielder(); }

export function webCodecsAvailable() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

/* ---------------------------------------------------------------- mp4box */

function descriptionFor(mp4, track) {
  const trak = mp4.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) continue;
    // DataStream は mp4box.all.js がグローバルに置く（MP4Box の下ではない）
    const Stream = window.DataStream || MP4Box.DataStream;
    const stream = new Stream(undefined, 0, Stream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8); // ボックスヘッダ8バイトを除く
  }
  return null;
}

/** ファイルを mp4box に流し込み、映像トラックと全サンプルを取り出す。 */
async function demux(file, onProgress) {
  if (typeof MP4Box === 'undefined') throw new Error('mp4box.js が読み込まれていません');
  const mp4 = MP4Box.createFile();

  let track = null;
  let readyError = null;
  const samples = [];

  const ready = new Promise((resolve, reject) => {
    mp4.onReady = (info) => {
      const videos = info.videoTracks || [];
      if (!videos.length) { reject(new Error('映像トラックが見つかりません')); return; }
      track = videos[0];
      mp4.setExtractionOptions(track.id, null, { nbSamples: 500 });
      resolve(info);
    };
    mp4.onError = (err) => { readyError = err; reject(new Error(String(err))); };
  });

  mp4.onSamples = (id, user, list) => {
    for (const s of list) samples.push(s);
  };

  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + READ_CHUNK, file.size));
    const buffer = await slice.arrayBuffer();
    buffer.fileStart = offset;
    mp4.appendBuffer(buffer);
    offset += buffer.byteLength;
    if (onProgress) onProgress(offset / file.size * 0.25);
    if (readyError) throw new Error(String(readyError));
  }
  await ready;
  mp4.start();
  mp4.flush();

  if (!samples.length) throw new Error('フレームを取り出せませんでした');
  samples.sort((a, b) => a.cts - b.cts);
  return { mp4, track, samples, timing: timingOf(samples, track) };
}

/**
 * フレームレートと尺を、コンテナのヘッダではなく実際のサンプルから求める。
 *
 * 断片化 MP4（ブラウザの録画や配信用の書き出し）では moov の尺が 0 や
 * でたらめな値になっていることがあり、それを信じると fps が桁違いになって
 * カット検出もタイムコードも壊れる。サンプルの間隔なら必ず正しい。
 */
function timingOf(samples, track) {
  const timescale = samples[0].timescale || track.timescale || 1000;

  // 等間隔でないフレームが混ざっていても引きずられないよう中央値を使う
  const deltas = [];
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].cts - samples[i - 1].cts;
    if (delta > 0) deltas.push(delta);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;

  let fps = median > 0 ? timescale / median : 0;

  const last = samples[samples.length - 1];
  let duration = (last.cts + (last.duration || median) - samples[0].cts) / timescale;

  // サンプルから出せなかったときだけコンテナの値に頼る
  if (!(fps > 0.5 && fps < 1000)) {
    const declared = track.duration / (track.timescale || timescale);
    fps = declared > 0.1 ? samples.length / declared : 25;
  }
  if (!(duration > 0)) duration = samples.length / fps;

  return { fps, duration, timescale };
}

/* ------------------------------------------------------------ 公開 API */

/**
 * 動画のメタ情報を調べる。{width,height,fps,duration,frames,codec}
 */
export async function probe(file) {
  const { mp4, track, samples, timing } = await demux(file);
  const info = {
    width: track.video.width,
    height: track.video.height,
    fps: timing.fps,
    duration: timing.duration,
    frames: samples.length,
    codec: track.codec,
  };
  mp4.flush();
  return info;
}

/**
 * 全フレームを順に取り出す。
 *
 *   onFrame(index, timeSec, frame)  frame は VideoFrame。呼ばれた側で使い終わったら
 *                                   何もしなくてよい（こちらで close する）。
 *   wanted  取り出したいフレーム番号の Set。null なら全部。
 */
export async function decodeFrames(file, { onFrame, onProgress, wanted = null } = {}) {
  if (!webCodecsAvailable()) return decodeBySeeking(file, { onFrame, onProgress, wanted });
  try {
    return await decodeWithWebCodecs(file, { onFrame, onProgress, wanted });
  } catch (err) {
    // 素材によっては途中で詰まることがある（別々に書き出した映像を
    // つなぎ直したファイルなど）。その場合は遅いが確実な方法に切り替える。
    if (err && err.noFallback) throw err;
    console.warn('WebCodecs での読み込みに失敗したため、シーク方式に切り替えます', err);
    return decodeBySeeking(file, { onFrame, onProgress, wanted, hintFps: err.hintFps });
  }
}

async function decodeWithWebCodecs(file, { onFrame, onProgress, wanted = null } = {}) {

  const { mp4, track, samples, timing } = await demux(file, onProgress);
  const description = descriptionFor(mp4, track);

  let index = 0;
  let failed = null;
  let inFlight = 0;
  // コンテナによっては先頭フレームの時刻が 0 でないので、原点をそろえる
  let baseTimestamp = null;
  const total = samples.length;

  // onFrame は非同期のことがある（JPEG 化など）。順番どおりに、かつ
  // 処理が終わるまでフレームを閉じないように直列でさばく。
  let chain = Promise.resolve();
  const handle = (current, time, frame) => {
    inFlight++;
    chain = chain.then(async () => {
      try {
        await onFrame(current, time, frame);
      } catch (err) {
        if (!failed) failed = err;
      } finally {
        frame.close();
        inFlight--;
      }
    });
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      const current = index++;
      if (baseTimestamp === null) baseTimestamp = frame.timestamp;
      if (!wanted || wanted.has(current)) {
        handle(current, (frame.timestamp - baseTimestamp) / 1e6, frame);
      } else {
        frame.close();
      }
      if (onProgress && index % 20 === 0) onProgress(0.25 + 0.75 * (index / total));
    },
    error: (err) => { failed = err; },   // 呼ばれた時点でデコーダは閉じている
  });

  const config = {
    codec: track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
  };
  if (description) config.description = description;

  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) {
    decoder.close();
    const err = new Error(`このコーデックはブラウザで再生できません: ${track.codec}`);
    err.noFallback = true;
    throw err;
  }
  decoder.configure(config);

  for (const sample of samples) {
    if (failed) break;
    decoder.decode(new EncodedVideoChunk({
      type: sample.is_sync ? 'key' : 'delta',
      timestamp: (sample.cts / sample.timescale) * 1e6,
      duration: (sample.duration / sample.timescale) * 1e6,
      data: sample.data,
    }));
    // 溜めすぎるとメモリを食うので、少し捌けるまで待つ
    while (decoder.decodeQueueSize > 24 || inFlight > 8) {
      await nextTask();
      if (failed) break;
    }
  }
  if (decoder.state !== 'closed') {
    try { await decoder.flush(); } catch (err) { if (!failed) failed = err; }
    if (decoder.state !== 'closed') decoder.close();
  }
  await chain;   // 取り出したフレームの処理が終わるまで待つ
  if (failed) {
    const err = failed instanceof Error ? failed : new Error(String(failed));
    // 退避側でフレーム番号がずれないよう、分かっている fps を渡す
    err.hintFps = timing.fps;
    throw err;
  }

  return {
    width: track.video.width,
    height: track.video.height,
    fps: timing.fps,
    duration: timing.duration,
    frames: index,
    codec: track.codec,
  };
}

/* -------------------------------------------------- 予備：<video> でシーク */

/** WebCodecs が無い／コンテナが読めないときの代替。遅いが大抵の形式で動く。 */
async function decodeBySeeking(file, { onFrame, onProgress, wanted = null, hintFps = 0 } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('この動画をブラウザで開けませんでした'));
  });

  const duration = video.duration;
  // コンテナから分かっていればその fps を使う。分からなければ一般的な値を仮に置く。
  const fps = hintFps > 0 ? hintFps : 25;
  const total = Math.max(1, Math.floor(duration * fps));
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < total; i++) {
    if (wanted && !wanted.has(i)) continue;
    await new Promise((resolve) => {
      video.onseeked = resolve;
      video.currentTime = Math.min(duration - 1e-3, (i + 0.5) / fps);
    });
    ctx.drawImage(video, 0, 0);
    const bitmap = await createImageBitmap(canvas);
    await onFrame(i, (i + 0.5) / fps, bitmap);
    bitmap.close();
    if (onProgress && i % 10 === 0) onProgress(i / total);
  }

  URL.revokeObjectURL(url);
  return {
    width: video.videoWidth, height: video.videoHeight,
    fps, duration, frames: total, codec: 'unknown',
  };
}
