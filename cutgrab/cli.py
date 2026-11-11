"""コマンドラインから使う場合のエントリポイント。

例:
    python3 -m cutgrab.cli sample.mp4
    python3 -m cutgrab.cli --no-ai --sensitivity 22 *.mp4
"""

import argparse
import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cutgrab import APP_NAME, __version__, config, pipeline, video  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="cutgrab", description="%s v%s — CM動画からカットごとのベスト1枚を書き出す"
                                    % (APP_NAME, __version__)
    )
    parser.add_argument("inputs", nargs="+", help="動画ファイル、またはフォルダ")
    parser.add_argument("--out", default="", help="書き出し先の親フォルダ（既定: 動画と同じ場所）")
    parser.add_argument("--api-key", default="", help="Gemini API キー（既定: 設定/環境変数）")
    parser.add_argument("--model", default="", help="Gemini モデル名（既定: 自動選択）")
    parser.add_argument("--no-ai", action="store_true", help="AI 判定を使わずローカル判定のみ")
    parser.add_argument("--sensitivity", type=float, default=None,
                        help="カット検出のしきい値 12〜45（小さいほど細かく切る / 既定 27）")
    parser.add_argument("--format", choices=["png", "jpg"], default=None, help="書き出し形式")
    parser.add_argument("--candidates", type=int, default=None, help="1カットあたりの候補数")
    args = parser.parse_args(argv)

    cfg = config.load()
    if args.api_key:
        cfg["api_key"] = args.api_key
    if args.model:
        cfg["model"] = args.model
    if args.no_ai:
        cfg["use_ai"] = False
    if args.sensitivity is not None:
        cfg["sensitivity"] = args.sensitivity
    if args.format:
        cfg["image_format"] = args.format
    if args.candidates:
        cfg["candidates_per_cut"] = args.candidates
    if args.out:
        cfg["output_mode"] = "custom"
        cfg["output_dir"] = args.out

    targets = []
    for item in args.inputs:
        path = os.path.abspath(os.path.expanduser(item))
        if os.path.isdir(path):
            for name in sorted(os.listdir(path)):
                if video.is_video(name):
                    targets.append(os.path.join(path, name))
        elif video.is_video(path):
            targets.append(path)
        else:
            print("スキップ（動画ではありません）: %s" % path)

    if not targets:
        print("処理できる動画がありませんでした。")
        return 1

    failures = 0
    for path in targets:
        try:
            pipeline.process_video(path, cfg, log=print,
                                   progress=lambda f, m: None)
        except Exception as exc:
            failures += 1
            print("  ✗ 失敗: %s" % exc)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
