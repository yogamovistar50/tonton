#!/usr/bin/env bash
# Memasang Tonton di Termux (Android). Jalankan sekali:  bash tonton/termux/install.sh
# Memasang python, ffmpeg, dan nodejs lewat pkg, lalu yt-dlp dan Flask di lingkungan Python terpisah,
# dan membuat perintah "tonton". Aman dijalankan ulang (dipakai juga untuk memperbaiki pemasangan).
set -eu

say()  { printf '\n==> %s\n' "$1"; }
warn() { printf '   PERHATIAN: %s\n' "$1"; }
fail() { printf '\nGAGAL: %s\n' "$1" >&2; exit 1; }

# --- 0. pastikan ini Termux
if [ -z "${TERMUX_VERSION:-}" ] && [ ! -d /data/data/com.termux ]; then
  fail "Skrip ini hanya untuk Termux di Android. Di Windows pakai build_windows.bat, di komputer lain lihat README bagian B."
fi
command -v pkg >/dev/null 2>&1 || fail "Perintah 'pkg' tidak ditemukan. Pasang Termux dari F-Droid (bukan dari Play Store)."

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$HERE")"
[ -f "$APP_DIR/app.py" ] || fail "app.py tidak ditemukan di $APP_DIR. Jalankan skrip ini dari dalam folder tonton yang sudah diekstrak."
VENV="${TONTON_VENV:-$HOME/.tonton-venv}"
BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
PY="$VENV/bin/python"

# --- 1. paket sistem
say "1/5  Memasang paket sistem (python, ffmpeg, nodejs). Butuh internet dan beberapa menit..."
pkg update -y
# nodejs dipakai yt-dlp untuk menyelesaikan tantangan JavaScript YouTube; tanpanya sebagian format video hilang.
pkg install -y python ffmpeg nodejs || pkg install -y python ffmpeg nodejs-lts

# --- 2. lingkungan Python
say "2/5  Menyiapkan lingkungan Python di $VENV ..."
if [ ! -x "$PY" ]; then
  python -m venv "$VENV" || { pkg install -y python-pip && python -m venv "$VENV"; } || fail "Gagal membuat lingkungan Python."
fi

# --- 3. yt-dlp dan Flask
say "3/5  Memasang yt-dlp dan Flask..."
"$PY" -m pip install --upgrade -r "$HERE/requirements-termux.txt" || fail "Gagal memasang paket Python. Periksa koneksi internet lalu jalankan lagi."

# --- 4. perintah "tonton"
say "4/5  Membuat perintah 'tonton'..."
mkdir -p "$BIN_DIR"
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@VENV@|$VENV|g" "$HERE/tonton" > "$BIN_DIR/tonton"
chmod 755 "$BIN_DIR/tonton"
command -v termux-fix-shebang >/dev/null 2>&1 && termux-fix-shebang "$BIN_DIR/tonton" || true   # jalur #! yang benar saat dipanggil aplikasi lain

# --- 5. izin penyimpanan (agar unduhan langsung masuk ke folder Download HP)
say "5/5  Izin penyimpanan..."
if [ -d "$HOME/storage/downloads" ]; then
  echo "   Sudah diizinkan."
elif command -v termux-setup-storage >/dev/null 2>&1; then
  termux-setup-storage || true
  echo "   Izinkan akses penyimpanan pada jendela yang muncul. Tanpa izin, Tonton tetap jalan,"
  echo "   tetapi unduhan dikirim lewat browser (tersimpan di folder unduhan browser)."
fi

# --- pemeriksaan akhir
say "Memeriksa hasil pemasangan..."
problems=0
"$PY" - <<'PYEOF' || problems=1
import importlib.metadata as md
for name in ("flask", "yt-dlp", "yt-dlp-ejs"):
    print(f"   {name:<12} {md.version(name)}")
import yt_dlp, yt_dlp_ejs  # noqa: F401
PYEOF
for tool in ffmpeg ffprobe; do
  if command -v "$tool" >/dev/null 2>&1; then echo "   $tool        ada"; else warn "$tool tidak ditemukan"; problems=1; fi
done
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null || echo '?')"
  echo "   node         $node_version"
  case "$node_version" in
    v[0-9].*|v1[0-9].*|v2[01].*) warn "node $node_version terlalu lama; yt-dlp butuh node 22 atau lebih baru. Jalankan: pkg install nodejs"; problems=1 ;;
  esac
else
  warn "node tidak ditemukan; sebagian format YouTube mungkin tidak muncul"; problems=1
fi

if [ "$problems" -eq 0 ]; then
  printf '\nSelesai. Jalankan Tonton dengan perintah:\n\n    tonton\n\n'
else
  printf '\nPemasangan selesai dengan peringatan di atas. Tonton mungkin tetap berjalan; coba:  tonton\n\n'
fi
