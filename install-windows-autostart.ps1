$ErrorActionPreference = "Stop"

$taskName = "BLACK_SHORES_AGENT"
$launcherPath = Join-Path $PSScriptRoot "start-black-shores-agent-hidden.vbs"
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscriptPath)) {
  $wscriptPath = (Get-Command wscript.exe -ErrorAction Stop).Source
}

$arguments = "`"$launcherPath`""
$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument $arguments -WorkingDirectory $PSScriptRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
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
  -Trigger @($logonTrigger, $watchdogTrigger) `
  -Principal $principal `
  -Settings $settings `
  -Description "Keep BLACK_SHORES_AGENT available on 127.0.0.1 without a visible terminal." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output "$taskName is installed and running in the background."
