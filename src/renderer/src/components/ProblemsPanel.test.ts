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
    // Final review M4: filtered and sorted on what the row shows, not the absolute path or the English label
    expect(src).toMatch(/sortDiagnostics\(filterDiagnostics\(problems \?\? \[\], \{ severities, text, shown \}\), sort, sourceOf\)/)
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
    // Final review M5: a keyboard opens it too
    expect(src).toMatch(/role=\{openable \? 'button' : undefined\}\s*tabIndex=\{openable \? 0 : undefined\}/)
    expect(src).toMatch(/onKeyDown=\{\s*openable\s*\? \(e\) => \{\s*if \(e\.key !== 'Enter' && e\.key !== ' '\) return/)
  })

  it('marks a stale problem and says why on hover', () => {
    expect(src).toMatch(/d\.stale !== undefined && \(\s*<span className="problem-stale" title=\{t\(d\.stale === 'changed' \? 'problems\.stale\.changedHint' : 'problems\.stale\.missingHint'\)\}>/)
  })

  it('says why the list is empty, and what it is made of', () => {
    for (const key of ['problems.noProject', 'problems.empty', 'problems.filteredEmpty', 'problems.unavailable', 'problems.scope', 'problems.loading']) {
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
    expect(app).toMatch(/\}, \[problemsOn, currentProject, orchSnapshot, problemsAsk\]\)/)
    expect(app).toMatch(/window\.addEventListener\('focus', again\)/)
  })

  it('opens a problem in the editor at its line, and has an action that opens the tab', () => {
    expect(app).toMatch(/onOpenProblem=\{\(file, line\) => openFile\(file, line !== undefined \? \{ line \} : undefined\)\}/)
    expect(app).toMatch(/'problems\.open': \{\s*blockedBy: \(\) =>\s*workspaceFeaturesRef\.current\?\.problemsTab !== true \? 'action\.blocked\.featureOff' : currentProject \? null : 'action\.blocked\.noProject',\s*run: \(\) => \{\s*setRunPanelOpen\(true\)\s*setBottomTab\('problems'\)/)
  })
})

describe('ProblemsPanel, rows without a place (final review I2, M10, C1)', () => {
  it('says a failed check with no words of its own failed, and counts findings it kept no detail of', () => {
    expect(src).toMatch(/d\.unlisted !== undefined \? t\('problems\.unlisted', \{ count: d\.unlisted \}\) : d\.message !== '' \? d\.message : t\('problems\.checkFailed'\)/)
  })

  it('shows a name it would not look at, dimmed, with why on hover, and never opens it', () => {
    expect(src).toMatch(/d\.unresolved !== undefined && \(\s*<span className="problem-where unresolved" title=\{t\('problems\.unresolvedHint'\)\}>/)
  })

  // Final review M5: the sort control is named for what it is, whatever is chosen
  it('names the sort control', () => {
    expect(src).toMatch(/ariaLabel=\{t\('problems\.sort'\)\}/)
  })

  // Final review M2: a project just opened shows no other project's list
  it('says it is reading while the list for this project is not known yet', () => {
    expect(src).toMatch(/problems === undefined\s*\? t\('problems\.loading'\)/)
  })
})

describe('the Problems tab, badge and switching (final review M3, M5, M11)', () => {
  it('counts errors and warnings on the tab, red only when there is an error', () => {
    expect(bottom).toMatch(/const problemTally = problemCounts\(problems \?\? \[\]\)/)
    expect(bottom).toMatch(/const problemsShown = problemTally\.error \+ problemTally\.warning/)
    expect(bottom).toMatch(/className=\{`bottom-tab-badge\$\{problemTally\.error === 0 \? ' quiet' : ''\}`\}/)
  })

  it('stays on the Problems tab when the project or its terminals change', () => {
    expect(app).toMatch(/setBottomTab\(\(cur\) => \(cur === 'run' \|\| cur === 'kube' \|\| cur === 'problems' \|\|/)
  })

  // Final review I1, M2: asked again on main's ping and after a save in the editor; cleared on a project change
  it('is asked again when main says it may differ and after a save, and starts unknown for a new project', () => {
    expect(app).toMatch(/const off = window\.api\.on\('problems:changed', again\)/)
    expect(app).toMatch(/onFileSavedRef\.current\(tab\.path\)\s*setProblemsAsk\(\(n\) => n \+ 1\)/)
    expect(app).toMatch(/useEffect\(\(\) => \{\s*setProblems\(undefined\)\s*\}, \[currentProject\]\)/)
  })

  // Final review M6: the block sits above kubeRail's own doc
  it('leaves kubeRail its doc comment', () => {
    expect(app).toMatch(/\/\*\* The rail's Kubernetes icon: opens the panel on the Kubernetes tab, or collapses it while that tab shows\. \*\/\s*const kubeRail = /)
  })
})
