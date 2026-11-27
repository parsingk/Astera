// The Dusk theme sample (Phase 2 remaining): a themes-only plugin, declarative, which Astera installs without running
// anything and whose colours keep the floors every theme keeps.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../../src/core/plugins/manifest'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dusk-theme')
const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8')

describe('the Dusk theme sample', () => {
  it('is a declarative plugin with one theme, asking only for themes.register', () => {
    const parsed = parseManifest(JSON.parse(read('package.json')))
    if (!parsed.ok) throw new Error(parsed.problems.join('; '))
    const m = parsed.manifest
    expect(m.trust).toBe('declarative')
    expect(m.entry).toBeUndefined()
    expect(m.ui).toBeUndefined()
    expect(m.permissions).toEqual(['themes.register'])
    expect(m.contributes.themes?.map((t) => [t.id, t.base])).toEqual([['dusk', 'vega']])
  })

  it('says how to install it and links the guide', () => {
    expect(read('README.md')).toContain('astera plugins install --path examples/plugins/dusk-theme')
    expect(read('README.md')).toContain('docs/plugins.md#themes)')
  })
})
