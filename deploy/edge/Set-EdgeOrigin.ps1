<#
.SYNOPSIS
  Lets the platform use this laptop's MediaMTX as a video source (administrator, once per address).

.DESCRIPTION
  The server does not trust stream URLs a gateway declares: the URL's origin (scheme, host, port)
  must be on the organisation's list of edge media origins. There is no screen for this list yet,
  so this script asks for the administrator's password, signs in and adds the origin. Loopback
  addresses (localhost, 127.x) are refused by the server; use the laptop's LAN address.

  After it succeeds, restart the gateway (Ctrl+C, then Start-Edge.ps1) so it declares the stream again.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\edge\Set-EdgeOrigin.ps1 -Origin http://192.168.10.50:8889
#>
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [string]$Server = 'http://192.168.20.13:8090',
  [string]$Username = 'admin'
)
$ErrorActionPreference = 'Stop'

$cred = Get-Credential -UserName $Username -Message "Platform administrator for $Server"
$body = @{ username = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$Server/api/v1/auth/login" -ContentType 'application/json' -Body $body
$headers = @{ Authorization = "Bearer $($login.token)" }
try {
  # Organisation-wide origins (no site): keep the ones already there and add this one.
  $current = @(Invoke-RestMethod -Uri "$Server/api/v1/admin/edge-origins" -Headers $headers)
  $origins = @($current | Where-Object { -not $_.siteId } | ForEach-Object { $_.origin })
  if ($origins -notcontains $Origin) { $origins += $Origin }
  $result = Invoke-RestMethod -Method Put -Uri "$Server/api/v1/admin/edge-origins" -Headers $headers -ContentType 'application/json' -Body (@{ origins = $origins } | ConvertTo-Json)
  Write-Host 'Allowed edge media origins:'
  $result.origins | ForEach-Object { Write-Host "  $_" }
  Write-Host 'Now restart the gateway (Ctrl+C in its window, then Start-Edge.ps1).'
} finally {
  try { $null = Invoke-RestMethod -Method Post -Uri "$Server/api/v1/auth/logout" -Headers $headers } catch { }
}
