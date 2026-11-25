import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The panel needs a DOM; its wiring is pinned by its text, as the palette's is. What it decides is in
// core/problems/diagnostic.ts (sort, filter, counts) and main/problems.ts (where a file is, whether it is stale).
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'ProblemsPanel.tsx'), 'utf8')
const bottom = readFileSync(path.join(here, 'BottomPanel.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')

describe('ProblemsPanel', () => {
  // Spec W5: filter, sort, jump to the place, and a stale mark
  it('filters by severity with counts and by text, and sorts as asked', () => {
    expect(src).toMatch(/const counts = problemCounts\(problems \?\? \[\]\)/)
    expect(src).toMatch(/filterDiagnostics\(problems \?\? \[\], \{ severities, text \}\)/)
    expect(src).toMatch(/sortDiagnostics\(/)
    expect(src).toMatch(/t\(SEVERITY_KEY\[s\], \{ count: counts\[s\] \}\)/)
    for (const key of ['problems.severity.error', 'problems.severity.warning', 'problems.severity.info']) expect(src).toContain(`'${key}'`)
    for (const key of ['problems.filter', 'problems.sort.severity', 'problems.sort.file', 'problems.sort.source', 'problems.refresh']) {
      expect(src).toContain(`t('${key}'`)
    }
  })

  // Review focus 1 and 4: a row opens its file at its line; a problem with no file, or whose file is gone, opens nothing.
  it('opens a row at its line only when it has a file that is there', () => {
    expect(src).toMatch(/const openable = d\.path !== undefined && d\.stale !== 'missing'/)
    expect(src).toMatch(/onClick=\{openable \? \(\) => onOpen\(d\.path as string, d\.line\) : undefined\}/)
  })

  it('marks a stale problem and says why on hover', () => {
    expect(src).toMatch(/d\.stale !== undefined && \(\s*<span className="problem-stale" title=\{t\(d\.stale === 'changed' \? 'problems\.stale\.changedHint' : 'problems\.stale\.missingHint'\)\}>/)
  })

  it('says why the list is empty, and what it is made of', () => {
    for (const key of ['problems.noProject', 'problems.empty', 'problems.filteredEmpty', 'problems.unavailable', 'problems.scope']) {
      expect(src).toContain(`t('${key}')`)
    }
  })

  it('names a review finding in the app\'s words, and a check by its name', () => {
    expect(src).toMatch(/d\.source\.kind === 'review' \? t\('problems\.source\.review'\) : d\.source\.label/)
  })
})

describe('the Problems tab', () => {
  it('sits in the bottom panel with a project, its errors and warnings counted on it', () => {
    expect(bottom).toMatch(/data-tab-id="problems"/)
    expect(bottom).toMatch(/<ProblemsPanel\s+projectRoot=\{problemsRoot\}\s+problems=\{problems\}/)
  })

  it('is asked again when the project or its Jobs change and when the window comes back', () => {
    expect(app).toMatch(/window\.api\.problems\s*\.list\(currentProject\)/)
    expect(app).toMatch(/\}, \[currentProject, orchSnapshot, problemsAsk\]\)/)
    expect(app).toMatch(/window\.addEventListener\('focus', again\)/)
  })

  it('opens a problem in the editor at its line, and has an action that opens the tab', () => {
    expect(app).toMatch(/onOpenProblem=\{\(file, line\) => openFile\(file, line !== undefined \? \{ line \} : undefined\)\}/)
    expect(app).toMatch(/'problems\.open': \{\s*blockedBy: \(\) => \(currentProject \? null : 'action\.blocked\.noProject'\),\s*run: \(\) => \{\s*setRunPanelOpen\(true\)\s*setBottomTab\('problems'\)/)
  })
})
