# Agent workspace isolation — design brief

Status: **scope decided, mechanism measured, design not written yet.** This is the brief a next
session starts from: the problem, what was measured, the candidate shapes, and what is still open.

Written 2026-09-08 after the explorer clipboard work (develop `5ac2116`) forced the question, and
updated the same day with the scope decisions and a spike that measured an isolated desktop
directly.

## The problem

When an agent verifies GUI work it has to drive real windows, and today those windows are the
person's own screen. During one verification session on 2026-09-08 the agent:

- launched a second dev app window and raised it to the top of the person's desktop,
- opened Explorer windows, moved them and made them topmost,
- moved the mouse pointer and pressed and dragged with it,
- pressed a real Ctrl+V,
- overwrote whatever the person had on the clipboard.

Each of those is necessary to prove that an OS integration works. All of them are unacceptable while
someone is sitting at the machine, and they happen every time an agent has to launch an app, open a
file manager window and drag something in the space the person is working in.

The comparison they drew is the agent browser: rather than driving the person's browser, the app
gives the agent a surface of its own that it drives programmatically. The question is whether the
same can be done for "a running app plus the OS around it".

## What was measured (2026-09-08, Windows 11, Electron 41)

These constrain every design below. They were measured, not read.

- **A second app instance is already isolated.** `--user-data-dir=<tmp>` makes
  `requestSingleInstanceLock` take a different lock, so an agent's instance runs beside the person's
  without either noticing, and neither has to be closed first.
- **Most driving does not need the screen at all.** The context-menu paste verification passed with
  the app window behind other windows and `document.hasFocus() === false`, driven only by CDP
  `Runtime.evaluate` and DOM clicks. Screenshots come from `Page.captureScreenshot`, which does not
  need a visible window.
- **Only OS-level integration needed real input.** Of the whole session, exactly two steps did:
  Ctrl+V arriving as a real paste event, and a drag that Explorer would accept. CDP
  `Input.dispatchKeyEvent` takes a `commands: ['paste']` array which is likely to cover the first;
  it was not tried.
- **A background process cannot take the foreground.** `SetForegroundWindow` from a background
  process is refused; a synthetic *click* grants foreground rights. So any design that uses real
  input on the shared desktop necessarily steals focus.
- **Windows: a desktop object isolates windows and input; it does not isolate the clipboard.**
  Windows created on another desktop (`CreateDesktop`, `STARTUPINFO.lpDesktop` — the mechanism
  Sysinternals Desktops uses) are invisible on the person's desktop, and `SendInput` from a process
  attached to it lands only there. The clipboard belongs to the *window station* above it, and every
  desktop in `WinSta0` shares one. A separate window station would isolate the clipboard but
  interactive GUI apps generally do not run on one.
- Full clipboard isolation therefore means a second logon session or a VM.

## What the agent browser already does

`src/main/agentBrowser/`, `src/core/agentBrowser/`, `src/renderer/src/components/BrowserPane.tsx`.
The pattern worth copying: the agent gets a surface the app owns, a small scripted API instead of
raw input, a visible marker while it is driving (the violet frame and pointer), and an Escape that
gives control back. The isolation there is not an OS mechanism — it is that the agent never touches
the person's browser, only the app's own view.

## Candidate shapes

**A. Procedure only (no product change).** Codify: always `--user-data-dir`, always `show: false` or
off-screen, drive with CDP, never touch the real pointer. Costs nothing, ships today, and covers
everything except OS integration. Does not help agents working in the person's own projects.

**B. An agent verification instance inside astera.** The app launches the project's app for the
agent — hidden window, own profile, debug port — and exposes it through a scripted API the way the
agent browser exposes a page. The agent asks for clicks and screenshots; it never gets the mouse.
This is the direct analogue of the agent browser, and the `run` skill already knows how to start a
project's app, so the launch half exists in some form.

**C. A separate Windows desktop for agent GUI work.** The app creates a desktop object and launches
the agent's app (and any helper like `explorer.exe`) on it. Real input works there and lands nowhere
else. This is the only shape that covers drag-and-drop and other real-input integrations without
touching the person's screen. Windows-only, needs native calls (`CreateDesktop`,
`CreateProcess` with `lpDesktop`, and a capture path for that desktop), and still shares the
clipboard.

B and C compose: B for everyday UI verification, C only for the integrations that need real input.

## What the isolated-desktop spike measured (2026-09-08, Windows 11, Electron 41)

A throwaway spike created a desktop with `CreateDesktop`, launched apps on it through
`STARTUPINFO.lpDesktop`, and drove them from outside. The desktop was never switched to, so the
person kept their screen the whole time: their foreground window was unchanged after every probe,
and no window from that desktop ever appeared on theirs.

**Works on a desktop nobody is looking at**

- **Launching anything there.** An Electron app and `explorer.exe` both started and drew normally.
  Their windows enumerate on that desktop and are absent from `Default`.
- **Driving a Chromium app over CDP.** The debugging port is a TCP socket and does not care about
  desktops. `Runtime.evaluate`, `Input.insertText` and `Input.dispatchKeyEvent` all worked, and the
  page reported `document.hasFocus() === true`.
- **A genuine paste with no real input at all.** `Input.dispatchKeyEvent` with `commands: ['paste']`
  produced a `paste` event with `isTrusted: true` carrying the real clipboard contents. The brief
  listed this as untried; it removes one of the two cases that were thought to need the person's
  screen.
- **Screenshots two ways.** `Page.captureScreenshot` returns the web contents.
  `PrintWindow` with `PW_RENDERFULLCONTENT`, called from a process attached to that desktop, returns
  any window including its native frame. Explorer's window came back fully rendered.
- **Keyboard input through posted messages.** `PostMessage` of `WM_KEYDOWN`/`WM_CHAR`/`WM_KEYUP` to
  the Chromium child window arrived as `isTrusted: true` key events, with no foreground window
  anywhere.

**Does not work there**

- **No foreground window and no pointer.** `GetForegroundWindow` returns 0, `SetForegroundWindow`
  returns false, and `GetCursorPos`/`SetCursorPos` both fail. A desktop that has never been switched
  to has no input state of its own.
- **Therefore no `SendInput`/`keybd_event`.** Real key presses sent from a process on that desktop
  reached nothing; the target app's event log was unchanged.
- **No desktop-wide capture.** `BitBlt` from the desktop DC returns false and the bitmap is blank.
  Per-window `PrintWindow` is the only picture available.
- **Consequently no mouse-driven drag and drop.** OLE drag needs a real cursor and mouse capture and
  neither exists there, so dropping files into Explorer stays unverifiable in this shape.
- **The clipboard is shared**, as expected: the paste above picked up what the person had copied.

`SwitchDesktop` would give that desktop real input, and is how Sysinternals Desktops works, but it
takes the screen away from the person, which is the thing this feature exists to avoid. It was not
tried for that reason.

## What this does to the candidate shapes

B is no longer merely "the direct analogue of the agent browser"; it is the shape the measurements
support. C survives in a reduced form: the desktop is worth having as **a place to put windows so
they never appear on the person's screen**, not as a place where real input happens. The two collapse
into one design: an isolated desktop holding the agent's app instance, driven by CDP and posted
messages, observed through `Page.captureScreenshot` and `PrintWindow`.

The one case left uncovered is cross-app drag and drop. It needs the person's screen or a second
logon session, and is out of scope for the shape above.

## Decisions taken (2026-09-08)

1. **Scope: a product feature.** Any agent working in any project through astera, not only agents
   verifying astera itself.
2. **The clipboard is not isolated.** "The agent may overwrite the clipboard, but must not take the
   screen or the pointer" is the accepted line. A second logon session or a VM is out.
3. **Windows first.** Other platforms get whatever needs no real input. The desktop object is
   Windows-only, as `clipboardFiles.ts` already is.
4. **The first round targets an Electron app plus the OS around it.** That means the project's own
   app launched from a Run configuration, driven precisely, with the OS-integration cases that
   survive the measurements above.

## Still open

- **Who drives.** A scripted API in the agent-browser style, or a CDP endpoint the skill drives
  directly. The agent browser's own history argues for the scripted API, because its guardrails all
  turned out to be load-bearing: a busy tab, a stop, a bounded script.
- **Visibility.** The agent browser shows a violet frame and a pointer while it works. The
  equivalent for a desktop the person cannot see is undecided: a tab that mirrors `PrintWindow`
  captures, a status pill, or nothing.
- **Lifecycle.** The desktop object dies when its last process exits (measured). Who creates it,
  when, and what happens to a stranded instance is undesigned.

## Suggested next step

Design the surface with the person, starting from the two open questions above. The mechanism no
longer needs proving; what needs deciding is what the agent is handed and how the person sees what
it is doing.

## Pointers

- The verification session that produced the measurements: develop `5ac2116`, the explorer clipboard
  work in both directions. `src/main/clipboardFiles.ts` carries the PowerShell route and the reason
  Electron cannot do it alone.
- An agent picking this up in Astera's own working setup also has local notes on the method
  (`electron-file-clipboard-and-drag`, `astera-dev-run-cdp`, `orca-peer-reference`); those are agent
  memory, not part of this repository.
- The spike was throwaway and is not in the repository. What it established is written above; the
  calls it used were `CreateDesktop`, `CreateProcess` with `STARTUPINFO.lpDesktop`,
  `EnumDesktopWindows`, `PrintWindow(PW_RENDERFULLCONTENT)`, `PostMessage`, and CDP over the app's
  debugging port. Two traps cost the most time: PowerShell turns `$null` into an empty string for a
  `[string]` P/Invoke argument (use `[NullString]::Value`, or `CreateProcess` fails with
  ERROR_PATH_NOT_FOUND), and a process on an invisible desktop has no console, so an `Add-Type` that
  fails to compile is silent and every later call returns `$null`.
