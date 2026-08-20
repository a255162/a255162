# -*- coding: utf-8 -*-
"""
寶可夢卡牌鑑定 App - 本機測試伺服器
========================================
零外部套件，直接執行：

    python serve.py

會印出手機可以連的區網網址。手機要跟電腦連同一個 Wi-Fi。
"""

import http.server
import os
import re
import socket
import socketserver
import sys

PORT = 8080
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Windows 主控台預設是 CP950，先切成 UTF-8 才不會被表情符號炸掉
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass


class Handler(http.server.SimpleHTTPRequestHandler):
    """開發用：關掉快取，否則改了程式手機上還是舊的。"""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_POST(self):
        """
        開發用存檔端點：把瀏覽器畫布的內容存成 PNG，方便檢查畫面輸出對不對。

        只接受 /__save，只寫進 test/out/，副檔名固定 .png，檔名去掉所有路徑字元。
        這支伺服器只是本機測試工具，不會跟著 App 部署出去。
        """
        if self.path != "/__save":
            self.send_error(404)
            return

        name = self.headers.get("X-Filename", "out.png")
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
        if not name.endswith(".png"):
            name += ".png"

        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 40 * 1024 * 1024:
            self.send_error(400, "bad length")
            return
        data = self.rfile.read(length)
        if not data.startswith(b"\x89PNG"):
            self.send_error(400, "not a png")
            return

        out_dir = os.path.join(BASE_DIR, "test", "out")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(data)

        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(("saved test/out/" + name).encode("utf-8"))

    def log_message(self, fmt, *args):
        # 只印出非 200 的請求，畫面才不會被洗版
        status = args[1] if len(args) > 1 else ""
        if status != "200":
            sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))


def lan_ip():
    """抓本機在區網上的 IP（不會真的送出封包）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as httpd:
        ip = lan_ip()
        print("=" * 52)
        print("  寶可夢卡牌鑑定 App - 測試伺服器已啟動")
        print("=" * 52)
        print()
        print("  電腦上開：  http://localhost:%d" % PORT)
        print("  手機上開：  http://%s:%d" % (ip, PORT))
        print()
        print("  手機需連同一個 Wi-Fi。若連不上，通常是 Windows")
        print("  防火牆擋了 Python，第一次執行時請選「允許存取」。")
        print()
        print("  按 Ctrl+C 結束")
        print("=" * 52)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")


if __name__ == "__main__":
    main()
