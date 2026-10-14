# Bifrost clipboard helper (Windows PowerShell 5.1, text only).
#   stdin  : "S <base64 utf-8>"   put this text on the clipboard
#   stdout : "READY" once started, then "C <base64 utf-8>" whenever the clipboard text changes
#            (changes caused by "S" are not echoed back), and "A ok" / "A fail" after each "S".
# Input is polled with PeekNamedPipe instead of being read asynchronously: in this host a
# pending console read blocks every later write to [Console]::Out. The clipboard is polled
# through GetClipboardSequenceNumber, so an unchanged clipboard costs nothing.
# Text larger than -MaxBytes is never forwarded. Run with -Sta (Forms clipboard).
# ASCII only on purpose (see capture.ps1).
param([int]$MaxBytes = 1048576)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BifrostClip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr left);

  /// Bytes waiting on stdin, or -1 when stdin is closed / not a pipe.
  public static int Pending() {
    uint available;
    if (!PeekNamedPipe(GetStdHandle(-10), IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) return -1;
    return (int)available;
  }
}
'@

$utf8 = New-Object System.Text.UTF8Encoding($false)
$last = [BifrostClip]::GetClipboardSequenceNumber()
$ignore = $null

function Set-ClipboardText([string]$text) {
  for ($i = 0; $i -lt 5; $i++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
      return $true
    } catch {
      Start-Sleep -Milliseconds 60   # another program holds the clipboard right now
    }
  }
  return $false
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $pending = [BifrostClip]::Pending()
  if ($pending -lt 0) { break }        # the agent closed stdin: session over
  if ($pending -gt 0) {
    $line = [Console]::In.ReadLine()   # whole lines are written at once: returns immediately
    if ($line -eq $null) { break }
    if ($line.StartsWith('S ')) {
      try {
        $bytes = [Convert]::FromBase64String($line.Substring(2))
        if ($bytes.Length -le $MaxBytes) {
          $text = $utf8.GetString($bytes)
          if (Set-ClipboardText $text) {
            $ignore = $text
            $last = [BifrostClip]::GetClipboardSequenceNumber()
            [Console]::Out.WriteLine('A ok')
          } else {
            [Console]::Out.WriteLine('A fail')
          }
          [Console]::Out.Flush()
        }
      } catch { }
    }
    continue
  }

  $seq = [BifrostClip]::GetClipboardSequenceNumber()
  if ($seq -ne $last) {
    $last = $seq
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $text = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
        if ($text -ne $ignore -and $text.Length -gt 0) {
          $bytes = $utf8.GetBytes($text)
          if ($bytes.Length -le $MaxBytes) {
            [Console]::Out.WriteLine('C ' + [Convert]::ToBase64String($bytes))
            [Console]::Out.Flush()
          }
        }
        $ignore = $null
      }
    } catch { }
  }
  Start-Sleep -Milliseconds 100
}
