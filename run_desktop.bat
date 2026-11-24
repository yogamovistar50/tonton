@echo off
rem Jalankan Tonton sebagai aplikasi desktop tanpa membangun .exe.
rem Butuh Python dan FFmpeg (atau letakkan ffmpeg.exe + ffprobe.exe di folder "ffmpeg" di sebelah file ini).
cd /d "%~dp0"
python -m pip install -r requirements-desktop.txt
python desktop.py
