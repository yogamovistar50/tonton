"""Tonton: aplikasi video bergaya YouTube dengan unduhan multi-format.

Backend Flask + yt-dlp. Jalankan dengan:  python app.py
"""
from __future__ import annotations

import itertools
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import yt_dlp
from yt_dlp.utils import download_range_func
from flask import Flask, abort, jsonify, request, send_file

BASE_DIR = Path(__file__).resolve().parent
# Folder sumber daya: berbeda saat dibungkus PyInstaller (file dibongkar ke sys._MEIPASS).
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR))
# Folder kerja sementara untuk unduhan yang sedang diproses.
DOWNLOAD_DIR = Path(tempfile.gettempdir()) / "tonton-downloads"

# Mode desktop (diatur oleh desktop.py): dibungkus jendela pywebview, dan hasil unduhan langsung disimpan
# ke folder di komputer, bukan dikirim lewat browser.
DESKTOP = os.environ.get("TONTON_DESKTOP") == "1"
# Mode Android: berjalan di Termux (lihat folder termux/). Dibuka di browser ponsel.
ANDROID = bool(os.environ.get("TERMUX_VERSION")) or os.environ.get("TONTON_ANDROID") == "1"
SAVE_DIR = Path(
    os.environ.get("TONTON_SAVE_DIR")
    or Path.home() / ("storage/downloads" if ANDROID else "Downloads") / "Tonton"   # Android: folder Download bersama
)


def can_save_locally() -> bool:
    """True bila server sendiri yang menyimpan hasil unduhan ke SAVE_DIR (bukan dikirim lewat browser).
    Desktop: selalu. Android: hanya bila folder Download sudah bisa ditulis (izin dari termux-setup-storage);
    kalau belum, Tonton tetap jalan dan file dikirim lewat browser."""
    if DESKTOP:
        return True
    if not ANDROID:
        return False
    if os.environ.get("TONTON_SAVE_DIR"):
        # Folder pilihan sendiri: cukup bila folder induk terdekat yang sudah ada bisa ditulis.
        folder = SAVE_DIR
        while not folder.exists() and folder != folder.parent:
            folder = folder.parent
    else:
        # Folder bawaan: ~/storage/downloads (tautan ke Download bersama) HARUS sudah ada. Tidak boleh mundur ke folder
        # induk: itu akan jatuh ke folder rumah Termux, dan file tersimpan di tempat yang tidak terlihat dari HP.
        folder = SAVE_DIR.parent
    return folder.is_dir() and os.access(folder, os.W_OK)


LOCAL_SAVE = can_save_locally()

# Pakai FFmpeg yang dibundel bersama aplikasi bila ada (folder "ffmpeg" di samping app).
for _folder in (RESOURCE_DIR / "ffmpeg", BASE_DIR / "ffmpeg"):
    if _folder.is_dir():
        os.environ["PATH"] = str(_folder) + os.pathsep + os.environ.get("PATH", "")

# yt-dlp terbaru butuh JavaScript runtime supaya YouTube memberi semua format (tanpanya: "some formats may be
# missing"), dan hanya deno yang aktif secara bawaan. Aktifkan semua yang didukung: yang tidak terpasang dilewati,
# nama yang tak dikenal hanya memunculkan peringatan. Di Termux yang dipakai adalah node.
JS_RUNTIMES = ("deno", "node", "bun", "quickjs")


def ytdlp_opts(**extra) -> dict:
    """Opsi dasar untuk setiap panggilan yt-dlp. Dict js_runtimes dibuat baru tiap kali karena yt-dlp mengubahnya."""
    return {"quiet": True, "no_warnings": True, "js_runtimes": {name: {} for name in JS_RUNTIMES}, **extra}


SEARCH_PREFIX = "ytsearch"
PAGE_SIZE = 24      # video per halaman hasil pencarian
MAX_RESULTS = 300   # batas total hasil per pencarian (hasil YouTube sendiri tidak tak terbatas)

MAX_CLIP_SECONDS = 48 * 3600   # batas kewajaran untuk waktu potong
MIN_CLIP_SECONDS = 1.0
MAX_COLLECTION = 2000   # batas video yang dimuat dari satu channel/playlist
CHANNEL_TABS = {"videos": "videos", "shorts": "shorts", "live": "streams", "playlists": "playlists"}
YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}
YT_ID_RE = re.compile(r"^[\w-]{11}$")
# Filter "Live" pada pencarian YouTube (parameter sp, protobuf: filter fitur 8 = 1). Hanya siaran yang sedang tayang.
LIVE_FILTER = "EgJAAQ=="
# Pesan yt-dlp untuk siaran/premiere yang belum dimulai (belum punya format, tapi metadatanya tetap berguna).
UPCOMING_RE = re.compile(r"live event will begin|premieres? in|will begin in", re.I)
CHANNEL_ID_RE = re.compile(r"^UC[\w-]{22}$")
HANDLE_RE = re.compile(r"^@[\w.\-]{1,60}$")
PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
CHANNEL_PATH_RE = re.compile(r"^/(channel/UC[\w-]{22}|@[\w.\-%]{1,120}|user/[\w.\-%]{1,60}|c/[\w.\-%]{1,120})(?:/|$)")

SUGGEST_URL = "https://suggestqueries.google.com/complete/search"
SUGGEST_TTL = 600   # detik
_suggest_cache: dict[str, tuple[float, list[str]]] = {}

# Rekomendasi beranda: hasil pencarian untuk beberapa topik (dari riwayat pencarian di komputer pengguna),
# diambil paralel lalu diselang. Aplikasi ini tidak punya login YouTube, jadi bukan beranda pribadi YouTube.
RECO_MAX = 120      # batas total rekomendasi
RECO_TOPICS = 4     # topik maksimum per permintaan
RECO_TTL = 15 * 60  # detik: buka beranda berulang tidak mengulang pencarian yang sama
_reco_cache: dict[tuple[str, int, int], tuple[float, list[dict]]] = {}

JOB_TTL = 30 * 60   # file dihapus 30 menit setelah selesai
MAX_PARALLEL = 2    # jumlah unduhan yang berjalan bersamaan

VIDEO_FORMATS = {"mp4", "webm", "mkv"}
AUDIO_FORMATS = {"mp3", "m4a", "opus", "aac", "wav", "flac"}
BITRATE_FORMATS = {"mp3", "aac", "opus"}   # format audio yang punya pilihan bitrate
HEIGHTS = {"best": None, "1080": 1080, "720": 720, "480": 480, "360": 360}
BITRATES = {"128", "192", "256", "320"}

ANSI = re.compile(r"\x1b\[[0-9;]*m")

app = Flask(__name__, static_folder=str(RESOURCE_DIR / "static"), static_url_path="")
app.json.ensure_ascii = False

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
slots = threading.Semaphore(MAX_PARALLEL)

# Bersihkan sisa unduhan dari sesi sebelumnya.
shutil.rmtree(DOWNLOAD_DIR, ignore_errors=True)
DOWNLOAD_DIR.mkdir(exist_ok=True)


# --------------------------------------------------------------------------
# Utilitas
# --------------------------------------------------------------------------
def has_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def is_url(text: str) -> bool:
    try:
        parsed = urlparse(text.strip())
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def clean_error(exc: Exception) -> str:
    msg = ANSI.sub("", str(exc)).replace("ERROR: ", "", 1).strip()
    return msg[:300] or "Terjadi kesalahan yang tidak diketahui."


def is_youtube(entry: dict) -> bool:
    url = entry.get("webpage_url") or entry.get("url") or ""
    return entry.get("ie_key") in ("Youtube", "YoutubeTab") or "youtube.com" in url or "youtu.be" in url


def entry_kind(entry: dict) -> str:
    """video, playlist, atau channel (hasil pencarian YouTube bisa berisi ketiganya)."""
    url = entry.get("webpage_url") or entry.get("url") or ""
    if entry.get("ie_key") == "YoutubeTab" or entry.get("_type") == "playlist" or "/playlist?list=" in url:
        return "channel" if re.search(r"youtube\.com/(channel/|@|user/|c/)", url) else "playlist"
    return "video"


def channel_base(ref: str) -> str | None:
    """Ubah id, @handle, atau URL channel YouTube menjadi URL dasar yang aman. Selain itu ditolak."""
    ref = (ref or "").strip()
    if CHANNEL_ID_RE.match(ref):
        return f"https://www.youtube.com/channel/{ref}"
    if HANDLE_RE.match(ref):
        return f"https://www.youtube.com/{ref}"
    try:
        parsed = urlparse(ref)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or (parsed.hostname or "").lower() not in YT_HOSTS:
        return None
    match = CHANNEL_PATH_RE.match(parsed.path)
    return f"https://www.youtube.com/{match.group(1)}" if match else None


def playlist_url(ref: str) -> str | None:
    ref = (ref or "").strip()
    if PLAYLIST_ID_RE.match(ref):
        list_id = ref
    else:
        try:
            parsed = urlparse(ref)
        except ValueError:
            return None
        if parsed.scheme not in ("http", "https") or (parsed.hostname or "").lower() not in YT_HOSTS:
            return None
        if parsed.path != "/playlist":
            return None
        list_id = (parse_qs(parsed.query).get("list") or [""])[0]
        if not PLAYLIST_ID_RE.match(list_id):
            return None
    return f"https://www.youtube.com/playlist?list={list_id}"


def live_state(entry: dict) -> str | None:
    """"live" = sedang tayang, "upcoming" = terjadwal tapi belum mulai, None = video biasa
    (termasuk rekaman siaran yang sudah selesai, yang bisa diunduh seperti video lain)."""
    status = entry.get("live_status")
    if status == "is_live" or (status is None and entry.get("is_live")):
        return "live"
    if status == "is_upcoming":
        return "upcoming"
    return None


def summarize(entry: dict, default_channel: dict | None = None) -> dict:
    default_channel = default_channel or {}
    kind = entry_kind(entry)
    vid = entry.get("id")
    yt = is_youtube(entry)
    url = entry.get("webpage_url") or entry.get("url") or ""
    if kind == "video" and yt and vid and not url.startswith("http"):
        url = f"https://www.youtube.com/watch?v={vid}"

    thumb = entry.get("thumbnail")
    if kind == "video" and yt and vid:
        thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    elif not thumb and entry.get("thumbnails"):
        thumb = entry["thumbnails"][-1].get("url")

    # Info pembuat konten: hanya untuk YouTube, supaya namanya bisa diklik ke halaman channel.
    channel_id = entry.get("channel_id") or default_channel.get("channel_id")
    channel_id = channel_id if channel_id and CHANNEL_ID_RE.match(channel_id) else None
    channel_url = entry.get("channel_url") or entry.get("uploader_url")
    channel_url = channel_base(channel_url) if yt and channel_url else None
    if channel_id and not channel_url:
        channel_url = channel_base(channel_id)

    live = live_state(entry)
    if live == "live":   # hasil flat menyimpan penonton siaran di concurrent_view_count, bukan view_count
        views = entry.get("concurrent_view_count")
        views = entry.get("view_count") if views is None else views
    else:
        views = None if live == "upcoming" else entry.get("view_count")
    scheduled = entry.get("release_timestamp") if live == "upcoming" else None

    return {
        "id": vid,
        "kind": kind,
        "title": entry.get("title") or "Tanpa judul",
        "channel": entry.get("channel") or entry.get("uploader") or default_channel.get("channel") or "",
        "channel_id": channel_id if yt else None,
        "channel_url": channel_url if yt else None,
        "duration": entry.get("duration"),
        "views": views,
        "count": entry.get("playlist_count") or entry.get("n_entries"),
        "url": url,
        "thumbnail": thumb,
        "youtube": yt,
        "short": "/shorts/" in url,
        "live_status": live,
        "scheduled": int(scheduled) if isinstance(scheduled, (int, float)) else None,
    }


def detail(info: dict) -> dict:
    item = summarize(info)
    heights = {
        f["height"]
        for f in info.get("formats", [])
        if f.get("height") and f.get("vcodec") not in (None, "none")
    }
    item["heights"] = sorted(heights, reverse=True)
    item["description"] = (info.get("description") or "")[:800]
    # False = pemilik mematikan pemutaran di luar YouTube (sering pada siaran langsung). None/teks = coba saja.
    item["embeddable"] = info.get("playable_in_embed") is not False
    return item


def extract(url: str) -> dict:
    opts = ytdlp_opts(noplaylist=True, skip_download=True)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        if not UPCOMING_RE.search(clean_error(exc)):
            raise   # galat lain: perilaku lama, tidak diubah
    # Siaran terjadwal belum punya format, jadi yt-dlp menolaknya. Ambil metadatanya saja
    # (judul, jadwal, channel) supaya halaman tonton tetap lengkap.
    with yt_dlp.YoutubeDL({**opts, "ignore_no_formats_error": True}) as ydl:
        return ydl.extract_info(url, download=False)


# --------------------------------------------------------------------------
# Halaman & API pencarian
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/health")
def health():
    return jsonify(
        ffmpeg=has_ffmpeg(),
        yt_dlp=yt_dlp.version.__version__,
        desktop=LOCAL_SAVE,     # server yang menyimpan file (desktop, atau Android dengan izin penyimpanan)
        embedded=DESKTOP,       # dibungkus jendela pywebview
        android=ANDROID,
        save_dir=str(SAVE_DIR) if LOCAL_SAVE else None,
    )


@app.get("/api/search")
def search():
    q = (request.args.get("q") or "").strip()
    offset = max(0, request.args.get("offset", default=0, type=int))
    live_only = request.args.get("live") in ("1", "true")
    if not q:
        return jsonify(error="Kata kunci masih kosong."), 400

    try:
        if is_url(q):
            return jsonify(kind="video", item=detail(extract(q)))

        if offset >= MAX_RESULTS:
            return jsonify(kind="results", items=[], next_offset=None)
        limit = min(PAGE_SIZE, MAX_RESULTS - offset)

        # Pencarian yt-dlp bersifat lazy: hanya halaman yang diperlukan untuk mencapai item
        # (offset+limit) yang diambil dari YouTube, bukan seluruh MAX_RESULTS.
        opts = ytdlp_opts(extract_flat=True, skip_download=True, playlist_items=f"{offset + 1}-{offset + limit}")
        if live_only:   # halaman hasil pencarian YouTube dengan filter Live
            target = "https://www.youtube.com/results?" + urlencode({"search_query": q, "sp": LIVE_FILTER})
        else:
            target = f"{SEARCH_PREFIX}{MAX_RESULTS}:{q}"
        with yt_dlp.YoutubeDL(opts) as ydl:
            data = ydl.extract_info(target, download=False)
    except yt_dlp.utils.DownloadError as exc:
        return jsonify(error=clean_error(exc)), 502

    entries = [e for e in (data.get("entries") or []) if e]
    next_offset = offset + limit if len(entries) >= limit and offset + limit < MAX_RESULTS else None
    return jsonify(kind="results", items=[summarize(e) for e in entries], next_offset=next_offset)


def fetch_suggestions(q: str) -> list[str]:
    params = urlencode({"client": "firefox", "ds": "yt", "hl": "id", "q": q})
    req = urllib.request.Request(f"{SUGGEST_URL}?{params}", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=4) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
    data = json.loads(raw.decode(charset, errors="replace"))
    return [str(x) for x in data[1] if str(x).strip()][:10]


@app.get("/api/suggest")
def suggest():
    """Saran kata kunci saat mengetik. Bersifat opsional: bila gagal, balas daftar kosong."""
    q = (request.args.get("q") or "").strip()[:100]
    if len(q) < 2:
        return jsonify(items=[])

    key = q.lower()
    cached = _suggest_cache.get(key)
    if cached and time.time() - cached[0] < SUGGEST_TTL:
        return jsonify(items=cached[1])
    try:
        items = fetch_suggestions(q)
    except (OSError, ValueError, LookupError, TypeError):   # jaringan, JSON rusak/bentuk lain, charset aneh
        return jsonify(items=[])

    if len(_suggest_cache) > 500:
        _suggest_cache.clear()
    _suggest_cache[key] = (time.time(), items)
    return jsonify(items=items)


def pick_thumb(thumbs: list[dict], wanted: str, *, square: bool = False, wide: bool = False) -> str | None:
    """Ambil avatar/banner channel dari daftar thumbnail yt-dlp."""
    for t in thumbs:
        if t.get("id") == wanted and t.get("url"):
            return t["url"]
    sized = [t for t in thumbs if t.get("url") and t.get("width") and t.get("height")]
    if square:
        sized = [t for t in sized if t["width"] == t["height"]]
    elif wide:
        sized = [t for t in sized if t["width"] / t["height"] >= 3]
    else:
        return None
    return max(sized, key=lambda t: t["width"])["url"] if sized else None


def channel_meta(info: dict) -> dict:
    thumbs = info.get("thumbnails") or []
    name = info.get("channel") or info.get("uploader") or re.sub(r"\s+-\s+\w+$", "", info.get("title") or "")
    handle = info.get("uploader_id") or ""
    return {
        "name": name,
        "handle": handle if handle.startswith("@") else None,
        "channel_id": info.get("channel_id") if CHANNEL_ID_RE.match(info.get("channel_id") or "") else None,
        "followers": info.get("channel_follower_count"),
        "description": (info.get("description") or "")[:600],
        "avatar": pick_thumb(thumbs, "avatar_uncropped", square=True),
        "banner": pick_thumb(thumbs, "banner_uncropped", wide=True),
    }


def collection_page(url: str, offset: int, *, meta: str):
    """Satu halaman isi channel/playlist. yt-dlp memuat lazy, jadi hanya halaman yang perlu diambil."""
    if offset >= MAX_COLLECTION:
        return jsonify(items=[], next_offset=None)
    limit = min(PAGE_SIZE, MAX_COLLECTION - offset)
    opts = ytdlp_opts(extract_flat=True, skip_download=True, playlist_items=f"{offset + 1}-{offset + limit}")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        message = clean_error(exc)
        if re.search(r"does not have a .* tab", message, re.I):   # mis. channel tanpa Shorts/Live
            return jsonify(items=[], next_offset=None)
        return jsonify(error=message), 502

    info = info or {}
    entries = [e for e in (info.get("entries") or []) if e]
    default_channel = {
        "channel": info.get("channel") or info.get("uploader"),
        "channel_id": info.get("channel_id"),
    }
    out = {
        "items": [summarize(e, default_channel) for e in entries],
        "next_offset": offset + limit if len(entries) >= limit and offset + limit < MAX_COLLECTION else None,
    }
    if offset == 0:
        meta_block = channel_meta(info)
        if meta == "playlist":
            meta_block = {
                "title": info.get("title") or "",
                "channel": meta_block["name"],
                "channel_id": meta_block["channel_id"],
                "count": info.get("playlist_count"),
            }
        out[meta] = meta_block
    return jsonify(out)


def reco_fetch(topic: str, start: int, count: int) -> list[dict]:
    """Satu halaman hasil pencarian untuk satu topik (dengan cache singkat)."""
    key = (topic.lower(), start, count)
    cached = _reco_cache.get(key)
    if cached and time.time() - cached[0] < RECO_TTL:
        return cached[1]
    opts = ytdlp_opts(extract_flat=True, skip_download=True, playlist_items=f"{start + 1}-{start + count}")
    with yt_dlp.YoutubeDL(opts) as ydl:
        data = ydl.extract_info(f"{SEARCH_PREFIX}{MAX_RESULTS}:{topic}", download=False)
    items = [summarize(e) for e in (data or {}).get("entries") or [] if e]
    if len(_reco_cache) > 200:
        _reco_cache.clear()
    _reco_cache[key] = (time.time(), items)
    return items


@app.get("/api/recommend")
def recommend():
    topics: list[str] = []
    for raw in request.args.getlist("q"):
        topic = " ".join(raw.split())[:100]
        if len(topic) >= 2 and topic.lower() not in {t.lower() for t in topics}:
            topics.append(topic)
    topics = topics[:RECO_TOPICS]
    offset = max(0, request.args.get("offset", default=0, type=int))
    if not topics:
        return jsonify(error="Belum ada topik untuk rekomendasi."), 400
    if offset >= RECO_MAX:
        return jsonify(items=[], next_offset=None)

    per = max(1, PAGE_SIZE // len(topics))     # item per topik per halaman
    start = (offset // PAGE_SIZE) * per

    def work(topic: str):
        try:
            return reco_fetch(topic, start, per), None
        except yt_dlp.utils.DownloadError as exc:   # satu topik gagal tidak boleh menggagalkan seluruh beranda
            return None, clean_error(exc)

    with ThreadPoolExecutor(max_workers=len(topics)) as pool:
        outcomes = list(pool.map(work, topics))
    rows = [items for items, _ in outcomes if items is not None]
    if not rows:
        return jsonify(error=outcomes[0][1]), 502

    seen: set[str] = set()
    merged = []
    for group in itertools.zip_longest(*rows):   # selang antar topik supaya beragam
        for item in group:
            if item and item["kind"] == "video" and not item["short"] and item["id"] and item["id"] not in seen:
                seen.add(item["id"])
                merged.append(item)

    more = any(len(items) >= per for items in rows) and offset + PAGE_SIZE < RECO_MAX
    return jsonify(items=merged, next_offset=offset + PAGE_SIZE if more else None)


@app.get("/api/channel")
def channel():
    base = channel_base(request.args.get("ref", ""))
    tab = request.args.get("tab", "videos")
    offset = max(0, request.args.get("offset", default=0, type=int))
    if not base or tab not in CHANNEL_TABS:
        return jsonify(error="Channel tidak valid."), 400
    return collection_page(f"{base}/{CHANNEL_TABS[tab]}", offset, meta="channel")


@app.get("/api/playlist")
def playlist():
    url = playlist_url(request.args.get("ref", ""))
    offset = max(0, request.args.get("offset", default=0, type=int))
    if not url:
        return jsonify(error="Playlist tidak valid."), 400
    return collection_page(url, offset, meta="playlist")


@app.get("/api/info")
def info():
    url = (request.args.get("url") or "").strip()
    if not is_url(url):
        return jsonify(error="Tautan video tidak valid."), 400
    try:
        return jsonify(detail(extract(url)))
    except yt_dlp.utils.DownloadError as exc:
        return jsonify(error=clean_error(exc)), 502


# --------------------------------------------------------------------------
# Unduhan
# --------------------------------------------------------------------------
class ClipError(Exception):
    """Potongan tidak bisa dibuat (mis. waktu mulai melewati akhir video). Pesannya aman ditampilkan."""


class LiveStreamError(Exception):
    """Siaran langsung belum bisa diunduh. Pesannya aman ditampilkan."""


def reject_live(info: dict, *, incomplete: bool = False) -> None:
    """Filter yt-dlp: tolak siaran yang masih tayang atau belum mulai SEBELUM ada yang diunduh.
    Tanpa ini yt-dlp akan merekam siaran tanpa henti sampai siarannya berakhir (berjam-jam, file raksasa)."""
    state = live_state(info)
    if state == "live":
        raise LiveStreamError(
            "Siaran langsung belum bisa diunduh karena masih berlangsung. "
            "Tunggu sampai siarannya selesai, lalu coba lagi."
        )
    if state == "upcoming":
        raise LiveStreamError("Siaran ini belum dimulai, jadi belum ada yang bisa diunduh.")


def parse_clip(body: dict) -> dict | None:
    """Baca waktu potong dari permintaan. None berarti seluruh video. ValueError bila tidak valid."""
    start, end = body.get("start"), body.get("end")
    if start is None and end is None:
        return None

    def number(value, name):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"Waktu {name} tidak valid.")
        return float(value)

    s = number(start, "mulai") if start is not None else 0.0
    e = number(end, "selesai") if end is not None else None
    if s < 0 or s > MAX_CLIP_SECONDS:
        raise ValueError("Waktu mulai tidak valid.")
    if e is not None and (e > MAX_CLIP_SECONDS or e - s < MIN_CLIP_SECONDS):
        raise ValueError("Waktu selesai harus setidaknya 1 detik setelah waktu mulai.")
    if s == 0 and e is None:
        return None   # sama saja dengan seluruh video
    return {"start": s, "end": e}


def clock_label(sec: float) -> str:
    """1m30s / 1h02m03s: aman dipakai di nama file (tanpa titik dua)."""
    sec = int(round(sec))
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


def clip_label(clip: dict) -> str:
    end = "akhir" if clip["end"] is None else clock_label(clip["end"])
    return f"{clock_label(clip['start'])}-{end}"


def media_duration(path: Path) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        return float(out)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def build_opts(fmt: str, quality: str, outdir: Path, on_progress, on_post, clip: dict | None = None) -> dict:
    opts = {
        **ytdlp_opts(),
        "noprogress": True,   # progres ditampilkan lewat UI, bukan konsol/log
        "noplaylist": True,
        "outtmpl": str(outdir / "%(title).120B [%(id)s].%(ext)s"),
        "windowsfilenames": True,
        "match_filter": reject_live,
        "concurrent_fragment_downloads": 4,
        "progress_hooks": [on_progress],
        "postprocessor_hooks": [on_post],
    }

    if clip:
        # Hanya bagian yang dipilih yang diunduh (lewat FFmpeg), bukan seluruh video lalu dipotong.
        end = float("inf") if clip["end"] is None else clip["end"]
        opts["download_ranges"] = download_range_func(None, [(clip["start"], end)])
        # Selalu presisi: video disusun ulang di titik potong supaya tepat di detik yang dipilih.
        opts["force_keyframes_at_cuts"] = True
        opts["outtmpl"] = str(outdir / f"%(title).120B [%(id)s] (potongan {clip_label(clip)}).%(ext)s")

    if fmt in AUDIO_FORMATS:
        opts["format"] = "bestaudio/best"
        extract_pp = {"key": "FFmpegExtractAudio", "preferredcodec": fmt}
        if fmt in BITRATE_FORMATS:
            extract_pp["preferredquality"] = quality
        opts["postprocessors"] = [extract_pp, {"key": "FFmpegMetadata"}]
        return opts

    height = HEIGHTS.get(quality)
    cap = f"[height<={height}]" if height else ""
    if fmt == "mp4":
        selector = f"bv*{cap}[ext=mp4]+ba[ext=m4a]/bv*{cap}+ba/b{cap}/b"
    elif fmt == "webm":
        selector = f"bv*{cap}[ext=webm]+ba[ext=webm]/bv*{cap}+ba/b{cap}/b"
    else:  # mkv menampung codec apa pun
        selector = f"bv*{cap}+ba/b{cap}/b"
    opts["format"] = selector
    opts["merge_output_format"] = fmt

    # merge_output_format hanya berlaku bila yt-dlp menggabungkan dua stream.
    # Kalau sumbernya satu file utuh, pastikan container akhirnya tetap sesuai pilihan.
    # Remux (tanpa encode ulang) dilewati otomatis bila file sudah berformat yang diminta.
    if fmt == "webm":
        # WebM hanya menampung VP8/VP9/AV1 + Vorbis/Opus, jadi mungkin perlu encode ulang.
        opts["postprocessors"] = [{"key": "FFmpegVideoConvertor", "preferedformat": "webm"}]
    else:
        opts["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": fmt}]
    return opts


def pick_output(outdir: Path, fmt: str) -> Path | None:
    files = [
        p for p in outdir.iterdir()
        if p.is_file() and p.suffix.lower() not in {".part", ".ytdl", ".temp"}
    ]
    if not files:
        return None
    exact = [p for p in files if p.suffix.lower() == f".{fmt}"]
    return max(exact or files, key=lambda p: p.stat().st_size)


def move_to_save_dir(src: Path) -> Path:
    """Pindahkan hasil unduhan ke SAVE_DIR dengan nama yang rapi dan tidak menimpa file lama."""
    SAVE_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"\s*\[[\w-]{11}\]", "", src.stem, count=1).strip() or src.stem   # buang " [id YouTube]"
    target = SAVE_DIR / f"{stem}{src.suffix}"
    n = 1
    while target.exists():
        target = SAVE_DIR / f"{stem} ({n}){src.suffix}"
        n += 1
    # copyfile, bukan copy2 bawaan: penyimpanan bersama Android menolak chmod/utime (PermissionError) pada salinan
    # lintas penyimpanan. Di komputer dengan disk yang sama, ini tetap sekadar rename.
    shutil.move(str(src), str(target), copy_function=shutil.copyfile)
    return target


def reveal_in_folder(path: Path) -> None:
    if ANDROID:
        subprocess.Popen(["termux-open", str(path)])   # buka dengan aplikasi bawaan (pemutar video/audio)
    elif sys.platform == "win32":
        subprocess.Popen(f'explorer /select,"{path}"')
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])


def run_job(job_id: str, url: str, fmt: str, quality: str, clip: dict | None = None) -> None:
    job = jobs[job_id]
    outdir = DOWNLOAD_DIR / job_id
    outdir.mkdir(parents=True, exist_ok=True)
    expected_streams = 2 if fmt in VIDEO_FORMATS else 1

    def on_progress(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            frac = min((d.get("downloaded_bytes") or 0) / total, 1) if total else 0
            pct = (job["_streams"] + frac) / expected_streams * 94
            job.update(
                status="downloading",
                progress=round(min(pct, 94), 1),
                speed=d.get("speed"),
                eta=d.get("eta"),
                bytes=d.get("downloaded_bytes"),
                indeterminate=not total,   # total tidak diketahui (umum pada potongan): UI tampil tanpa persen
            )
        elif d["status"] == "finished":
            job["_streams"] += 1

    def on_post(d):
        if d["status"] == "started":
            job.update(status="processing", progress=96, speed=None, eta=None, indeterminate=False)

    try:
        with slots:
            job["status"] = "downloading"
            opts = build_opts(fmt, quality, outdir, on_progress, on_post, clip)
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.extract_info(url, download=True)

        result = pick_output(outdir, fmt)
        if result is None:
            raise RuntimeError("File hasil unduhan tidak ditemukan.")
        if clip:
            length = media_duration(result)
            if length is None or length < 0.3:
                raise ClipError("Potongan kosong. Pastikan waktu mulai masih berada di dalam durasi video.")
        if LOCAL_SAVE:
            result = move_to_save_dir(result)
            job["saved_path"] = str(result)
        job.update(status="done", progress=100, indeterminate=False, file=str(result), filename=result.name)
    except (ClipError, LiveStreamError) as exc:
        job.update(status="error", error=str(exc))
    except OSError as exc:
        job.update(status="error", error=f"Gagal menyimpan file: {exc.strerror or exc}")
    except yt_dlp.utils.DownloadError as exc:
        message = clean_error(exc)
        if UPCOMING_RE.search(message):
            # yt-dlp menolak siaran terjadwal lebih dulu karena belum ada formatnya.
            message = "Siaran ini belum dimulai, jadi belum ada yang bisa diunduh."
        elif clip and re.search(r"postprocessing|unable to obtain file|empty", message, re.I):
            # Biasanya karena waktu mulai melewati akhir video: file hasilnya kosong.
            message = f"Potongan gagal diproses. Pastikan waktu mulai masih berada di dalam durasi video. ({message})"
        job.update(status="error", error=message)
    except Exception as exc:  # noqa: BLE001
        job.update(status="error", error=f"Gagal tak terduga: {clean_error(exc)}")
    finally:
        job["finished_at"] = time.time() if job["status"] in ("done", "error") else None


def public(job: dict) -> dict:
    keys = ("id", "status", "progress", "speed", "eta", "filename", "error", "title", "format", "quality", "saved_path", "clip", "bytes", "indeterminate")
    return {k: job.get(k) for k in keys}


@app.post("/api/download")
def start_download():
    body = request.get_json(silent=True) or {}
    url = str(body.get("url", "")).strip()
    fmt = str(body.get("format", "")).lower()
    quality = str(body.get("quality", ""))

    if not is_url(url):
        return jsonify(error="Tautan video tidak valid."), 400
    if fmt not in VIDEO_FORMATS | AUDIO_FORMATS:
        return jsonify(error="Format tidak dikenal."), 400
    if not has_ffmpeg():
        return jsonify(error="FFmpeg belum terpasang. Pasang FFmpeg dulu (lihat README), lalu jalankan ulang aplikasi."), 503

    if fmt in VIDEO_FORMATS:
        quality = quality if quality in HEIGHTS else "best"
    elif fmt in BITRATE_FORMATS:
        quality = quality if quality in BITRATES else "192"
    else:
        quality = ""

    try:
        clip = parse_clip(body)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "progress": 0,
        "speed": None,
        "eta": None,
        "filename": None,
        "error": None,
        "title": str(body.get("title", ""))[:200],
        "format": fmt,
        "quality": quality,
        "file": None,
        "saved_path": None,
        "clip": {"start": clip["start"], "end": clip["end"]} if clip else None,
        "bytes": None,
        "indeterminate": False,
        "finished_at": None,
        "_streams": 0,
    }
    with jobs_lock:
        jobs[job_id] = job

    threading.Thread(target=run_job, args=(job_id, url, fmt, quality, clip), daemon=True).start()
    return jsonify(public(job)), 202


@app.get("/api/jobs/<job_id>")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return jsonify(error="Unduhan tidak ditemukan atau sudah kedaluwarsa."), 404
    return jsonify(public(job))


@app.get("/api/jobs/<job_id>/file")
def job_file(job_id: str):
    job = jobs.get(job_id)
    if not job or job["status"] != "done" or not job["file"]:
        abort(404)
    return send_file(job["file"], as_attachment=True, download_name=job["filename"])


@app.post("/api/jobs/<job_id>/reveal")
def job_reveal(job_id: str):
    """Buka Explorer/Finder (Android: aplikasi pemutar) pada file hasil unduhan. Hanya bila server yang menyimpan file."""
    if not LOCAL_SAVE:
        abort(404)
    job = jobs.get(job_id)
    path = Path(job["saved_path"]) if job and job.get("saved_path") else None
    if not path or not path.exists():
        return jsonify(error="File tidak ditemukan. Mungkin sudah dipindahkan atau dihapus."), 404
    try:
        reveal_in_folder(path)
    except OSError:
        return jsonify(error="File tidak bisa dibuka." if ANDROID else "Folder tidak bisa dibuka."), 500
    return jsonify(ok=True)


@app.post("/api/open-youtube")
def open_youtube():
    """Buka video di browser bawaan. Cadangan untuk siaran yang pemiliknya mematikan pemutaran di luar YouTube.
    Hanya aktif di mode desktop, dan hanya menerima id video (bukan URL bebas)."""
    if not DESKTOP:
        abort(404)
    vid = str((request.get_json(silent=True) or {}).get("id", ""))
    if not YT_ID_RE.match(vid):
        return jsonify(error="Id video tidak valid."), 400
    try:
        webbrowser.open(f"https://www.youtube.com/watch?v={vid}")
    except webbrowser.Error:
        return jsonify(error="Browser tidak bisa dibuka."), 500
    return jsonify(ok=True)


def janitor() -> None:
    """Hapus file unduhan yang sudah lewat masa simpannya."""
    while True:
        time.sleep(60)
        cutoff = time.time() - JOB_TTL
        with jobs_lock:
            expired = [
                jid for jid, j in jobs.items()
                if j["finished_at"] and j["finished_at"] < cutoff
            ]
            for jid in expired:
                jobs.pop(jid, None)
        for jid in expired:
            shutil.rmtree(DOWNLOAD_DIR / jid, ignore_errors=True)


if __name__ == "__main__":
    threading.Thread(target=janitor, daemon=True).start()
    host = os.environ.get("HOST", "127.0.0.1")   # default: hanya bisa diakses dari komputer ini
    port = int(os.environ.get("PORT", "5000"))
    print(f"Tonton berjalan di http://{host}:{port}")
    app.run(host=host, port=port, threaded=True)
