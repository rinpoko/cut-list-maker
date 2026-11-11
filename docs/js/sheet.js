/* AI に渡すコンタクトシートの生成。cutgrab/sheet.py の移植。 */

const TILE_W = 440;
const COLS = 3;
const GAP = 8;

/** 候補フレームを番号付きで並べた 1 枚の JPEG（base64）にする。 */
export async function candidateSheet(bitmaps) {
  const ratio = bitmaps[0].height / bitmaps[0].width;
  const tileH = Math.round(TILE_W * ratio);
  const cols = Math.min(COLS, Math.max(1, bitmaps.length));
  const rows = Math.ceil(bitmaps.length / cols);

  const canvas = new OffscreenCanvas(
    cols * TILE_W + GAP * (cols + 1),
    rows * tileH + GAP * (rows + 1),
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  bitmaps.forEach((bitmap, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const x = GAP + c * (TILE_W + GAP);
    const y = GAP + r * (tileH + GAP);
    ctx.fillStyle = '#161616';
    ctx.fillRect(x, y, TILE_W, tileH);

    const scale = Math.min(TILE_W / bitmap.width, tileH / bitmap.height);
    const dw = Math.round(bitmap.width * scale);
    const dh = Math.round(bitmap.height * scale);
    ctx.drawImage(bitmap, x + (TILE_W - dw) / 2, y + (tileH - dh) / 2, dw, dh);

    // 左上に大きな番号（AI はこの数字で答える）
    const size = Math.round(tileH / 5);
    ctx.font = `bold ${size}px sans-serif`;
    const label = String(i + 1);
    const metrics = ctx.measureText(label);
    const pad = Math.round(size * 0.22);
    ctx.fillStyle = '#eb1e1e';
    ctx.fillRect(x, y, metrics.width + pad * 2, size + pad * 2);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x + pad, y + pad);
  });

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return blobToBase64(blob);
}

export async function blobToBase64(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 書き出し結果の一覧シート。 */
export async function resultSheet(entries, tileWidth = 420, cols = 4) {
  if (!entries.length) return null;
  const first = entries[0].bitmap;
  const ratio = first.height / first.width;
  const tileH = Math.round(tileWidth * ratio);
  const useCols = Math.min(cols, entries.length);
  const rows = Math.ceil(entries.length / useCols);
  const gap = 10;
  const labelH = Math.round(tileH * 0.13);

  const canvas = new OffscreenCanvas(
    useCols * tileWidth + gap * (useCols + 1),
    rows * (tileH + labelH) + gap * (rows + 1),
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  entries.forEach((entry, i) => {
    const r = Math.floor(i / useCols), c = i % useCols;
    const x = gap + c * (tileWidth + gap);
    const y = gap + r * (tileH + labelH + gap);
    ctx.fillStyle = '#161616';
    ctx.fillRect(x, y, tileWidth, tileH);
    const scale = Math.min(tileWidth / entry.bitmap.width, tileH / entry.bitmap.height);
    const dw = Math.round(entry.bitmap.width * scale);
    const dh = Math.round(entry.bitmap.height * scale);
    ctx.drawImage(entry.bitmap, x + (tileWidth - dw) / 2, y + (tileH - dh) / 2, dw, dh);

    ctx.fillStyle = '#282828';
    ctx.font = `${Math.round(tileWidth / 26)}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(entry.label, x + 4, y + tileH + labelH * 0.55);
  });

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}
