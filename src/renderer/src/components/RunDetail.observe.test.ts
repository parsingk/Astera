import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeyedRunDetail, RunDetail } from './RunDetail'
import { runDetailInstanceKey } from './securityText'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '..', 'styles.css'), 'utf8')

const app = readFileSync(path.join(here, '..', 'App.tsx'), 'utf8')

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

  it('renders Run detail under a key of the Run (and Runtime) it shows, so another Run is a new component', () => {
    const props = { open: { runId: 'run_1' } } as unknown as Parameters<typeof KeyedRunDetail>[0]
    const a = KeyedRunDetail(props)
    expect(a.type).toBe(RunDetail)
    expect(a.key).toBe(runDetailInstanceKey({ runId: 'run_1' }))
    expect(KeyedRunDetail({ ...props, open: { runId: 'run_2' } }).key).not.toBe(a.key)
    expect(KeyedRunDetail({ ...props, open: { runId: 'run_1', runtimeId: 'rt_1' } }).key).not.toBe(a.key)
  })

  it('is the component App renders for the open Run', () => {
    expect(app).toMatch(/<KeyedRunDetail\s/)
    expect(app).not.toMatch(/<RunDetail\s/)
  })
})
