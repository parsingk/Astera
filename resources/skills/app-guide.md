# astera app, the agent's hidden desktop, full guide

This document, which `astera app help` prints, is the single source of truth. `help('launch')` inside
a script prints one section of it.

`astera app js` reads a JavaScript script from stdin (or `--file path.js`) and runs it against **this
session's own desktop**, which the person never sees. On Windows it is a desktop object nobody switches
to. On Linux it is a virtual display (Xvfb) of its own, so it also works over SSH and on a server. On
macOS the app runs in the background in the person's session and only its page can be driven. The
first `launch()` creates it; your app's windows open there and nowhere else. The person keeps their
screen, their foreground window and their pointer the whole time. The Astera app, when it is open,
shows them a picture of your app in a tab with a violet frame and the helper you are running; they can
stop your script or close the desktop from there. It works the same when the Astera app is closed.

## Rules

- **Never reach for the real screen.** Do not use a mouse or keyboard tool, a desktop or window
  screenshot tool, or anything that raises, moves or focuses a window. Those act on the person's
  screen, not on your desktop. Read the app with `snapshot()`, photograph it with `screenshot()` or
  `windowShot()`, and act with the helpers below. If a helper fails, report what it said and stop.
- **The app must open a debugging port.** `launch()` gives the command `ASTERA_APP_CDP_PORT`, a free
  port, in its environment. Electron has to be started with
  `--remote-debugging-port=%ASTERA_APP_CDP_PORT%` on Windows (the command runs in cmd) or
  `--remote-debugging-port=$ASTERA_APP_CDP_PORT` on Linux and macOS (the command runs in sh), on the
  command line, in the npm script, or with
  `app.commandLine.appendSwitch('remote-debugging-port', process.env.ASTERA_APP_CDP_PORT)` in the main
  process. Without it `launch()` fails with that hint and the app keeps running. On Windows and Linux
  only `windows()`, `windowShot()` and `keys()` work then; the page helpers throw `no CDP connection`.
- **On macOS, pass `$ASTERA_APP_CHROMIUM_FLAGS` too.** It holds the Chromium switches that keep a page
  nobody sees rendering. `windows()`, `windowShot()` and `keys()` throw `not available on macOS`, since
  the app runs in the background and only its page can be driven. Use `screenshot()` to see it. A Dock
  icon can appear while it runs, and a plain command's window can show unless the app keeps it hidden
  (it may when `ASTERA_APP_CHROMIUM_FLAGS` is set). An app that hides itself should also create that
  window with `paintWhenInitiallyHidden: true` and `webPreferences: { backgroundThrottling: false }`,
  so a page nobody sees still paints and `screenshot()` does not wait. An app bundle (`/Applications/My App.app --flag`) is
  opened in the background; it sees only what reaches it after its path, not the environment.
- **The clipboard.** On Windows and macOS it is the person's: `paste()` pastes what they copied, and
  your app can overwrite what they copied. Say so before you rely on it. On Linux it is the virtual
  display's own, so `paste()` pastes only what your app itself copied.
- **What cannot be done here.** Dragging out of the app into a file manager or another app needs a real
  mouse, which this desktop does not have. `dropFiles()` proves your app handles a drop; it does not
  prove a file manager would start the drag. There is no real pointer, no foreground window and no
  desktop wide screenshot on this desktop.
- **`log(value)` is the only output.** There is no `console`. A thrown error ends the script; what was
  logged before it is kept, and the report names the helper that was running (`error.at`).
- **60 seconds per script, 30 per wait.** A script cut off reports `at: "timeout"`. The time `launch()`
  and `relaunch()` spend waiting for the app to start does not count against those 60 seconds, up to
  5 minutes of such waiting per script. An app whose first build is slow can take the time it needs:
  pass a longer `waitMs`. Keep the first round to launching and one look.
- **Stopped by the person.** When they press Stop, your script ends with `at: "stopped"` and the app
  keeps running. When they press Close, the desktop is gone and the next `launch()` starts afresh.
- **One script at a time** per session. A second `astera app js` while one runs is refused.
- **Cleanup.** Call `close()` when you are done. The desktop is also cleaned up when your session ends
  and after 10 minutes without a script.
- **Ending the app.** `close()` and `relaunch()` end the app whatever it is doing, even when it does
  not answer a quit. An Electron app you started with `--inspect` and drove through its main process
  inspector does not end at `app.quit()` or Cmd+Q while your inspector connection is open: Node
  prints `Waiting for the debugger to disconnect...` and keeps the process until every inspector
  client has gone, and one SIGTERM does not change that. Close your inspector connection before you
  quit the app, or end the app with `close()`.
- Every helper is `async` except `log` and `help`; `await` them.
- **A script that never finishes is cut off at 60 s.** A busy loop such as `while (!ready) {}` is ended
  there, or when the person presses Stop, and reports `at: "timeout"` or `at: "stopped"`. Wait with
  `waitFor()` instead, which returns as soon as the selector matches.
- **A script that takes more than 512 MB of memory is ended.** It runs in a process of its own, so this
  ends only your script, which reports `at: "memory"`. Keep large buffers and arrays out of the script;
  log a summary of what you measured, not the data itself.

## The pattern

```js
await launch({ config: 'Electron dev' })
log(await snapshot())
log(await screenshot())
log(await consoleErrors())
```

```js
await click('#new-note')
await fill('#title', 'Groceries')
await press('Enter')
await waitFor('.note-list li')
log((await snapshot()).interactive.length)
```

```js
await dropFiles('#import', ['C:\\Users\\me\\Documents\\notes.txt'])
log(await windows())
log(await windowShot('Import'))
await keys('Import', 'Enter')
await close()
```

## launch(spec, options?)
Starts the app on this session's desktop, creating the desktop the first time. `spec` is either
`{ config: '<name or id>' }`, a Run configuration of this project as Astera's Run panel shows it, or
`{ command: '<shell command>', cwd?: '<folder>' }`, run in this session's folder or in `cwd` relative
to it. `options.waitMs` bounds the wait for the debugging port: 60000 by default, and up to 300000
(5 minutes) when you ask for more, for an app whose first dev build is slow, such as an Electron or
webpack app. The wait does not count against the script's 60 seconds, and the person's mirror tab
shows how long the app has been starting. Resolves with `{ pid, port }` once a page answers on the port.
Refused when something is already launched; use `relaunch()`.

```js
await launch({ config: 'Electron dev' }, { waitMs: 180000 })
```

## relaunch(options?)
Ends the launched app and everything it started, then starts the same spec again. Use it after you
changed the app's source. `options.waitMs` is the same as `launch()`'s.

## close()
Ends the launched app and everything it started, closes the desktop and ends its helper.

## snapshot()
The page as text: `title`, `url`, `headings`, `landmarks`, `interactive` (every control with a
`selector` you can pass to `click()` and `fill()`), and `text`. The same budgets and the same
redaction as the agent browser's `snapshot()`. `url` is empty for an address that is not http or https.

## url()
The page's current address, as the page reports it.

## consoleErrors()
Console errors and uncaught exceptions since `launch()`, oldest first, as strings.

## click(selector)
Clicks the first element that matches, after scrolling it into view. A link is followed: this is your
app, not the web. Throws `click: nothing matches <selector>` or `click: <selector> is disabled`.

## fill(selector, text)
Sets an input, textarea, select or editable element the way typing would, so the app's listeners
fire. Throws when nothing matches or the element cannot take text.

## press(key)
A real key press on the focused element: one character, or `Enter`, `Escape`, `Tab`, `Backspace`,
`Delete`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`,
`PageDown`.

## waitFor(selectorOrMs)
Waits until the selector matches (up to 30 s), or for that many milliseconds (also capped at 30 s).

## paste()
A real paste into the focused element, with the person's clipboard (see the rules).

## drag(fromSelector, toSelector)
Drags one element onto another inside the page, as HTML drag and drop. Throws when the source does not
start a drag.

## dropFiles(selector, paths)
Drops files (absolute paths) onto an element, as the app would receive them from a file manager.

## screenshot()
The page as a PNG. Resolves with `{ path, width, height }`; the path opens without a permission prompt.

## windowShot(title?)
A native window or dialog on this desktop as a PNG, by part of its title, or the largest window when
no title is given. Resolves with `{ path, width, height, title }`. Not available on macOS: it throws
there.

## windows()
The windows showing on this desktop: `{ title, className, pid, width, height }` each. Use it to find a
native dialog's title. `className` is empty on Linux. Not available on macOS: it throws there.

## keys(title, textOrKey)
Types text, or presses one of the key names `press()` knows, into the window whose title contains
`title`. It reaches native dialogs that the page helpers cannot. Not available on macOS: it throws
there.

## help(name?)
This guide, or one section of it.
