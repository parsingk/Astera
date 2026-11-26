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
    expect(ipc).toMatch(/await testResults\.record\(base \? \{ \.\.\.r, scope: 'failures' \} : r, base\)\s*problemsPing\.touch\(\)\s*send\('tests:changed', e\.projectPath\)/)
    // Final review M5 and M6: the configurations that name a test report now, under their name now
    expect(ipc).toMatch(/new Map\(core\.runConfig\.get\(project\)\.filter\(\(c\) => c\.testReport !== undefined\)\.map\(\(c\) => \[c\.id, c\.name\]\)\)/)
    expect(ipc).toMatch(/return testResults\.load\(project, testConfigsOf\(project\)\)/)

    // The Problems list's test producer reads the same results
    expect(ipc).toMatch(/testProducer\(\{\s*results: \(p\) => testResults\.load\(p, testConfigsOf\(p\)\),\s*stat: statMtime\s*\}\)/)
  })

  // Final review M6: a configuration removed, or no longer naming a report, takes its result with it
  it('forgets the result of a configuration a save removed or took the report from', () => {
    expect(ipc).toMatch(/const reporting = \[\.\.\.testConfigsOf\(projectPath\)\.keys\(\)\]\s*const saved = await saveConfigsBatch\(/)
    expect(ipc).toMatch(/const gone = reporting\.filter\(\(id\) => !still\.has\(id\)\)/)
    expect(ipc).toMatch(/Promise\.all\(gone\.map\(\(id\) => testResults\.forget\(id\)\)\)/)
  })

  // A rerun of the failures: worked out in main from the stored result, added to the root configuration's command only,
  // and merged into the result it reran
  it('reruns from the stored result, adds to the root command only, and marks the run for the merge', () => {
    expect(ipc).toMatch(/plan = rerunArgs\(config, base, buildRunContext\(files, process\.platform\)\)/)
    expect(ipc).toMatch(/command: stepId === configId && append !== '' \? `\$\{step\.command\}\$\{append\}` : step\.command/)
    // Final review I1: on the root configuration's own run, whenever a before-launch chain gets to it, with the result it
    // reran (M1); kept through an exit the app lost sight of
    expect(ipc).toMatch(/if \(stepId === configId\) onRoot\?\.\(started\)/)
    expect(ipc).toMatch(/startChain\(projectPath, configId, plan\.append, reran \? \(root\) => rerunBases\.set\(root\.runId, reran\) : undefined\)/)
    expect(ipc).toMatch(/const base = rerunBases\.get\(e\.runId\)\s*if \(e\.exitCode !== PTY_LOST_SIGHT_EXIT_CODE\) rerunBases\.delete\(e\.runId\)/)
  })
})
