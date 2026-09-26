# Restart the Web GUI so it loads the hub's updated Host half.
#
# The browser half hot-reloads by itself (the shell polls the artifact URL and
# its revision changes with the file). The Host half does not: it is an
# in-process ESM module, and the plugin lives outside the profile directory, so
# nothing watches it. Replacing the package without restarting silently keeps
# the old host code running.
#
# Starting a second `dsh web` while the first is alive fails with EADDRINUSE, so
# this script stops the current listener first — after confirming the process is
# actually a JavaScript runtime, because killing by port number alone is how an
# unrelated server gets taken down.
#
# Usage:  pwsh -File restart-web.ps1 -Checkout <dsh source checkout>
#         pwsh -File restart-web.ps1 -Port 3080 -Checkout C:\path\to\deepseek-harness
#
# The checkout defaults to $env:DSH_CHECKOUT so no machine-specific path has to
# live in this repository.

[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$Checkout = $env:DSH_CHECKOUT
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Checkout)) {
  throw 'pass -Checkout <dsh source checkout>, or set $env:DSH_CHECKOUT to it'
}

if (-not (Test-Path (Join-Path $Checkout 'package.json'))) {
  throw "no package.json under '$Checkout' — pass -Checkout with the dsh source checkout root"
}

function Get-ListenerPid {
  param([int]$LocalPort)
  $lines = netstat -ano | Select-String ":$LocalPort\s+.*LISTENING\s+(\d+)\s*$"
  foreach ($line in $lines) {
    $match = [regex]::Match($line.Line, 'LISTENING\s+(\d+)\s*$')
    if ($match.Success) { return [int]$match.Groups[1].Value }
  }
  return $null
}

$existing = Get-ListenerPid -LocalPort $Port
if ($null -eq $existing) {
  Write-Host "nothing is listening on $Port; starting a fresh dsh web" -ForegroundColor Yellow
} else {
  $target = Get-Process -Id $existing -ErrorAction SilentlyContinue
  if ($null -eq $target) {
    throw "pid $existing is listening on $Port but cannot be inspected; stop it yourself, then re-run this script"
  }
  if ($target.ProcessName -notin @('node', 'pnpm', 'bun', 'deno')) {
    throw "pid $existing on Port $Port is '$($target.ProcessName)', not a JavaScript runtime; refusing to stop it"
  }
  Write-Host "stopping pid $existing ($($target.ProcessName), the current $Port listener)" -ForegroundColor Yellow
  Stop-Process -Id $existing -Force
  # Wait for the socket to be released; starting too early fails on EADDRINUSE.
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    if ($null -eq (Get-ListenerPid -LocalPort $Port)) { break }
  }
  if ($null -ne (Get-ListenerPid -LocalPort $Port)) {
    throw "port $Port is still held after 6s; free it yourself, then re-run this script"
  }
}

Write-Host "starting dsh web from $Checkout" -ForegroundColor Green
Start-Process -FilePath 'pnpm' -ArgumentList 'run', 'start:web' -WorkingDirectory $Checkout

Write-Host ''
Write-Host 'a new window is starting the server; wait for it to print its URL, then reload the GUI.' -ForegroundColor Green
Write-Host 'the browser half reloads on its own, so after the restart the panel is current.' -ForegroundColor Green
