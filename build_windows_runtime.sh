#!/bin/bash
# Windows 版に同梱する「インストール不要の Python 一式」を組み立てる。
#
# Windows 実機は要らない。python.org の埋め込み版 Python と、win_amd64 用の
# ホイールを macOS 側でダウンロードして展開するだけ。中身は macOS 版とまったく
# 同じ cutgrab のコードが動く。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/winruntime"
CACHE="$ROOT/.wincache"

PY_VERSION="3.11.9"
PY_TAG="311"
PY_ZIP="python-$PY_VERSION-embed-amd64.zip"
PY_URL="https://www.python.org/ftp/python/$PY_VERSION/$PY_ZIP"

echo "▶ Windows 用ランタイムを組み立てます"
mkdir -p "$CACHE"

# --- 1. 埋め込み Python ---
if [ ! -f "$CACHE/$PY_ZIP" ]; then
  echo "  埋め込み Python $PY_VERSION を取得中…"
  curl -sL -o "$CACHE/$PY_ZIP" "$PY_URL"
fi

rm -rf "$OUT"
mkdir -p "$OUT/python"
unzip -o -q "$CACHE/$PY_ZIP" -d "$OUT/python"

# --- 2. Windows 用ホイール ---
if [ ! -d "$CACHE/wheels" ] || [ -z "$(ls -A "$CACHE/wheels" 2>/dev/null)" ]; then
  echo "  Windows 用ホイールを取得中…（numpy / OpenCV / Pillow / python-pptx）"
  mkdir -p "$CACHE/wheels"
  /usr/bin/python3 -m pip download --quiet --only-binary=:all: \
    --platform win_amd64 --python-version "3.11" --implementation cp --abi cp311 \
    numpy pillow python-pptx -d "$CACHE/wheels"
  # OpenCV は abi3 ホイールなので別に取る（macOS 版と同じ 4.x 系に揃える）
  /usr/bin/python3 -m pip download --quiet --only-binary=:all: \
    --platform win_amd64 --python-version "3.11" --implementation cp --abi abi3 \
    "opencv-python-headless>=4.13,<5" -d "$CACHE/wheels"
fi

echo "  ホイールを展開中…"
mkdir -p "$OUT/python/Lib/site-packages"
for wheel in "$CACHE"/wheels/*.whl; do
  unzip -o -q "$wheel" -d "$OUT/python/Lib/site-packages"
done

# --- 3. sys.path の設定 ---
# 埋め込み版は既定で site-packages を見ないので、明示的に通す。
# `..` を入れて、python フォルダの隣にある cutgrab を import できるようにする。
cat > "$OUT/python/python$PY_TAG._pth" <<EOF
python$PY_TAG.zip
.
..
Lib\\site-packages

import site
EOF

# --- 4. 解析エンジン本体（macOS 版と同一のコード） ---
mkdir -p "$OUT/cutgrab"
cp "$ROOT"/cutgrab/*.py "$OUT/cutgrab/"
cp "$ROOT"/cutgrab/ui.html "$OUT/cutgrab/"

# --- 5. 使わないものを削って軽くする ---
# 消すのは実行に絶対関わらないものだけ。ライブラリ本体には手を付けない。
echo "  不要ファイルを削除中…"
find "$OUT" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT" -name "*.pyi" -delete 2>/dev/null || true

SIZE=$(du -sh "$OUT" | cut -f1)
echo "✓ 完成: $OUT  ($SIZE)"
echo "  python.exe: $(ls "$OUT/python/python.exe" >/dev/null 2>&1 && echo あり || echo '無し（失敗）')"
echo "  cutgrab   : $(ls "$OUT/cutgrab"/*.py | wc -l | tr -d ' ') ファイル"
