// Which Ozone platform Electron runs on, on Linux. Electron picks x11 by itself, and under WSLg that
// is what makes the app unusable. XWayland advertises no display DPI (xrdb -query comes back empty),
// so Chromium computes deviceScaleFactor 1 while the Windows host runs at 150%. Measured on Ubuntu
// 22.04 under WSLg: Chromium's X surface came up 3840x2088 while the Windows-side WSLg window was
// 2560x1392 — exactly 1.5x on both axes. Capturing the X window shows the app drawing correctly
// *inside* its own surface (title bar spanning the full width, controls in the corner, status bar
// along the bottom), so no part of the layout is at fault: the surface and the window it is presented
// in simply disagree. What a person sees is a window hanging off the right edge of the screen and
// clicks landing away from the thing they are drawn on.
//
// Running on Wayland instead removes both symptoms (confirmed by hand under WSLg). What does not work:
//
//   - `--ozone-platform-hint=auto`, `--ozone-platform-hint=wayland` and
//     `ELECTRON_OZONE_PLATFORM_HINT=wayland` all leave the renderer on `--ozone-platform=x11` in this
//     build — checked by reading the renderer's own command line. Only the explicit
//     `--ozone-platform=wayland` switches, which is why this decision is made here in code instead of
//     being handed to Electron's own detection.
//   - `--force-device-scale-factor=1.5` on top of Wayland, to also fix the too-small UI: it breaks the
//     window geometry instead (the window comes up tiny). The UI being 1.5x smaller than the Windows
//     build under WSLg is left unfixed on purpose — WSLg tells the client no scale, and nothing in the
//     environment exposes the host's factor (only XDG_RUNTIME_DIR and PULSE_SERVER point at WSLg at
//     all), so there is no value for the app to apply. It is still strictly better than x11, where the
//     same UI is laid out across 3840px instead of 2560px.
//   - three further dead ends predate this file and are recorded with the window options in index.ts:
//     frame:false, leaving titleBarStyle unset on Linux, and `--force-device-scale-factor=1`.
//
// Deliberately confined to WSLg rather than "any Linux Wayland session": there was no real Linux
// desktop available to test on, and forcing the platform carries no fallback of its own. A real X11
// session has no WAYLAND_DISPLAY and is unaffected either way, so the only population this could newly
// break is real Wayland desktops — precisely the ones that could not be tested. Widen the condition
// once one is available. See knowledge/decisions/ADR-002-wslg-ozone-platform.md.

/** WSLg's mount point. Its presence is what identifies WSLg: WSL_DISTRO_NAME and the other WSL
 *  variables are set for shells, and the app is normally started from the WSLg launcher, where they
 *  may be absent. */
export const WSLG_MARKER = '/mnt/wslg'

/** Whether to append `--ozone-platform=wayland` before the app starts.
 *
 *  `exists` is a seam so the marker path is covered by the test rather than read at the call site —
 *  the same shape as makeDescriptors' keychainHas (core/providers/descriptor.ts). */
export function shouldForceWaylandOzone(
  platform: NodeJS.Platform,
  waylandDisplay: string | undefined,
  exists: (path: string) => boolean
): boolean {
  if (platform !== 'linux') return false
  // No Wayland session to switch to, and the switch brings no fallback — forcing it here would risk
  // an app that cannot open at all, which is worse than the misalignment it is meant to fix.
  if (!waylandDisplay) return false
  return exists(WSLG_MARKER)
}
