@echo off
rem 13STORE event kit: stop (see README_TH.md)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0event.ps1" stop
echo.
pause
