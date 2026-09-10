import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Every path that installs an update has to ask first.
//
// Why a scan rather than a test of the code: the question is not what one function does, it is
// whether some *other* place calls past it, and that is a fact about the whole renderer rather than
// about any one module. It got past a review exactly that way. `installUpdate` in App.tsx was
// written with the confirmation in it, and two buttons went straight to `window.api.update.install()`
// instead — the toolbar's restart button and the Settings Info row's — so half the ways a person can
// install an update never told them what it costs their running sessions. Nothing in either place
// looked wrong on its own; what was wrong was only visible by counting.
//
// The invariant is deliberately blunt, following the same reasoning as lineNumberCitations.test.ts:
// one call in the renderer, in App.tsx, and it is the one `installUpdate` makes after the person has
// answered. A fourth button added later has to go through it or turn this red. If `installUpdate`
// ever moves out of App.tsx, this fails and the fix is to name its new home here, deliberately,
// rather than to widen the rule.

const RENDERER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const EXTS = /\.tsx?$/
const CALL = 'window.api.update.install('

function collect(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) collect(full, out)
    else if (EXTS.test(e.name) && !e.name.endsWith('.test.ts') && !e.name.endsWith('.test.tsx'))
      out.push(full)
  }
  return out
}

describe('every update install path asks first', () => {
  const files = collect(RENDERER_ROOT, [])
  const hits = files.flatMap((f) => {
    const src = readFileSync(f, 'utf8')
    return src.includes(CALL) ? [{ file: path.relative(RENDERER_ROOT, f), src }] : []
  })

  it('installs the update from one place only', () => {
    const occurrences = hits.flatMap((h) => h.src.split(CALL).slice(1).map(() => h.file))
    expect(occurrences, 'every other button must call installUpdate, which confirms first').toEqual([
      'App.tsx'
    ])
  })

  it('that one place is installUpdate, after the confirmation', () => {
    const app = hits.find((h) => h.file === 'App.tsx')
    expect(app, 'App.tsx should hold the single install call').toBeDefined()
    const src = app?.src ?? ''
    const call = src.indexOf(CALL)
    const declaration = src.indexOf('const installUpdate =')
    expect(declaration).toBeGreaterThanOrEqual(0)
    expect(call).toBeGreaterThan(declaration)
    // The confirmation is between the two, so no rewrite can leave the call in place and drop the
    // question above it without this noticing.
    expect(src.slice(declaration, call)).toContain('updateConfirmBody')
  })
})
