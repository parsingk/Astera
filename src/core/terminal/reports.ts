// What the app's own terminal writes into a pty without anyone typing: the reports xterm.js sends
// back when the program running in the tab asked for them, or when the tab gains or loses focus.
//
// Why it matters: `astera sessions list` reads a session's `state` off its last hook event and voids
// it once anything is typed into the pty afterwards (core/hooks/sessionState.ts, host/registry.ts).
// Every one of these goes through the same `pty-write` as a keystroke (TerminalView's `onData` has
// no "the user did this" flag), so without this a click on another tab would turn a waiting
// session `unknown` for the rest of its idle time. Claude Code asks for several of them: a cursor
// position (`?6n`), the terminal version (`>0q`), the kitty keyboard flags (`?u`), the cell size
// (`16t`), and focus reporting (DECSET 1004).
//
// **Only whole writes made of nothing but reports.** Each alternative is a reply's grammar, never a
// key's, so nothing a person types matches:
// - a bare Esc, arrows (`CSI A`…, `SS3 A`), `CSI 1;5A`, `CSI 3~` and every other key end in a final
//   byte none of these use, or lack the `?`/`>`/`$` marker a reply carries;
// - a plain CPR (`CSI row;col R`) is left out on purpose: xterm sends Shift+F3 as `CSI 1;2R`, and
//   the two cannot be told apart. The DEC form Claude Code asks for (`CSI ? row;col R`) is no key;
// - mouse reports are left out too: a click can answer a dialog, so it counts as input;
// - a bracketed paste (`CSI 200~`) is input.
//
// No imports: host/registry.ts uses this, and the Host bundle keeps that file free of anything but
// the protocol types.

const REPORT = new RegExp(
  '^(?:' +
    [
      String.raw`\x1b\[[IO]`, // focus in / out (DECSET 1004)
      String.raw`\x1b\[\?\d+;\d+(?:;\d+)?R`, // DECXCPR, the answer to CSI ?6n
      String.raw`\x1b\[[?>=][\d;]*c`, // primary / secondary / tertiary device attributes
      String.raw`\x1b\[\??\d+;\d+\$y`, // DECRPM, the answer to DECRQM
      String.raw`\x1b\[\?\d+u`, // kitty keyboard flags, the answer to CSI ?u
      String.raw`\x1b\[\d+(?:;\d+)*t`, // XTWINOPS reports (cell size, text area, window state)
      String.raw`\x1b\[[03]n`, // DSR operating status
      String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`, // OSC replies (colours), BEL or ST terminated
      String.raw`\x1bP[^\x1b]*\x1b\\` // DCS replies: XTVERSION, DA3, DECRQSS, XTGETTCAP
    ].join('|') +
    ')+$'
)

/** True when `data` is one or more terminal reports and nothing else — something the terminal wrote,
 *  not something a person typed. An empty string is not a report. */
export function isOnlyTerminalReports(data: string): boolean {
  return REPORT.test(data)
}
