/** The options the run console's xterm is created with.
 *
 *  Here rather than inline in RunPanel because one of them is load-bearing in a way nothing else on
 *  screen states. The find bar's highlighting goes through the search addon, which marks matches with
 *  xterm's decoration API — and xterm classifies that as proposed API: a terminal created without
 *  `allowProposedApi` throws "You must set the allowProposedApi option to true to use proposed API" on
 *  the first findNext, before it selects or highlights anything. The throw lands in the renderer
 *  console and the find bar simply does nothing, which is how it shipped and how a user found it.
 *
 *  A renderer file cannot be tested here (vitest runs environment: 'node'), so the option travels
 *  through this module, which can. */
export function consoleTerminalOptions(a: {
  fontFamily: string
  theme: { background: string; foreground: string; cursor: string }
}): {
  fontSize: number
  fontFamily: string
  scrollback: number
  allowProposedApi: true
  theme: { background: string; foreground: string; cursor: string }
} {
  return {
    fontSize: 13,
    fontFamily: a.fontFamily,
    scrollback: 5000,
    // The search addon's decorations are proposed API — see this module's own comment
    allowProposedApi: true,
    theme: a.theme
  }
}
