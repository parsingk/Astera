/** Accented stand-ins that stay readable, so a screen in pseudo-locale can still be navigated. */
const ACCENTS: Record<string, string> = {
  a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú'
}

/** Padding ratio. Roughly the worst case a longer language costs over English, so a control that
 *  survives this survives translation. */
const PAD = 0.35

/**
 * Renders a string as a longer, obviously-fake variant so a fixed-width control that will clip a
 * translation shows it now. Placeholders are left exactly as they are — a pseudo-locale that broke
 * substitution would be reporting its own bug rather than the layout's.
 */
export function pseudoize(s: string): string {
  const body = s.replace(/\{\w+\}|./gs, (m) => (m.startsWith('{') ? m : (ACCENTS[m] ?? m)))
  return `⟦${body}${'·'.repeat(Math.ceil(s.length * PAD))}⟧`
}

let on = false

/** Turned on at startup from each side's own environment — the renderer and main read different things,
 *  and t() lives in core, which reads neither. */
export function setPseudoLocalization(enabled: boolean): void {
  on = enabled
}

export function isPseudoLocalization(): boolean {
  return on
}
