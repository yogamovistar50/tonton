"""Tonton versi desktop.

Menjalankan server Flask di port lokal acak, lalu menampilkannya di jendela aplikasi
sendiri (pywebview). Di Windows jendela memakai Microsoft Edge WebView2.

Jalankan langsung:  python desktop.py
Bangun jadi .exe:   build_windows.bat
"""
from __future__ import annotations

import ctypes
import logging
import os
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

# Harus diatur sebelum "app" diimpor: menyalakan mode desktop (file disimpan ke folder Downloads\Tonton).
os.environ.setdefault("TONTON_DESKTOP", "1")

LOG_DIR = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "Tonton"


def _ensure_streams() -> None:
    """Aplikasi --windowed tidak punya konsol (stdout/stderr = None). Arahkan ke file log
    supaya library seperti yt-dlp tidak error saat menulis pesan."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / "tonton.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or log
    sys.stderr = sys.stderr or log


_ensure_streams()

import webview                      # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

import app as tonton                # noqa: E402

logging.getLogger("werkzeug").setLevel(logging.ERROR)   # jangan catat setiap polling progres


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def show_error(message: str) -> None:
    if sys.platform == "win32":
        ctypes.windll.user32.MessageBoxW(0, message, "Tonton", 0x10)   # MB_ICONERROR
    else:
        print(message, file=sys.stderr)


def main() -> None:
    port = free_port()
    server = make_server("127.0.0.1", port, tonton.app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=tonton.janitor, daemon=True).start()

    webview.create_window(
        "Tonton",
        f"http://127.0.0.1:{port}/",
        width=1280,
        height=820,
        min_size=(900, 600),
        background_color="#101319",
    )

    # Paksa Edge WebView2 di Windows; mesin lama (MSHTML) tidak bisa menjalankan antarmuka ini.
    gui = "edgechromium" if sys.platform == "win32" else None
    storage = LOG_DIR / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    try:
        try:
            # private_mode=False: riwayat pencarian (localStorage) tetap ada setelah Tonton ditutup.
            webview.start(gui=gui, private_mode=False, storage_path=str(storage))
        except TypeError:
            webview.start(gui=gui)   # pywebview lama tanpa opsi di atas: tetap jalan, tanpa riwayat tersimpan
    except Exception as exc:  # noqa: BLE001
        show_error(
            "Tonton tidak bisa membuka jendela aplikasi.\n\n"
            "Pasang 'Microsoft Edge WebView2 Runtime' dari microsoft.com/edge/webview2, "
            "lalu buka Tonton lagi.\n\n"
            f"Detail: {exc}"
        )
        sys.exit(1)
    finally:
        server.shutdown()
        shutil.rmtree(tonton.DOWNLOAD_DIR, ignore_errors=True)

    os._exit(0)   # matikan paksa thread unduhan yang masih berjalan


if __name__ == "__main__":
    main()
