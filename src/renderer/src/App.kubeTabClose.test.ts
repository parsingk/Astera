import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// App.tsx cannot run without a full React + Electron harness, so its wiring is pinned by its text, as
// App.layoutWriteThrough.test.ts does. Closing a cluster object's editor tab only drops the tab: its id is the whole
// record. Without its own branch the id would fall through to closeSession and be read as a session id, killing
// whatever that names (Task 14 minor). Mutation: delete the 'kube' branch, or move it below closeSession, and this fails.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')

describe('App.tsx closes a cluster object tab without closing a session', () => {
  const start = src.indexOf('const closeWorkbenchTab = (tabId: string): void => {')
  const body = src.slice(start, src.indexOf('closeWorkbenchTabRef.current = closeWorkbenchTab', start))

  it('has a kube branch ahead of the fall-through to closeSession', () => {
    expect(start).toBeGreaterThan(-1)
    const kube = body.indexOf("if (ref.kind === 'kube') {")
    expect(kube).toBeGreaterThan(-1)
    expect(kube).toBeLessThan(body.lastIndexOf('closeSession(ref.id)'))
  })

  it('only drops the tab from the tree there, and returns', () => {
    const kube = body.indexOf("if (ref.kind === 'kube') {")
    const branch = body.slice(kube, body.indexOf('}', kube) + 1)
    expect(branch).toMatch(/dropTabFromTree\(tabId\)\s*return\s*\}$/)
    expect(branch).not.toContain('closeSession')
  })
})
