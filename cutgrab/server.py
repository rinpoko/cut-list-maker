"""ローカル Web UI サーバー（標準ライブラリのみ）。

127.0.0.1 のランダムポートで待ち受け、トークン付き URL をブラウザで開く。
すでに起動中のインスタンスがあれば、そちらにファイルを渡して終了する。
"""

import json
import mimetypes
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cutgrab import APP_NAME, __version__, config, gemini, pipeline, video  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(config.CONFIG_DIR, "server.json")
UPLOAD_DIR = os.path.expanduser("~/Library/Caches/CutListMaker/uploads")
UPLOAD_OUTPUT_DIR = os.path.join(os.path.expanduser("~"), "Desktop", "Cut List Maker")
IS_WIN = sys.platform == "win32"


def open_in_os(target):
    """フォルダ・ファイル・URL を OS の標準の方法で開く。"""
    try:
        if IS_WIN:
            if target.startswith("http://") or target.startswith("https://"):
                subprocess.Popen(["cmd", "/c", "start", "", target], shell=False)
            else:
                os.startfile(target)          # エクスプローラで開く
        else:
            subprocess.Popen(["/usr/bin/open", target])
    except OSError:
        pass
IDLE_SHUTDOWN_SEC = 60 * 45
MAX_LOG = 800


class State(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.files = []          # [{"path", "name", "origin"}]
        self.log = []
        self.results = []
        self.processed = set()
        self.queue_pending = False
        self.running = False
        self.progress = 0.0
        self.status = "待機中"
        self.allowed_dirs = set()
        self.last_seen = time.time()
        self.cfg = config.load()

    def add_log(self, message):
        with self.lock:
            self.log.append(message)
            if len(self.log) > MAX_LOG:
                del self.log[: len(self.log) - MAX_LOG]

    def snapshot(self, since=0):
        with self.lock:
            return {
                "running": self.running,
                "progress": self.progress,
                "status": self.status,
                "files": list(self.files),
                "log": self.log[since:],
                "log_total": len(self.log),
                "results": list(self.results),
                "settings": {k: v for k, v in self.cfg.items() if k != "api_key"},
                "has_key": bool(self.cfg.get("api_key", "").strip()),
                "version": __version__,
            }


STATE = State()
TOKEN = ""


# ------------------------------------------------------------------ helpers
def _ui_path():
    """PyInstaller で固めた場合は展開先から読む。"""
    base = getattr(sys, "_MEIPASS", None)
    if base:
        for candidate in (os.path.join(base, "cutgrab", "ui.html"),
                          os.path.join(base, "ui.html")):
            if os.path.exists(candidate):
                return candidate
    return os.path.join(HERE, "ui.html")


def _read_ui():
    with open(_ui_path(), "r", encoding="utf-8") as fh:
        return fh.read()


def add_paths(paths):
    added = 0
    for raw in paths:
        path = os.path.abspath(os.path.expanduser(str(raw).strip()))
        if os.path.isdir(path):
            for name in sorted(os.listdir(path)):
                if video.is_video(name):
                    added += add_paths([os.path.join(path, name)])
            continue
        if not os.path.exists(path) or not video.is_video(path):
            continue
        with STATE.lock:
            if any(f["path"] == path for f in STATE.files):
                continue
            STATE.files.append({"path": path, "name": os.path.basename(path), "origin": "local"})
            added += 1
    return added


def native_pick():
    """macOS 標準のファイル選択ダイアログを出してパスを返す。"""
    script = (
        'set theFiles to choose file with prompt "CM動画を選んでください" '
        'of type {"public.movie", "public.audiovisual-content"} with multiple selections allowed\n'
        'set out to ""\n'
        'repeat with f in theFiles\n'
        '  set out to out & POSIX path of f & linefeed\n'
        'end repeat\n'
        'return out'
    )
    if IS_WIN:
        # Windows ではファイル選択は Electron 側のダイアログを使うので、ここは使わない
        return []
    try:
        proc = subprocess.run(["/usr/bin/osascript", "-e", script],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    return [line for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]


def run_job(pending_only=False):
    """pending_only=True なら、まだ処理していないファイルだけを対象にする
    （アイコンに追加でドロップされたときに、既に済んだ動画を焼き直さないため）。"""
    with STATE.lock:
        if STATE.running:
            # 処理中に追加でドロップされた分は、終わってから続けて処理する
            STATE.queue_pending = STATE.queue_pending or pending_only
            return
        if not STATE.files:
            return
        targets = [f for f in STATE.files
                   if not pending_only or f["path"] not in STATE.processed]
        if not targets:
            return
        STATE.running = True
        if not pending_only:
            STATE.results = []
            STATE.processed = set()
        STATE.progress = 0.0
        STATE.status = "準備中…"
        cfg = dict(STATE.cfg)

    def work():
        total = len(targets)
        for i, entry in enumerate(targets):
            base, span = i / float(total), 1.0 / float(total)

            job_cfg = dict(cfg)
            if entry["origin"] == "upload":
                job_cfg["output_mode"] = "custom"
                job_cfg["output_dir"] = UPLOAD_OUTPUT_DIR
                os.makedirs(UPLOAD_OUTPUT_DIR, exist_ok=True)

            def on_progress(fraction, message, base=base, span=span, i=i):
                with STATE.lock:
                    STATE.progress = base + span * fraction
                    STATE.status = "[%d/%d] %s" % (i + 1, total, message)

            try:
                result = pipeline.process_video(
                    entry["path"], job_cfg, log=STATE.add_log, progress=on_progress
                )
                with STATE.lock:
                    STATE.allowed_dirs.add(os.path.realpath(result["outdir"]))
                    STATE.processed.add(entry["path"])
                    STATE.results = [r for r in STATE.results
                                     if r["name"] != os.path.basename(entry["path"])]
                    STATE.results.append({
                        "name": os.path.basename(entry["path"]),
                        "outdir": result["outdir"],
                        "ai_used": result["ai_used"],
                        "ai_model": result["ai_model"],
                        "elapsed": round(result["elapsed"], 1),
                        "pptx": result.get("pptx", ""),
                        "xlsx": result.get("xlsx", ""),
                        "cuts": [{
                            "cut": c["cut"], "file": c["file"], "time": c["time"],
                            "duration": c["cut_duration"], "frames": c.get("cut_frames", 0),
                            "frame_index": c.get("frame_index", 0),
                            "narration": c.get("narration", ""),
                            "fps": result.get("fps", 0), "chosen_by": c["chosen_by"],
                            "reason": c["reason"], "direction": c.get("direction", ""),
                            "path": os.path.join(result["outdir"], c["file"]),
                            "url": "/api/file?t=%s&p=%s" % (
                                TOKEN, urllib.parse.quote(os.path.join(result["outdir"], c["file"]))),
                        } for c in result["cuts"]],
                    })
                if cfg.get("open_when_done", True):
                    open_in_os(result["outdir"])
            except Exception as exc:
                STATE.add_log("  ✗ 失敗: %s" % exc)

        with STATE.lock:
            STATE.running = False
            STATE.progress = 1.0
            done = sum(len(r["cuts"]) for r in STATE.results)
            STATE.status = ("完了：%d本 / 合計 %d カットを書き出しました" % (len(STATE.results), done)
                            if STATE.results else "書き出せませんでした")
            queued = STATE.queue_pending
            STATE.queue_pending = False
        if queued:
            run_job(pending_only=True)

    threading.Thread(target=work, daemon=True).start()


# ------------------------------------------------------------------ handler
class Handler(BaseHTTPRequestHandler):
    server_version = "CMCutGrabber/%s" % __version__

    def log_message(self, *_args):
        pass  # アクセスログは出さない

    # -- utils
    def _auth(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        token = (query.get("t") or [""])[0] or self.headers.get("X-Token", "")
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self._json({"error": "forbidden host"}, 403)
            return None
        if token != TOKEN:
            self._json({"error": "unauthorized"}, 403)
            return None
        STATE.last_seen = time.time()
        return query

    def _json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _json_body(self):
        try:
            return json.loads(self._body().decode("utf-8") or "{}")
        except ValueError:
            return {}

    # -- GET
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            query = urllib.parse.parse_qs(parsed.query)
            if (query.get("t") or [""])[0] != TOKEN:
                self.send_response(403)
                self.end_headers()
                self.wfile.write("トークンが違います。アプリから開き直してください。".encode("utf-8"))
                return
            STATE.last_seen = time.time()
            html = _read_ui().replace("__TOKEN__", TOKEN).replace("__VERSION__", __version__)
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        query = self._auth()
        if query is None:
            return

        if parsed.path == "/api/ping":
            self._json({"ok": True, "version": __version__})
        elif parsed.path == "/api/state":
            try:
                since = int((query.get("since") or ["0"])[0])
            except ValueError:
                since = 0
            self._json(STATE.snapshot(since))
        elif parsed.path == "/api/file":
            self._serve_file((query.get("p") or [""])[0])
        else:
            self._json({"error": "not found"}, 404)

    def _serve_file(self, path):
        real = os.path.realpath(os.path.expanduser(path))
        with STATE.lock:
            allowed = any(real.startswith(d + os.sep) for d in STATE.allowed_dirs)
        if not allowed or not os.path.isfile(real):
            self._json({"error": "forbidden"}, 403)
            return
        ctype = mimetypes.guess_type(real)[0] or "application/octet-stream"
        size = os.path.getsize(real)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(real, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    # -- POST
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        query = self._auth()
        if query is None:
            return
        route = parsed.path

        if route == "/api/add":
            data = self._json_body()
            count = add_paths(data.get("paths") or [])
            self._json({"added": count})

        elif route == "/api/browse":
            paths = native_pick()
            self._json({"added": add_paths(paths)})

        elif route == "/api/upload":
            name = urllib.parse.unquote(self.headers.get("X-Filename", "movie.mp4"))
            name = os.path.basename(name) or "movie.mp4"
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            dest = os.path.join(UPLOAD_DIR, name)
            length = int(self.headers.get("Content-Length") or 0)
            with open(dest, "wb") as fh:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
            with STATE.lock:
                STATE.files = [f for f in STATE.files if f["path"] != dest]
                STATE.files.append({"path": dest, "name": name, "origin": "upload"})
            self._json({"added": 1, "path": dest})

        elif route == "/api/remove":
            index = self._json_body().get("index", -1)
            with STATE.lock:
                if 0 <= index < len(STATE.files):
                    del STATE.files[index]
            self._json({"ok": True})

        elif route == "/api/clear":
            with STATE.lock:
                STATE.files = []
            self._json({"ok": True})

        elif route == "/api/settings":
            data = self._json_body()
            with STATE.lock:
                for key, value in data.items():
                    if key in config.DEFAULTS:
                        if key == "api_key" and value == "__KEEP__":
                            continue
                        STATE.cfg[key] = value
                cfg = dict(STATE.cfg)
            try:
                config.save(cfg)
            except OSError:
                pass
            self._json({"ok": True, "has_key": bool(cfg.get("api_key", "").strip())})

        elif route == "/api/verify_key":
            key = (self._json_body().get("api_key") or "").strip()
            if not key:
                key = STATE.cfg.get("api_key", "").strip()
            ok, message, models = gemini.verify_key(key)
            self._json({"ok": ok, "message": message, "models": models})

        elif route == "/api/start":
            pending_only = bool(self._json_body().get("pending_only"))
            if not pending_only:
                with STATE.lock:
                    STATE.log = []
                    STATE.results = []
            run_job(pending_only=pending_only)
            self._json({"ok": True})

        elif route == "/api/reveal":
            path = self._json_body().get("path") or ""
            real = os.path.realpath(os.path.expanduser(path))
            with STATE.lock:
                allowed = any(real == d or real.startswith(d + os.sep) for d in STATE.allowed_dirs)
            if allowed and os.path.exists(real):
                open_in_os(real)
                self._json({"ok": True})
            else:
                self._json({"ok": False}, 403)

        elif route == "/api/quit":
            self._json({"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.4), os._exit(0)), daemon=True).start()

        else:
            self._json({"error": "not found"}, 404)


# ------------------------------------------------------------------ 起動処理
def _load_state_file():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (IOError, OSError, ValueError):
        return None


def _save_state_file(port, token):
    try:
        os.makedirs(config.CONFIG_DIR, exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump({"port": port, "token": token, "pid": os.getpid()}, fh)
    except OSError:
        pass


def _try_existing(files):
    """すでに起動中のインスタンスがあれば、そこにファイルを渡す。"""
    state = _load_state_file()
    if not state:
        return None
    url = "http://127.0.0.1:%d" % state["port"]
    try:
        req = urllib.request.Request("%s/api/ping?t=%s" % (url, state["token"]))
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    if files:
        try:
            data = json.dumps({"paths": files}).encode("utf-8")
            req = urllib.request.Request(
                "%s/api/add?t=%s" % (url, state["token"]), data=data,
                headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=5).read()
            req = urllib.request.Request(
                "%s/api/start?t=%s" % (url, state["token"]),
                data=json.dumps({"pending_only": True}).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:
            pass
    return "%s/?t=%s" % (url, state["token"])


def _cleanup_uploads(max_age_days=7):
    """ブラウザにドロップされた動画のコピーが溜まらないように古いものを消す。"""
    if not os.path.isdir(UPLOAD_DIR):
        return
    cutoff = time.time() - max_age_days * 86400
    for name in os.listdir(UPLOAD_DIR):
        path = os.path.join(UPLOAD_DIR, name)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError:
            pass


def _idle_watchdog():
    while True:
        time.sleep(60)
        if STATE.running:
            continue
        if time.time() - STATE.last_seen > IDLE_SHUTDOWN_SEC:
            os._exit(0)


def _selftest():
    """固めた実行ファイルが必要なものを全部抱えているかの確認（ビルド時に使う）。"""
    import cv2
    import numpy
    import pptx
    import xlsxwriter
    from cutgrab import (detect, gemini, pipeline, pptx_export, score, sheet,  # noqa: F401
                         xlsx_export)
    assert os.path.exists(_ui_path()), "ui.html が同梱されていません"
    from pptx import Presentation
    Presentation()  # 既定テンプレートが同梱されているかの確認
    print("selftest ok: opencv %s / numpy %s / python-pptx %s / xlsxwriter %s / ui %s"
          % (cv2.__version__, numpy.__version__, pptx.__version__, xlsxwriter.__version__,
             os.path.basename(_ui_path())))
    return 0


def main(argv=None):
    global TOKEN
    argv = list(argv if argv is not None else sys.argv[1:])
    if "--selftest" in argv:
        return _selftest()

    files = [a for a in argv if not a.startswith("-")]
    electron = "--electron" in argv
    no_open = electron or "--no-open" in argv

    # Electron 版はアプリ側がプロセスを管理するので、既存インスタンスの再利用はしない
    existing = None if electron else _try_existing(files)
    if existing and not no_open:
        open_in_os(existing)
        return 0

    TOKEN = os.urandom(16).hex()
    STATE.electron = electron
    _cleanup_uploads()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    if not electron:
        _save_state_file(port, TOKEN)

    if files:
        add_paths(files)

    url = "http://127.0.0.1:%d/?t=%s" % (port, TOKEN)
    print("%s v%s → %s" % (APP_NAME, __version__, url), flush=True)
    if not no_open:
        open_in_os(url)

    if STATE.files:
        threading.Timer(1.2, lambda: run_job(pending_only=True)).start()

    threading.Thread(target=_idle_watchdog, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
