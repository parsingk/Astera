import type { MessageKey } from '../../../core/i18n'
import type { RecordStatus } from '../../../core/understanding/types'

/** Shape carries the status; colour only supports it (design §7). */
export const RECORD_GLYPH: Record<RecordStatus, string> = {
  generating: '◐',
  ready: '✓',
  'needs-review': '⚠',
  failed: '!'
}

export const RECORD_GLYPH_COLOR: Record<RecordStatus, string> = {
  generating: 'var(--accent)',
  ready: 'var(--ok)',
  'needs-review': 'var(--warn)',
  failed: 'var(--danger)'
}

export const RECORD_STATUS_KEY: Record<RecordStatus, MessageKey> = {
  generating: 'hiw.record.generating',
  ready: 'hiw.record.ready',
  'needs-review': 'hiw.record.needsReview',
  failed: 'hiw.record.failed'
}

/** Spins while the write-up is running. The rotation is applied to the character alone —
 *  styles.css's .hiw-spin comment says why. */
export function StatusGlyph({ glyph, spinning }: { glyph: string; spinning: boolean }): React.JSX.Element {
  return spinning ? <span className="hiw-spin">{glyph}</span> : <>{glyph}</>
}
