// The Settings "Reviewer" group (external reviewers). The renderer tests run in node with no DOM, so what the component
// does on a save is guarded in its source, as other components' wiring is.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ReviewerSettings.tsx'), 'utf8')

describe('ReviewerSettings', () => {
  // Final fix wave E3: the Test result shown for a reviewer described its old command
  it('clears the shown Test result of a reviewer whose edit is saved', () => {
    const start = source.indexOf('const saveEdit = ')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n  }\n', start))
    expect(body).toContain('setResults((r) => withoutKey(r, id))')
    expect(body.indexOf('withoutKey')).toBeGreaterThan(body.indexOf("'error' in next"))
  })
})
