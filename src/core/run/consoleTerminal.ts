const HEX6 = /^#[0-9a-f]{6}$/i

/** Parses a `#RRGGBB` string into its three channels, or null if it is not that shape. */
function parseHex6(hex: string): [number, number, number] | null {
  if (!HEX6.test(hex)) return null
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

function toHex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}

/** The colours the run console's find highlights are painted with.
 *
 *  Two forms of one colour, because xterm paints them by two different rules. A decoration's
 *  background keeps only the RGB of what it is given — the alpha is discarded — while a selection's
 *  background is blended against the terminal background. Handing both the same `#RRGGBBAA` therefore
 *  paints two different colours, which is exactly the mismatch a user reported: the active match sits
 *  inside the selection the search addon makes, so it came out amber-blended-dark while every other
 *  match came out full-strength amber.
 *
 *  So the decoration is given the blend already performed, and the selection the alpha form that xterm
 *  will blend to the same value. The active match is then told apart by an outline, not by colour.
 *
 *  A colour this cannot parse (a theme could supply a non-hex value) falls back to the highlight
 *  itself for both — a mismatched pair is better than a crash, and no shipped theme takes that path. */
export function findHighlightPaint(a: { highlight: string; background: string; outline: string }): {
  /** Opaque: what a decoration must be given to paint like the blended selection */
  decorationBackground: string
  /** The alpha form: xterm blends this against the terminal background to the same pixels */
  selectionBackground: string
  /** The active match's outline — how it is told apart, since every match is now one colour */
  activeBorder: string
  /** The overview ruler marks, where the full-strength colour reads better than the blend */
  ruler: string
} {
  const highlight = parseHex6(a.highlight)
  const background = parseHex6(a.background)
  if (!highlight || !background) {
    return { decorationBackground: a.highlight, selectionBackground: a.highlight, activeBorder: a.outline, ruler: a.highlight }
  }
  // 40% alpha, blended by hand: each channel at 0.4 over the same channel of the terminal background.
  const blended = highlight.map((c, i) => Math.round(c * 0.4 + background[i] * 0.6))
  return {
    decorationBackground: `#${blended.map(toHex2).join('')}`,
    selectionBackground: `${a.highlight}66`,
    activeBorder: a.outline,
    ruler: a.highlight
  }
}

/** The options the run console's xterm is created with.
 *
 *  Here rather than inline in RunPanel because one of them is load-bearing in a way nothing else on
 *  screen states. The find bar's highlighting goes through the search addon, which marks matches with
 *  xterm's decoration API — and xterm classifies that as proposed API: a terminal created without
 *  `allowProposedApi` throws "You must set the allowProposedApi option to true to use proposed API" on
 *  the first findNext, before it selects or highlights anything. The throw lands in the renderer
 *  console and the find bar simply does nothing, which is how it shipped and how a user found it.
 *
 *  The theme also carries a selection colour, and that one is load-bearing too: the addon selects the
 *  active match, so whatever colour the selection paints is what the active match looks like. It is now
 *  the alpha form of the find highlight (see findHighlightPaint) — the same colour every other match's
 *  decoration paints, once xterm blends that alpha against this same background.
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
  const { selectionBackground } = findHighlightPaint({
    highlight: a.findHighlight,
    background: a.theme.background,
    outline: a.theme.foreground
  })
  return {
    fontSize: 13,
    fontFamily: a.fontFamily,
    scrollback: 5000,
    // The search addon's decorations are proposed API — see this module's own comment
    allowProposedApi: true,
    theme: { ...a.theme, selectionBackground }
  }
}
