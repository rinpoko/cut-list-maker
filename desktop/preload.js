'use strict';
/**
 * レンダラー（操作画面）に、Electron でしかできないことだけを渡す橋渡し。
 *  - ドロップされた File から「実際のファイルパス」を取り出す（コピーせずに済む）
 *  - ネイティブのファイル選択ダイアログ
 *  - Finder で書き出し先を開く
 *  - 書き出し先フォルダの選択と、確認ダイアログ
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cutgrab', {
  isElectron: true,

  pathsFor(fileList) {
    const out = [];
    for (const file of Array.from(fileList || [])) {
      try {
        const p = webUtils.getPathForFile(file);
        if (p) out.push(p);
      } catch (err) { /* パスが取れないものは無視 */ }
    }
    return out;
  },

  addPaths: (paths) => ipcRenderer.invoke('cutgrab:add-paths', paths),
  chooseFiles: () => ipcRenderer.invoke('cutgrab:choose-files'),
  chooseOutputDir: (defaultPath) => ipcRenderer.invoke('cutgrab:choose-output-dir', defaultPath),
  confirm: (options) => ipcRenderer.invoke('cutgrab:confirm', options),
  reveal: (target) => ipcRenderer.invoke('cutgrab:reveal', target),
});
