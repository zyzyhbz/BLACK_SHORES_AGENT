$ErrorActionPreference = "Stop"

$taskName = "BLACK_SHORES_AGENT"
$launcherPath = Join-Path $PSScriptRoot "start-black-shores-agent-hidden.ps1"
$powershellPath = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path -LiteralPath $powershellPath)) {
  $powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
}

$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Keep BLACK_SHORES_AGENT available on 127.0.0.1 without a visible terminal." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output "$taskName is installed and running in the background."
