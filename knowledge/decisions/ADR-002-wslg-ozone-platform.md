# ADR-002 — WSLg runs on the Wayland Ozone platform, and only WSLg

**Status:** accepted, 2026-08-18

## Context

On Linux the app came up with two symptoms that made it effectively unusable: the window hung off the
right edge of the screen, and clicks registered away from what they were drawn on — you had to click
outside a button to press it. Both cleared up when the window was small and returned on maximize.

Three window configurations had already been tried against this and changed neither symptom
(`frame: false`, leaving `titleBarStyle` unset on Linux, `--force-device-scale-factor=1`). That
consistency was the useful signal: the window options were not where the problem lived.

Measuring the layers instead named it. Under WSLg on Ubuntu 22.04, with the Windows host at 150%
display scaling:

| Layer | Size |
|---|---|
| Chromium's X surface (`xwininfo`) | 3840 x 2088 |
| The Windows-side WSLg window (`GetWindowRect`) | 2560 x 1392 |

Exactly 1.5x on both axes. `xrdb -query` returns nothing, so XWayland advertises no display DPI and
Chromium has nothing from which to derive the host's factor — it computes `deviceScaleFactor` 1.
Capturing the X window shows the app drawing correctly *inside* its own surface: title bar spanning
the full width, controls in the corner, status bar along the bottom. Nothing about the layout is
wrong. The surface and the window it is presented in disagree, and every symptom follows from that.

Electron selects `--ozone-platform=x11` on its own; the app sets no Ozone flag. Running on Wayland
instead removes both symptoms, confirmed by hand under WSLg.

## Decision

On Linux, append `--ozone-platform=wayland` **when WSLg is detected and `WAYLAND_DISPLAY` is set** —
`shouldForceWaylandOzone` in `src/main/ozone.ts`, called before the app starts because a command-line
switch has to be appended that early.

Two parts of that condition are deliberate.

**The switch is explicit, not a hint.** `--ozone-platform-hint=auto`,
`--ozone-platform-hint=wayland` and `ELECTRON_OZONE_PLATFORM_HINT=wayland` all leave the renderer on
`--ozone-platform=x11` in this build — verified by reading the renderer process's own command line, not
inferred. Electron's own detection cannot be relied on here; `XDG_SESSION_TYPE` is empty under WSLg,
which is likely why `auto` declines. Only the explicit platform switch takes effect.

**It is scoped to WSLg, not to any Linux Wayland session.** There was no real Linux desktop available
to test on, and forcing the platform brings no fallback of its own. A real X11 session has no
`WAYLAND_DISPLAY` and is unaffected either way, so the only population a broader condition could newly
break is real Wayland desktops — exactly the ones that could not be tested. WSLg is identified by the
presence of `/mnt/wslg` rather than `WSL_DISTRO_NAME`: those variables are set for shells, and the app
is normally started from the WSLg launcher, where they may be absent.

## Consequences

The two reported symptoms are gone under WSLg. Nothing changes for Windows, macOS, or any Linux
session without `WAYLAND_DISPLAY`.

**The UI stays 1.5x smaller than the Windows build under WSLg, and that is not fixed.** It is the other
half of the same missing scale factor. WSLg tells the client no scale, and nothing in the environment
exposes the host's — only `XDG_RUNTIME_DIR` and `PULSE_SERVER` point at WSLg at all. Adding
`--force-device-scale-factor=1.5` on top of Wayland does fix the size in principle but breaks the
window geometry outright (the window comes up tiny), so it is not a usable lever, and 1.5 is this
host's number rather than a constant the app could ship. The app has no UI zoom control to fall back
on. Wayland is still strictly better than the status quo: the same UI was previously laid out across
3840px instead of 2560px.

**The decision is verified in one environment only.** Whether a real Linux desktop shows any of this is
unknown — on a real Wayland session the compositor does advertise a scale, so the small-UI half likely
does not occur there, but that is reasoning, not measurement. When a real Linux desktop becomes
available, the questions to settle are whether the symptoms reproduce on XWayland there at all, and
whether the condition should widen from WSLg to any Wayland session.

## Alternatives considered

**Ship nothing and document the workaround** (tell WSLg users to launch with
`--ozone-platform=wayland`). Rejected: it leaves the default launch broken for the one Linux
environment that was actually measured, and the flag is not something a user would discover.

**Apply the switch to every Linux Wayland session.** Rejected on testability, not on merit — it may
well be the right end state, and the condition is written in one function so widening it is a one-line
change once there is a real Wayland desktop to verify against.

**Set `Xft.dpi` so XWayland reports a DPI and Chromium derives 1.5 on x11.** Rejected: that is a change
to the user's X resources, not to this app, and an app writing global X settings to work around its own
host is the wrong boundary.
