@echo off
echo Fixing line endings for all JS files...
powershell -NoProfile -ExecutionPolicy Bypass -File fix-line-endings.ps1
echo Done. Now commit and push in GitHub Desktop.
pause
