import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Phase 3 Part 2: how main keeps a person's test results. ipc.ts needs Electron to load, so its wiring is pinned by its
// text; resultOfRun and the store are tested on their own (testResults.test.ts).
const ipc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')

describe('test results in main', () => {
  it('records a person’s run as it ends, tells Problems and the Tests tab, and lists only stored configurations', () => {
    expect(ipc).toMatch(/if \(e\.status === 'exited' && e\.validation !== true\) void recordTestRun\(e\)/)
    expect(ipc).toMatch(/resultOfRun\(\{ status: e, config, cwd: core\.run\.cwdOf\(e\.runId\) \?\? e\.projectPath, read: readTestReport \}\)/)
    expect(ipc).toMatch(/await testResults\.record\(partial \? \{ \.\.\.r, scope: 'failures' \} : r\)\s*problemsPing\.touch\(\)\s*send\('tests:changed', e\.projectPath\)/)
    expect(ipc).toMatch(/testResults\.load\(project, new Set\(core\.runConfig\.get\(project\)\.map\(\(c\) => c\.id\)\)\)/)

    // The Problems list's test producer reads the same results, for the configurations the project still has
    expect(ipc).toMatch(/testProducer\(\{\s*results: \(p\) => testResults\.load\(p, new Set\(core\.runConfig\.get\(p\)\.map\(\(c\) => c\.id\)\)\),\s*stat: statMtime\s*\}\)/)
  })

  // A rerun of the failures: worked out in main from the stored result, added to the root configuration's command only,
  // and merged into the result it reran
  it('reruns from the stored result, adds to the root command only, and marks the run for the merge', () => {
    expect(ipc).toMatch(/plan = rerunArgs\(config, result, buildRunContext\(files, process\.platform\)\)/)
    expect(ipc).toMatch(/command: stepId === configId && append !== '' \? `\$\{step\.command\}\$\{append\}` : step\.command/)
    expect(ipc).toMatch(/if \(plan\.scope !== 'all'\) rerunScopes\.add\(status\.runId\)/)
    expect(ipc).toMatch(/const partial = rerunScopes\.delete\(e\.runId\)/)
  })
})
