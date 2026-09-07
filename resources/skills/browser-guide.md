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
- **This tab is your screen.** It is yours: it opens in the background, it is drawn while your
  script runs, and the person using Astera keeps the tab and the window they were on. So read the
  page with `snapshot()` and photograph it with `screenshot()`, and do not reach for anything that
  drives the computer instead — a desktop or window screenshot, a mouse or keyboard tool, a second
  browser. Those capture the person's screen, not your page, and everything else that is on it. If a
  helper here fails, report what it said and stop; that failure is the answer.
- **`log(value)` is the only output.** Strings print as they are, anything else as JSON, in order.
  There is no `console` in the script's world, so `console.log(x)` does not print nothing — it throws
  `Cannot read properties of undefined (reading 'log')` and ends the run. A thrown error ends the
  script; what was logged before it is kept and the error names the helper that was running
  (`error.at`).
- **`open()` before anything else.** Every helper below except `log`, `help` and `close` needs a page;
  called before the first `open(url)` they throw `no page open — call open(url) first`.
- **60 seconds per script, 30 per wait.** A script cut off reports `at: "timeout"`.
- **Read after you load.** `consoleErrors()` and `networkErrors()` return what happened since the
  last `open`/`reload` — call them after the load you care about.
- **The page is your own dev server.** `click()` on a link that leaves this machine is refused before
  the click, with the address; the page stays. Fill and press act on the page the way a person's
  input would, through the events frameworks listen for, but they are synthetic: the browser's own
  default actions do not fire, except Enter submitting the form of a focused input.
- **A refusal may still mean it happened.** `press` and `click` can navigate the page; when that
  navigation tears the frame down before the reply arrives, the helper reports `the page refused the
  call` even though the click or the submit went through. Check with `snapshot()` before repeating
  such an action — it waits for the navigation to land. `url()` waits for nothing, so trust it only
  after `waitForLoad()`. Do not retry blind.
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

```js
await open()
await click('#login')
await fill('#email', 'dev@test')
await press('Enter')
await waitFor('.dashboard')
log((await snapshot()).headings)
log(await consoleErrors())
```

## open(url?)
Opens `url` in this session's tab (creating the tab on the first call) and resolves when the page has
loaded. **With no `url`, opens this project's dev server** — the Run the user marked for preview (the
preview address on its configuration), or else the one Run of this project that printed an address.
That is how you know which localhost port is yours when several projects are open. If no such Run is
running, or several qualify and none is marked, `open()` refuses and says so (the candidates are
listed by their Run's name — pass one). A server you started yourself in your terminal is not known
to Astera; pass its address. Throws if `url` is not this machine, or if the load itself fails (connection refused, DNS),
with the reason. **A 404 or a 500 that returns a page is not a load failure** — the browser renders
it and `open()` resolves; that one reaches you through `networkErrors()`.

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

## snapshot()
The page as text, for reading rather than looking: `title`, `url`, `headings` (with levels), `landmarks`
(nav, main, header, footer, aside, form, each with a one-line summary), `interactive` — every link,
button, input, select, textarea, element with a role, and any other element carrying a tabindex other
than -1 — with its `tag`, a `selector` you can pass to `click()`/`fill()`, its accessible `name`, its
visible `text`, `disabled`, and `href` for links — then `text`, the visible text of the page. Budgets:
200 interactive elements, 150 headings and 80 landmarks — `moreInteractive`, `moreHeadings` and
`moreLandmarks` say how many more the page has, counted on the page itself rather than in what was
sent — 8,000 characters of text (ending in `… (N more characters)` when cut), 32,000 characters in
all — when the total is still over after that, text shrinks further first, then landmarks give way,
then headings, then interactive elements give way further. Hidden inputs, script
and style bodies are left out, and so are secrets, in different ways: a heading or landmark whose text
looks like one is dropped from its list; an interactive element's `name` or `text` that looks like one
becomes `[redacted]` and the element stays; a secret-looking word in the free text is stripped from it.
A password input is listed like any other field, so you know it is there, but its `text` is always
empty: its value is never read.
Throws `snapshot: the page returned nothing readable` when the page gave back nothing usable.

## screenshot()
The page as a PNG: `{ path, width, height }`. The file is under Astera's own data folder and your
session may read it without asking — open the path to look at it. Only your page is in it, never
Astera's window and never the rest of the screen.

Your tab is drawn while your script runs, so a capture normally answers in well under a second; a
first one right after `open()` may take a moment longer while the page starts producing frames. It
throws `screenshot: the page did not paint within 5 s — the window may be minimised` when no frame
arrives, which on a minimised window is what happens; when the page said why instead — the tab was
closed under you, say — the message ends with that reason. That is a real answer: say so rather than
looking for another way to take a picture. A file that could not be written is
`screenshot: the capture could not be saved (<reason>)`.

## click(sel)
Clicks the first element matching the CSS selector, scrolling it into view first. Throws
`click: nothing matches <sel>`, and `click: <sel> is disabled` for a control that is — a click on a
disabled control dispatches nothing, so this is reported rather than answered as a click. A link whose
address leaves this machine is refused before the click:
`click: the link leaves this machine (<address>)`. After a click that navigates, `snapshot()`,
`screenshot()`, `fill()`, `press()`, another `click()` and `waitFor()` with a selector wait for the
load first — you do not need `waitForLoad()` between. `url()`, `title()`, `consoleErrors()` and
`networkErrors()` do not wait either — call `waitForLoad()` first if you need one of them to see the
new page. Neither does `close()`, but for a different reason: it closes whichever tab exists, loading
or not, so a pending load has nothing to do with it.

## fill(sel, text)
Sets the value of an input, textarea or select — or the text of an editable element — the way typing
would, so the page's framework sees the change. Throws `fill: nothing matches <sel>`,
`fill: <sel> is not an input, textarea, select or editable element`, or, for a select,
`fill: <sel> has no option with that value`.

## press(key)
A key on the focused element: `'Enter'`, `'Escape'`, `'Tab'`, an arrow, or a single character. Enter on
an input inside a form submits the form, as it would for a person; other default actions are not
performed. Throws `press: key must be a non-empty string`.

## waitFor(sel | ms)
With a selector, resolves as soon as it matches, polling; throws
`waitFor: nothing matched <sel> within 30000 ms` otherwise. With a number, waits that many
milliseconds (capped at 30000). Anything else throws
`waitFor: expects a selector or a number of milliseconds`.

## close()
Closes this session's tab. The next `open` makes a new one.

## log(value)
Appends to the script's output. The only way anything reaches you.

## help(name?)
This guide, or one helper's section: `help('open')`. With no name, and when Astera's Run has a dev
server running for this project, the first line names it.
