"""ffmpeg / ffprobe まわり。フレームの一括読み込みと、書き出し用の高画質フレーム抽出。"""

import json
import os
import shutil
import subprocess
import sys

import numpy as np

VIDEO_EXTS = {
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".mxf", ".mpg", ".mpeg",
    ".m2v", ".mts", ".m2ts", ".wmv", ".webm", ".flv", ".prores", ".dv",
}


class VideoError(Exception):
    pass


def _tool(name):
    # アプリに同梱された ffmpeg/ffprobe を最優先（Electron 版はこれを渡してくる）
    override = os.environ.get("CMCUT_" + name.upper())
    if override and os.path.exists(override):
        return override
    path = shutil.which(name)
    if path:
        return path
    if sys.platform != "win32":
        for candidate in ("/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/"):
            if os.path.exists(candidate + name):
                return candidate + name
        raise VideoError(
            "%s が見つかりません。Homebrew で `brew install ffmpeg` を実行してください。" % name
        )
    raise VideoError(
        "%s が見つかりません。アプリのフォルダから %s.exe が失われている可能性があります。"
        % (name, name)
    )


def ffmpeg_path():
    return _tool("ffmpeg")


def ffprobe_path():
    return _tool("ffprobe")


def is_video(path):
    return os.path.splitext(path)[1].lower() in VIDEO_EXTS


def _parse_rate(text):
    try:
        if "/" in str(text):
            num, den = str(text).split("/")
            num, den = float(num), float(den)
            return num / den if den else 0.0
        return float(text)
    except (TypeError, ValueError):
        return 0.0


def probe(path):
    """動画のメタ情報を返す。"""
    cmd = [
        ffprobe_path(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,codec_name:format=duration",
        "-of", "json", path,
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as exc:
        raise VideoError("動画を読み込めませんでした: %s" % exc.output.decode("utf-8", "replace")[:400])

    data = json.loads(out.decode("utf-8", "replace"))
    streams = data.get("streams") or []
    if not streams:
        raise VideoError("映像トラックが見つかりません: %s" % os.path.basename(path))
    stream = streams[0]

    fps = _parse_rate(stream.get("avg_frame_rate")) or _parse_rate(stream.get("r_frame_rate")) or 25.0
    duration = 0.0
    try:
        duration = float((data.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise VideoError("解像度を取得できませんでした: %s" % os.path.basename(path))

    try:
        nb_frames = int(stream.get("nb_frames") or 0)
    except (TypeError, ValueError):
        nb_frames = 0
    if nb_frames <= 0 and duration > 0:
        nb_frames = int(round(duration * fps))

    return {
        "path": path,
        "width": width,
        "height": height,
        "fps": fps,
        "duration": duration,
        "frames": nb_frames,
        "codec": stream.get("codec_name") or "",
    }


def read_frames(path, info, target_width=384, progress=None):
    """動画全体を縮小して BGR の numpy 配列(list)として読み込む。

    解析用。長尺やメモリ状況に応じて自動で解像度を落とす。
    """
    est_frames = max(info["frames"], 1)
    width = int(target_width)

    # メモリ上限のおおよその目安 (約 700MB)
    while width > 160:
        height = max(2, int(round(width * info["height"] / float(info["width"]))))
        if est_frames * width * height * 3 <= 700 * 1024 * 1024:
            break
        width -= 32

    width = max(160, width - (width % 2))
    height = int(round(width * info["height"] / float(info["width"])))
    height = max(2, height - (height % 2))

    cmd = [
        ffmpeg_path(), "-v", "error", "-nostdin",
        "-i", path,
        "-map", "0:v:0",
        # 素材のフレームをそのまま受け取る。これが無いと ffmpeg が出力を CFR に
        # 揃えようとしてフレームを複製・間引きし、フレーム番号と時刻がずれる。
        "-fps_mode", "passthrough",
        "-vf", "scale=%d:%d:flags=area" % (width, height),
        "-pix_fmt", "bgr24", "-f", "rawvideo", "-",
    ]
    frame_bytes = width * height * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    frames = []
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frames.append(np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3))
            if progress is not None and len(frames) % 25 == 0:
                progress(len(frames), est_frames)
    finally:
        try:
            proc.stdout.close()
        except (IOError, OSError):
            pass
        err = proc.stderr.read().decode("utf-8", "replace")
        proc.stderr.close()
        proc.wait()

    if not frames:
        raise VideoError("フレームを取得できませんでした。\n%s" % err[:400])
    return frames, (width, height)


def effective_fps(path, info, frame_count):
    """実際にデコードできたフレーム数から本当のフレームレートを割り出す。

    素材によっては ffprobe の avg_frame_rate が実際と食い違う（テレシネ、
    可変フレームレート、コンテナのメタデータ不一致など）。フレーム番号から
    時刻を出すときにずれると書き出す瞬間がまるごとずれるので、
    デコード結果を正とする。
    """
    duration = info.get("duration") or 0.0
    if frame_count > 1 and duration > 0.5:
        measured = frame_count / float(duration)
        declared = info.get("fps") or 0.0
        if declared <= 0 or abs(measured - declared) / max(declared, 1e-6) > 0.02:
            return measured
    return info.get("fps") or 25.0


def extract_audio(path, out_path, sample_rate=16000):
    """音声をモノラル 16kHz の FLAC に落とす。

    音声トラックが無い、または取り出せない場合は None を返す（処理は続行する）。
    FLAC は ffmpeg に必ず入っていて可逆なので、書き起こし精度を落とさずに小さくできる。
    """
    cmd = [
        ffmpeg_path(), "-v", "error", "-nostdin", "-y",
        "-i", path,
        "-map", "0:a:0",
        "-ac", "1", "-ar", str(int(sample_rate)),
        "-c:a", "flac", "-compression_level", "8",
        out_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) < 512:
        return None
    return out_path


def extract_frame(path, timestamp, out_path, image_format="png", quality=95,
                  duration=0.0, step=0.0):
    """指定時刻のフレームを元解像度・高画質で書き出す。

    末尾ぎりぎりの指定でシークが空振りすることがあるので、
    少しずつ手前に戻しながら数回試す。
    """
    if duration > 0:
        timestamp = min(timestamp, max(0.0, duration - max(step, 0.04)))
    attempts = [max(0.0, timestamp)]
    back = step if step > 0 else 0.04
    for i in range(1, 4):
        candidate = timestamp - back * i
        if candidate > 0:
            attempts.append(candidate)

    last_error = ""
    for attempt in attempts:
        cmd = [
            ffmpeg_path(), "-v", "error", "-nostdin", "-y",
            "-ss", "%.5f" % attempt,
            "-i", path,
            "-map", "0:v:0",
            "-frames:v", "1",
            "-update", "1",
        ]
        if image_format == "jpg":
            cmd += ["-q:v", str(max(1, min(31, int(round((100 - quality) / 3.0) + 1))))]
        cmd += [out_path]

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return out_path
        last_error = proc.stderr.decode("utf-8", "replace")[:300]

    raise VideoError(
        "フレーム書き出しに失敗しました (%.3fs): %s" % (timestamp, last_error or "原因不明")
    )
