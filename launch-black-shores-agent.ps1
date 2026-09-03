$ErrorActionPreference = "Stop"

$taskName = "BLACK_SHORES_AGENT"
$installedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($installedTask) {
  Start-ScheduledTask -TaskName $taskName
  exit 0
}

$workerPath = Join-Path $PSScriptRoot "start-black-shores-agent-hidden.ps1"
$powershellPath = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $powershellPath)) {
  $powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
}
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$workerPath`""
Start-Process `
  -FilePath $powershellPath `
  -ArgumentList $arguments `
  -WorkingDirectory $PSScriptRoot `
  -WindowStyle Hidden
