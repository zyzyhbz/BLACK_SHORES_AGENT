$ErrorActionPreference = "Stop"

$taskName = "BLACK_SHORES_AGENT"
$installedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($installedTask) {
  Start-ScheduledTask -TaskName $taskName
  exit 0
}

$workerPath = Join-Path $PSScriptRoot "start-black-shores-agent-hidden.vbs"
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscriptPath)) {
  $wscriptPath = (Get-Command wscript.exe -ErrorAction Stop).Source
}
Start-Process `
  -FilePath $wscriptPath `
  -ArgumentList "`"$workerPath`"" `
  -WorkingDirectory $PSScriptRoot `
  -WindowStyle Hidden
