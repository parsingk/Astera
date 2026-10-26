import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '..', 'styles.css'), 'utf8')
const app = readFileSync(path.join(here, '..', 'App.tsx'), 'utf8')
const detail = readFileSync(path.join(here, 'RunDetail.tsx'), 'utf8')

const rule = (selector: string): string => {
  const m = css.match(new RegExp(`^${selector.replaceAll('.', '[.]')}\\s*[{]([^}]*)[}]`, 'm'))
  return m?.[1] ?? ''
}

describe('Run detail observe line', () => {
  it('writes the cached-input note in the colour of the other secondary notes there, not a fainter one', () => {
    expect(rule('.detail-observe')).toContain('color: var(--text-dim)')
    expect(rule('.detail-observe-note')).toContain('color: var(--text-dim)')
    expect(rule('.detail-observe-note')).not.toContain('--text-faint')
  })

  it('is keyed by the Run it shows, and a failed read is recorded as one', () => {
    expect(app).toContain('key={runDetailInstanceKey(openRun)}')
    expect(detail).toContain('afterObserveRead(')
  })
})
