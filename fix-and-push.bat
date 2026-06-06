@echo off
echo Fixing line endings...
powershell -Command "$text = [System.IO.File]::ReadAllText('js\app.js'); $fixed = $text.Replace([char]13 + [char]10, [char]10); [System.IO.File]::WriteAllText('js\app.js', $fixed, (New-Object System.Text.UTF8Encoding $false))"
echo Done - no BOM, LF endings. Now commit and push in GitHub Desktop.
pause
