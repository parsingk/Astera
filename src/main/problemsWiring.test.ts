// The Problems list's wiring in main and preload, read from the source like the other *Wiring tests: the parts are
// tested on their own (problems.test.ts, core/problems), and what could still go wrong is that ipc.ts stops connecting
// them.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ipc = readFileSync(path.resolve(__dirname, 'ipc.ts'), 'utf8')
const preload = readFileSync(path.resolve(__dirname, '../preload/index.ts'), 'utf8')
const types = readFileSync(path.resolve(__dirname, '../core/types.ts'), 'utf8')

describe('Problems wiring', () => {
  it('answers problems.list behind the files path guard, from the project\'s own Jobs', () => {
    expect(ipc).toMatch(/createProblems\(\{\s*producers: \[\s*completionProducer\(\{/)
    expect(ipc).toMatch(/runIdsOf: \(p\) => \{\s*const s = orch\?\.deps\.getState\(\)\s*return s \? idsOfProject\(s, repoPathOf\(core\.worktrees\.list\(\), p\), core\.worktrees\.list\(\)\) : new Set<string>\(\)/)
    expect(ipc).toMatch(/allowedRoot: assertAllowedPath\s*\}\)/)
    expect(ipc).toContain("ipcMain.handle('problems.list', (_e, project: unknown) => problems(project))")
  })

  it('is on window.api.problems, and its change ping is an event the renderer may listen to', () => {
    expect(preload).toMatch(/problems: \{\s*list: invoke\('problems\.list'\)/)
    expect(preload).toContain("'problems:changed',")
    expect(types).toMatch(/'problems:changed': null/)
  })

  // Final review I1: told of every orchestration write and every explorer file batch, it pings when the list may differ
  it('pings the renderer from orchestration writes and the explorer watcher', () => {
    expect(ipc).toMatch(/const problemsPing = createProblemsPing\(\{ send: \(\) => send\('problems:changed', null\) \}\)/)
    expect(ipc).toMatch(/const pushOrchState = \(state: OrchState\): void => \{\s*orchPushes\.push\(state\)\s*problemsPing\.onState\(state\)/)
    expect(ipc).toMatch(/fileIndex\.noteChanges\(batch\.changes\)\s*(?:\/\/[^\n]*\n\s*)*problemsPing\.touch\(\)/)
  })
})
