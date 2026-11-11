'use strict';
/**
 * CMカット抽出 — Electron のメインプロセス。
 *
 * 実際の解析は Python バックエンド（127.0.0.1 のローカルサーバー）が行う。
 * ここはその起動・監視と、ウィンドウ／ドラッグ＆ドロップ／メニューの面倒を見る。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const ROOT = path.join(__dirname, '..');

let backend = null;
let serverOrigin = null;
let token = null;
let mainWindow = null;
let backendLog = '';
const pendingFiles = [];

/* ------------------------------------------------------------------ paths */
const IS_WIN = process.platform === 'win32';

/* 解析エンジンの起動方法。
 *  macOS  … PyInstaller で 1 本にまとめた実行ファイル
 *  Windows… 同梱した組み込み Python（インストール不要）で cutgrab を直接動かす
 */
function backendCommand() {
  if (isDev) {
    return { cmd: '/usr/bin/python3', args: ['-m', 'cutgrab.server', '--electron'], cwd: ROOT };
  }
  const base = path.join(process.resourcesPath, 'backend');
  if (IS_WIN) {
    return {
      cmd: path.join(base, 'python', 'python.exe'),
      args: ['-m', 'cutgrab.server', '--electron'],
      cwd: base,
    };
  }
  return {
    cmd: path.join(base, 'cutgrab-backend'),
    args: ['--electron'],
    cwd: base,
  };
}

function ffmpegPaths() {
  const exe = IS_WIN ? '.exe' : '';
  if (isDev) {
    return {
      ffmpeg: path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
      ffprobe: path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin', 'darwin', 'arm64', 'ffprobe'),
    };
  }
  return {
    ffmpeg: path.join(process.resourcesPath, 'bin', 'ffmpeg' + exe),
    ffprobe: path.join(process.resourcesPath, 'bin', 'ffprobe' + exe),
  };
}

/* ---------------------------------------------------------------- backend */
function startBackend() {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd } = backendCommand();
    const bins = ffmpegPaths();
    const env = Object.assign({}, process.env, {
      CMCUT_FFMPEG: fs.existsSync(bins.ffmpeg) ? bins.ffmpeg : '',
      CMCUT_FFPROBE: fs.existsSync(bins.ffprobe) ? bins.ffprobe : '',
      PYTHONUNBUFFERED: '1',
    });

    try {
      backend = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error('バックエンドが応答しませんでした。\n\n' + backendLog.slice(-1200)));
    }, 60000);

    const onData = (chunk) => {
      const text = chunk.toString();
      backendLog += text;
      if (backendLog.length > 20000) backendLog = backendLog.slice(-20000);
      const match = backendLog.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/);
      if (match && !serverOrigin) {
        serverOrigin = 'http://127.0.0.1:' + match[1];
        token = match[2];
        clearTimeout(timer);
        resolve(serverOrigin + '/?t=' + token);
      }
    };

    backend.stdout.on('data', onData);
    backend.stderr.on('data', onData);
    backend.on('error', (err) => { clearTimeout(timer); reject(err); });
    backend.on('exit', (code) => {
      backend = null;
      if (!serverOrigin) {
        clearTimeout(timer);
        reject(new Error('バックエンドが終了しました (code ' + code + ')\n\n' + backendLog.slice(-1200)));
      }
    });
  });
}

function apiPost(pathname, body) {
  return new Promise((resolve) => {
    if (!serverOrigin) { resolve(null); return; }
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const url = new URL(serverOrigin + pathname);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + '?t=' + token,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

/* 動画を渡して、そのまま処理を始める */
/* 書き出し先は毎回たずねる。キャンセルされたら書き出しは始めない。 */
let lastOutputDir = '';

async function askOutputDir() {
  const options = {
    title: '書き出し先フォルダを選んでください',
    message: 'このフォルダの中に「動画名_カット」フォルダを作ります',
    buttonLabel: 'ここに書き出す',
    properties: ['openDirectory', 'createDirectory'],
  };
  if (lastOutputDir) options.defaultPath = lastOutputDir;
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return false;
  lastOutputDir = result.filePaths[0];
  await apiPost('/api/settings', { output_mode: 'custom', output_dir: lastOutputDir });
  return true;
}

async function submitFiles(paths, autoStart) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return { added: 0 };
  if (!serverOrigin) { pendingFiles.push.apply(pendingFiles, list); return { added: 0 }; }
  const result = await apiPost('/api/add', { paths: list });
  if (autoStart !== false) {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    if (await askOutputDir()) await apiPost('/api/start', { pending_only: true });
  }
  if (mainWindow) mainWindow.focus();
  return result || { added: 0 };
}

/* ---------------------------------------------------------------- window */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 920,
    minWidth: 860,
    minHeight: 620,
    title: 'Cut List Maker',
    backgroundColor: '#f6f7f9',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部リンクは既定のブラウザで開く（アプリ内で遷移させない）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (serverOrigin && !url.startsWith(serverOrigin) && !url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const template = [
    {
      label: 'Cut List Maker',
      submenu: [
        { role: 'about', label: 'Cut List Maker について' },
        { type: 'separator' },
        { role: 'hide', label: 'Cut List Maker を隠す' },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        { type: 'separator' },
        { role: 'quit', label: 'Cut List Maker を終了' },
      ],
    },
    {
      label: 'ファイル',
      submenu: [
        {
          label: '動画を開く…',
          accelerator: 'CmdOrCtrl+O',
          click: () => chooseFiles(),
        },
        { type: 'separator' },
        { role: 'close', label: 'ウィンドウを閉じる' },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'cut', label: 'カット' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: 'ペースト' },
        { role: 'selectAll', label: 'すべてを選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
    { role: 'windowMenu', label: 'ウインドウ' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function chooseFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'CM動画を選ぶ',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '動画', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'mxf', 'mpg', 'mpeg', 'mts', 'm2ts', 'webm', 'wmv'] },
      { name: 'すべて', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { added: 0 };
  return submitFiles(result.filePaths, false);
}

/* ------------------------------------------------------------------ 起動 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /* Windows は「アイコンにドロップ」も「関連付けで開く」もコマンドライン引数で来る。
     macOS は open-file イベントで来る。 */
  function filesFromArgv(argv) {
    return (argv || []).slice(1).filter((a) => {
      if (!a || a.startsWith('-')) return false;
      try { return fs.existsSync(a) && !fs.statSync(a).isDirectory() ? true : fs.existsSync(a); }
      catch (err) { return false; }
    });
  }

  app.on('second-instance', (event, argv) => {
    const files = filesFromArgv(argv);
    if (files.length) submitFiles(files);
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  // Finder からアイコンにドロップされたとき（起動前に来ることもある）
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (serverOrigin) submitFiles([filePath]);
    else pendingFiles.push(filePath);
  });

  // Windows: 最初の起動時に渡されたファイル
  if (IS_WIN) {
    for (const file of filesFromArgv(process.argv)) pendingFiles.push(file);
  }

  app.whenReady().then(async () => {
    buildMenu();
    createWindow();

    ipcMain.handle('cutgrab:add-paths', (event, paths) => submitFiles(paths));
    ipcMain.handle('cutgrab:choose-files', () => chooseFiles());

    // 書き出し先フォルダを毎回たずねる
    ipcMain.handle('cutgrab:choose-output-dir', async (event, defaultPath) => {
      if (defaultPath) lastOutputDir = defaultPath;
      return (await askOutputDir()) ? lastOutputDir : '';
    });

    ipcMain.handle('cutgrab:confirm', async (event, options) => {
      const opts = options || {};
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['キャンセル', opts.confirmLabel || 'OK'],
        defaultId: 0,
        cancelId: 0,
        message: opts.message || '',
        detail: opts.detail || '',
      });
      return result.response === 1;
    });
    ipcMain.handle('cutgrab:reveal', (event, target) => {
      if (!target) return false;
      if (fs.existsSync(target)) {
        if (fs.statSync(target).isDirectory()) shell.openPath(target);
        else shell.showItemInFolder(target);
        return true;
      }
      return false;
    });

    try {
      const url = await startBackend();
      if (mainWindow) await mainWindow.loadURL(url);
      if (pendingFiles.length) {
        const files = pendingFiles.splice(0, pendingFiles.length);
        setTimeout(() => submitFiles(files), 400);
      }
    } catch (err) {
      dialog.showErrorBox('起動に失敗しました', String(err && err.message ? err.message : err));
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        if (serverOrigin) mainWindow.loadURL(serverOrigin + '/?t=' + token);
      }
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    if (backend) {
      try { backend.kill('SIGTERM'); } catch (e) { /* 無視 */ }
      backend = null;
    }
  });
}
