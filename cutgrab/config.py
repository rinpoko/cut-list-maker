"""設定の読み書き。

保存先は OS ごとのユーザー領域。
  macOS   … ~/Library/Application Support/CutListMaker/config.json
  Windows … %APPDATA%\CutListMaker\config.json
アプリ本体（.app / 配布フォルダ）の中には何も書かないので、
フォルダごと人に渡しても API キーは付いていかない。
"""

import json
import os
import stat
import sys


def _config_dir():
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, "CutListMaker")
    return os.path.expanduser("~/Library/Application Support/CutListMaker")


CONFIG_DIR = _config_dir()
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

# 既定モデル。3.1 系にフルの Flash は存在せず lite のみ（2026-07 時点で API 実在確認済み）。
DEFAULT_MODEL = "gemini-3.1-flash-lite"

# 上から順に試す。混雑(503)や未提供(404)なら次へ自動フォールバックする。
DEFAULT_MODEL_CANDIDATES = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    "gemini-2.5-flash",
]

DEFAULTS = {
    "api_key": "",
    "model": DEFAULT_MODEL,       # 空 = 使えるモデルを自動選択
    "use_ai": True,               # False なら完全ローカル判定
    "image_format": "png",        # png / jpg
    "jpeg_quality": 95,
    "sensitivity": 27.0,          # カット検出のしきい値 (小さいほど細かく切る)
    "min_cut_seconds": 0.30,      # これより短いカットは前のカットに統合
    "candidates_per_cut": 9,      # 1カットあたりの候補フレーム数
    "ai_shortlist": 6,            # AI に見せる候補数 (ローカル上位から)
    "output_mode": "ask",         # ask = 毎回たずねる / beside = 動画と同じ場所 / custom
    "output_dir": "",             # 直近に選んだ書き出し先（次回の初期値になる）
    "open_when_done": True,
    "save_contact_sheet": True,
    "write_directions": True,     # ト書きを自動生成する
    "transcribe_narration": True, # ナレーションを音声認識して各カットに載せる
    "export_pptx": True,          # コンテ PPTX を書き出す
    "export_xlsx": True,          # カット表 XLSX を書き出す
    "pptx_cols": 4,               # PPTX 1ページの列数（横方向）
    "pptx_rows": 2,               # PPTX 1ページの行数（縦方向）
}


def _ensure_dir():
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
    except OSError:
        pass


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            for key, value in data.items():
                if key in cfg:
                    cfg[key] = value
    except (IOError, OSError, ValueError):
        pass

    if not cfg["api_key"]:
        for env_name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"):
            if os.environ.get(env_name):
                cfg["api_key"] = os.environ[env_name].strip()
                break
    return cfg


def save(cfg):
    _ensure_dir()
    data = {key: cfg.get(key, DEFAULTS[key]) for key in DEFAULTS}
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    try:
        os.chmod(CONFIG_PATH, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
