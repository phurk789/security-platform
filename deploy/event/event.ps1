# 13STORE event kit: the platform on one Windows PC (e.g. a OneX handheld) for a show, without Docker.
# The kit folder holds node\node.exe, app\ (server, console, field app, gateway), media\mediamtx.exe and data\.
# START.cmd, STOP.cmd, MENU.cmd and SETUP.cmd call this script:
#   event.ps1 start | stop | restart | status | setup | import <backup.tgz> | mode pilot|demo | ip auto|<address>
#             autostart on|off | menu
# Windows PowerShell 5.1. Saved as UTF-8 with BOM so the Thai text shows correctly.
param([string]$Command = 'menu', [string]$Arg = '')

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Root = $PSScriptRoot
$Node = Join-Path $Root 'node\node.exe'
$Server = Join-Path $Root 'app\apps\server\dist\index.js'
$MediaExe = Join-Path $Root 'media\mediamtx.exe'
$MediaYml = Join-Path $Root 'media\mediamtx.yml'
$Template = Join-Path $Root 'mediamtx.template.yml'
$ConfigFile = Join-Path $Root 'config.env'
$RunDir = Join-Path $Root 'run'
$LogDir = Join-Path $Root 'logs'
$ImportDir = Join-Path $Root 'import'
$Port = 8090
$TcpPorts = @(8090, 18554, 18889, 18189)
$UdpPorts = @(18189)
$MediaUrl = 'https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_windows_amd64.zip'
$TaskName = '13STORE event platform'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

# ---- settings (config.env: MODE, MEDIA_SECRET, IP) ---------------------------------------------------------

function Read-Config {
  $c = @{ MODE = 'pilot'; IP = 'auto'; MEDIA_SECRET = '' }
  if (Test-Path $ConfigFile) {
    foreach ($line in Get-Content $ConfigFile) {
      if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $c[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  if (-not $c.MEDIA_SECRET) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $c.MEDIA_SECRET = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    Write-Config $c
  }
  return $c
}

function Write-Config($c) {
  $lines = @(
    '# Event kit settings (event.ps1). MODE: pilot = real vehicles, demo = simulated.',
    '# IP: auto = this PC''s address on the network with a router, or a fixed address such as 192.168.1.10.',
    "MODE=$($c.MODE)",
    "IP=$($c.IP)",
    "MEDIA_SECRET=$($c.MEDIA_SECRET)"
  )
  Set-Content -Path $ConfigFile -Value $lines -Encoding ascii
}

# This PC's address on the event network: the adapter with a default gateway (the router), else the first LAN one.
function Get-LanIp($c) {
  if ($c.IP -and $c.IP -ne 'auto') { return $c.IP }
  try {
    $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if ($cfg) { return @($cfg.IPv4Address)[0].IPAddress }
  } catch { }
  $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Bluetooth' } |
    Select-Object -First 1
  if ($a) { return $a.IPAddress }
  return '127.0.0.1'
}

function Get-DataDir($c) { return Join-Path $Root ("data\" + $c.MODE) }

# ---- processes ------------------------------------------------------------------------------------------------

# The kit's own process for a pid file, or $null (a stale pid of another program never counts).
function Get-KitProcess([string]$Name, [string]$Exe) {
  $file = Join-Path $RunDir "$Name.pid"
  if (-not (Test-Path $file)) { return $null }
  $id = [int](Get-Content $file -Raw)
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.Path -and ((Resolve-Path $p.Path).Path -eq (Resolve-Path $Exe).Path)) { return $p }
  Remove-Item $file -ErrorAction SilentlyContinue
  return $null
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/v1/health" -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Test-PortFree([int]$P) {
  $busy = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue
  return -not $busy
}

# ---- commands -------------------------------------------------------------------------------------------------

function Start-Platform {
  if (-not (Test-Path $Node) -or -not (Test-Path $Server)) { Say 'ไม่พบโปรแกรมในชุดนี้ (node\node.exe หรือ app\) ให้แตกไฟล์ชุดติดตั้งใหม่ทั้งโฟลเดอร์' Red; return }
  if (Get-KitProcess 'server' $Node) { Say 'ระบบเปิดอยู่แล้ว' Yellow; Show-Status; return }
  if (-not (Test-PortFree $Port)) { Say "พอร์ต $Port ถูกโปรแกรมอื่นใช้อยู่ ปิดโปรแกรมนั้นก่อน" Red; return }
  $c = Read-Config
  $ip = Get-LanIp $c
  $data = Get-DataDir $c
  New-Item -ItemType Directory -Force -Path $RunDir, $LogDir, $data | Out-Null

  # Real vehicles: the first start takes the office server's data from import\ when the data folder is still empty.
  if ($c.MODE -eq 'pilot' -and -not (Test-Path (Join-Path $data 'platform.sqlite'))) {
    $tgz = Get-ChildItem -Path $ImportDir -Filter '*.tgz' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($tgz) { Import-Data $tgz.FullName }
  }

  $hasMedia = Test-Path $MediaExe
  $env:NODE_ENV = 'production'
  $env:NODE_OPTIONS = '--disable-warning=ExperimentalWarning'
  $env:DATA_DIR = $data
  $env:PORT = "$Port"
  $env:HOST = '0.0.0.0'
  $env:ENV_MODE = $c.MODE
  $env:MEDIA_SECRET = $c.MEDIA_SECRET
  $env:TRUST_PROXY = '0'
  # Plain http on the event network: the console may also fetch video from an edge's own media server.
  $env:CSP_CONNECT_SRC = 'https: wss: http:'
  # Plain http, so no HSTS (it would only matter behind https).
  $env:HSTS = '0'
  if ($hasMedia) {
    $env:MEDIA_INGEST_URL = "rtsp://${ip}:18554"
    $env:MEDIA_PUBLIC_URL = "http://${ip}:18889"
  } else {
    Remove-Item Env:MEDIA_INGEST_URL, Env:MEDIA_PUBLIC_URL -ErrorAction SilentlyContinue
  }

  $out = Join-Path $LogDir 'server.out.log'
  $err = Join-Path $LogDir 'server.err.log'
  $p = Start-Process -FilePath $Node -ArgumentList "`"$Server`"" -WorkingDirectory (Join-Path $Root 'app') -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  Set-Content -Path (Join-Path $RunDir 'server.pid') -Value $p.Id -Encoding ascii
  Say 'กำลังเปิดระบบ...' Cyan
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($p.HasExited) { break }
    if (Test-Health) { $ok = $true; break }
  }
  if (-not $ok) {
    Say 'เปิดระบบไม่สำเร็จ ข้อความล่าสุดจากระบบ:' Red
    if (Test-Path $err) { Get-Content $err -Tail 15 | ForEach-Object { Say "  $_" } }
    if (Test-Path $out) { Get-Content $out -Tail 5 | ForEach-Object { Say "  $_" } }
    return
  }

  if ($hasMedia) {
    (Get-Content $Template -Raw).Replace('__IP__', $ip).Replace('__PORT__', "$Port") | Set-Content -Path $MediaYml -Encoding ascii
    $m = Start-Process -FilePath $MediaExe -ArgumentList "`"$MediaYml`"" -WorkingDirectory (Join-Path $Root 'media') -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $LogDir 'media.out.log') -RedirectStandardError (Join-Path $LogDir 'media.err.log') -PassThru
    Set-Content -Path (Join-Path $RunDir 'media.pid') -Value $m.Id -Encoding ascii
  } else {
    Say 'ยังไม่มีตัวส่งวิดีโอ (media\mediamtx.exe): ระบบทำงานได้แต่ไม่มีภาพกล้อง ให้รัน SETUP.cmd ตอนต่ออินเทอร์เน็ต' Yellow
  }

  # A brand-new real-vehicle setup prints the administrator password once.
  $once = Select-String -Path $out -Pattern 'shown once' -ErrorAction SilentlyContinue
  if ($once) {
    Say ''
    Say 'ระบบใหม่ จดรหัสนี้ไว้ (แสดงครั้งเดียว):' Yellow
    $once | ForEach-Object { Say ("  " + $_.Line) Yellow }
  }
  Show-Status
  # EVENT_NO_BROWSER=1: start without opening the browser (tests, or a PC that only serves).
  if (-not $env:EVENT_NO_BROWSER) { Start-Process "http://localhost:$Port" | Out-Null }
}

function Stop-Platform {
  $any = $false
  foreach ($n in @(@('media', $MediaExe), @('server', $Node))) {
    $p = Get-KitProcess $n[0] $n[1]
    if ($p) { Stop-Process -Id $p.Id -Force; $any = $true }
    Remove-Item (Join-Path $RunDir "$($n[0]).pid") -ErrorAction SilentlyContinue
  }
  if ($any) { Say 'ปิดระบบแล้ว' Green } else { Say 'ระบบไม่ได้เปิดอยู่' Yellow }
}

function Show-Status {
  $c = Read-Config
  $ip = Get-LanIp $c
  $server = Get-KitProcess 'server' $Node
  $media = Get-KitProcess 'media' $MediaExe
  $modeText = if ($c.MODE -eq 'demo') { 'เดโม (รถจำลอง)' } else { 'รถจริง (pilot)' }
  Say ''
  Say '========================================================' DarkGray
  if ($server -and (Test-Health)) {
    Say ' ระบบเปิดอยู่' Green
    Say (" เปิดเว็บจากเครื่องอื่น:  http://${ip}:$Port") White
    Say (" เปิดบนเครื่องนี้:       http://localhost:$Port") Gray
  } elseif ($server) {
    Say ' ระบบกำลังเปิด หรือค้าง (ดูไฟล์ใน logs\)' Yellow
  } else {
    Say ' ระบบปิดอยู่' Yellow
  }
  Say (" โหมด: $modeText   ·   ที่อยู่เครื่องนี้: $ip   ·   วิดีโอ: " + $(if ($media) { 'เปิด' } elseif (Test-Path $MediaExe) { 'ปิด' } else { 'ไม่มีตัวส่งวิดีโอ' })) Gray
  Say (" ข้อมูล: " + (Get-DataDir $c)) DarkGray
  Say '========================================================' DarkGray
}

function Import-Data([string]$File) {
  if (-not $File -or -not (Test-Path $File)) { Say 'ระบุไฟล์ข้อมูล (.tgz) ที่ได้จากเครื่อง .13' Red; return }
  if (Get-KitProcess 'server' $Node) { Say 'ปิดระบบก่อน (STOP.cmd) แล้วค่อยนำเข้าข้อมูล' Red; return }
  $dest = Join-Path $Root 'data\pilot'
  if (Test-Path (Join-Path $dest 'platform.sqlite')) {
    $keep = "$dest-before-import-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item $dest $keep
    Say "ข้อมูลเดิมเก็บไว้ที่ $keep" Gray
  }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  & "$env:SystemRoot\System32\tar.exe" -xzf $File -C $dest
  if ($LASTEXITCODE -ne 0) { Say 'แตกไฟล์ข้อมูลไม่สำเร็จ' Red; return }
  Say ("นำเข้าข้อมูลรถจริงแล้ว: " + (Split-Path $File -Leaf)) Green
}

function Set-Mode([string]$M) {
  if ($M -ne 'pilot' -and $M -ne 'demo') { Say 'ใช้ได้แค่ pilot (รถจริง) หรือ demo (รถจำลอง)' Red; return }
  $c = Read-Config
  $c.MODE = $M
  Write-Config $c
  $running = Get-KitProcess 'server' $Node
  if ($running) { Stop-Platform; Start-Platform } else { Say "ตั้งเป็นโหมด $M แล้ว" Green }
}

function Set-Ip([string]$A) {
  if (-not $A) { $A = 'auto' }
  if ($A -ne 'auto' -and $A -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Say 'ใส่ auto หรือที่อยู่ IP เช่น 192.168.1.10' Red; return }
  $c = Read-Config
  $c.IP = $A
  Write-Config $c
  if (Get-KitProcess 'server' $Node) { Stop-Platform; Start-Platform } else { Say "ตั้งที่อยู่เป็น $A แล้ว" Green }
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# One-time preparation of this PC (needs administrator): firewall, no sleep on mains power, the video server.
function Invoke-Setup {
  if (-not (Test-Admin)) {
    Say 'ขอสิทธิ์ผู้ดูแลเครื่อง (กด Yes ในหน้าต่างที่ขึ้นมา)...' Cyan
    Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'setup', 'pause')
    return
  }
  Say 'ตั้งค่า Firewall ให้เครื่องอื่นเข้าถึงระบบ...' Cyan
  Get-NetFirewallRule -DisplayName '13STORE event *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName '13STORE event TCP' -Direction Inbound -Protocol TCP -LocalPort $TcpPorts -Action Allow -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName '13STORE event UDP' -Direction Inbound -Protocol UDP -LocalPort $UdpPorts -Action Allow -Profile Any | Out-Null
  Say ("  เปิดพอร์ต TCP " + ($TcpPorts -join ', ') + " และ UDP " + ($UdpPorts -join ', ')) Gray

  Say 'ตั้งไม่ให้เครื่องหลับตอนเสียบสายชาร์จ...' Cyan
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null

  if (-not (Test-Path $MediaExe)) {
    Say 'ดาวน์โหลดตัวส่งวิดีโอ (MediaMTX 1.9.3 จาก GitHub ประมาณ 15 MB)...' Cyan
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      New-Item -ItemType Directory -Force -Path (Join-Path $Root 'media') | Out-Null
      $zip = Join-Path $Root 'media\mediamtx.zip'
      Invoke-WebRequest -Uri $MediaUrl -OutFile $zip -UseBasicParsing
      Expand-Archive -Path $zip -DestinationPath (Join-Path $Root 'media\unpack') -Force
      Copy-Item (Join-Path $Root 'media\unpack\mediamtx.exe') $MediaExe -Force
      Remove-Item $zip, (Join-Path $Root 'media\unpack') -Recurse -Force
      Say '  ได้ตัวส่งวิดีโอแล้ว' Green
    } catch {
      Say ("  ดาวน์โหลดไม่สำเร็จ: " + $_.Exception.Message + " (ต่ออินเทอร์เน็ตแล้วรัน SETUP.cmd ใหม่)") Red
    }
  }
  Read-Config | Out-Null
  Say 'ตั้งค่าเครื่องเสร็จแล้ว ต่อไปกด START.cmd' Green
}

function Set-Autostart([string]$OnOff) {
  if ($OnOff -eq 'off') {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Say 'ยกเลิกการเปิดเองตอนล็อกอินแล้ว' Green
    return
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" start-quiet"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Description 'Starts the 13STORE platform from the event kit' -Force | Out-Null
  Say 'ตั้งให้ระบบเปิดเองทุกครั้งที่ล็อกอินเครื่องนี้แล้ว' Green
}

function Show-Menu {
  while ($true) {
    Show-Status
    Say ''
    Say ' 1  เปิดระบบ' White
    Say ' 2  ปิดระบบ' White
    Say ' 3  เปิดใหม่ (ปิดแล้วเปิด)' White
    Say ' 4  สลับโหมด รถจริง / รถจำลอง' White
    Say ' 5  นำเข้าข้อมูลจากเครื่อง .13 (ไฟล์ .tgz)' White
    Say ' 6  ตั้งค่าเครื่องครั้งแรก (Firewall, ไม่หลับ, ตัวส่งวิดีโอ)' White
    Say ' 7  ให้เปิดเองตอนล็อกอิน / ยกเลิก' White
    Say ' 0  ออก' White
    $k = Read-Host ' เลือก'
    switch ($k) {
      '1' { Start-Platform }
      '2' { Stop-Platform }
      '3' { Stop-Platform; Start-Platform }
      '4' { $c = Read-Config; if ($c.MODE -eq 'demo') { Set-Mode 'pilot' } else { Set-Mode 'demo' } }
      '5' {
        $f = Read-Host ' ลากไฟล์ .tgz มาวางที่นี่ แล้วกด Enter'
        Import-Data ($f.Trim('"', ' '))
      }
      '6' { Invoke-Setup }
      '7' {
        $a = Read-Host ' พิมพ์ on (เปิดเอง) หรือ off (ยกเลิก)'
        Set-Autostart $a.Trim()
      }
      '0' { return }
      default { }
    }
  }
}

switch ($Command) {
  'start' { Start-Platform }
  'start-quiet' { Start-Platform *> (Join-Path $LogDir 'autostart.log') }
  'stop' { Stop-Platform }
  'restart' { Stop-Platform; Start-Platform }
  'status' { Show-Status }
  'setup' { Invoke-Setup; if ($Arg -eq 'pause') { Read-Host ' กด Enter เพื่อปิดหน้าต่างนี้' | Out-Null } }
  'import' { Import-Data $Arg }
  'mode' { Set-Mode $Arg }
  'ip' { Set-Ip $Arg }
  'autostart' { Set-Autostart $Arg }
  default { Show-Menu }
}
