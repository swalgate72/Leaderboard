@echo off
echo Fixing line endings...
powershell -Command "(Get-Content 'js\app.js') -join \"`n\" | Set-Content 'js\app.js' -NoNewline"
echo Done. Now commit and push in GitHub Desktop.
pause
