param([string]$Model = 'gemma4:e2b-it-qat')
$ErrorActionPreference = 'Stop'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:KATSE_GEMMA_URL = 'http://127.0.0.1:11434'
if ($Model -notmatch '^gemma[\w.:-]+$' -or $Model -match 'cloud') { throw 'Use a local Gemma tag, never a cloud model.' }
$ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCommand) { throw 'Install Ollama from https://ollama.com/download/windows, reopen PowerShell and run this script again.' }
try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 }
catch { Start-Process -FilePath $ollamaCommand.Source -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep -Seconds 3 }
& $ollamaCommand.Source pull $Model
if ($LASTEXITCODE -ne 0) { throw 'Gemma download failed.' }
$env:KATSE_GEMMA_MODEL = $Model
node (Join-Path $PSScriptRoot 'check-privacy.js')
if ($LASTEXITCODE -ne 0) { throw 'Gemma privacy smoke test failed; private reviews remain blocked.' }
