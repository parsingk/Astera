import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

const rendererSrc = join(__dirname, '..')

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourcesUnder(p)
    return p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : []
  })

// A native <select> opens an OS-drawn list that ignores the app's theme; the one themed dropdown is Select,
// which is the only file allowed to say so.
describe('renderer components', () => {
  it('use the app dropdown, not a native select', () => {
    const offenders = sourcesUnder(rendererSrc)
      .filter((f) => !f.endsWith(`${sep}components${sep}Select.tsx`))
      .filter((f) => /<select[\s>]/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(rendererSrc.length + 1).split(sep).join('/'))
    expect(offenders).toEqual([])
  })
})
