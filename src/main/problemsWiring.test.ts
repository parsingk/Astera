// The Problems list's wiring in main and preload, read from the source like the other *Wiring tests: the parts are
// tested on their own (problems.test.ts, core/problems), and what could still go wrong is that ipc.ts stops connecting
// them.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ipc = readFileSync(path.resolve(__dirname, 'ipc.ts'), 'utf8')
const preload = readFileSync(path.resolve(__dirname, '../preload/index.ts'), 'utf8')

describe('Problems wiring', () => {
  it('answers problems.list behind the files path guard, from the project\'s own Jobs', () => {
    expect(ipc).toMatch(/createProblems\(\{\s*producers: \[\s*completionProducer\(\{/)
    expect(ipc).toMatch(/runIdsOf: \(p\) => \{\s*const s = orch\?\.deps\.getState\(\)\s*return s \? idsOfProject\(s, repoPathOf\(core\.worktrees\.list\(\), p\), core\.worktrees\.list\(\)\) : new Set<string>\(\)/)
    expect(ipc).toMatch(/allowedRoot: assertAllowedPath\s*\}\)/)
    expect(ipc).toContain("ipcMain.handle('problems.list', (_e, project: unknown) => problems(project))")
  })

  it('is on window.api.problems', () => {
    expect(preload).toMatch(/problems: \{\s*list: invoke\('problems\.list'\)/)
  })
})
