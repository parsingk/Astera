# Agent workspace isolation — design brief

Status: **not designed yet**. This is the brief a next session starts from: the problem, what was
measured, the candidate shapes, and the decisions still open. Nothing here is decided except where
it says "measured".

Written 2026-09-08, after the explorer clipboard work (develop `5ac2116`) forced the question.

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

## Open questions

1. **Scope.** Is this for agents verifying *astera itself*, or for any agent working in any project
   through astera? The second is a product feature; the first is closer to tooling.
2. **How much does the clipboard matter?** If clipboard verification must be isolated too, the
   answer is a second logon session or a VM and the cost changes shape entirely. If "the agent may
   overwrite the clipboard, but must not steal the screen or the pointer" is acceptable, C is enough.
3. **Cross-platform.** C is Windows-only. macOS has no equivalent of a desktop object; the nearest
   is a separate user session. Is a Windows-only capability acceptable, as `clipboardFiles.ts`
   already is?
4. **Who drives.** Does the agent get a scripted API (agent-browser style, safer, more work) or a
   raw CDP endpoint the skill drives (cheap, no guardrails)?
5. **Visibility.** The agent browser makes it obvious when the agent is acting. What is the
   equivalent when the work happens on a desktop the person cannot see — a tab that mirrors
   screenshots, a status pill, nothing?

## Suggested next step

Answer 1 and 2 first; they decide whether this is a weekend of work or a month. Then design the shape
with the person, rather than building from this brief: it is deliberately a list of constraints and
not a proposal.

## Pointers

- The verification session that produced the measurements: develop `5ac2116`, the explorer clipboard
  work in both directions. `src/main/clipboardFiles.ts` carries the PowerShell route and the reason
  Electron cannot do it alone.
- An agent picking this up in Astera's own working setup also has local notes on the method
  (`electron-file-clipboard-and-drag`, `astera-dev-run-cdp`, `orca-peer-reference`); those are agent
  memory, not part of this repository.
