# dsh-harness-monitor/kill.ps1 v2 - release one dsh harness instance by category.
#
# NOTE: this file is deliberately ASCII-only: Windows PowerShell 5.1 reads .ps1
# without a BOM as ANSI, which would mangle non-ASCII comments on a zh-CN host.
#
# param -Pids   : candidate pids (comma separated integer list).
# param -Kind   : requested category, whitelist background / dev / desktop.
#                 Defaults to background so a v3 caller that only sends -Pids
#                 keeps the old (background-only) contract.
# param -Confirm: explicit confirmation marker. dev / desktop REQUIRE it, and are
#                 refused without it; background is released directly.
# param -Actor  : who triggered the release (host pid@remote address + cwd), log only.
#
# Every pid passes a second identity check: the command line must really be a dsh
# harness (node + dsh/lib/bin.js + --port), and its actual category must equal the
# requested one. Desktop wins over the port test when classifying.
# Every action - released, refused or skipped - is appended to the release log
# with time / pid / category / confirm / actor / result.
param(
  [int[]]$Pids = @(),
  [string]$Kind = 'background',
  [switch]$Confirm,
  [string]$Actor = 'unknown'
)
$ErrorActionPreference = 'SilentlyContinue'

$kindWhitelist = @('background', 'dev', 'desktop')
if ($kindWhitelist -notcontains $Kind) {
  [pscustomobject]@{ killed = @(); skipped = @($Pids); refused = @($Pids); log = '' } |
    ConvertTo-Json -Compress -Depth 3
  exit 0
}

$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$logDir = Join-Path $dshHome 'logs'
$logPath = Join-Path $logDir 'harness-monitor-release.log'

function Write-ReleaseLog([string]$line) {
  try {
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {
    # A failing log must never block the release itself.
  }
}

# Strict harness identity: the node executable directly followed by dsh's
# lib/bin.js (side processes such as dsh-subprocess-local/runner.js do NOT match).
function Get-HarnessCategory([string]$cl) {
  if (-not $cl) { return $null }
  if ($cl -notmatch '(?i)node(\.exe)?["'']?\s+["'']?[^"'']*[\\/]dsh[\\/]lib[\\/]bin\.js') { return $null }
  if ($cl -notmatch '--port') { return $null }
  if ($cl -match 'DSH Desktop') { return 'desktop' }
  $port = '?'
  if ($cl -match '--port[\s"'']*(\d+)') { $port = $Matches[1] }
  if ($port -eq '0') { return 'background' }
  return 'dev'
}

$killed = @()
$skipped = @()
$refused = @()
$confirmFlag = if ($Confirm) { 'yes' } else { 'no' }

foreach ($targetPid in $Pids) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" | Select-Object -First 1
  $category = $null
  if ($p -and $p.CommandLine) { $category = Get-HarnessCategory $p.CommandLine }

  $reason = $null
  if (-not $p) { $reason = 'no-such-process' }
  elseif (-not $category) { $reason = 'not-a-dsh-harness-process' }
  elseif ($category -ne $Kind) { $reason = "category-mismatch(actual=$category)" }
  elseif ($Kind -ne 'background' -and -not $Confirm) { $reason = 'confirm-required' }

  if ($reason) {
    if ($reason -eq 'confirm-required') { $refused += $targetPid } else { $skipped += $targetPid }
    Write-ReleaseLog "$stamp kind=$Kind confirm=$confirmFlag pid=$targetPid result=refused reason=$reason actor=$Actor"
    continue
  }

  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
  # Stop-Process returns before the kernel finishes tearing the process down, so
  # an immediate Get-Process check can still see it and would mis-report a caught
  # release as "still-alive". Poll for exit (max ~2s) before judging.
  $exited = $false
  for ($wait = 0; $wait -lt 20; $wait++) {
    if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { $exited = $true; break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $exited) {
    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
    for ($wait2 = 0; $wait2 -lt 10; $wait2++) {
      if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { $exited = $true; break }
      Start-Sleep -Milliseconds 100
    }
  }
  if ($exited) {
    $killed += $targetPid
    Write-ReleaseLog "$stamp kind=$Kind confirm=$confirmFlag pid=$targetPid result=killed actor=$Actor"
  } else {
    $skipped += $targetPid
    Write-ReleaseLog "$stamp kind=$Kind confirm=$confirmFlag pid=$targetPid result=skipped reason=still-alive actor=$Actor"
  }
}

[pscustomobject]@{
  killed  = @($killed)
  skipped = @($skipped)
  refused = @($refused)
  log     = $logPath
} | ConvertTo-Json -Compress -Depth 3
