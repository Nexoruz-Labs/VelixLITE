$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'assets\icon.png'
$dst = Join-Path $root 'assets\icon.ico'

$orig = [System.Drawing.Bitmap]::FromFile($src)
$w = $orig.Width
$h = $orig.Height

$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    if ($orig.GetPixel($x, $y).A -gt 10) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0) { throw 'No opaque pixels found in icon' }

$glyphW = $maxX - $minX + 1
$glyphH = $maxY - $minY + 1

$cropRect = New-Object System.Drawing.Rectangle($minX, $minY, $glyphW, $glyphH)
$cropped = New-Object System.Drawing.Bitmap($glyphW, $glyphH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g1 = [System.Drawing.Graphics]::FromImage($cropped)
$g1.DrawImage($orig, 0, 0, $cropRect, [System.Drawing.GraphicsUnit]::Pixel)
$g1.Dispose()

$canvas = 1024
$target = [int]($canvas * 0.88)
$scale = $target / [math]::Max($glyphW, $glyphH)
$drawW = [int]($glyphW * $scale)
$drawH = [int]($glyphH * $scale)
$px = [int](($canvas - $drawW) / 2)
$py = [int](($canvas - $drawH) / 2)

$filled = New-Object System.Drawing.Bitmap($canvas, $canvas, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($filled)
$g2.Clear([System.Drawing.Color]::Transparent)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.DrawImage($cropped, $px, $py, $drawW, $drawH)
$g2.Dispose()

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g3 = [System.Drawing.Graphics]::FromImage($bmp)
  $g3.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g3.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g3.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g3.DrawImage($filled, 0, 0, $s, $s)
  $g3.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $images += @{ Size = $s; Data = $ms.ToArray() }
  $ms.Dispose()
  $bmp.Dispose()
}

$fs = [System.IO.File]::Create($dst)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$images.Count)
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
  $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
  $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
  $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$img.Data.Length); $bw.Write([UInt32]$offset)
  $offset += $img.Data.Length
}
foreach ($img in $images) { $bw.Write($img.Data) }
$bw.Flush()
$bw.Close()
$fs.Close()

$cropped.Dispose()
$filled.Dispose()
$orig.Dispose()

Write-Output "Regenerated $dst ($((Get-Item $dst).Length) bytes) - glyph fill $([math]::Round(100 * $drawW / $canvas, 1))% x $([math]::Round(100 * $drawH / $canvas, 1))%"
