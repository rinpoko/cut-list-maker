"""処理全体の流れ。1 本の動画 → カット検出 → ベストフレーム選定 → 書き出し。"""

import glob
import json
import os
import re
import time

from . import detect, gemini, score, sheet, video


def _log_noop(*_args):
    pass


def _unique_dir(base):
    if not os.path.exists(base):
        return base
    return base


# 読点・句点などの切れ目。区切り文字は前の語にくっつけたまま分ける。
_PHRASE_BREAK = re.compile(r"(?<=[、。，．！？!?,.])")


def _phrases(text):
    """ナレーションを読点・句点で自然なかたまりに分ける。"""
    parts = [p for p in _PHRASE_BREAK.split(text or "") if p.strip()]
    return parts or ([text] if text else [])


def _place(picks, start, end):
    """その言葉が「いちばん長く聞こえている」カットを返す。

    読み始めた時刻だけで決めると、カットの変わり目の数十ミリ秒手前から声が出た
    ときに前のカットへ寄ってしまい、絵と言葉がずれる。実際に重なっている時間で
    決めれば、その言葉を聞いている間に映っている絵に付く。
    同点なら先のカットを採る。
    """
    end = max(end, start + 1e-3)
    best = None
    best_overlap = 0.0
    for pick in picks:
        overlap = min(end, pick["cut_end"]) - max(start, pick["cut_start"])
        if overlap > best_overlap + 1e-9:
            best_overlap = overlap
            best = pick
    if best is not None:
        return best
    return min(picks, key=lambda p: min(abs(p["cut_start"] - start),
                                        abs(p["cut_end"] - start)))


def _assign_narration(segments, picks):
    """聞き取ったナレーションを、それが実際に読まれているカットに置く。

    1つのナレーションが複数カットにまたがるとき、まとめて先頭のカットに書くと
    絵と言葉がずれてしまう。読点・句点でフレーズに分け、フレーズごとに
    「そこが読まれ始める時刻」を文字数の進み具合から見積もって、
    その瞬間に映っているカットに置く。
    """
    for pick in picks:
        pick["narration"] = ""
        pick["narration_type"] = ""

    if not picks:
        return

    written_by = {}   # カットの id -> 最後に書き込んだ発話のインデックス
    for seg_index, seg in enumerate(segments):
        phrases = _phrases(seg["text"])
        if not phrases:
            continue
        span = max(1e-6, seg["end"] - seg["start"])
        total = float(sum(len(p) for p in phrases)) or 1.0

        consumed = 0
        for phrase in phrases:
            # 話す速さは文字数にほぼ比例するので、文字の進み具合で時間帯を見積もる
            phrase_start = seg["start"] + span * (consumed / total)
            consumed += len(phrase)
            phrase_end = seg["start"] + span * (consumed / total)
            target = _place(picks, phrase_start, phrase_end)

            key = id(target)
            if not target["narration"]:
                target["narration"] = phrase
            elif written_by.get(key) == seg_index:
                target["narration"] += phrase          # 同じ発話の続き
            else:
                target["narration"] += "\u3000" + phrase   # 別の発話
            written_by[key] = seg_index
            if not target["narration_type"]:
                target["narration_type"] = seg.get("type") or "NA"


def _prepare_outdir(video_path, cfg):
    stem = os.path.splitext(os.path.basename(video_path))[0]
    if cfg.get("output_mode") in ("custom", "ask") and cfg.get("output_dir"):
        parent = os.path.expanduser(cfg["output_dir"])
    else:
        parent = os.path.dirname(os.path.abspath(video_path))
    outdir = os.path.join(parent, "%s_カット" % stem)
    os.makedirs(outdir, exist_ok=True)
    # 前回の結果を掃除（カット数が変わっても古い画像が残らないように）
    for old in glob.glob(os.path.join(outdir, "cut*.png")) + \
            glob.glob(os.path.join(outdir, "cut*.jpg")) + \
            glob.glob(os.path.join(outdir, "_*.png")) + \
            glob.glob(os.path.join(outdir, "_*.jpg")):
        try:
            os.remove(old)
        except OSError:
            pass
    return outdir


def process_video(path, cfg, log=_log_noop, progress=None):
    started = time.time()

    def report(fraction, message):
        if progress:
            progress(max(0.0, min(1.0, fraction)), message)

    if not os.path.exists(path):
        raise video.VideoError("ファイルが見つかりません: %s" % path)

    log("■ %s" % os.path.basename(path))
    info = video.probe(path)
    log("  %dx%d / %.2f fps / %.2f 秒 / %s"
        % (info["width"], info["height"], info["fps"], info["duration"], info["codec"]))

    report(0.03, "動画を読み込み中…")
    def frame_progress(done, total):
        report(0.03 + 0.30 * (done / float(max(1, total))), "動画を読み込み中… %d フレーム" % done)

    frames, (aw, ah) = video.read_frames(path, info, progress=frame_progress)
    fps = video.effective_fps(path, info, len(frames))
    if abs(fps - (info["fps"] or 0)) > 0.05:
        log("  ※ 実測フレームレートを採用: %.3f fps（メタ情報は %.3f fps）"
            % (fps, info["fps"]))
    log("  解析用フレーム: %d 枚 (%dx%d)" % (len(frames), aw, ah))

    report(0.36, "カットの切り替わりを検出中…")
    cuts, meta = detect.detect_cuts(
        frames, fps,
        threshold=float(cfg.get("sensitivity", 27.0)),
        min_cut_seconds=float(cfg.get("min_cut_seconds", 0.30)),
    )
    log("  → %d カットを検出" % len(cuts))

    report(0.42, "各カットの候補フレームを採点中…")
    per_cut = []
    for i, cut in enumerate(cuts):
        cands = score.pick_candidates(
            frames, cut, meta, fps, count=int(cfg.get("candidates_per_cut", 9))
        )
        per_cut.append({"cut": cut, "candidates": cands})
        report(0.42 + 0.20 * ((i + 1) / float(len(cuts))),
               "候補を採点中… (%d/%d カット)" % (i + 1, len(cuts)))

    # --- AI による最終選定 ---
    shortlist_n = max(2, int(cfg.get("ai_shortlist", 6)))
    ai_choice = {}
    ai_model = ""
    use_ai = bool(cfg.get("use_ai", True)) and bool(cfg.get("api_key", "").strip())

    ai_state = {}
    if use_ai:
        report(0.60, "AI にベストな瞬間を判定してもらっています…")
        try:
            api_key = cfg["api_key"].strip()
            ai_model = cfg.get("model", "") or gemini.resolve_model(api_key, "")
            log("  AI 判定: %s" % ai_model)
            payload = []
            for entry in per_cut:
                shortlist = entry["candidates"][:shortlist_n]
                shortlist = sorted(shortlist, key=lambda c: c["frame_index"])
                entry["shortlist"] = shortlist
                payload.append({
                    "cut": entry["cut"]["index"],
                    "count": len(shortlist),
                    "jpeg": sheet.candidate_sheet(frames, shortlist),
                })
            ai_choice = gemini.select_best_frames(api_key, ai_model, payload, log, ai_state)
            ai_model = ai_state.get("model", ai_model)
            log("  → AI が %d カット分を選定" % len(ai_choice))
        except Exception as exc:  # AI が使えなくてもローカル判定で完走させる
            log("  ⚠ AI 判定をスキップしました: %s" % exc)
            ai_choice = {}
    else:
        if not cfg.get("api_key", "").strip():
            log("  （API キー未設定のため、ローカル判定のみで選定します）")
        for entry in per_cut:
            entry["shortlist"] = entry["candidates"][:shortlist_n]

    # --- 書き出し ---
    outdir = _prepare_outdir(path, cfg)
    ext = "png" if cfg.get("image_format", "png") == "png" else "jpg"
    picks = []
    report(0.72, "画像を書き出し中…")

    for i, entry in enumerate(per_cut):
        cut = entry["cut"]
        shortlist = entry.get("shortlist") or entry["candidates"][:shortlist_n]
        chosen = entry["candidates"][0]
        source = "local"
        reason = ""

        sel = ai_choice.get(cut["index"])
        if sel:
            pos = sel.get("best", 0)
            if isinstance(pos, int) and 1 <= pos <= len(shortlist):
                chosen = shortlist[pos - 1]
                source = "ai"
                reason = sel.get("reason", "")

        name = "cut%02d_%06.2fs.%s" % (cut["index"], chosen["time"], ext)
        out_path = os.path.join(outdir, name)
        try:
            video.extract_frame(path, chosen["time"], out_path,
                                image_format=ext, quality=int(cfg.get("jpeg_quality", 95)),
                                duration=info.get("duration") or 0.0, step=1.0 / fps)
        except Exception as exc:
            # 1カット失敗しても残りは書き出す
            log("  ⚠ カット%02d を書き出せませんでした: %s" % (cut["index"], exc))
            continue

        picks.append({
            "cut": cut["index"],
            "file": name,
            "time": chosen["time"],
            "frame_index": chosen["frame_index"],
            "cut_start": cut["start_time"],
            "cut_end": cut["end_time"],
            "cut_duration": cut["duration"],
            "cut_frames": cut["end_frame"] - cut["start_frame"] + 1,
            "chosen_by": source,
            "reason": reason,
            "direction": "",
            "local_score": round(chosen["local_score"], 4),
            "frame": chosen["frame_index"],
        })
        report(0.62 + 0.20 * ((i + 1) / float(len(per_cut))),
               "画像を書き出し中… (%d/%d)" % (i + 1, len(per_cut)))

    # --- 選ばれた絵を実際に見て、CMコンテのト書きを書かせる ---
    directions = {}
    if use_ai and cfg.get("write_directions", True) and picks:
        report(0.84, "各カットのト書きを書いています…")
        try:
            payload = [{
                "cut": pick["cut"],
                "duration": pick["cut_duration"],
                "jpeg": sheet.file_jpeg(os.path.join(outdir, pick["file"])),
            } for pick in picks]
            directions = gemini.write_directions(
                cfg["api_key"].strip(), ai_model, payload, log, ai_state)
            ai_model = ai_state.get("model", ai_model)
            for pick in picks:
                pick["direction"] = directions.get(pick["cut"], "")
            log("  → %d カット分のト書きを生成" % len(directions))
        except Exception as exc:  # ト書きが無くても画像とPPTXは出す
            log("  ⚠ ト書きの生成をスキップしました: %s" % exc)

    # --- ナレーションの音声認識 ---
    segments = []
    if use_ai and cfg.get("transcribe_narration", True) and picks:
        report(0.88, "ナレーションを聞き取っています…")
        audio_path = os.path.join(outdir, "_narration.flac")
        try:
            if video.extract_audio(path, audio_path):
                with open(audio_path, "rb") as fh:
                    audio = fh.read()
                log("  ナレーションを聞き取り中（音声 %.1f MB）…" % (len(audio) / 1048576.0))
                segments = gemini.transcribe(
                    cfg["api_key"].strip(), ai_model, audio, "audio/flac", log, ai_state)
                ai_model = ai_state.get("model", ai_model)
                _assign_narration(segments, picks)
                spoken = sum(1 for p in picks if p.get("narration"))
                log("  → %d 箇所を聞き取り、%d カットに割り当てました" % (len(segments), spoken))
            else:
                log("  （音声トラックが無いため、ナレーションは付けません）")
        except Exception as exc:  # 聞き取れなくても画像とPPTXは出す
            log("  ⚠ ナレーションの聞き取りをスキップしました: %s" % exc)
        finally:
            try:
                os.remove(audio_path)
            except OSError:
                pass

    for pick in picks:
        pick.pop("frame", None)

    if cfg.get("save_contact_sheet", True):
        sheet.result_sheet(frames, picks, os.path.join(outdir, "_一覧.jpg"))

    # --- コンテ PPTX ---
    pptx_path = ""
    if cfg.get("export_pptx", True) and picks:
        report(0.94, "コンテ PPTX を作成中…")
        try:
            from . import pptx_export
            stem = os.path.splitext(os.path.basename(path))[0]
            pptx_path = pptx_export.build_deck(
                picks, outdir, os.path.join(outdir, "%s_コンテ.pptx" % stem),
                title=stem,
                subtitle="%d カット / %.1f秒 / %s" % (
                    len(picks), info["duration"],
                    time.strftime("%Y-%m-%d")),
                cols=int(cfg.get("pptx_cols", 4)),
                rows=int(cfg.get("pptx_rows", 2)),
                fps=fps,
            )
            log("  → コンテ PPTX: %s" % os.path.basename(pptx_path))
        except Exception as exc:
            log("  ⚠ PPTX の書き出しに失敗しました: %s" % exc)
            pptx_path = ""

    # --- カット表 XLSX ---
    xlsx_path = ""
    if cfg.get("export_xlsx", True) and picks:
        report(0.97, "カット表 Excel を作成中…")
        try:
            from . import xlsx_export
            stem = os.path.splitext(os.path.basename(path))[0]
            xlsx_path = xlsx_export.build_sheet(
                picks, outdir, os.path.join(outdir, "%s_カット表.xlsx" % stem),
                title=stem,
                subtitle="%d カット / %.1f秒 / %s" % (
                    len(picks), info["duration"], time.strftime("%Y-%m-%d")),
                fps=fps,
            )
            log("  → カット表 Excel: %s" % os.path.basename(xlsx_path))
        except Exception as exc:
            log("  ⚠ Excel の書き出しに失敗しました: %s" % exc)
            xlsx_path = ""

    report_path = os.path.join(outdir, "_report.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump({
            "source": os.path.abspath(path),
            "video": {k: info[k] for k in ("width", "height", "fps", "duration", "frames", "codec")},
            "cut_count": len(picks),
            "ai_model": ai_model,
            "ai_used": bool(ai_choice),
            "directions_used": bool(directions),
            "narration_used": bool(segments),
            "narration_segments": segments,
            "sensitivity": cfg.get("sensitivity"),
            "fps": round(fps, 4),
            "pptx": os.path.basename(pptx_path) if pptx_path else "",
            "xlsx": os.path.basename(xlsx_path) if xlsx_path else "",
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "cuts": picks,
        }, fh, ensure_ascii=False, indent=2)

    elapsed = time.time() - started
    log("  ✓ %d 枚を書き出しました（%.1f 秒）" % (len(picks), elapsed))
    log("  → %s" % outdir)
    report(1.0, "完了")

    return {
        "video": path,
        "outdir": outdir,
        "cuts": picks,
        "ai_used": bool(ai_choice),
        "ai_model": ai_model,
        "pptx": pptx_path,
        "xlsx": xlsx_path,
        "fps": fps,
        "elapsed": elapsed,
    }
