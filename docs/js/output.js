/* 書き出し先の扱い。
 *
 * File System Access API が使えるブラウザ（Chrome / Edge）では、デスクトップ版と
 * 同じように毎回フォルダを選んでもらい、そこへ直接書き出す。
 * 使えない場合（Safari など）は ZIP にまとめてダウンロードする。
 */

export function canPickDirectory() {
  return typeof window.showDirectoryPicker === 'function';
}

/** 書き出し先フォルダを選んでもらう。キャンセルなら null。 */
export async function pickDirectory() {
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite', id: 'cutlist-output' });
  } catch (err) {
    return null;   // ユーザーがキャンセルした
  }
}

async function writeFile(dir, name, blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  await stream.write(blob);
  await stream.close();
}

/**
 * files: [{name, blob}] を書き出す。
 * dirHandle があればそのフォルダに <動画名_カット> を作って入れる。
 * 無ければ ZIP をダウンロードする。
 */
export async function deliver(folderName, files, dirHandle, log = () => {}) {
  if (dirHandle) {
    const target = await dirHandle.getDirectoryHandle(folderName, { create: true });
    for (const file of files) await writeFile(target, file.name, file.blob);
    log(`  → ${folderName} に ${files.length} 個のファイルを書き出しました`);
    return { kind: 'folder', folderName };
  }

  const zip = new JSZip();
  const folder = zip.folder(folderName);
  for (const file of files) folder.file(file.name, file.blob);
  const blob = await zip.generateAsync({ type: 'blob' });
  download(`${folderName}.zip`, blob);
  log(`  → ${folderName}.zip をダウンロードしました`);
  return { kind: 'zip', folderName };
}

export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
