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
    expect(src).toMatch(/onClick=\{openable \? \(\) => onOpen\(d\.path as string, d\.line, d\.column\) : undefined\}/)
    // Final review M5: a keyboard opens it too
    expect(src).toMatch(/role=\{openable \? 'button' : undefined\}\s*tabIndex=\{openable \? 0 : undefined\}/)
    expect(src).toMatch(/onKeyDown=\{\s*openable\s*\? \(e\) => \{\s*if \(e\.key !== 'Enter' && e\.key !== ' '\) return/)
  })

  // Phase 3 Part 1: rows are chosen with a checkbox and sent to an agent, or fixed by one; nothing of it with the bridge off
  it('sends or fixes the chosen rows, and shows neither the checkboxes nor the buttons with the bridge off', () => {
    expect(src).toMatch(/actions\?: \{\s*send: \(rows: Diagnostic\[\]\) => void\s*fix: \(rows: Diagnostic\[\]\) => void\s*dismiss: \(rows: Diagnostic\[\]\) => void\s*undismiss: \(rows: Diagnostic\[\]\) => void\s*\}/)
    expect(src).toMatch(/const chosen = rows\.filter\(\(d\) => selected\.has\(d\.id\)\)/)
    for (const key of ['problems.send', 'problems.fix', 'problems.choose']) expect(src).toContain(`t('${key}'`)
    expect(src).toMatch(/\{actions !== undefined && \(/)
    expect(src).toMatch(/disabled=\{chosen\.length === 0\}/)
    // A checkbox does not open the row's file
    expect(src).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/)
    expect(bottom).toMatch(/actions=\{problemActions\}/)
  })

  // Final review I4 and M13 (Phase 3 Part 3): a root or file no language server checked is said in the person's
  // language, and is a note, not a finding to send or fix
  it('words what was not checked, with the server and the folder, and offers no checkbox on it', () => {
    for (const key of ['problems.unchecked.not-installed', 'problems.unchecked.room', 'problems.unchecked.crashed', 'problems.unchecked.refused', 'problems.unchecked.too-large'])
      expect(src).toContain(`'${key}'`)
    expect(src).toMatch(/d\.unchecked !== undefined\s*\? t\(UNCHECKED_KEY\[d\.unchecked\], \{ server: d\.source\.label, folder: folderOf\(d\.root\) \}\)/)
    expect(src).toMatch(/\{actions !== undefined && d\.unchecked === undefined && \(/)
  })

  // Phase 3 Part 1b: a finding a person acted on says where it stands; its chip opens its history under the row
  it('shows a recorded finding’s state as a chip that opens its history, and dims a dismissed row', () => {
    expect(src).toMatch(/const chip = findingChipKey\(d\)/)
    expect(src).toMatch(/className=\{`problem-finding \$\{d\.finding\.state\}`\}/)
    expect(src).toMatch(/aria-expanded=\{history\.has\(d\.id\)\}/)
    expect(src).toMatch(/history\.has\(d\.id\) && d\.finding !== undefined && \(/)
    expect(src).toContain('className="problem-history"')
    expect(src).toMatch(/d\.finding\?\.state === 'dismissed' \? ' dismissed' : ''/)
    for (const key of ['problems.finding.change', 'problems.finding.new', 'problems.finding.historyHint']) expect(src).toContain(`'${key}'`)
  })

  it('dismisses the chosen rows, or takes the dismissal back when every chosen row is dismissed', () => {
    expect(src).toMatch(/const allDismissed = chosen\.length > 0 && chosen\.every\(\(d\) => d\.finding\?\.state === 'dismissed'\)/)
    expect(src).toMatch(/disabled=\{dismissGroups\(chosen\) === null\}/)
    expect(src).toMatch(/act\(allDismissed \? actions\.undismiss : actions\.dismiss\)/)
    expect(src).toMatch(/t\(allDismissed \? 'problems\.undismiss' : 'problems\.dismiss'\)/)
    // The app asks for the note, then one command per Task; taking it back asks nothing
    expect(app).toMatch(/const dismissProblems = async \(rows: Diagnostic\[\]\): Promise<void> => \{[\s\S]*?confirmModalWithInput\(\{[\s\S]*?changeFindings\(root, 'tasks-dismiss', groups, note\)/)
    expect(app).toMatch(/const undismissProblems = async \(rows: Diagnostic\[\]\): Promise<void> => \{[\s\S]*?changeFindings\(root, 'tasks-undismiss', groups\)/)
    expect(app).not.toMatch(/const undismissProblems = async \(rows: Diagnostic\[\]\): Promise<void> => \{[^}]*confirmModal/)
    expect(app).toMatch(/for \(const g of groups\)[\s\S]{0,200}window\.api\.orch\s*\.command\(root, cmd, \{ task: g\.task, finding: g\.finding/)
  })

  it('wires sending through the W4 preview and fixing through a dry run first, then the draft on a refusal', () => {
    expect(app).toMatch(/problemActions=\{contextOn \? \{ send: sendProblems, fix: fixProblems, dismiss: dismissProblems, undismiss: undismissProblems \} : undefined\}/)
    expect(app).toMatch(/const made = problemsContext\(\{ rows, root, files \}\)/)
    expect(app).toMatch(/openContextPreview\(made\.ref, contextText\(made\.ref, made\.excerpt, made\.language\)\)/)
    // Phase 3 Part 4: the dry run, the confirmation and the call are one flow, requestRepair, the diff's findings use too
    expect(app).toMatch(/const dry = repairAnswer\(await call\(\{ \.\.\.request, dryRun: true \}\)\)/)
    // A refusal offers the draft whenever it comes: from the dry run, or from the real call after the state moved (M10)
    expect(app).toMatch(/if \(dry\.kind === 'refused'\) return onRefused\(dry\.key\)/)
    expect(app).toMatch(/else if \(asked\.kind === 'refused'\) await onRefused\(asked\.key\)/)
    expect(app).toMatch(/await requestRepair\(root, request, \{ job: origin\.job \?\? origin\.runId, task: origin\.task, count: rows\.length \}, offerDraft\)/)
    expect(app).toMatch(/openProblemsDraft\(rows\)/)
    // Rows of two folders: said, nothing opens (I3)
    expect(app).toMatch(/if \(made\.reason === 'folders'\) toast\.info\(t\('problems\.send\.folders'\)\)/)
  })

  // Phase 3 Part 4: the revision a change was made on shows in the history
  it('shows a history change’s revision in Problems', () => {
    expect(src).toMatch(/c\.revision !== undefined && <span className="problem-history-revision">\{t\('agentReview\.finding\.revision', \{ sha: c\.revision\.slice\(0, 7\) \}\)\}<\/span>/)
  })

  it('marks a stale problem and says why on hover', () => {
    expect(src).toMatch(/d\.stale !== undefined && \(\s*<span className="problem-stale" title=\{t\(STALE_HINT_KEY\[d\.stale\]\)\}>\s*\{t\(STALE_KEY\[d\.stale\]\)\}/)
    // Phase 3 Part 4: a review finding whose Task moved to another revision
    for (const key of ['problems.stale.changed', 'problems.stale.missing', 'problems.stale.revision', 'problems.stale.changedHint', 'problems.stale.missingHint', 'problems.stale.revisionHint'])
      expect(src).toContain(`'${key}'`)
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
    expect(app).toMatch(/onOpenProblem=\{\(file, line, column\) => openFile\(file, line !== undefined \? \{ line, \.\.\.\(column !== undefined \? \{ col: column \} : \{\}\) \} : undefined\)\}/)
    expect(app).toMatch(/'problems\.open': \{\s*blockedBy: \(\) =>\s*workspaceFeaturesRef\.current\?\.problemsTab !== true \? 'action\.blocked\.featureOff' : currentProject \? null : 'action\.blocked\.noProject',\s*run: \(\) => \{\s*setRunPanelOpen\(true\)\s*setBottomTab\('problems'\)/)
  })
})

describe('ProblemsPanel, rows without a place (final review I2, M10, C1)', () => {
  it('says a failed check with no words of its own failed, and counts findings it kept no detail of', () => {
    expect(src).toMatch(/d\.unlisted !== undefined\s*\? t\('problems\.unlisted', \{ count: d\.unlisted \}\)\s*: d\.message !== ''\s*\? d\.message\s*: t\('problems\.checkFailed'\)/)
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
    // The language servers hear of the save first (Phase 3 Part 3)
    expect(app).toMatch(/onFileSavedRef\.current\(tab\.path\)\s*void window\.api\.lsp\.saved\(\[tab\.path\]\)\.catch\(\(\) => \{\}\)\s*setProblemsAsk\(\(n\) => n \+ 1\)/)
    expect(app).toMatch(/useEffect\(\(\) => \{\s*setProblems\(undefined\)\s*\}, \[currentProject\]\)/)
  })

  // Final review M6: the block sits above kubeRail's own doc
  it('leaves kubeRail its doc comment', () => {
    expect(app).toMatch(/\/\*\* The rail's Kubernetes icon: opens the panel on the Kubernetes tab, or collapses it while that tab shows\. \*\/\s*const kubeRail = /)
  })
})
