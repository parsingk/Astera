# ADR-001 — Linux support floor is Ubuntu 22.04 / Debian 12

**Status:** accepted, 2026-08-17

## Context

Adding Linux packaging surfaced a failure mode that a green build cannot catch: **the glibc version
of the machine that builds the artifact becomes the artifact's floor.**

`node-pty` ships no Linux prebuild — its `prebuilds/` directory holds `darwin-*` and `win32-*` only —
so on Linux `npm ci` compiles it from source with node-gyp. Built on `ubuntu-latest` (which was
Ubuntu 24.04, glibc 2.39), the resulting `pty.node` demanded `GLIBC_2.34`. On Ubuntu 20.04
(glibc 2.31) the deb installed cleanly and then the app died before any JavaScript ran:

```
Error: Failed to load native module: pty.node, checked: build/Release, build/Debug,
prebuilds/linux-x64: Error: Cannot find module './prebuilds/linux-x64//pty.node'
```

That message is misleading and cost time. node-pty's loader (`lib/utils.js`) tries each candidate
directory, swallows every failure into `lastError`, and reports only the last one — so a module that
was **found but could not be opened** looks exactly like one that was missing. Packaging was fine
the whole time; `ldd` on the unpacked binary is what named the real cause.

Two related gaps came out of the same investigation. electron-builder's default deb `depends` list
omits `libasound2`, which Electron links against, and `libgbm1`; both produced the same shape of
failure — install succeeds, the dynamic linker refuses to start the binary, the launcher shows
nothing, no log is written because no JavaScript runs.

## Decision

The supported floor is **Ubuntu 22.04 / Debian 12**, enforced in two places that must stay in step:

- `.github/workflows/linux-artifacts.yml` pins `runs-on: ubuntu-22.04`. Building on the oldest
  supported distro is what makes the declared floor true rather than accidental.
- `electron-builder.yml` declares `libc6 (>= 2.35)` in `deb.depends`, so apt refuses an unsupported
  system instead of installing something that cannot start.

`deb.depends` also repeats electron-builder's own nine defaults verbatim, because setting `depends`
**replaces** the default list rather than merging with it (`app-builder-lib`'s `targets/FpmTarget.js`
only calls its internal `getDefaultDepends()` when `depends` is unset). Our additions are `libc6`,
`libasound2t64 | libasound2`, and `libgbm1`.

The ALSA entry is an alternative dependency, not a single name, and the order matters: on Ubuntu
24.04 `libasound2` is a virtual package with more than one provider, and apt was observed selecting
`liboss4-salsa-asound2` — an OSS shim that also declares `Provides: libasound2`. `ldd` reports that
as satisfied while audio goes to the wrong backend, so naming the real package first is what makes
the dependency mean what it says.

The artifact workflow installs each build into clean minimal 22.04 and 24.04 containers and asserts
every shipped ELF object resolves its libraries. A clean container is the point: the runner has half
the world installed and would pass while a user's machine does not.

## Consequences

Ubuntu 20.04 and Debian 11 are not supported. Ubuntu 20.04 left standard support in April 2025, and
users on it now get a clear apt refusal rather than an app that installs and never opens.

**The runner pin has an expiry.** GitHub announced (2026-06-16) that Ubuntu 22 images begin
deprecation on **2026-09-17** and are fully unsupported by **2027-04-17**. When that lands, the fix
is to move the floor deliberately — pin the next oldest supported image and raise the `libc6` bound
to match — **not** to switch to `ubuntu-latest`. That would restore exactly the accidental floor this
decision exists to prevent, silently, with the build staying green.

Today's artifact happens to reference no symbol newer than `GLIBC_2.34`, which is below 22.04's
2.35. The pin's value is keeping that true as dependencies change, not lowering today's number.

## Alternatives considered

**Build in an old-glibc container** (Debian 11, glibc 2.31) to keep Ubuntu 20.04 working. Rejected:
it adds a container plus the packaging tools the runner image already provides, to support a distro
that is past end of standard support. The simpler decision is to declare the floor and enforce it.

**Leave `ubuntu-latest` and declare the floor in documentation only.** Rejected: the floor would be
whatever the newest runner image happened to produce, and would move without any build failing.

**A bare `libasound2` dependency.** Rejected after measurement — see the OSS-shim provider above.
