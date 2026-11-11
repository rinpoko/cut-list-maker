/* カット表の Excel (.xlsx) を書き出す。cutgrab/xlsx_export.py の移植。
 *
 * カット数ぶんの行が上から下に並び、左から順に
 *   カット番号 / キャプチャ画像 / ナレーション / ト書き / タイムコード /
 *   クライアントFB / 修正ポイント / 備考・素材など
 * 後ろの3列は書き込んでもらうための空欄。 */

import { formatTimecode, formatDuration } from './timecode.js';

const INK = 'FF1D2026';
const MUTED = 'FF8A909C';
const HEAD_BG = 'FF2C3242';
const INPUT_BG = 'FFFFFDF5';
const BORDER = 'FFD5D8DE';
const DIM = 'FF808080';

// 游ゴシックは macOS・Windows のどちらにも入っているので、
// クライアントに渡しても書体が置き換わらない
const JP_FONT = 'Yu Gothic';

const IMAGE_WIDTH_PX = 260;
const CELL_PAD_PX = 6;

const COLUMNS = [
  ['カット番号', 9.0],
  ['キャプチャ画像', IMAGE_WIDTH_PX / 7.0],
  ['ナレーション', 30.0],
  ['ト書き', 30.0],
  ['タイムコード', 15.0],
  ['クライアントFB', 30.0],
  ['修正ポイント', 30.0],
  ['備考・素材など', 30.0],
];
const INPUT_FROM = 5;

const edge = { style: 'thin', color: { argb: BORDER } };
const BORDERS = { top: edge, left: edge, bottom: edge, right: edge };

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function buildSheet(picks, { title = '', subtitle = '', fps = 24 } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('カット表', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  COLUMNS.forEach(([, width], index) => { sheet.getColumn(index + 1).width = width; });

  sheet.getCell('A1').value = title || 'カット表';
  sheet.getCell('A1').font = { name: JP_FONT, bold: true, size: 14, color: { argb: INK } };
  sheet.getRow(1).height = 22;
  if (subtitle) {
    sheet.getCell('A2').value = subtitle;
    sheet.getCell('A2').font = { name: JP_FONT, size: 9, color: { argb: MUTED } };
  }
  sheet.getRow(2).height = 16;

  const headerRow = 4;
  COLUMNS.forEach(([name], index) => {
    const cell = sheet.getCell(headerRow, index + 1);
    cell.value = name;
    cell.font = { name: JP_FONT, bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = BORDERS;
  });
  sheet.getRow(headerRow).height = 24;

  // 画像の縦横比は素材から取る（16:9 とは限らない）
  const first = picks.find((p) => p.width && p.height);
  const aspect = first ? first.height / first.width : 9 / 16;
  const imageHpx = IMAGE_WIDTH_PX * aspect;

  for (let offset = 0; offset < picks.length; offset++) {
    const pick = picks[offset];
    const rowIndex = headerRow + 1 + offset;
    const row = sheet.getRow(rowIndex);
    row.height = (imageHpx + CELL_PAD_PX * 2) * 0.75;   // px → pt

    const put = (column, value, font, extra = {}) => {
      const cell = sheet.getCell(rowIndex, column);
      cell.value = value;
      cell.font = { name: JP_FONT, ...font };
      cell.border = BORDERS;
      cell.alignment = { vertical: 'middle', wrapText: true, horizontal: 'left', ...extra };
      return cell;
    };

    put(1, pick.cut, { bold: true, size: 13, color: { argb: INK } }, { horizontal: 'center' });
    sheet.getCell(rowIndex, 2).border = BORDERS;
    put(3, pick.narration || '', { size: 10, color: { argb: INK } });
    put(4, pick.direction || '', { size: 9, color: { argb: DIM } });
    put(5, `${formatTimecode(pick, fps)}\n${formatDuration(pick, fps)}`,
        { size: 9, color: { argb: MUTED } }, { horizontal: 'center' });

    for (let column = INPUT_FROM + 1; column <= COLUMNS.length; column++) {
      const cell = sheet.getCell(rowIndex, column);
      cell.border = BORDERS;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INPUT_BG } };
      cell.alignment = { vertical: 'top', wrapText: true, horizontal: 'left' };
      cell.font = { name: JP_FONT, size: 10 };
    }

    if (pick.blob) {
      const imageId = workbook.addImage({
        base64: await toBase64(pick.blob),
        extension: pick.file && pick.file.endsWith('.jpg') ? 'jpeg' : 'png',
      });
      // tl の小数部は「その行の高さ・その列の幅に対する割合」なので、
      // 余白のピクセル数をセルの実寸で割って出す
      const rowHeightPx = imageHpx + CELL_PAD_PX * 2;
      const columnWidthPx = COLUMNS[1][1] * 7 + 5;
      sheet.addImage(imageId, {
        tl: {
          col: 1 + CELL_PAD_PX / columnWidthPx,
          row: rowIndex - 1 + CELL_PAD_PX / rowHeightPx,
        },
        ext: { width: IMAGE_WIDTH_PX, height: imageHpx },
        editAs: 'absolute',
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
