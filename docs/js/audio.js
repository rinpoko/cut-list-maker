/* 音声の取り出し。ナレーション書き起こしのために、
 * 動画の音声トラックをモノラル 16kHz の WAV にして Gemini に渡す。 */

const TARGET_RATE = 16000;

/** 動画ファイルから音声を取り出して WAV の Uint8Array にする。無音・音声なしなら null。 */
export async function extractAudioWav(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  let decoded;
  try {
    const buffer = await file.arrayBuffer();
    const ctx = new Ctx();
    decoded = await ctx.decodeAudioData(buffer);
    ctx.close();
  } catch (err) {
    return null;   // 音声トラックが無い、または読めない
  }
  if (!decoded || !decoded.length) return null;

  // モノラル 16kHz に落とす
  const frames = Math.max(1, Math.round(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const samples = rendered.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 0.001) return null;   // 実質無音

  return encodeWav(samples, TARGET_RATE);
}

function encodeWav(samples, sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return bytes;
}

/** Uint8Array を base64 に（大きいデータでもスタックを溢れさせない）。 */
export function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
