import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The shortcut settings are pinned by their text: they need a DOM to render. What a stored binding means (an empty list
// is "no key") is core/keys/binding.ts resolveBindings, tested in binding.test.ts.
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'ShortcutSettings.tsx'), 'utf8')

// Phase 1 gate: the palette, go to file and find in files open only by their keys, so taking the key away turns them off
describe('leaving a shortcut without a key', () => {
  it('stores an empty list for the action and reads the overrides back', () => {
    expect(src).toMatch(/const unbind = async \(id: ActionId\): Promise<void> => \{\s*await window\.api\.keys\.set\(id, \[\]\)\s*onChanged\(await window\.api\.keys\.get\(\)\)/)
  })

  it('has a button per row, off while a key is being captured or when the action has no key already', () => {
    expect(src).toMatch(/onClick=\{\(\) => void unbind\(action\.id\)\}\s*disabled=\{capturing !== null \|\| keys\.length === 0\}\s*title=\{t\('shortcut\.unbind'\)\}\s*aria-label=\{t\('shortcut\.unbind'\)\}/)
    // Between change and default, so default stays last as the way back
    expect(src.indexOf("t('shortcut.edit')")).toBeLessThan(src.indexOf("t('shortcut.unbind')"))
    expect(src.indexOf("t('shortcut.unbind')")).toBeLessThan(src.indexOf("t('shortcut.resetOne')"))
  })
})
