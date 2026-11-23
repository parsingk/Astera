import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourcesUnder(p)
    return p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : []
  })

// A native <select> opens an OS-drawn list that ignores the app's theme; the one themed dropdown is Select.
describe('kube components', () => {
  it('use the app dropdown, not a native select', () => {
    const offenders = sourcesUnder(__dirname).filter((f) => /<select[\s>]/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
