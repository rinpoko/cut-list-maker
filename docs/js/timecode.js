/* タイムコード表記。デスクトップ版 pptx_export.py と同じ数え方にそろえている。 */

/** 1秒あたりのフレーム数（整数）。23.976 なら 24、29.97 なら 30。 */
export function frameRate(fps) {
  return fps && fps > 0 ? Math.max(1, Math.round(fps)) : 24;
}

/** 総フレーム数を [秒, フレーム] に分ける。fps に達したら次の秒へ繰り上がる。 */
export function splitFrames(total, fps) {
  const rate = frameRate(fps);
  const n = Math.max(0, Math.round(total));
  return [Math.floor(n / rate), n % rate];
}

/** Premiere Pro と同じ HH:MM:SS:FF 表記。 */
export function timecode(totalFrames, fps) {
  const [seconds, frames] = splitFrames(totalFrames, fps);
  const s = seconds % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(frames)}`;
}

/** その絵が動画のどの位置か。 */
export function formatTimecode(pick, fps) {
  const index = pick.frameIndex != null
    ? pick.frameIndex
    : Math.round((pick.time || 0) * frameRate(fps));
  return timecode(index, fps);
}

/** そのカットの長さ（尺）。 */
export function formatDuration(pick, fps) {
  const total = pick.cutFrames || Math.round((pick.cutDuration || 0) * frameRate(fps));
  return timecode(total, fps);
}
