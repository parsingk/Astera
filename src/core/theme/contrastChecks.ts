import type { ThemeColors } from './themes'

/** The contrast floors every theme keeps, built-in or a plugin's (spec §5; plugin themes, design 2026-11-27). --text is
 *  AAA on the surface text is read on (--bg) and AA on the surfaces it passes over; 7:1 everywhere would drop the real
 *  IntelliJ palette, whose selected row is 6.9:1. */
export const THEME_CONTRAST_CHECKS: readonly { label: string; fg: keyof ThemeColors; bg: keyof ThemeColors; min: number }[] = [
  { label: 'text on bg', fg: 'text', bg: 'bg', min: 7 },
  { label: 'text on panel', fg: 'text', bg: 'panel', min: 4.5 },
  { label: 'text on elevated', fg: 'text', bg: 'elevated', min: 4.5 },
  { label: 'text-dim on elevated', fg: 'textDim', bg: 'elevated', min: 4.5 },
  { label: 'text-faint on elevated', fg: 'textFaint', bg: 'elevated', min: 3 },
  { label: 'rail-icon on rail', fg: 'railIcon', bg: 'rail', min: 4.5 },
  { label: 'accent on bg', fg: 'accent', bg: 'bg', min: 3 },
  { label: 'accent-ink on accent', fg: 'accentInk', bg: 'accent', min: 4.5 },
  { label: 'status-ink on status-bg', fg: 'statusInk', bg: 'statusBg', min: 4.5 },
  { label: 'md-link on bg', fg: 'mdLink', bg: 'bg', min: 4.5 }
]

/** The brightest surface of the built-in themes, Orion's --elevated. The shared colours (file icons, git, danger) are
 *  not defined per theme and keep 3:1 on it, so a surface no brighter than this keeps them readable. */
export const BRIGHTEST_SURFACE = '#303236'
