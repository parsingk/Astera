# Generates every app icon asset from a single source image.
#   From the repo root:  powershell -File scripts/gen-icon.ps1
#
#   Input   resources/logo-source.png   (square; the brand mark on its dark tile)
#   Outputs build/icon.ico              multi-resolution 16..256, PNG-in-ICO (installer + .exe)
#           build/icon.png              256 (electron-builder's non-Windows targets)
#           resources/icon.png          256 (window / taskbar icon, loaded by src/main/index.ts)
#           resources/tray.png          32  (tray icon, loaded by src/main/index.ts)
#           src/renderer/src/assets/logo.png  256 (in-app logo, imported by App.tsx)
#
# Why two crops instead of plain downscaling:
#   At 16-24px the full tile loses the mark — the rounded border and outer padding eat the pixels
#   the "A" needs, and the orbital ring disappears into mud. Cropping SMALL_INSET_RATIO off every
#   edge first lets the mark fill the frame, which measurably survives the downscale. Large sizes
#   keep the full tile because the border and ring are part of the design and read fine there.
#
# Uses System.Drawing so there is no ImageMagick dependency, which also means this only runs on
# Windows — that is why the generated assets are committed rather than built in CI.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root 'resources/logo-source.png'
$buildDir = Join-Path $root 'build'
$resourcesDir = Join-Path $root 'resources'
$rendererAssets = Join-Path $root 'src/renderer/src/assets'

if (-not (Test-Path $srcPath)) { throw "Source logo not found: $srcPath" }
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory $buildDir | Out-Null }

# Sizes at or below this use the tightened crop; above it, the full tile.
$SMALL_MAX = 32
$SMALL_INSET_RATIO = 0.12

$full = [System.Drawing.Bitmap]::new($srcPath)
if ($full.Width -ne $full.Height) {
  Write-Warning "Source is $($full.Width)x$($full.Height), not square — the output will be distorted."
}
$inset = [int]($full.Width * $SMALL_INSET_RATIO)
$small = $full.Clone(
  [System.Drawing.Rectangle]::new($inset, $inset, $full.Width - 2 * $inset, $full.Height - 2 * $inset),
  $full.PixelFormat)

function Resize-ToPngBytes([System.Drawing.Image]$image, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($image, 0, 0, $size, $size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return , $ms.ToArray()
}

# Picks the crop that survives the target size, then encodes it.
function Png([int]$size) {
  $source = if ($size -le $SMALL_MAX) { $small } else { $full }
  return , (Resize-ToPngBytes $source $size)
}

function Write-Png([string]$path, [int]$size) {
  [System.IO.File]::WriteAllBytes($path, (Png $size))
  Write-Output ("  {0} ({1}px)" -f (Resolve-Path -Relative $path), $size)
}

Write-Output 'Writing PNG assets:'
Write-Png (Join-Path $buildDir 'icon.png') 256
Write-Png (Join-Path $resourcesDir 'icon.png') 256
Write-Png (Join-Path $resourcesDir 'tray.png') 32
Write-Png (Join-Path $rendererAssets 'logo.png') 256

# Multi-resolution .ico (PNG-in-ICO).
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @{}
foreach ($s in $sizes) { $pngs[$s] = Png $s }
$full.Dispose()
$small.Dispose()

$ico = Join-Path $buildDir 'icon.ico'
$fs = [System.IO.File]::Open($ico, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)   # ICONDIR
# base = header(6) + directory entries(16 * count). Accumulated in a loop because the
# multiplication was unreliable across PowerShell versions here.
$offset = 6
foreach ($x in $sizes) { $offset = $offset + 16 }
foreach ($s in $sizes) {
  $data = $pngs[$s]
  $wb = if ($s -ge 256) { 0 } else { $s }   # 256 is encoded as 0 in the ICO directory
  $bw.Write([Byte]$wb); $bw.Write([Byte]$wb); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]([int]$offset))
  $offset = [int]$offset + [int]$data.Length
}
foreach ($s in $sizes) { $bw.Write($pngs[$s]) }
$bw.Flush(); $bw.Close(); $fs.Close()
Write-Output ("Writing build/icon.ico ({0} bytes, sizes {1})" -f (Get-Item $ico).Length, ($sizes -join ','))
