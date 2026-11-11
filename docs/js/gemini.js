/* Gemini API 連携。cutgrab/gemini.py の移植。
 *
 * ブラウザから直接 generativelanguage.googleapis.com を叩く。
 * API キーは利用者のブラウザ（localStorage）にだけ置かれ、どこにも送られない。
 */

import { PROMPTS } from './prompts.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
export const SHOTS_PER_REQUEST = 8;
export const DIRECTION_SHOTS_PER_REQUEST = 12;

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
export const MODEL_CANDIDATES = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];

export class GeminiError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    const err = new GeminiError(`HTTP ${response.status}: ${body.slice(0, 400)}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return response.json();
}

export async function listModels(apiKey) {
  try {
    const url = `${API_ROOT}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => (m.name || '').split('/').pop())
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

/** 画像を読める Flash / Pro 系だけを、使いそうな順に返す（設定画面の選択肢用）。 */
export function usableModels(available) {
  const skip = ['image', 'tts', 'robotics', 'computer-use', 'deep-research',
                'lyria', 'gemma', 'nano-banana', 'antigravity', 'omni'];
  const picked = available.filter((m) => m.includes('gemini') && !skip.some((s) => m.includes(s)));
  const ordered = MODEL_CANDIDATES.filter((m) => picked.includes(m));
  return ordered.concat(picked.filter((m) => !ordered.includes(m)).sort().reverse());
}

/** API キーが有効かを確かめる。 */
export async function verifyKey(apiKey) {
  if (!apiKey.trim()) return { ok: false, message: 'API キーが未入力です。', models: [] };
  const models = await listModels(apiKey.trim());
  if (!models.length) {
    return { ok: false, message: '接続できませんでした（キーが違うか、ネットワークの問題）。', models: [] };
  }
  const usable = usableModels(models);
  return { ok: true, message: `OK / 使用モデル: ${usable[0] || models[0]}`, models: usable };
}

function extractJson(text) {
  let body = text.trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try { return JSON.parse(body); } catch (err) { /* 続けて探す */ }
  const match = body.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (err) { return null; }
  }
  return null;
}

function modelChain(preferred) {
  const chain = [];
  for (const name of [preferred, ...MODEL_CANDIDATES]) {
    if (name && !chain.includes(name)) chain.push(name);
  }
  return chain;
}

/** 1 モデルに 1 リクエスト投げて JSON を取り出す。再試行つき。 */
async function call(apiKey, model, parts, expectKey, log) {
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
  };
  const url = `${API_ROOT}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let data = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      data = await post(url, payload);
      break;
    } catch (err) {
      lastError = err;
      const status = err.status;
      if (status === 400 && String(err.body || '').includes('responseMimeType')) {
        delete payload.generationConfig.responseMimeType;
        continue;
      }
      if (status === 404) throw err;                      // このモデルは無い → 次へ
      if (status === 429 || status === 500 || status === 503) {
        if (attempt === 2) throw err;                     // 混んでいる → 次へ
        const wait = 5000 * (attempt + 1);
        log(`  混雑/レート制限。${wait / 1000} 秒待って再試行します…`);
        await sleep(wait);
        continue;
      }
      if (status) throw err;
      await sleep(3000);                                  // ネットワーク断など
    }
  }
  if (!data) throw new GeminiError(lastError ? lastError.message : '不明なエラー');

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new GeminiError(`応答を解釈できませんでした: ${JSON.stringify(data).slice(0, 300)}`);
  const parsed = extractJson(text);
  if (!parsed || !(expectKey in parsed)) {
    throw new GeminiError(`JSON を取得できませんでした: ${text.slice(0, 200)}`);
  }
  return parsed[expectKey];
}

/** モデルを順に試す。一度成功したモデルは以後も使い続ける。 */
async function callWithFallback(apiKey, model, parts, expectKey, log, state) {
  const chain = modelChain(state.model || model);
  const errors = [];
  for (const name of chain) {
    try {
      const result = await call(apiKey, name, parts, expectKey, log);
      if (state.model !== name) {
        if (state.model) log(`  → モデルを ${name} に切り替えました`);
        state.model = name;
      }
      return result;
    } catch (err) {
      errors.push(`${name}: ${String(err.message).slice(0, 120)}`);
      log(`  ${name} が使えませんでした。次のモデルを試します…`);
    }
  }
  throw new GeminiError(errors.slice(-3).join(' / '));
}

function imagePart(base64) {
  return { inline_data: { mime_type: 'image/jpeg', data: base64 } };
}

/** 各カットのベストな 1 枚を選ばせる。shots: [{cut, count, jpegBase64}] */
export async function selectBestFrames(apiKey, model, shots, log = () => {}, state = {}) {
  const result = {};
  for (let start = 0; start < shots.length; start += SHOTS_PER_REQUEST) {
    const batch = shots.slice(start, start + SHOTS_PER_REQUEST);
    if (start > 0) await sleep(4000);        // 無料枠のレート制限に配慮
    log(`  ベストな瞬間を選定中 (${Math.floor(start / SHOTS_PER_REQUEST) + 1}/${Math.ceil(shots.length / SHOTS_PER_REQUEST)} バッチ, カット ${batch.length}件)…`);

    const parts = [{ text: PROMPTS.SELECT }];
    for (const item of batch) {
      parts.push({ text: `▼ カット ${item.cut} （候補は 1〜${item.count}）` });
      parts.push(imagePart(item.jpegBase64));
    }
    parts.push({ text: `対象カット: ${batch.map((b) => b.cut).join(', ')}。全てについて JSON で回答してください。` });

    const selections = await callWithFallback(apiKey, model, parts, 'selections', log, state);
    for (const sel of selections || []) {
      const cut = parseInt(sel.cut, 10);
      const best = parseInt(sel.best, 10);
      if (Number.isFinite(cut) && Number.isFinite(best)) {
        result[cut] = { best, reason: String(sel.reason || '').trim() };
      }
    }
  }
  return result;
}

/** 選ばれた絵を見せて、CMコンテのト書きを書かせる。 */
export async function writeDirections(apiKey, model, shots, log = () => {}, state = {}) {
  const result = {};
  const size = DIRECTION_SHOTS_PER_REQUEST;
  for (let start = 0; start < shots.length; start += size) {
    const batch = shots.slice(start, start + size);
    if (start > 0) await sleep(4000);
    log(`  ト書きを生成中 (${Math.floor(start / size) + 1}/${Math.ceil(shots.length / size)} バッチ, カット ${batch.length}件)…`);

    const parts = [{ text: PROMPTS.DIRECTION }];
    for (const item of batch) {
      parts.push({ text: `▼ カット ${item.cut}（尺 ${item.duration.toFixed(1)}秒）` });
      parts.push(imagePart(item.jpegBase64));
    }
    parts.push({ text: `対象カット: ${batch.map((b) => b.cut).join(', ')}。全てについて JSON で回答してください。` });

    const directions = await callWithFallback(apiKey, model, parts, 'directions', log, state);
    for (const item of directions || []) {
      const cut = parseInt(item.cut, 10);
      if (Number.isFinite(cut)) result[cut] = String(item.text || '').trim();
    }
  }
  return result;
}

/** CM の音声からナレーション／セリフを時刻付きで書き起こす。 */
export async function transcribe(apiKey, model, audioBase64, mime, log = () => {}, state = {}) {
  const parts = [
    { text: PROMPTS.NARRATION },
    { inline_data: { mime_type: mime, data: audioBase64 } },
  ];
  const segments = await callWithFallback(apiKey, model, parts, 'segments', log, state);

  const cleaned = [];
  for (const seg of segments || []) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    const start = Number(seg.start) || 0;
    const end = Number(seg.end) || start;
    cleaned.push({
      start: Math.max(0, start),
      end: Math.max(start, end),
      type: String(seg.type || 'NA').trim() || 'NA',
      text,
    });
  }
  cleaned.sort((a, b) => a.start - b.start);
  return cleaned;
}
