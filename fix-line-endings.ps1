$files = @('js\app.js', 'data.js', 'game.js', 'tournament.js')
foreach ($f in $files) {
    if (Test-Path $f) {
        $bytes = [System.IO.File]::ReadAllBytes($f)
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        $fixed = $text -replace "`r`n", "`n"
        $outBytes = [System.Text.Encoding]::UTF8.GetBytes($fixed)
        [System.IO.File]::WriteAllBytes($f, $outBytes)
        Write-Host "Fixed: $f"
    }
}
