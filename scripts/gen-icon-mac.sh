#!/bin/sh
# Builds the macOS app bundle icon from a single brand source.
#   From the repo root:  sh scripts/gen-icon-mac.sh
#
#   input  resources/icon.png          (256x256 RGBA. Output of gen-icon.ps1's rounded-mask pass)
#   output build/icon.icns             16..1024 multi-resolution (.app bundle icon)
#
# The macOS counterpart to gen-icon.ps1. That one uses System.Drawing and only runs on Windows; this
# one uses sips/iconutil and only runs on macOS. Neither is a CI dependency — the output is committed.
# **Sharing the source is the whole point**: if the two scripts start reading different sources, the
# two platforms' icons will quietly drift apart over time.
#
# **Why this reads icon.png rather than logo-source.png (measured):** logo-source.png is hasAlpha:no,
# and the area **outside** the tile's rounded border is filled with opaque navy (corner pixel
# [15,21,36]). Building an icns from that as-is means the Dock/Finder/Launchpad/app switcher, drawing
# it over an arbitrary background, show dark squares at the four corners — the exact bug commit
# dd6a006 "fix: cut the opaque corners off the app icon" fixed on Windows. macOS doesn't auto-round
# app icons the way iOS does, so it's even more noticeable there. icon.png is gen-icon.ps1's output
# already clipped to the tile's silhouette, so its corners are transparent (corner pixel [0,0,0,0]).
#
# The cost is resolution: icon.png is 256x256, so 512 is a 2x upscale and 1024 is a 4x upscale
# interpolation. Drawing the mask here directly against a 352px source would be sharper, but sips has
# no compositing, and this repo deliberately avoids an ImageMagick dependency (see gen-icon.ps1's
# header). Correct corners matter more than sharpness — upscaling is just a bit blurry, but opaque
# corners are a visible defect. For sharper output, have gen-icon.ps1 also export a 512 or 1024
# mask-applied version and read that here instead.
#
# **The tray icon isn't built here.** macOS menu-bar template images read only alpha and let the
# system tint them, but logo-source.png is hasAlpha:no with the mark sitting on an opaque tile. Fed in
# as a template as-is, it shows a solid rounded square in the menu bar. That needs a mark-only asset
# with a transparent background, which means new artwork (sips has no alpha keying, and this repo
# avoids an ImageMagick dependency). Until then, macOS also uses the existing color resources/tray.png
# — see src/main/index.ts.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/resources/icon.png"
build="$root/build"

[ -f "$src" ] || { echo "Source image not found: $src" >&2; exit 1; }
command -v sips >/dev/null || { echo "sips not found (run this on macOS)" >&2; exit 1; }
command -v iconutil >/dev/null || { echo "iconutil not found (run this on macOS)" >&2; exit 1; }

mkdir -p "$build"

# iconutil only accepts an .iconset directory following a fixed naming convention.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
iconset="$work/icon.iconset"
mkdir -p "$iconset"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  size=${spec%% *}
  name=${spec##* }
  sips -s format png -z "$size" "$size" "$src" --out "$iconset/$name.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$build/icon.icns"
echo "wrote build/icon.icns"
