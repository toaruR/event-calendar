# Keep the event-calendar daemon running: restart on exit, append output to .event-calendar/daemon.log (UTF-8).
# Intended to be launched by Task Scheduler at logon (see README "常駐起動").
# No --stdin-shutdown: a scheduled task has no stdin, so stdin EOF would stop the daemon immediately.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$log = Join-Path $root '.event-calendar\daemon.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
function Write-Log($m) { [IO.File]::AppendAllText($log, "[$(Get-Date -Format o)] $m`r`n", $utf8) }

while ($true) {
  Write-Log 'starting daemon'
  # via cmd so node's raw UTF-8 bytes go to the file (PowerShell redirection would re-encode to UTF-16)
  cmd /c "node src/daemon.ts --data-dir .event-calendar --config config.json >> `"$log`" 2>&1"
  Write-Log "daemon exited (code $LASTEXITCODE); restarting in 10s"
  Start-Sleep -Seconds 10
}
