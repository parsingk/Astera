import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Phase 3 Part 2: the Tests tab needs a DOM; its wiring is pinned by its text, as the Problems tab's is
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'TestsPanel.tsx'), 'utf8')
const bottom = readFileSync(path.join(here, 'BottomPanel.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')

describe('TestsPanel', () => {
  it('shows the tab only with its switch on, beside the Problems tab', () => {
    expect(bottom).toMatch(/\{runAvailable && testsEnabled && \(/)
    expect(bottom).toContain('data-tab-id="tests"')
    expect(app).toMatch(/testsAvailable: workspaceFeatures\?\.testsTab === true/)
  })

  it('offers rerun always and rerun-failures only when this run’s result has failures', () => {
    expect(src).toMatch(/onRerun\(r\.configId, false\)/)
    // Screen check: a report an earlier run left is not this run's failures, so it offers no rerun of them
    expect(src).toMatch(/!r\.stale && r\.outcome === 'failed' && r\.counts\.failed \+ r\.counts\.errored > 0 && \(/)
    expect(src).toMatch(/onRerun\(r\.configId, true\)/)
    for (const key of ['tests.rerun', 'tests.rerunFailures', 'tests.counts']) expect(src).toContain(`'${key}'`)
  })

  // Final review M9: how long the run took, not the sum of its cases (parallel workers make that larger)
  it('shows how long the run took, and says so when a failure has no words', () => {
    expect(src).toMatch(/const took = Date\.parse\(r\.endedAt\) - Date\.parse\(r\.startedAt\)/)
    expect(src).not.toMatch(/sum \+ \(c\.durationMs/)
    expect(src).toMatch(/n\.case\.failure\.message \|\| t\('tests\.noMessage'\)/)
  })

  it('says when a result is stale, stopped, unknown or cut, and when there is none', () => {
    for (const key of ['tests.stale', 'tests.outcome.stopped', 'tests.outcome.unknown', 'tests.truncated', 'tests.empty']) expect(src).toContain(`'${key}'`)
  })

  it('opens a case at its place, and the app says how far a rerun narrowed', () => {
    expect(src).toMatch(/const at = caseLocation\(r, n\.case\)/)
    expect(src).toMatch(/onOpen\(at\.path, at\.line\)/)
    expect(app).toMatch(/window\.api\.tests\s*\.rerun\(currentProject, configId, failuresOnly\)/)
    // Final review M14: the toast names the reason (lib/testTree.ts rerunNote)
    expect(app).toMatch(/const note = failuresOnly \? rerunNote\(r\.scope, r\.why\) : null/)
    expect(app).toMatch(/window\.api\.on\('tests:changed'/)
  })
})
