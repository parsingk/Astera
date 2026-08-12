/** The chain the three xterm instances used before this setting existed, and still the chain when the
 *  user has chosen nothing: the Windows PowerShell console font (Cascadia → Consolas), then 'Malgun
 *  Gothic' for Hangul — none of the fonts before it carry Hangul glyphs, so without it the lookup falls
 *  through to the generic monospace and Chromium picks Gulim. */
const BASE_LATIN = ['"Cascadia Mono"', '"Cascadia Code"', 'Consolas']
const BASE_HANGUL = ['"Malgun Gothic"']
const TAIL = ['"Courier New"', 'monospace']

/** Rejects only the characters that can break out of the quoted font-family name or the declaration
 *  it sits in — a quote, backslash, semicolon, comma, or brace — plus C0/C1 control characters.
 *  Everything else (including non-Latin scripts such as Hangul) is allowed: the injection surface is
 *  those terminator characters, not the script the name is written in. A name is rejected rather than
 *  escaped, and rejection is silent by design — the caller treats null as "not set" and falls back. */
const SAFE = /^[^"'\\;,{}\u0000-\u001F\u007F-\u009F]+$/

/** The user's terminal font choice. null on either side means "not chosen" — the chain builder then
 *  falls back to the app default for that half. */
export interface TerminalFont {
  latin: string | null
  hangul: string | null
}

export function sanitizeFontFamily(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 64) return null
  return SAFE.test(trimmed) ? trimmed : null
}

/** Assembles the CSS font-family chain. Order is what splits the roles: the Latin choice is claimed by
 *  the first family that has the glyph, and Hangul by the first one after it that does. A Latin font
 *  that happens to carry Hangul therefore wins over the Hangul choice — that is inherent to a single
 *  ordered chain, and the settings UI says so rather than pretending otherwise. */
export function terminalFontFamily(latin: string | null, hangul: string | null): string {
  const l = sanitizeFontFamily(latin)
  const h = sanitizeFontFamily(hangul)
  return [
    ...(l ? [`"${l}"`] : []),
    ...BASE_LATIN,
    ...(h ? [`"${h}"`] : []),
    ...BASE_HANGUL,
    ...TAIL
  ].join(', ')
}

export const DEFAULT_TERMINAL_FONT_FAMILY = terminalFontFamily(null, null)
