# Bifrost screen capture helper (Windows PowerShell 5.1, no external dependency).
# Writes frames to stdout as: [u32 BE jpeg length][u16 BE width][u16 BE height][jpeg bytes]
# Only the primary monitor is captured. Exits when stdout is closed.
#
# Desktop following: before every frame the thread attaches to the *input* desktop. When the
# agent runs as SYSTEM in the interactive session (Windows service mode) this makes the logon
# screen, the lock screen and UAC prompts (secure desktop) visible. As a normal user the
# secure desktop cannot be opened, the thread simply stays on the user's desktop.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [int]$Fps = 10,
  [int]$Quality = 55,
  [int]$MaxWidth = 1600
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BifrostNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int step, IntPtr bg, int flags);
}
public static class BifrostDesktop {
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr obj, int index, IntPtr info, int length, out int needed);
  static IntPtr attached = IntPtr.Zero;
  static string current = "";
  public static string Current { get { return current; } }

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

  /// Attaches the calling thread to the current input desktop. True when it changed.
  public static bool Sync() {
    // GENERIC_ALL (SYSTEM), then the minimal mask a plain user is allowed on its own desktop.
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

[void][BifrostNative]::SetProcessDPIAware()

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

$script:srcW = 0
$script:srcH = 0
$script:dstW = 0
$script:dstH = 0
$script:srcBmp = $null
$script:srcG = $null
$script:dstBmp = $null
$script:dstG = $null
$script:size = $null

function Release-Surfaces {
  if ($script:srcG -ne $null) { $script:srcG.Dispose() }
  if ($script:srcBmp -ne $null) { $script:srcBmp.Dispose() }
  if ($script:dstG -ne $null) { $script:dstG.Dispose() }
  if ($script:dstBmp -ne $null) { $script:dstBmp.Dispose() }
  $script:srcG = $null; $script:srcBmp = $null; $script:dstG = $null; $script:dstBmp = $null
}

# (Re)creates the capture surfaces for the current primary monitor size.
function New-Surfaces {
  Release-Surfaces
  $script:srcW = [BifrostNative]::GetSystemMetrics(0)
  $script:srcH = [BifrostNative]::GetSystemMetrics(1)
  $script:dstW = $script:srcW
  $script:dstH = $script:srcH
  if ($script:srcW -gt $MaxWidth) {
    $script:dstW = $MaxWidth
    $script:dstH = [int][Math]::Round($script:srcH * $MaxWidth / $script:srcW)
  }
  $script:srcBmp = New-Object System.Drawing.Bitmap($script:srcW, $script:srcH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $script:srcG = [System.Drawing.Graphics]::FromImage($script:srcBmp)
  $script:size = New-Object System.Drawing.Size($script:srcW, $script:srcH)
  if ($script:dstW -ne $script:srcW) {
    $script:dstBmp = New-Object System.Drawing.Bitmap($script:dstW, $script:dstH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $script:dstG = [System.Drawing.Graphics]::FromImage($script:dstBmp)
    $script:dstG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
  }
}

[void][BifrostDesktop]::Sync()
New-Surfaces

$out = [Console]::OpenStandardOutput()
$ms = New-Object System.IO.MemoryStream
$header = New-Object byte[] 8
$interval = [int](1000 / [Math]::Max(1, $Fps))
$sw = New-Object System.Diagnostics.Stopwatch
$ci = New-Object 'BifrostNative+CURSORINFO'

try {
  while ($true) {
    $sw.Restart()

    # Follow the input desktop (logon screen, UAC) and monitor resolution changes.
    [void][BifrostDesktop]::Sync()
    if ([BifrostNative]::GetSystemMetrics(0) -ne $script:srcW -or [BifrostNative]::GetSystemMetrics(1) -ne $script:srcH) {
      New-Surfaces
    }

    try {
      $script:srcG.CopyFromScreen(0, 0, 0, 0, $script:size)
    } catch {
      # Desktop switch in progress or not accessible right now: try again shortly.
      Start-Sleep -Milliseconds 150
      continue
    }

    # Draw the mouse pointer (CopyFromScreen does not include it).
    try {
      $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
      if ([BifrostNative]::GetCursorInfo([ref]$ci) -and (($ci.flags -band 1) -ne 0)) {
        $hdc = $script:srcG.GetHdc()
        try { [void][BifrostNative]::DrawIconEx($hdc, $ci.ptScreenPos.x, $ci.ptScreenPos.y, $ci.hCursor, 0, 0, 0, [IntPtr]::Zero, 3) }
        finally { $script:srcG.ReleaseHdc($hdc) }
      }
    } catch { }

    $img = $script:srcBmp
    if ($script:dstBmp -ne $null) {
      $script:dstG.DrawImage($script:srcBmp, 0, 0, $script:dstW, $script:dstH)
      $img = $script:dstBmp
    }

    $ms.SetLength(0)
    $img.Save($ms, $codec, $encParams)
    $len = [int]$ms.Length
    $dw = $script:dstW
    $dh = $script:dstH
    $header[0] = ($len -shr 24) -band 255
    $header[1] = ($len -shr 16) -band 255
    $header[2] = ($len -shr 8) -band 255
    $header[3] = $len -band 255
    $header[4] = ($dw -shr 8) -band 255
    $header[5] = $dw -band 255
    $header[6] = ($dh -shr 8) -band 255
    $header[7] = $dh -band 255
    $out.Write($header, 0, 8)
    $out.Write($ms.GetBuffer(), 0, $len)
    $out.Flush()

    $left = $interval - [int]$sw.ElapsedMilliseconds
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
  }
} catch [System.IO.IOException] {
  # stdout closed: the agent ended the session.
} finally {
  Release-Surfaces
}
