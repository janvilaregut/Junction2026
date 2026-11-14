$ErrorActionPreference = 'Stop'
$katseVersion = '0.13.4'
$katseTools = Join-Path $env:LOCALAPPDATA 'Katse/tools'
$katseDownload = Join-Path $env:TEMP ('katse-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $katseDownload, $katseTools -Force | Out-Null
$katseRelease = "https://github.com/entireio/cli/releases/download/v$katseVersion"
$katseArchive = Join-Path $katseDownload 'entire_windows_amd64.zip'
Invoke-WebRequest "$katseRelease/entire_windows_amd64.zip" -OutFile $katseArchive
$katseChecksums = (Invoke-WebRequest "$katseRelease/checksums.txt").Content
$katseExpected = ($katseChecksums -split "`n" | Where-Object { $_ -match 'entire_windows_amd64.zip$' } | Select-Object -First 1).Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0]
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $katseArchive).Hash.ToLowerInvariant() -ne $katseExpected.ToLowerInvariant()) { throw 'Entire checksum mismatch' }
Expand-Archive -LiteralPath $katseArchive -DestinationPath $katseTools -Force
& (Join-Path $katseTools 'entire.exe') version
Write-Output 'Entire instalado. Ejecuta npm ci y configura .env.local desde .env.example.'
