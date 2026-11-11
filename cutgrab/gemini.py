"""Gemini API 連携（外部ライブラリ不要・標準ライブラリのみ）。

各カットの候補フレームを 1 枚のコンタクトシートにまとめて渡し、
「このカットを一番よく表している 1 枚」を番号で選ばせる。
1 リクエストに複数カットをまとめるので、CM 1 本あたり 1〜2 回の API 呼び出しで済む。
"""

import base64
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .config import DEFAULT_MODEL, DEFAULT_MODEL_CANDIDATES

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
SHOTS_PER_REQUEST = 8
DIRECTION_SHOTS_PER_REQUEST = 12
TIMEOUT = 180

# ------------------------------------------------------------------ ト書き
# 参考にした CM コンテ / シナリオのト書きの作法:
#   ・現在形で書く（映像の中で今起きていることを指示するもの）
#   ・書くのは「見えるもの」だけ = 場所・人物の配置と動作・小道具・画の作り
#   ・心理描写（悲しむ・喜ぶ）、セリフ、「何か」のような曖昧語は書かない
#   ・体言止めを基本に、1カットの状況が一読で分かる最短の文にする
DIRECTION_PROMPT = """あなたは日本のテレビCMの絵コンテを書くベテランのCMプランナーです。
これから、1本のCMから各カットのベストな1枚を抜き出した静止画を、カット順に見せます。

各カットに「ト書き」を書いてください。
ト書きとは絵コンテで絵の下に添える、そのカットの状況を説明する短い文です。

【ト書きの作法】必ず守ってください
・現在形で書く（「〜している」「〜する」）。過去形にしない
・体言止めを基本にし、短く言い切る。例:「商品を手に取る女性」「青空に浮かぶロゴ」
・書いてよいのは目に見えるものだけ
    - 場所・状況（例: 朝のキッチン、駅のホーム）
    - 人物の配置と動作（例: 母娘が並んで座る／振り向く男）
    - 小道具・商品（例: テーブルに置かれた新商品パッケージ）
    - 画の作り（例: 商品のアップ、俯瞰、手元のクローズアップ）
・書いてはいけないもの
    - 心理描写（悲しむ／喜ぶ／感動する など、見えない気持ち）
    - セリフやナレーションの文言
    - 「何か」「〜のようなもの」といった曖昧な表現
    - 推測（〜と思われる、〜だろう）
・長さは日本語で 10〜25 文字程度。長くても30文字まで
・句点（。）は付けない
・カット同士がつながって1本のCMとして読めるように、前後の流れを意識する

必ず次の JSON 形式だけを返してください（説明文やマークダウンは不要）:
{"directions": [{"cut": <カット番号>, "text": "<ト書き>"}]}

見せられた全てのカットについて、必ず1つずつ書いてください。"""

SYSTEM_PROMPT = """あなたは日本のテレビCMを扱うベテランのアートディレクター / 編集者です。
これから、1本のCMから切り出した「1カット分の候補フレームを並べたコンタクトシート」を複数枚見せます。

各シートには、そのカットの中から時系列で抜き出した候補が並んでおり、
左上に大きな番号（1, 2, 3 ...）が振ってあります。

あなたの仕事は、各カットについて「このカットはこういうカットだ」と一目で分かる、
最も印象的で構図・バランスの良い1枚を選ぶことです。

選ぶ基準（重要な順）:
1. そのカットの内容・意図が最も明快に伝わる瞬間（商品・人物・アクションが決まっている）
2. 構図とバランスが良い（主題の配置、余白、水平、被写体が切れていない）
3. ピントが合っていてブレていない（モーションブラー、残像は避ける）
4. 人物がいる場合、目が開いていて表情が良い。半目・口が変な形・顔が見切れているものは避ける
5. カットの切り替わり直後／直前の中途半端な絵、テロップが出かかっている絵、
   ディゾルブで2つの絵が混ざっている絵は選ばない
6. 露出が破綻していない（白飛び・黒つぶれしていない）

必ず次の JSON 形式だけを返してください（説明文やマークダウンは不要）:
{"selections": [{"cut": <カット番号>, "best": <選んだ候補番号>, "reason": "<日本語で30字以内の理由>"}]}

見せられた全てのカットについて、必ず1つずつ選んでください。"""


class GeminiError(Exception):
    pass


def _post(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _get(url):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def list_models(api_key):
    try:
        data = _get("%s/models?key=%s&pageSize=200" % (API_ROOT, urllib.parse.quote(api_key)))
    except Exception:
        return []
    names = []
    for model in data.get("models", []):
        methods = model.get("supportedGenerationMethods") or []
        if "generateContent" not in methods:
            continue
        name = (model.get("name") or "").split("/")[-1]
        if name:
            names.append(name)
    return names


def usable_models(api_key):
    """画像を読める Flash / Pro 系だけを、使いそうな順に返す（設定画面の選択肢用）。"""
    available = list_models(api_key)
    skip = ("image", "tts", "robotics", "computer-use", "deep-research",
            "lyria", "gemma", "nano-banana", "antigravity", "omni")
    picked = [m for m in available
              if ("gemini" in m) and not any(s in m for s in skip)]
    ordered = [m for m in DEFAULT_MODEL_CANDIDATES if m in picked]
    ordered += sorted([m for m in picked if m not in ordered], reverse=True)
    return ordered


def resolve_model(api_key, preferred=""):
    """使えるモデル名を決める。preferred が空 or 使えない場合は自動で選ぶ。"""
    available = list_models(api_key)
    if not available:
        return preferred or DEFAULT_MODEL
    if preferred and preferred in available:
        return preferred
    for candidate in DEFAULT_MODEL_CANDIDATES:
        if candidate in available:
            return candidate
    flash = sorted([m for m in available if "flash" in m and "image" not in m], reverse=True)
    if flash:
        return flash[0]
    return available[0]


def verify_key(api_key):
    """API キーが有効かを確認する。(ok, message, models) を返す。"""
    if not api_key.strip():
        return False, "API キーが未入力です。", []
    models = list_models(api_key.strip())
    if not models:
        return False, "接続できませんでした（キーが違うか、ネットワークの問題）。", []
    return True, "OK / 使用モデル: %s" % resolve_model(api_key.strip()), usable_models(api_key.strip())


def _extract_json(text):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except ValueError:
        pass
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        try:
            return json.loads(match.group(0))
        except ValueError:
            return None
    return None


def _model_chain(preferred):
    """試す順にモデル名を並べる。混雑や未提供のときに次へ移るため。"""
    chain = []
    for name in [preferred] + DEFAULT_MODEL_CANDIDATES:
        if name and name not in chain:
            chain.append(name)
    return chain


def _call(api_key, model, parts, expect_key, log):
    """1 モデルに 1 リクエスト投げて JSON を取り出す。再試行つき。"""
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.3, "responseMimeType": "application/json"},
    }
    url = "%s/models/%s:generateContent?key=%s" % (API_ROOT, model, urllib.parse.quote(api_key))

    last_error = None
    data = None
    for attempt in range(3):
        try:
            data = _post(url, payload)
            break
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:400]
            last_error = "HTTP %s: %s" % (exc.code, body)
            if exc.code == 400 and "responseMimeType" in body:
                payload["generationConfig"].pop("responseMimeType", None)
                continue
            if exc.code == 404:
                raise GeminiError(last_error)  # このモデルは無い → 呼び出し側で次へ
            if exc.code in (429, 500, 503):
                if attempt == 2:
                    raise GeminiError(last_error)  # 混んでいる → 呼び出し側で次へ
                wait = 5 * (attempt + 1)
                log("  混雑/レート制限。%d 秒待って再試行します…" % wait)
                time.sleep(wait)
                continue
            raise GeminiError(last_error)
        except GeminiError:
            raise
        except Exception as exc:  # ネットワーク断など
            last_error = str(exc)
            time.sleep(3)
    if data is None:
        raise GeminiError(last_error or "不明なエラー")

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        raise GeminiError("応答を解釈できませんでした: %s" % json.dumps(data)[:300])

    parsed = _extract_json(text)
    if not parsed or expect_key not in parsed:
        raise GeminiError("JSON を取得できませんでした: %s" % text[:200])
    return parsed[expect_key]


def _call_with_fallback(api_key, model, parts, expect_key, log, state):
    """モデルを順に試す。一度成功したモデルは以後も使い続ける。"""
    chain = _model_chain(state.get("model") or model)
    errors = []
    for name in chain:
        try:
            result = _call(api_key, name, parts, expect_key, log)
            if state.get("model") != name:
                if state.get("model"):
                    log("  → モデルを %s に切り替えました" % name)
                state["model"] = name
            return result
        except GeminiError as exc:
            errors.append("%s: %s" % (name, str(exc)[:120]))
            log("  %s が使えませんでした。次のモデルを試します…" % name)
    raise GeminiError(" / ".join(errors[-3:]))


NARRATION_PROMPT = """これは日本のテレビCMの音声です。
ナレーション（NA）と登場人物のセリフだけを、時刻付きで書き起こしてください。

守ること:
- 歌／ジングルの歌詞は書き起こさない（音楽が流れているだけの区間は無視）
- 効果音・環境音・BGM は無視
- **細かく区切る**。読点（、）句点（。）息継ぎ・間で必ず切り、さらに長い場合は
  文節の切れ目でも切る。1つの区切りは目安として **15文字以内**
  例:「人の自由を広げ、人の心を動かすために。」→
     {"人の自由を広げ、"} と {"人の心を動かすために。"} の2つに分ける
- 時刻は動画の先頭からの秒数（小数第2位まで）。**区切りごとに**開始と終了の両方を入れる
  （その言葉が実際に聞こえ始める・聞こえ終わる時刻。まとめて1つにしない）
- 聞き取れない箇所は含めない。推測で補わない
- 画面に出ている文字（テロップ）は、読み上げられていなければ書かない

必ず次の JSON だけを返す:
{"segments": [{"start": 0.00, "end": 2.40, "type": "NA", "text": "書き起こし"}]}

type は ナレーション なら "NA"、登場人物のセリフなら "セリフ"。
ナレーションもセリフも無ければ {"segments": []} を返す。"""


def transcribe(api_key, model, audio, mime="audio/flac", log=lambda *_: None, state=None):
    """CM の音声からナレーション／セリフを時刻付きで書き起こす。

    戻り値: [{"start": float, "end": float, "type": str, "text": str}, ...]
    """
    state = state if state is not None else {}
    parts = [
        {"text": NARRATION_PROMPT},
        {"inline_data": {"mime_type": mime,
                         "data": base64.b64encode(audio).decode("ascii")}},
    ]
    segments = _call_with_fallback(api_key, model, parts, "segments", log, state)

    cleaned = []
    for seg in segments or []:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(seg.get("start") or 0.0)
            end = float(seg.get("end") or start)
        except (TypeError, ValueError):
            continue
        cleaned.append({
            "start": max(0.0, start),
            "end": max(start, end),
            "type": str(seg.get("type") or "NA").strip() or "NA",
            "text": text,
        })
    cleaned.sort(key=lambda s: s["start"])
    return cleaned


def _image_part(jpeg):
    return {"inline_data": {"mime_type": "image/jpeg",
                            "data": base64.b64encode(jpeg).decode("ascii")}}


def select_best_frames(api_key, model, shots, log=lambda *_: None, state=None):
    """shots: [{"cut": int, "count": int, "jpeg": bytes}, ...]

    戻り値: {cut_index: {"best": 1-origin index, "reason": str}}
    """
    state = state if state is not None else {}
    result = {}
    batches = [shots[i:i + SHOTS_PER_REQUEST] for i in range(0, len(shots), SHOTS_PER_REQUEST)]
    for bi, batch in enumerate(batches):
        if bi > 0:
            time.sleep(3)  # 無料枠のレート制限に配慮
        log("  ベストな瞬間を選定中 (%d/%d バッチ, カット %d件)…"
            % (bi + 1, len(batches), len(batch)))

        parts = [{"text": SYSTEM_PROMPT}]
        for item in batch:
            parts.append({"text": "▼ カット %d （候補は 1〜%d）" % (item["cut"], item["count"])})
            parts.append(_image_part(item["jpeg"]))
        parts.append({"text": "対象カット: %s。全てについて JSON で回答してください。"
                              % ", ".join(str(i["cut"]) for i in batch)})

        for sel in _call_with_fallback(api_key, model, parts, "selections", log, state):
            try:
                cut = int(sel.get("cut"))
                best = int(sel.get("best"))
            except (TypeError, ValueError):
                continue
            result[cut] = {"best": best, "reason": str(sel.get("reason") or "").strip()}
    return result


def write_directions(api_key, model, shots, log=lambda *_: None, state=None):
    """選定済みのカット画像を実際に見て、CMコンテのト書きを書かせる。

    shots: [{"cut": int, "jpeg": bytes, "duration": float}, ...]（カット順）
    戻り値: {cut_index: "ト書き"}
    """
    state = state if state is not None else {}
    result = {}
    batches = [shots[i:i + DIRECTION_SHOTS_PER_REQUEST]
               for i in range(0, len(shots), DIRECTION_SHOTS_PER_REQUEST)]
    for bi, batch in enumerate(batches):
        if bi > 0:
            time.sleep(3)
        log("  ト書きを生成中 (%d/%d バッチ, カット %d件)…"
            % (bi + 1, len(batches), len(batch)))

        parts = [{"text": DIRECTION_PROMPT}]
        if len(batches) > 1:
            parts.append({"text": "※ このCMは全%dカットです。今回はその一部（カット %d〜%d）です。"
                                  % (len(shots), batch[0]["cut"], batch[-1]["cut"])})
        for item in batch:
            parts.append({"text": "▼ カット %d（尺 %.1f秒）"
                                  % (item["cut"], item.get("duration") or 0.0)})
            parts.append(_image_part(item["jpeg"]))
        parts.append({"text": "対象カット: %s。全てについて JSON で回答してください。"
                              % ", ".join(str(i["cut"]) for i in batch)})

        for item in _call_with_fallback(api_key, model, parts, "directions", log, state):
            try:
                cut = int(item.get("cut"))
            except (TypeError, ValueError):
                continue
            text = str(item.get("text") or "").strip().rstrip("。")
            if text:
                result[cut] = text
    return result
