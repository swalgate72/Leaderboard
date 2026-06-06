@echo off
echo Fixing line endings (preserving ASCII encoding)...
powershell -Command "$content = [System.IO.File]::ReadAllText('js\app.js'); $content = $content -replace \"`r`n\", \"`n\"; [System.IO.File]::WriteAllText('js\app.js', $content, [System.Text.Encoding]::ASCII)"
echo Done. Now commit and push in GitHub Desktop.
pause
