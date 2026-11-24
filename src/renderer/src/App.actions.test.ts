import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// App.tsx cannot run without a full React + Electron harness, so its wiring is pinned by its text, as
// App.layoutWriteThrough.test.ts does. Every UI action runs through the action registry (ADR-007): the keydown listener
// only routes keys, the handlers live in actionImplRef (a Record over ActionId, so the compiler proves each action has
// one), and one effect registers a delegate for every action in ACTIONS. Mutation: branch on an action id in the
// listener again, register a hand-picked subset, or run the palette's choice without closing the palette first, and
// this fails.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')
const listener = src.slice(src.indexOf('  // The global shortcuts: one capture listener'), src.indexOf('  // One delegate per action'))

describe('App.tsx runs shortcuts through the action registry', () => {
  it('has a keydown listener that routes keys and never branches on an action id', () => {
    expect(listener).toContain("window.addEventListener('keydown', onKey, true)")
    expect(listener).toContain('focusKeepsKey(action, keyFocusOf(document.activeElement), spec.yieldsToTerminal)')
    expect(listener).toContain('if (!state.ok && !spec.swallowsWhenBlocked) return')
    expect(listener).toContain('if (state.ok) actionRegistry.run(action)')
    expect(listener).not.toMatch(/action === '/)
    expect(src).not.toMatch(/action === '[a-zA-Z]+\.[a-zA-Z]+'/)
  })

  it('registers a delegate for every action in ACTIONS under the core owner', () => {
    expect(src).toMatch(/ACTIONS\.map\(\(a\) =>\s*actionRegistry\.register\('core', a\.id,/)
    expect(src).toMatch(/const actionImplRef = useRef<Record<ActionId, ActionHandler> \| null>\(null\)/)
    expect(src).toMatch(/actionImplRef\.current = \{/)
  })

  it('treats an open palette as a modal, and closes it before running the chosen action', () => {
    expect(src).toMatch(/modalOpenRef\.current = modalOpenRef\.current \|\| paletteOpen \|\|/)
    expect(src).toMatch(/onRun=\{\(id\) => \{\s*setPaletteOpen\(false\)\s*actionRegistry\.run\(id\)/)
  })
})
