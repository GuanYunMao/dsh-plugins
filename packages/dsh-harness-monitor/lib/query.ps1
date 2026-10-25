# dsh-harness-monitor/query.ps1 v2 - list all dsh harness node processes, identified.
# Output: JSON array [{pid, kind, started, uptimeSec, portArg, portActual, profile,
#                       cwd, workspace, argv, childCount, childNames, active}]
# kind: "background" = Cherry codemate spawn (--port 0, the lock holders, safe to kill)
#       "desktop"    = DSH Desktop runtime (protected)
#       "dev"        = fixed-port instance, e.g. dev profile (protected)
# Identity key = cwd (the harness process working directory): Cherry launches each
# codemate harness inside its workspace, so the cwd leaf names the project it serves.
$ErrorActionPreference = 'SilentlyContinue'

# --- P/Invoke: read another process' current working directory (x64) ---
$src = @'
using System;
using System.Runtime.InteropServices;
public static class ProcCwd {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int pic, ref PROCESS_BASIC_INFORMATION pbi, int cb, out int pSize);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  public static string GetCwd(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
      int sz;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out sz) != 0) return "";
      byte[] buf = new byte[16]; IntPtr read;
      if (!ReadProcessMemory(h, (IntPtr)((long)pbi.PebBaseAddress + 0x20), buf, 8, out read)) return "";
      IntPtr paramsAddr = (IntPtr)BitConverter.ToInt64(buf, 0);
      // RTL_USER_PROCESS_PARAMETERS x64: CurrentDirectory.DosPath (UNICODE_STRING) at +0x38
      if (!ReadProcessMemory(h, (IntPtr)((long)paramsAddr + 0x38), buf, 16, out read)) return "";
      ushort len = BitConverter.ToUInt16(buf, 0);
      if (len == 0 || len > 1024) return "";
      IntPtr strAddr = (IntPtr)BitConverter.ToInt64(buf, 8);
      byte[] strBuf = new byte[len];
      if (!ReadProcessMemory(h, strAddr, strBuf, len, out read)) return "";
      return System.Text.Encoding.Unicode.GetString(strBuf);
    } catch { return ""; }
    finally { CloseHandle(h); }
  }
}
'@
try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { }

function Get-Leaf([string]$p) {
  if (-not $p) { return '' }
  $t = $p.TrimEnd('\', '/')
  if (-not $t) { return '' }
  $parts = $t -split '[\\/]'
  return $parts[$parts.Length - 1]
}

$now = Get-Date
$out = @()
$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
$listen = @{}
try {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not $listen.ContainsKey([int]$_.OwningProcess)) { $listen[[int]$_.OwningProcess] = @() }
    $listen[[int]$_.OwningProcess] += [int]$_.LocalPort
  }
} catch { }
$children = @{}
try {
  Get-CimInstance Win32_Process -Filter "name='node.exe' OR name='powershell.exe' OR name='pwsh.exe' OR name='cmd.exe' OR name='git.exe' OR name='cargo.exe' OR name='rustc.exe' OR name='python.exe' OR name='conhost.exe'" |
    ForEach-Object {
      $pp = [int]$_.ParentProcessId
      if (-not $children.ContainsKey($pp)) { $children[$pp] = New-Object System.Collections.Generic.List[string] }
      $children[$pp].Add($_.Name)
    }
} catch { }

foreach ($p in $procs) {
  $cl = $p.CommandLine
  if (-not $cl) { continue }
  if ($cl -notmatch 'dsh.*lib[\\/]bin\.js') { continue }
  if ($cl -notmatch '--port') { continue }

  $hpid = [int]$p.ProcessId
  $portArg = '?'
  if ($cl -match '--port[\s"'']*(\d+)') { $portArg = $Matches[1] }
  $kind = 'dev'
  if ($cl -match 'DSH Desktop') { $kind = 'desktop' }
  elseif ($portArg -eq '0') { $kind = 'background' }

  $profile = 'web'
  if ($cl -match '--profile[\s"'']+([a-z0-9_-]+)') { $profile = $Matches[1] }

  $cwd = ''
  try { if ('ProcCwd' -as [type]) { $cwd = [ProcCwd]::GetCwd($hpid) } } catch { }
  $ports = @(0)
  if ($listen.ContainsKey($hpid)) { $ports = @($listen[$hpid] | Sort-Object) }

  $kids = @()
  if ($children.ContainsKey($hpid)) { $kids = @($children[$hpid] | Select-Object -Unique) }
  # 活动信号：存在 node.exe 之外的子进程（工具子任务：powershell/git/cargo/python…）
  $toolKids = @($kids | Where-Object { $_ -ne 'node.exe' -and $_ -ne 'conhost.exe' })

  $started = $p.CreationDate
  $uptime = 0
  try { $uptime = [int](($now - $started).TotalSeconds) } catch { }

  $argvShort = $cl
  if ($argvShort.Length -gt 220) { $argvShort = $argvShort.Substring(0, 220) + '…' }
# 脱敏：命令行常带 token / key，面板会把它塞进 tooltip，别让凭据进浏览器 DOM。
$argvShort = [regex]::Replace($argvShort, '(?i)(--?(?:token|api[-_]?key|secret|password|passwd|auth|bearer)[= ]+)\S+', '$1***')
$argvShort = [regex]::Replace($argvShort, '(?i)\bsk-[A-Za-z0-9_\-]{8,}', 'sk-***')
$argvShort = [regex]::Replace($argvShort, '(?i)(Bearer\s+)\S+', '$1***')

  $out += [pscustomobject]@{
    pid        = $hpid
    kind       = $kind
    started    = $started.ToString('yyyy-MM-dd HH:mm:ss')
    uptimeSec  = $uptime
    portArg    = $portArg
    portActual = if ($ports.Count -gt 0) { $ports[0] } else { 0 }
    profile    = $profile
    cwd        = $cwd
    workspace  = Get-Leaf $cwd
    argv       = $argvShort
    childCount = $kids.Count
    childNames = ($kids -join ',')
    active     = ($toolKids.Count -gt 0)
  }
}
# PS 5.1 里空数组经管道进 ConvertTo-Json 不输出任何字符 → 调用方 JSON.parse 抛错，
# "没有进程"和"权限不足"就变成同一个 500。用 -InputObject 让它显式输出 []。
ConvertTo-Json -InputObject @($out | Sort-Object -Property kind, pid) -Compress -Depth 3
