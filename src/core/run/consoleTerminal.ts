/** The options the run console's xterm is created with.
 *
 *  Here rather than inline in RunPanel because one of them is load-bearing in a way nothing else on
 *  screen states. The find bar's highlighting goes through the search addon, which marks matches with
 *  xterm's decoration API — and xterm classifies that as proposed API: a terminal created without
 *  `allowProposedApi` throws "You must set the allowProposedApi option to true to use proposed API" on
 *  the first findNext, before it selects or highlights anything. The throw lands in the renderer
 *  console and the find bar simply does nothing, which is how it shipped and how a user found it.
 *
 *  The theme also carries a selection colour, and that one is load-bearing too. xterm's DOM renderer
 *  lets the selection win over a decoration's background unless the decoration is on the `top` layer,
 *  which the search addon does not use — and the addon selects the active match. Without a selection
 *  colour of our own, the active match drew in xterm's built-in grey while every other match drew amber.
 *  The visible consequence: dragging to select text in a run console now highlights in amber too.
 *
 *  A renderer file cannot be tested here (vitest runs environment: 'node'), so the option travels
 *  through this module, which can. */
export function consoleTerminalOptions(a: {
  fontFamily: string
  theme: { background: string; foreground: string; cursor: string }
  findHighlight: string
}): {
  fontSize: number
  fontFamily: string
  scrollback: number
  allowProposedApi: true
  theme: { background: string; foreground: string; cursor: string; selectionBackground: string }
} {
  // Same alpha convention as RunPanel's search decorations: append it only when it is safe to.
  const selectionBackground = /^#[0-9a-f]{6}$/i.test(a.findHighlight) ? `${a.findHighlight}8c` : a.findHighlight
  return {
    fontSize: 13,
    fontFamily: a.fontFamily,
    scrollback: 5000,
    // The search addon's decorations are proposed API — see this module's own comment
    allowProposedApi: true,
    theme: { ...a.theme, selectionBackground }
  }
}
