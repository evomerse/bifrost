# Builds the application icons from the official logo:
#   icon.png (256), tray.png (32) and icon.ico (16..256)
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File desktop\assets\make-icons.ps1
#
# The logo is a wide picture (mark + wordmark on a dark blue background). Icons are square, so
# the mark alone is cropped out and centred on a rounded square of the logo's own background
# colour. Small sizes (16..48 px) use the arch alone, which stays readable where the full
# mark with its two end nodes would turn into a smear.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [string]$Source = (Join-Path $PSScriptRoot 'logo-source.jpg'),
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Pixel boxes of the logo picture (2752 x 1536), measured on the file: x0, y0, x1, y1.
$FullMark = @(990, 505, 1762, 770)   # arch + both end nodes
$ArchMark = @(1150, 505, 1600, 770)  # arch and B only
$Background = [System.Drawing.Color]::FromArgb(255, 25, 30, 42)

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Source))

function Render([int]$size, $box, [double]$fill) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # rounded square, corner radius 20 % of the side
  $r = [Math]::Max(2.0, $size * 0.2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush($Background)), $path)

  # the mark, centred, as wide as $fill of the icon
  $sw = $box[2] - $box[0]
  $sh = $box[3] - $box[1]
  $dw = $size * $fill
  $dh = $dw * $sh / $sw
  if ($dh -gt $size * $fill) { $dh = $size * $fill; $dw = $dh * $sw / $sh }
  $dest = New-Object System.Drawing.RectangleF((($size - $dw) / 2), (($size - $dh) / 2), $dw, $dh)
  $g.SetClip($path)
  $g.DrawImage($src, $dest, (New-Object System.Drawing.RectangleF($box[0], $box[1], $sw, $sh)), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  return $bmp
}

function Png-Bytes($bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return , $ms.ToArray()
}

$sizes = 16, 32, 48, 64, 128, 256
$images = @()
foreach ($s in $sizes) {
  if ($s -le 48) { $bmp = Render $s $ArchMark 0.78 } else { $bmp = Render $s $FullMark 0.86 }
  $images += , @($s, (Png-Bytes $bmp))
  if ($s -eq 256) { [System.IO.File]::WriteAllBytes((Join-Path $OutDir 'icon.png'), (Png-Bytes $bmp)) }
  if ($s -eq 32) { [System.IO.File]::WriteAllBytes((Join-Path $OutDir 'tray.png'), (Png-Bytes $bmp)) }
  $bmp.Dispose()
}
$src.Dispose()

# ICO container with PNG-compressed images (Windows Vista and later)
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($ms)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($i in $images) {
  $s = $i[0]; $data = $i[1]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$data.Length); $w.Write([uint32]$offset)
  $offset += $data.Length
}
foreach ($i in $images) { $w.Write($i[1]) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $OutDir 'icon.ico'), $ms.ToArray())
"icons written to $OutDir"
