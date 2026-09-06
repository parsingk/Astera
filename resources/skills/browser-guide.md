# astera browser — the agent's browser, full guide

This document, which `astera browser help` prints, is the single source of truth. `help('open')`
inside a script prints one section of it.

`astera browser js` reads a JavaScript script from stdin (or `--file path.js`) and runs it against
**this session's own preview tab** of the project's dev server. The tab is created on the first
`open(url)`, in the background; a second `open` moves it. The user can see the tab and may click
into it; that is fine — your next script sees the page as it is.

## Rules

- **This machine only.** `open()` accepts `localhost`, `127.x`, `[::1]`, `*.localhost`, `0.0.0.0`
  and `[::]` (the last two become `localhost`). Anything else is refused, and so is a link on the
  page that would leave.
- **`log(value)` is the only output.** Strings print as they are, anything else as JSON, in order.
  `console.log` prints nowhere. A thrown error ends the script; what was logged before it is kept and
  the error names the helper that was running (`error.at`).
- **60 seconds per script, 30 per wait.** A script cut off reports `at: "timeout"`.
- **Read after you load.** `consoleErrors()` and `networkErrors()` return what happened since the
  last `open`/`reload` — call them after the load you care about.
- **One script at a time** per session. A second `astera browser js` while one runs is refused.
- Every helper is `async` except `log` and `help`; `await` them.

## The pattern

```js
await open('http://localhost:5173/')     // or reload() after your change
const errors = await consoleErrors()
if (errors.length === 0) log('console clean')
else log(errors)
log(await networkErrors())
```

## open(url)
Opens `url` in this session's tab (creating the tab on the first call) and resolves when the page has
loaded. Throws if `url` is not this machine, or if the page fails to load (connection refused, DNS,
HTTP error page), with the reason.

## reload()
Reloads the current page and resolves when it has loaded. Use after editing source with a dev server
that does not hot-reload, or to start the error buffers fresh.

## url()
The page's current address.

## title()
The page's `<title>`.

## waitForLoad()
Resolves when the current navigation, if any, has finished. `open` and `reload` already wait; use
this after something else started a load.

## consoleErrors()
`[{ level, message, source, line }]` — console `error` and `warning` entries, and uncaught
exceptions, since the last load. Empty array when there are none.

## networkErrors()
`[{ url, method, status?, error? }]` — requests that failed (`error`, e.g. `net::ERR_CONNECTION_REFUSED`)
or completed with status ≥ 400, since the last load.

## close()
Closes this session's tab. The next `open` makes a new one.

## log(value)
Appends to the script's output. The only way anything reaches you.

## help(name?)
This guide, or one helper's section: `help('open')`.

## What you cannot do yet
Snapshots, screenshots, clicking and typing arrive in later stages. Until then, read the DOM through
what the page prints and what the console reports.
