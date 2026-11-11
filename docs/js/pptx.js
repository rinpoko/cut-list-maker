/* CMコンテ用の PPTX を書き出す。cutgrab/pptx_export.py の移植。
 *
 * 1 ページに 列数 x 行数 のカットを並べる。1カットの構成は上から
 *   カット番号（絵の外・左上、囲みなし）
 *   絵
 *   ナレーション（黒）
 *   ト書き（ナレーションより 2pt 小さくグレー50%）
 *   タイムコード / 尺（Premiere と同じ HH:MM:SS:FF）
 *
 * レイアウトは固定値ではなく、実際の文章量から解く。
 */

import { formatTimecode, formatDuration } from './timecode.js';

const INK = '1D2026';
const MUTED = '8A909C';
const GRAY50 = '808080';

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MARGIN_X = 0.4;

/** 作った PC に確実にある日本語書体を選ぶ（PPTX には書体名が埋め込まれるため）。 */
function jpFont() {
  const ua = navigator.userAgent || '';
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'Yu Gothic';
  return 'Hiragino Kaku Gothic ProN';
}

/** 文字列の見た目の幅を「全角何文字ぶんか」で概算する。 */
function textUnits(text) {
  let total = 0;
  for (const ch of String(text || '')) total += ch.codePointAt(0) < 0x2E80 ? 0.55 : 1;
  return total;
}

/** その幅・その文字サイズで何行になるか。空文字なら 0 行。 */
function lineCount(text, widthInches, pointSize) {
  if (!text) return 0;
  // PowerPoint 側の折り返しが見積もりより 1 行増えないよう、使える幅を辛めに見る
  const perLine = Math.max(1, widthInches * 0.95 / (pointSize / 72));
  return Math.max(1, Math.ceil(textUnits(text) / perLine));
}

function rowGroups(picks, cols, rows) {
  const perPage = cols * rows;
  const pages = [];
  for (let start = 0; start < picks.length; start += perPage) {
    const chunk = picks.slice(start, start + perPage);
    const grid = [];
    for (let i = 0; i < chunk.length; i += cols) grid.push(chunk.slice(i, i + cols));
    pages.push(grid);
  }
  return pages.length ? pages : [[[]]];
}

/** ある絵の幅に対する、1カット分の各パーツの高さ。 */
class Metrics {
  constructor(widthIn, aspect) {
    this.LINE = 1.32;
    this.GAP_UNDER_NUMBER = 0.03;
    this.GAP_UNDER_IMAGE = 0.07;
    this.GAP_BETWEEN_TEXT = 0.09;

    this.width = widthIn;
    this.imageH = widthIn * aspect;
    this.narrationPt = Math.max(7, Math.min(13, widthIn * 4.7));
    this.directionPt = Math.max(6, this.narrationPt - 2);
    this.metaPt = Math.max(5.5, Math.min(8, widthIn * 3.1));
    this.numberPt = Math.max(9, Math.min(17, widthIn * 5.4));
    this.numberH = this.numberPt * 1.30 / 72 + 0.02;
    this.metaH = this.metaPt * 1.35 / 72 + 0.02;
  }

  lineH(pointSize) { return pointSize * this.LINE / 72; }

  /** 行の中で一番行数の多いカットに合わせる。誰も書いていない要素は領域を作らない。 */
  rowHeight(row) {
    const narrationLines = Math.max(0, ...row.map((p) => lineCount(p.narration, this.width, this.narrationPt)));
    const directionLines = Math.max(0, ...row.map((p) => lineCount(p.direction, this.width, this.directionPt)));
    let height = this.numberH + this.GAP_UNDER_NUMBER + this.imageH + this.GAP_UNDER_IMAGE;
    if (narrationLines) height += narrationLines * this.lineH(this.narrationPt);
    if (directionLines) {
      if (narrationLines) height += this.GAP_BETWEEN_TEXT;
      height += directionLines * this.lineH(this.directionPt);
    }
    return { height: height + 0.03 + this.metaH, narrationLines, directionLines };
  }
}

/** 全ページが収まる範囲で、いちばん絵が大きくなる幅を探す。 */
function solveWidth(pages, cellWIn, usableHIn, gutterY, aspect) {
  const lowest = cellWIn * 0.30;
  const step = cellWIn * 0.01;
  for (let width = cellWIn; width >= lowest; width -= step) {
    const metrics = new Metrics(width, aspect);
    let tallest = 0;
    for (const page of pages) {
      let total = page.reduce((sum, row) => sum + metrics.rowHeight(row).height, 0);
      total += gutterY * Math.max(0, page.length - 1);
      tallest = Math.max(tallest, total);
    }
    if (tallest <= usableHIn) return metrics;
  }
  return new Metrics(lowest, aspect);
}

async function dataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

/** picks から PPTX を組んで Blob で返す。 */
export async function buildDeck(picks, { title = '', subtitle = '', cols = 4, rows = 2, fps = 24 } = {}) {
  cols = Math.max(1, parseInt(cols, 10) || 4);
  rows = Math.max(1, parseInt(rows, 10) || 2);
  const font = jpFont();

  // 縦長のグリッド（行数 > 列数）のときはスライドも縦向きにする
  const portrait = rows > cols;
  const slideW = portrait ? SLIDE_H : SLIDE_W;
  const slideH = portrait ? SLIDE_W : SLIDE_H;

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'CUTLIST', width: slideW, height: slideH });
  pptx.layout = 'CUTLIST';

  // 実際の絵の縦横比を使う（16:9 とは限らない）
  const first = picks.find((p) => p.width && p.height);
  const aspect = first ? first.height / first.width : 9 / 16;

  const marginTop = rows >= 3 ? 0.62 : 0.72;
  const marginBottom = 0.22;
  const gutterXMin = 0.10;
  const gutterYMin = 0.14;

  const cellWIn = (slideW - MARGIN_X * 2 - gutterXMin * (cols - 1)) / cols;
  const usableHIn = slideH - marginTop - marginBottom;

  const pages = rowGroups(picks, cols, rows);
  const metrics = solveWidth(pages, cellWIn, usableHIn, gutterYMin, aspect);
  const contentW = metrics.width;

  // 横に余ったぶんは列の間隔に配って、絵をページ全体に散らす
  const spareX = slideW - MARGIN_X * 2 - contentW * cols;
  const gutterX = cols > 1 ? Math.max(gutterXMin, Math.min(0.42, spareX / (cols - 1))) : 0;
  const gridW = contentW * cols + gutterX * (cols - 1);
  const leftOffset = (slideW - gridW) / 2;

  const text = (slide, options, value, size, extra = {}) => {
    slide.addText(String(value ?? ''), {
      ...options, fontSize: size, fontFace: font, margin: 0,
      color: INK, align: 'left', valign: 'top', wrap: true, ...extra,
    });
  };

  const images = new Map();
  for (const pick of picks) {
    if (pick.blob) images.set(pick, await dataUrl(pick.blob));
  }

  pages.forEach((page, pageIndex) => {
    const slide = pptx.addSlide();
    const headW = slideW - MARGIN_X * 2 - 1.4;
    const headPt = rows <= 2 ? 15 : 13;
    text(slide, { x: MARGIN_X, y: 0.22, w: headW, h: 0.30 }, title || 'カット表', headPt, { bold: true });
    if (subtitle) {
      text(slide, { x: MARGIN_X, y: 0.22 + headPt * 1.5 / 72, w: headW, h: 0.2 }, subtitle, 8.5, { color: MUTED });
    }
    text(slide, { x: slideW - MARGIN_X - 1.4, y: 0.24, w: 1.4, h: 0.3 },
         `${pageIndex + 1} / ${pages.length}`, 9.5, { color: MUTED, align: 'right' });

    // このページの行の高さを出して、余りを行間に均等に配る
    const measured = page.map((row) => metrics.rowHeight(row));
    let blockH = measured.reduce((sum, m) => sum + m.height, 0);
    const slack = usableHIn - blockH;
    let gutterY = gutterYMin;
    if (page.length > 1 && slack > 0) gutterY = Math.min(0.5, gutterYMin + slack / page.length);
    blockH += gutterY * Math.max(0, page.length - 1);
    let y = marginTop + Math.max(0, (usableHIn - blockH) / 2);

    page.forEach((row, rowIndex) => {
      const { height: rowH, narrationLines, directionLines } = measured[rowIndex];

      row.forEach((pick, colIndex) => {
        const cellX = leftOffset + colIndex * (contentW + gutterX);
        const imageY = y + metrics.numberH + metrics.GAP_UNDER_NUMBER;

        const scale = Math.min(contentW / (pick.width || 16), metrics.imageH / (pick.height || 9));
        const drawW = (pick.width || 16) * scale;
        const drawH = (pick.height || 9) * scale;
        const imgX = cellX + (contentW - drawW) / 2;
        if (images.has(pick)) {
          slide.addImage({ data: images.get(pick), x: imgX, y: imageY, w: drawW, h: drawH });
        }

        // 絵の外・左上にカット番号（囲みなし、数字だけ）
        text(slide, { x: imgX, y, w: contentW, h: metrics.numberH },
             String(pick.cut).padStart(2, '0'), metrics.numberPt, { bold: true, valign: 'bottom' });

        let textY = imageY + drawH + metrics.GAP_UNDER_IMAGE;

        if (narrationLines) {
          const h = narrationLines * metrics.lineH(metrics.narrationPt);
          text(slide, { x: cellX, y: textY, w: contentW, h }, pick.narration || '', metrics.narrationPt);
          textY += h;
          if (directionLines) textY += metrics.GAP_BETWEEN_TEXT;
        }
        if (directionLines) {
          const h = directionLines * metrics.lineH(metrics.directionPt);
          text(slide, { x: cellX, y: textY, w: contentW, h }, pick.direction || '', metrics.directionPt, { color: GRAY50 });
          textY += h;
        }
        text(slide, { x: cellX, y: textY + 0.03, w: contentW, h: metrics.metaH },
             `${formatTimecode(pick, fps)} / ${formatDuration(pick, fps)}`, metrics.metaPt, { color: MUTED });
      });

      y += rowH + gutterY;
    });
  });

  return pptx.write({ outputType: 'blob' });
}
