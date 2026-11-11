#!/bin/bash
# Python バックエンド（解析エンジン）を単体で動く実行ファイルに固める。
# Python・OpenCV・NumPy がまるごと入るので、配布先に何も入っていなくても動く。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "▶ バックエンドを固めています（数分かかります）…"

rm -rf "$ROOT/backend" "$ROOT/.pyi-build"

/usr/bin/python3 -m PyInstaller \
  --noconfirm --clean --console \
  --name cutgrab-backend \
  --distpath "$ROOT/backend" \
  --workpath "$ROOT/.pyi-build/work" \
  --specpath "$ROOT/.pyi-build" \
  --add-data "$ROOT/cutgrab/ui.html:cutgrab" \
  --hidden-import cutgrab.pipeline \
  --hidden-import cutgrab.detect \
  --hidden-import cutgrab.score \
  --hidden-import cutgrab.sheet \
  --hidden-import cutgrab.gemini \
  --hidden-import cutgrab.video \
  --hidden-import cutgrab.pptx_export \
  --collect-all pptx \
  --exclude-module tkinter \
  --exclude-module matplotlib \
  --exclude-module PyQt5 \
  --exclude-module PyQt6 \
  --exclude-module PySide2 \
  --exclude-module PySide6 \
  --exclude-module IPython \
  --exclude-module pytest \
  --exclude-module setuptools \
  "$ROOT/backend_main.py"

rm -rf "$ROOT/.pyi-build"

BIN="$ROOT/backend/cutgrab-backend/cutgrab-backend"
if [ ! -x "$BIN" ]; then
  echo "✗ 実行ファイルが作られませんでした"
  exit 1
fi

echo "▶ 動作確認…"
"$BIN" --electron --selftest

echo "✓ 完成: $ROOT/backend/cutgrab-backend  ($(du -sh "$ROOT/backend/cutgrab-backend" | cut -f1))"
