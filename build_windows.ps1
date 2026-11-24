# Membangun Tonton.exe (Windows). Butuh Python 3.9+ dan koneksi internet.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Check($step) {
    if ($LASTEXITCODE -ne 0) { throw "Gagal pada langkah: $step" }
}

Write-Host "1/4  Menyiapkan lingkungan Python..." -ForegroundColor Yellow
if (-not (Test-Path ".venv-build")) { python -m venv .venv-build; Check "membuat venv (apakah Python sudah terpasang?)" }
$py = Join-Path $PSScriptRoot ".venv-build\Scripts\python.exe"
& $py -m pip install --upgrade pip --quiet;                              Check "pip"
& $py -m pip install --upgrade -r requirements-desktop.txt pyinstaller --quiet;  Check "memasang dependensi"   # --upgrade: selalu pakai yt-dlp terbaru

Write-Host "2/4  Menyiapkan FFmpeg..." -ForegroundColor Yellow
if (-not (Test-Path "ffmpeg\ffmpeg.exe") -or -not (Test-Path "ffmpeg\ffprobe.exe")) {
    $zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"
    $tmp = Join-Path $env:TEMP "ffmpeg-essentials"
    Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip -DestinationPath $tmp
    New-Item -ItemType Directory -Force "ffmpeg" | Out-Null
    Get-ChildItem $tmp -Recurse -Include "ffmpeg.exe", "ffprobe.exe" | Copy-Item -Destination "ffmpeg" -Force
    Remove-Item $zip -Force
    Remove-Item $tmp -Recurse -Force
}
if (-not (Test-Path "ffmpeg\ffmpeg.exe")) { throw "ffmpeg.exe tidak ditemukan setelah diunduh." }

Write-Host "3/4  Membangun aplikasi (beberapa menit)..." -ForegroundColor Yellow
& $py -m PyInstaller --noconfirm --clean --windowed --name Tonton --icon icon.ico `
    --add-data "static;static" --add-data "ffmpeg;ffmpeg" `
    --collect-submodules yt_dlp --collect-submodules webview `
    desktop.py
Check "PyInstaller"

Write-Host "4/4  Mengemas hasil..." -ForegroundColor Yellow
Compress-Archive -Path "dist\Tonton" -DestinationPath "dist\Tonton-windows.zip" -Force

Write-Host ""
Write-Host "Selesai." -ForegroundColor Green
Write-Host "Aplikasi : $PSScriptRoot\dist\Tonton\Tonton.exe"
Write-Host "Arsip    : $PSScriptRoot\dist\Tonton-windows.zip  (bisa dibagikan, ekstrak lalu buka Tonton.exe)"
