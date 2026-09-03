@echo off
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0launch-black-shores-agent.ps1"
exit /b %ERRORLEVEL%
