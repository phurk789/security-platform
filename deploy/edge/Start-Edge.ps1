<#
.SYNOPSIS
  Starts the edge stack on this Windows laptop: MediaMTX (vehicle video) and the edge gateway
  (vehicle link to the platform server).

.DESCRIPTION
  Needs, once:
    - Node 22 or newer, and `npm ci` run in the repo
    - deploy\edge\bin\mediamtx.exe (MediaMTX v1.9.3 for Windows)
    - deploy\edge\site.json: copy site.ugv.example.json, then put in the gateway key and this
      laptop's address (see FIRST_CONNECTION_TH.md)
    - the laptop wired to the UniRC 7 Pro's LAN port with a static 192.168.144.50/24

  MediaMTX opens in its own minimised window. The gateway runs in this window: Ctrl+C stops it.
  The vehicle stays in SHADOW (watch only) until a supervisor promotes it after the safety tests.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\edge\Start-Edge.ps1
  powershell -ExecutionPolicy Bypass -File deploy\edge\Start-Edge.ps1 -NoVideo
#>
param([switch]$NoVideo)
$ErrorActionPreference = 'Stop'

$edge = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $edge '..\..')).Path
$site = Join-Path $edge 'site.json'

if (-not (Test-Path $site)) { throw "Missing $site. Copy site.ugv.example.json to site.json and fill it in (FIRST_CONNECTION_TH.md)." }
$cfg = Get-Content -Raw $site | ConvertFrom-Json
if ($cfg.key -match 'REPLACE') { throw 'site.json still has the placeholder gateway key. Copy the key from the server log (FIRST_CONNECTION_TH.md, step 2).' }
foreach ($d in $cfg.devices) {
  if ($d.stream -and $d.stream.whep -match 'LAPTOP_IP') { throw "Put this laptop's address in $($d.deviceId) stream.whep (site.json)." }
}

Write-Host '--- this laptop''s addresses (use the one other computers reach for stream.whep)'
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.IPAddress, $_.InterfaceAlias) }

Write-Host '--- checks'
$http = $cfg.serverUrl -replace '^ws', 'http'
try {
  $null = Invoke-RestMethod -Uri "$http/api/v1/health" -TimeoutSec 5
  Write-Host "  platform server $http : OK"
} catch {
  Write-Warning "Platform server $http does not answer. Check the network to the server before going on."
}
foreach ($ip in @('192.168.144.20', '192.168.144.11', '192.168.144.25')) {
  $what = @{ '192.168.144.20' = 'UniRC 7 Pro'; '192.168.144.11' = 'air unit (radio link)'; '192.168.144.25' = 'SIYI camera' }[$ip]
  if (Test-Connection -ComputerName $ip -Count 1 -Quiet) { Write-Host "  $what $ip : OK" }
  else { Write-Warning "$what $ip does not answer (LAN cable, laptop address 192.168.144.50, power, binding)." }
}

if (-not $NoVideo) {
  $mtx = Join-Path $edge 'bin\mediamtx.exe'
  if (-not (Test-Path $mtx)) { throw "Missing $mtx. Unzip MediaMTX v1.9.3 for Windows there, or start with -NoVideo." }
  $running = Get-Process -Name mediamtx -ErrorAction SilentlyContinue
  if ($running) { Write-Host '  MediaMTX already running' }
  else {
    Start-Process -FilePath $mtx -ArgumentList "`"$(Join-Path $edge 'mediamtx.windows.yml')`"" -WorkingDirectory $edge -WindowStyle Minimized
    Write-Host '  MediaMTX started (minimised window; close it to stop video)'
  }
}

Write-Host '--- edge gateway (Ctrl+C to stop)'
$env:GATEWAY_CONFIG = $site
$env:GATEWAY_DATA_DIR = Join-Path $edge 'data\gateway'
Set-Location $repo
npm start -w @13store/gateway
