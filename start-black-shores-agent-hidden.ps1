$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot
$logDirectory = Join-Path $PSScriptRoot "data"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$stdoutPath = Join-Path $logDirectory "service.stdout.log"
$stderrPath = Join-Path $logDirectory "service.stderr.log"

& node "server.js" 1>> $stdoutPath 2>> $stderrPath
exit $LASTEXITCODE
