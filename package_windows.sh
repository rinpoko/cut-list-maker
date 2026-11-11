#!/bin/bash
# electron-builder が作った Windows 用 zip を、そのまま解凍して使える形に詰め直す。
#
# 既定の zip は中身がバラで入っているので、デスクトップに解凍すると散らかる。
# 「Cut List Maker」フォルダ 1 つにまとめて、説明書も同梱する。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"
NAME="Cut List Maker"
VERSION="$(/usr/bin/python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"

RAW="$DIST/$NAME-$VERSION-win-portable.zip"
[ -f "$RAW" ] || { echo "✗ $RAW が見つかりません"; exit 1; }

WORK="$DIST/_winpack"
rm -rf "$WORK"
mkdir -p "$WORK/$NAME"

echo "▶ 配布用に詰め直しています…"
unzip -q "$RAW" -d "$WORK/$NAME"

cat > "$WORK/$NAME/はじめにお読みください.txt" <<'EOF'
Cut List Maker  ─ Windows 版（インストール不要）

■ 使い方
  1. この「Cut List Maker」フォルダごと、デスクトップなど好きな場所に置いてください。
     （フォルダの中身はそのままにしてください。バラすと動きません）
  2. フォルダの中の「Cut List Maker.exe」をダブルクリックすると起動します。
  3. ウィンドウに CM 動画をドラッグ＆ドロップするか、exe のアイコンに直接
     ドロップしてください。書き出し先を聞かれるので、フォルダを選びます。

  よく使うなら、「Cut List Maker.exe」を右クリック →「ショートカットの作成」で
  デスクトップにショートカットを置くと便利です。
  （exe 本体だけを移動すると動かなくなるのでご注意ください）

■ インストールは不要です
  管理者権限も、Python も、ffmpeg も要りません。
  必要なものはすべてこのフォルダの中に入っています。
  レジストリも書き換えません。使わなくなったらフォルダごと削除してください。

■ 初回起動時に出ることがある画面
  「Windows によって PC が保護されました」と出たら、
  「詳細情報」→「実行」を押してください。
  （個人で作ったアプリで、有償のコード署名を付けていないためです）

■ AI（Gemini）の設定
  画面の「Gemini API キー」欄にキーを貼って「設定」を押してください。
  キーは https://aistudio.google.com/apikey で取得できます。
  キーは このPC のユーザーフォルダ内にだけ保存されます
  （%APPDATA%\CutListMaker\config.json）。このフォルダの中には入りません。

  キーを設定しなくても、AI を使わないローカル判定だけで動きます
  （その場合、ト書きとナレーションは付きません）。

■ 設定の保存場所
  %APPDATA%\CutListMaker\config.json
EOF

cd "$WORK"
OUT="$DIST/$NAME-$VERSION-Windows.zip"
rm -f "$OUT"
zip -q -r -X "$OUT" "$NAME"
cd "$ROOT"
rm -rf "$WORK" "$RAW"

SIZE=$(ls -la "$OUT" | awk '{printf "%.0f MB", $5/1048576}')
echo "✓ 完成: $OUT  ($SIZE)"
