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

  it('offers rerun always and rerun-failures only when the result has failures', () => {
    expect(src).toMatch(/onRerun\(r\.configId, false\)/)
    expect(src).toMatch(/r\.counts\.failed \+ r\.counts\.errored > 0 && \(/)
    expect(src).toMatch(/onRerun\(r\.configId, true\)/)
    for (const key of ['tests.rerun', 'tests.rerunFailures', 'tests.counts']) expect(src).toContain(`'${key}'`)
  })

  it('says when a result is stale, stopped, unknown or cut, and when there is none', () => {
    for (const key of ['tests.stale', 'tests.outcome.stopped', 'tests.outcome.unknown', 'tests.truncated', 'tests.empty']) expect(src).toContain(`'${key}'`)
  })

  it('opens a case at its place, and the app says how far a rerun narrowed', () => {
    expect(src).toMatch(/const at = caseLocation\(r, n\.case\)/)
    expect(src).toMatch(/onOpen\(at\.path, at\.line\)/)
    expect(app).toMatch(/window\.api\.tests\s*\.rerun\(currentProject, configId, failuresOnly\)/)
    expect(app).toContain("'tests.scope.files'")
    expect(app).toContain("'tests.scope.all'")
    expect(app).toMatch(/window\.api\.on\('tests:changed'/)
  })
})
