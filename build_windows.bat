@echo off
rem Membangun Tonton.exe. Cukup klik dua kali file ini.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_windows.ps1"
echo.
pause
