# Creates the "NestForge Pro" desktop shortcut (and a Start Menu entry).
#
#   Right-click this file > Run with PowerShell
#   or:  powershell -ExecutionPolicy Bypass -File desktop\make-shortcut.ps1
#
# The app is dist\nestforge-pro.html, one self-contained file that needs no
# network. The shortcut opens it in Microsoft Edge's app mode: its own window,
# no tabs or address bar, its own icon in the taskbar. Edge is on every
# Windows 10/11 machine, so nothing is installed. The browser profile the app
# uses (its settings, saved preferences) lives in desktop\profile next to the
# app, separate from your normal Edge.
#
# Re-run this if you move the folder; the shortcut stores absolute paths.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$app  = Join-Path $root 'dist\nestforge-pro.html'
$ico  = Join-Path $here 'NestForge Pro.ico'
$prof = Join-Path $here 'profile'

if (-not (Test-Path $app)) { Write-Host "Not found: $app  (run: node build.js)" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ico)) { Write-Host "Not found: $ico  (run: py -3.11 desktop\make-icon.py)" -ForegroundColor Red; exit 1 }

$edge = @(
  "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Host "Microsoft Edge not found." -ForegroundColor Red; exit 1 }

$url = 'file:///' + ($app -replace '\\', '/')
$edgeArgs = @(
  "--app=`"$url`"",
  "--user-data-dir=`"$prof`"",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=msImplicitSignin,msEdgeIdentityFRE',
  '--restore-last-session=false',
  '--disable-session-crashed-bubble',
  '--start-maximized',
  # Keep full speed when the window is covered or behind another app. Chromium
  # otherwise throttles a hidden window's timers and lowers its priority; a
  # 0.5 s nest measured 337 s that way.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows'
) -join ' '

$ws = New-Object -ComObject WScript.Shell
function Make-Link([string]$path) {
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath       = $edge
  $lnk.Arguments        = $edgeArgs
  $lnk.WorkingDirectory = $here
  $lnk.IconLocation     = "$ico,0"
  $lnk.Description      = 'NestForge Pro - DXF nesting for leather and sheet cutting'
  $lnk.Save()
  Write-Host "created  $path" -ForegroundColor Green
}

Make-Link (Join-Path ([Environment]::GetFolderPath('Desktop'))  'NestForge Pro.lnk')
Make-Link (Join-Path ([Environment]::GetFolderPath('Programs')) 'NestForge Pro.lnk')

Write-Host ""
Write-Host "Double-click 'NestForge Pro' on the desktop. To keep it on the taskbar, right-click its taskbar icon while it is open and choose 'Pin to taskbar'." -ForegroundColor Cyan
