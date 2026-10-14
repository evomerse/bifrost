# Bifrost input injection helper (Windows PowerShell 5.1, SendInput via P/Invoke).
# Reads one command per line on stdin:
#   r <x> <y> <w> <h>  the monitor the pointer maps onto, in virtual-desktop pixels
#                      (default: the primary monitor)
#   m <nx> <ny>        move pointer, normalized 0..1 over that monitor
#   b <l|r|m> <d|u>    mouse button down/up
#   w <dy>             vertical wheel, 120 = one notch (positive = up)
#   h <dx>             horizontal wheel
#   k <scan> <0|1> <d|u>   key by scancode, extended flag, down/up
#   u <codepoint>      type one UTF-16 code unit
# With -DryRun nothing is injected: each command is echoed as "DRY <command>".
# ASCII only on purpose (see capture.ps1).
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BifrostInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);

  public static void Mouse(uint flags, uint data) {
    INPUT[] i = new INPUT[1];
    i[0].type = 0;
    i[0].u.mi.dwFlags = flags;
    i[0].u.mi.mouseData = data;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Key(ushort scan, bool ext, bool down) {
    INPUT[] i = new INPUT[1];
    i[0].type = 1;
    i[0].u.ki.wScan = scan;
    uint f = 0x0008; // KEYEVENTF_SCANCODE
    if (ext) f |= 0x0001;
    if (!down) f |= 0x0002;
    i[0].u.ki.dwFlags = f;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Unicode(ushort ch) {
    INPUT[] i = new INPUT[2];
    i[0].type = 1; i[0].u.ki.wScan = ch; i[0].u.ki.dwFlags = 0x0004;
    i[1].type = 1; i[1].u.ki.wScan = ch; i[1].u.ki.dwFlags = 0x0004 | 0x0002;
    SendInput(2, i, Marshal.SizeOf(typeof(INPUT)));
  }
}
public static class BifrostDesktop {
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr obj, int index, IntPtr info, int length, out int needed);
  static IntPtr attached = IntPtr.Zero;
  static string current = "";

  static string NameOf(IntPtr desktop) {
    int needed;
    GetUserObjectInformationW(desktop, 2 /* UOI_NAME */, IntPtr.Zero, 0, out needed);
    if (needed <= 0) return "";
    IntPtr buf = Marshal.AllocHGlobal(needed);
    try {
      if (!GetUserObjectInformationW(desktop, 2, buf, needed, out needed)) return "";
      return Marshal.PtrToStringUni(buf);
    } finally { Marshal.FreeHGlobal(buf); }
  }

  // Input must be injected on the desktop that currently receives input (logon screen, UAC...).
  public static bool Sync() {
    IntPtr h = OpenInputDesktop(0, false, 0x10000000);
    if (h == IntPtr.Zero) h = OpenInputDesktop(0, false, 0x000001FF | 0x40000000);
    if (h == IntPtr.Zero) return false;
    string name = NameOf(h);
    if (name == current) { CloseDesktop(h); return false; }
    if (SetThreadDesktop(h)) {
      IntPtr old = attached;
      attached = h;
      current = name;
      if (old != IntPtr.Zero) CloseDesktop(old);
      return true;
    }
    CloseDesktop(h);
    return false;
  }
}
'@

[void][BifrostInput]::SetProcessDPIAware()
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$lastSync = New-Object System.Diagnostics.Stopwatch
$lastSync.Start()
if (-not $DryRun) { [void][BifrostDesktop]::Sync() }

function Parse-Double([string]$s) { return [double]::Parse($s, $inv) }

# Target monitor in virtual-desktop pixels; $null = the primary monitor at (0,0).
$script:rect = $null

# Pixel position of a normalized point on the target monitor.
function Get-Target([double]$nx, [double]$ny) {
  if ($script:rect -ne $null) {
    $x = $script:rect[0]; $y = $script:rect[1]; $w = $script:rect[2]; $h = $script:rect[3]
  } else {
    $x = 0; $y = 0
    $w = [BifrostInput]::GetSystemMetrics(0)
    $h = [BifrostInput]::GetSystemMetrics(1)
  }
  return @(($x + [int][Math]::Round($nx * ($w - 1))), ($y + [int][Math]::Round($ny * ($h - 1))))
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    if ($DryRun) {
      # Same bookkeeping as for real, so that the mapping can be verified without moving anything.
      if ($p[0] -eq 'r' -and $p.Length -ge 5) {
        $script:rect = @([int]$p[1], [int]$p[2], [Math]::Max(1, [int]$p[3]), [Math]::Max(1, [int]$p[4]))
      }
      [Console]::Out.WriteLine("DRY $line")
      if ($p[0] -eq 'm' -and $p.Length -ge 3) {
        $nx = [Math]::Min(1.0, [Math]::Max(0.0, (Parse-Double $p[1])))
        $ny = [Math]::Min(1.0, [Math]::Max(0.0, (Parse-Double $p[2])))
        $t = Get-Target $nx $ny
        [Console]::Out.WriteLine("AT $($t[0]) $($t[1])")
      }
      [Console]::Out.Flush()
      continue
    }
    # Re-attach to the input desktop at most every 200 ms (cheap enough, fast enough for UAC).
    if ($lastSync.ElapsedMilliseconds -gt 200) {
      [void][BifrostDesktop]::Sync()
      $lastSync.Restart()
    }
    switch ($p[0]) {
      'r' {
        $script:rect = @([int]$p[1], [int]$p[2], [Math]::Max(1, [int]$p[3]), [Math]::Max(1, [int]$p[4]))
      }
      'm' {
        $nx = [Math]::Min(1.0, [Math]::Max(0.0, (Parse-Double $p[1])))
        $ny = [Math]::Min(1.0, [Math]::Max(0.0, (Parse-Double $p[2])))
        $t = Get-Target $nx $ny
        [void][BifrostInput]::SetCursorPos($t[0], $t[1])
      }
      'b' {
        $down = ($p[2] -eq 'd')
        $flag = 0
        switch ($p[1]) {
          'l' { $flag = if ($down) { 0x0002 } else { 0x0004 } }
          'r' { $flag = if ($down) { 0x0008 } else { 0x0010 } }
          'm' { $flag = if ($down) { 0x0020 } else { 0x0040 } }
        }
        if ($flag -ne 0) { [BifrostInput]::Mouse([uint32]$flag, 0) }
      }
      'w' { [BifrostInput]::Mouse(0x0800, [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$p[1]), 0)) }
      'h' { [BifrostInput]::Mouse(0x1000, [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$p[1]), 0)) }
      'k' { [BifrostInput]::Key([uint16][int]$p[1], ($p[2] -eq '1'), ($p[3] -eq 'd')) }
      'u' { [BifrostInput]::Unicode([uint16][int]$p[1]) }
    }
  } catch { }
}
