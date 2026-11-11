/* 画面まわり。設定の保存、ファイルの受け取り、実行、結果表示。 */

import { processVideo } from './pipeline.js';
import { buildDeck } from './pptx.js';
import { buildSheet } from './xlsx.js';
import { canPickDirectory, pickDirectory, deliver } from './output.js';
import { formatTimecode, formatDuration } from './timecode.js';
import * as gemini from './gemini.js';
import { webCodecsAvailable } from './decode.js';

export const VERSION = '2.0.2';

const STORE_KEY = 'cutlistmaker.settings';
const KEY_KEY = 'cutlistmaker.apikey';

const DEFAULTS = {
  useAi: true,
  model: '',
  imageFormat: 'png',
  jpegQuality: 95,
  sensitivity: 27,
  minCutSeconds: 0.3,
  candidatesPerCut: 9,
  aiShortlist: 6,
  saveContactSheet: true,
  writeDirections: true,
  transcribeNarration: true,
  exportPptx: true,
  exportXlsx: true,
  pptxCols: 4,
  pptxRows: 2,
};

const $ = (id) => document.getElementById(id);
const state = { files: [], busy: false, dirHandle: null, settings: { ...DEFAULTS } };

/* ---------------------------------------------------------------- 設定 */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    state.settings = { ...DEFAULTS, ...saved };
  } catch (err) {
    state.settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch (err) { /* 保存できなくても動く */ }
}

function apiKey() {
  try { return localStorage.getItem(KEY_KEY) || ''; } catch (err) { return ''; }
}

function setApiKey(value) {
  try {
    if (value) localStorage.setItem(KEY_KEY, value);
    else localStorage.removeItem(KEY_KEY);
  } catch (err) { /* プライベートモードなど */ }
}

const SENS = (v) => (v <= 20 ? '細かめ（短いカットも拾う）' : (v <= 33 ? '標準' : '粗め（大きな転換のみ）'));

function applySettingsToForm() {
  const s = state.settings;
  $('use_ai').checked = !!s.useAi;
  $('model').value = s.model || '';
  $('write_directions').checked = !!s.writeDirections;
  $('transcribe_narration').checked = !!s.transcribeNarration;
  $('export_pptx').checked = !!s.exportPptx;
  $('export_xlsx').checked = !!s.exportXlsx;
  $('save_contact_sheet').checked = !!s.saveContactSheet;
  $('sensitivity').value = s.sensitivity;
  $('senslabel').textContent = `${Math.round(s.sensitivity)}  ${SENS(s.sensitivity)}`;
  const radio = document.querySelector(`input[name=fmt][value="${s.imageFormat}"]`);
  if (radio) radio.checked = true;
  for (const [id, value] of [['pptx_cols', s.pptxCols], ['pptx_rows', s.pptxRows]]) {
    $(id).value = String(value);
  }
  $('keystate').innerHTML = apiKey()
    ? '<span class="ok">設定済み</span>'
    : '未設定（ローカル判定のみで動きます）';
}

function readForm() {
  const fmt = document.querySelector('input[name=fmt]:checked');
  Object.assign(state.settings, {
    useAi: $('use_ai').checked,
    model: $('model').value.trim(),
    writeDirections: $('write_directions').checked,
    transcribeNarration: $('transcribe_narration').checked,
    exportPptx: $('export_pptx').checked,
    exportXlsx: $('export_xlsx').checked,
    saveContactSheet: $('save_contact_sheet').checked,
    sensitivity: parseFloat($('sensitivity').value),
    imageFormat: fmt ? fmt.value : 'png',
    pptxCols: parseInt($('pptx_cols').value, 10),
    pptxRows: parseInt($('pptx_rows').value, 10),
  });
  saveSettings();
}

/* ---------------------------------------------------------------- 画面 */

function log(message) {
  const box = $('log');
  box.textContent += message + '\n';
  box.scrollTop = box.scrollHeight;
}

function setProgress(fraction, message) {
  $('bar').firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
  if (message) $('status').textContent = message;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderFiles() {
  $('files').innerHTML = state.files.map((file, i) => `
    <li>
      <span class="nm">${esc(file.name)}</span>
      <span class="tag">${(file.size / 1048576).toFixed(1)} MB</span>
      <button class="mini rm" data-remove="${i}">外す</button>
    </li>`).join('');
}

function addFiles(list) {
  for (const file of list) {
    if (!file || !file.size) continue;
    if (state.files.some((f) => f.name === file.name && f.size === file.size)) continue;
    state.files.push(file);
  }
  renderFiles();
}

function updateOutputHint() {
  if (canPickDirectory()) {
    $('outpath').textContent = state.dirHandle
      ? `書き出し先: ${state.dirHandle.name}`
      : '（書き出すときに選びます）';
    $('outhint').textContent =
      '選んだフォルダの中に「動画名_カット」フォルダを作って、画像・コンテ・カット表を書き出します。';
  } else {
    $('pick_dir').hidden = true;
    $('outpath').textContent = '';
    $('outhint').textContent =
      'このブラウザはフォルダへの直接書き出しに対応していないため、ZIP でダウンロードします。'
      + '（Chrome / Edge ならフォルダを選んで直接書き出せます）';
  }
}

/* ---------------------------------------------------------------- 実行 */

async function run() {
  if (state.busy) return;
  if (!state.files.length) { $('status').textContent = '先に動画を追加してください'; return; }
  readForm();

  let dirHandle = state.dirHandle;
  if (canPickDirectory()) {
    // デスクトップ版と同じく、書き出しのたびに保存先をたずねる
    dirHandle = await pickDirectory();
    if (!dirHandle) { $('status').textContent = '書き出し先が選ばれなかったので中止しました'; return; }
    state.dirHandle = dirHandle;
    updateOutputHint();
  }

  state.busy = true;
  $('run').disabled = true;
  $('run').textContent = '処理中…';
  $('log').textContent = '';
  $('results').innerHTML = '';

  const cfg = { ...state.settings, apiKey: apiKey() };
  const targets = [...state.files];
  const done = [];

  for (let i = 0; i < targets.length; i++) {
    const file = targets[i];
    const base = i / targets.length;
    const span = 1 / targets.length;
    try {
      const result = await processVideo(file, cfg, {
        log,
        progress: (f, m) => setProgress(base + span * f, `[${i + 1}/${targets.length}] ${m}`),
      });
      await writeOutputs(result, cfg, dirHandle);
      done.push(result);
      renderResults(done);
    } catch (err) {
      log(`  ✗ 失敗: ${err.message}`);
      console.error(err);
    }
    setProgress(base + span, '');
  }

  state.busy = false;
  $('run').disabled = false;
  $('run').textContent = 'カットを書き出す';
  setProgress(1, done.length
    ? `完了：${done.length}本 / 合計 ${done.reduce((n, r) => n + r.picks.length, 0)} カットを書き出しました`
    : '書き出せませんでした');
}

async function writeOutputs(result, cfg, dirHandle) {
  const folder = `${result.stem}_カット`;
  const files = result.picks.map((pick) => ({ name: pick.file, blob: pick.blob }));

  if (result.overview) files.push({ name: '_一覧.jpg', blob: result.overview });

  const subtitle = `${result.picks.length} カット / ${result.info.duration.toFixed(1)}秒 / ${new Date().toISOString().slice(0, 10)}`;

  if (cfg.exportPptx && result.picks.length) {
    setProgress(0.94, 'コンテ PPTX を作成中…');
    try {
      const blob = await buildDeck(result.picks, {
        title: result.stem, subtitle, cols: cfg.pptxCols, rows: cfg.pptxRows, fps: result.fps,
      });
      files.push({ name: `${result.stem}_コンテ.pptx`, blob });
      log(`  → コンテ PPTX: ${result.stem}_コンテ.pptx`);
    } catch (err) {
      log(`  ⚠ PPTX の書き出しに失敗しました: ${err.message}`);
    }
  }

  if (cfg.exportXlsx && result.picks.length) {
    setProgress(0.96, 'カット表 Excel を作成中…');
    try {
      const blob = await buildSheet(result.picks, { title: result.stem, subtitle, fps: result.fps });
      files.push({ name: `${result.stem}_カット表.xlsx`, blob });
      log(`  → カット表 XLSX: ${result.stem}_カット表.xlsx`);
    } catch (err) {
      log(`  ⚠ XLSX の書き出しに失敗しました: ${err.message}`);
    }
  }

  const report = {
    source: result.name,
    video: result.info,
    cutCount: result.picks.length,
    aiModel: result.aiModel,
    aiUsed: result.aiUsed,
    directionsUsed: result.directionsUsed,
    narrationSegments: result.segments,
    fps: Math.round(result.fps * 1e4) / 1e4,
    createdAt: new Date().toISOString(),
    cuts: result.picks.map((p) => ({
      cut: p.cut, file: p.file, time: p.time, frameIndex: p.frameIndex,
      cutStart: p.cutStart, cutEnd: p.cutEnd, cutDuration: p.cutDuration,
      cutFrames: p.cutFrames, chosenBy: p.chosenBy, reason: p.reason,
      direction: p.direction, narration: p.narration,
      timecode: formatTimecode(p, result.fps), length: formatDuration(p, result.fps),
    })),
  };
  files.push({
    name: '_report.json',
    blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  });

  setProgress(0.98, '書き出し中…');
  await deliver(folder, files, dirHandle, log);
}

function renderResults(results) {
  $('results').innerHTML = results.map((r) => {
    const shots = r.picks.map((c) => `
      <div class="shot">
        <img src="${URL.createObjectURL(c.previewBlob)}" loading="lazy" alt="cut ${c.cut}">
        <div class="meta">
          ${c.narration ? `<div class="narration">${esc(c.narration)}</div>` : ''}
          <div class="direction">${esc(c.direction) || '<span class="hint">（ト書きなし）</span>'}</div>
          <div class="subline">
            <b>カット ${String(c.cut).padStart(2, '0')}</b>
            <span class="hint">${formatTimecode(c, r.fps)} / ${formatDuration(c, r.fps)}</span>
            <span class="badge ${c.chosenBy === 'ai' ? '' : 'local'}" title="${esc(c.reason)}">${c.chosenBy === 'ai' ? 'AI' : 'ローカル'}</span>
          </div>
        </div>
      </div>`).join('');
    return `<div class="card">
      <h2>${esc(r.name)} — ${r.picks.length} カット${r.aiUsed ? `（AI: ${esc(r.aiModel)}）` : '（ローカル判定）'} / ${r.elapsed.toFixed(1)}秒</h2>
      <div class="shots">${shots}</div>
    </div>`;
  }).join('');

  document.querySelectorAll('.shot img').forEach((img) => {
    img.addEventListener('click', () => {
      $('lightimg').src = img.src;
      $('lightbox').style.display = 'flex';
    });
  });
}

/* ---------------------------------------------------------------- キー */

async function applyKey() {
  const el = $('keystate');
  const key = $('api_key').value.trim();
  if (!key) { el.innerHTML = '<span class="ng">キーが入力されていません</span>'; return; }
  el.textContent = '確認中…';
  setApiKey(key);
  const result = await gemini.verifyKey(key);
  el.innerHTML = (result.ok ? '<span class="ok">✓ 設定しました / ' : '<span class="ng">✗ ')
               + esc(result.message) + '</span>';
  $('modellist').innerHTML = (result.models || []).map((m) => `<option value="${esc(m)}">`).join('');
}

function deleteKey() {
  const ok = window.confirm(
    'APIキーを削除します\n\n'
    + '保存されている Gemini の APIキーを消します。\n'
    + '削除すると、AIによるカット選定・ト書き・ナレーションは使えなくなります。\n\n'
    + '本当に削除していいですか？');
  if (!ok) return;
  setApiKey('');
  $('api_key').value = '';
  $('modellist').innerHTML = '';
  $('keystate').innerHTML = '<span class="ng">削除しました（未設定）</span>';
}

/* ---------------------------------------------------------------- 起動 */

function checkEngine() {
  const pill = $('enginepill');
  const problems = [];
  if (!webCodecsAvailable()) problems.push('WebCodecs');
  if (typeof OffscreenCanvas === 'undefined') problems.push('OffscreenCanvas');

  if (!problems.length) {
    pill.textContent = 'WebCodecs 対応';
    pill.classList.add('on');
    return;
  }
  pill.textContent = '簡易モード';
  const box = $('unsupported');
  box.hidden = false;
  box.textContent = `このブラウザは ${problems.join(' / ')} に対応していないため、`
    + '解析が遅くなるか動かないことがあります。Chrome・Edge・Safari 17 以降をお使いください。';
}

function bind() {
  $('browse').addEventListener('click', () => $('picker').click());
  $('drop').addEventListener('click', () => $('picker').click());
  $('picker').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('clear').addEventListener('click', () => { state.files = []; renderFiles(); });
  $('files').addEventListener('click', (e) => {
    const index = e.target.dataset.remove;
    if (index != null) { state.files.splice(Number(index), 1); renderFiles(); }
  });

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault(); $('drop').classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault(); $('drop').classList.remove('over');
  }));
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  $('run').addEventListener('click', run);
  $('apply_key').addEventListener('click', applyKey);
  $('delete_key').addEventListener('click', deleteKey);
  $('pick_dir').addEventListener('click', async () => {
    const handle = await pickDirectory();
    if (handle) { state.dirHandle = handle; updateOutputHint(); }
  });
  $('lightbox').addEventListener('click', () => { $('lightbox').style.display = 'none'; });

  $('sensitivity').addEventListener('input', () => {
    $('senslabel').textContent = `${Math.round($('sensitivity').value)}  ${SENS($('sensitivity').value)}`;
  });
  document.querySelectorAll('input, select').forEach((el) => {
    if (el.id === 'api_key') return;
    el.addEventListener('change', readForm);
  });
}

function fillSelects() {
  for (const id of ['pptx_cols', 'pptx_rows']) {
    $(id).innerHTML = [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}</option>`).join('');
  }
}

function setupInstall() {
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('install').hidden = false;
  });
  $('install').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('install').hidden = true;
  });
}

function start() {
  $('ver').textContent = `v${VERSION}`;
  fillSelects();
  loadSettings();
  applySettingsToForm();
  bind();
  checkEngine();
  updateOutputHint();
  setupInstall();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン対応なしでも動く */ });
  }
}

start();
