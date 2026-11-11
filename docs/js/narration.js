/* 聞き取ったナレーションを、実際に読まれているカットに置く。
 * cutgrab/pipeline.py の _phrases / _place / _assign_narration の移植。 */

// 読点・句点などの切れ目。区切り文字は前の語にくっつけたまま分ける。
const PHRASE_BREAK = /(?<=[、。，．！？!?,.])/;

export function phrases(text) {
  const parts = String(text || '').split(PHRASE_BREAK).filter((p) => p.trim());
  return parts.length ? parts : (text ? [text] : []);
}

/**
 * その言葉が「いちばん長く聞こえている」カットを返す。
 *
 * 読み始めた時刻だけで決めると、カットの変わり目の数十ミリ秒手前から声が出た
 * ときに前のカットへ寄ってしまい、絵と言葉がずれる。実際に重なっている時間で
 * 決めれば、その言葉を聞いている間に映っている絵に付く。同点なら先のカット。
 */
export function place(picks, start, end) {
  const stop = Math.max(end, start + 1e-3);
  let best = null;
  let bestOverlap = 0;
  for (const pick of picks) {
    const overlap = Math.min(stop, pick.cutEnd) - Math.max(start, pick.cutStart);
    if (overlap > bestOverlap + 1e-9) { bestOverlap = overlap; best = pick; }
  }
  if (best) return best;
  return picks.reduce((a, b) => {
    const da = Math.min(Math.abs(a.cutStart - start), Math.abs(a.cutEnd - start));
    const db = Math.min(Math.abs(b.cutStart - start), Math.abs(b.cutEnd - start));
    return db < da ? b : a;
  });
}

/**
 * ナレーションを各カットに割り当てる。
 * 1 つの発話が複数カットにまたがるときは読点・句点でフレーズに分け、
 * 文字数の進み具合から各フレーズの時間帯を見積もって置く。
 */
export function assignNarration(segments, picks) {
  for (const pick of picks) { pick.narration = ''; pick.narrationType = ''; }
  if (!picks.length) return;

  const writtenBy = new Map();
  segments.forEach((seg, segIndex) => {
    const parts = phrases(seg.text);
    if (!parts.length) return;
    const span = Math.max(1e-6, seg.end - seg.start);
    const total = parts.reduce((sum, p) => sum + p.length, 0) || 1;

    let consumed = 0;
    for (const phrase of parts) {
      const phraseStart = seg.start + span * (consumed / total);
      consumed += phrase.length;
      const phraseEnd = seg.start + span * (consumed / total);
      const target = place(picks, phraseStart, phraseEnd);

      if (!target.narration) target.narration = phrase;
      else if (writtenBy.get(target) === segIndex) target.narration += phrase;
      else target.narration += '　' + phrase;
      writtenBy.set(target, segIndex);
      if (!target.narrationType) target.narrationType = seg.type || 'NA';
    }
  });
}
