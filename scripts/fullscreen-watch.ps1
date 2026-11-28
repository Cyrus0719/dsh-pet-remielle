$ErrorActionPreference = 'SilentlyContinue'
$src = @'
using System;
using System.Runtime.InteropServices;
public struct PetRect { public int Left, Top, Right, Bottom; }
public struct PetMon { public int cbSize; public PetRect rcMonitor; public PetRect rcWork; public uint dwFlags; }
public class PetWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out PetRect r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref PetMon info);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $src | Out-Null
[PetWin]::SetProcessDPIAware() | Out-Null
$skip = @('Neutralinojs_webview', 'Progman', 'WorkerW', 'Shell_TrayWnd', 'Windows.UI.Core.CoreWindow')
while ($true) {
  $full = 0
  $h = [PetWin]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 256
    [PetWin]::GetClassName($h, $sb, 256) | Out-Null
    if ($skip -notcontains $sb.ToString()) {
      $r = New-Object PetRect
      if ([PetWin]::GetWindowRect($h, [ref]$r)) {
        $m = [PetWin]::MonitorFromWindow($h, 2)
        $mi = New-Object PetMon
        $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
        if ([PetWin]::GetMonitorInfo($m, [ref]$mi)) {
          $tol = 8
          if (($r.Left -le ($mi.rcMonitor.Left + $tol)) -and ($r.Top -le ($mi.rcMonitor.Top + $tol)) -and
              ($r.Right -ge ($mi.rcMonitor.Right - $tol)) -and ($r.Bottom -ge ($mi.rcMonitor.Bottom - $tol))) { $full = 1 }
        }
      }
    }
  }
  [Console]::Out.WriteLine($full)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1200
}
