import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The block needs a DOM; its wiring is pinned by its text, as ProblemsPanel's is. What it says is in lib/agentReview.ts.
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'ChangedFilesBlock.tsx'), 'utf8')
const runDetail = readFileSync(path.join(here, 'RunDetail.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')

describe('ChangedFilesBlock and the agent-aware review (Phase 3 Part 4)', () => {
  it('reads the Task’s attempts and offers its whole range or one attempt’s, with the switch on', () => {
    expect(src).toMatch(/reviewOn: boolean/)
    expect(src).toMatch(/doorRef\.current\.command\('dispatch-show', \{ task: taskId \}\)/)
    expect(src).toMatch(/<Select[\s\S]{0,400}agentReview\.scope\.task/)
  })

  it('sends the attempt and asks for attribution only with the switch on', () => {
    expect(src).toMatch(/\.\.\.\(reviewOn && attempt !== null \? \{ dispatchId: attempt \} : \{\}\)/)
    expect(src).toMatch(/\.\.\.\(reviewOn \? \{ attribution: true \} : \{\}\)/)
  })

  it('names the ranges read and badges each file with who changed it', () => {
    expect(src).toMatch(/className=\{`changed-file-attr is-\$\{badge\.tone\}`\}/)
    expect(src).toMatch(/title=\{attributionTitle\(t, a\)\}/)
  })

  // Final review M7, M9, M11: the limit on screen, the switch turned off drops an open diff's findings, Task parts named
  it('says the limit under the ranges, drops an open diff when the switch turns, and names each Task part’s range', () => {
    expect(src).toMatch(/<p className="modal-hint changed-files-limit">\{t\('agentReview\.limit'\)\}<\/p>/)
    expect(src).toMatch(/const scope = `\$\{runId\} \$\{taskId \?\? ''\} \$\{attempt \?\? ''\} \$\{reviewOn\}`/)
    expect(src).toMatch(/useEffect\(\(\) => \{\s*setDiff\(null\)\s*\}, \[reviewOn\]\)/)
    expect(src).toMatch(/partRangeLabel\(t, r, r\.taskId !== undefined \? taskTitleOf\?\.\(r\.taskId\) : undefined\)/)
  })

  it('falls back to the Task’s list when a runtime does not echo the attempt', () => {
    expect(src).toMatch(/attempt !== null && reply\.dispatchId !== attempt/)
    expect(src).toContain("t('agentReview.attemptUnsupported')")
  })

  it('gets the switch from App through the Run detail', () => {
    expect(runDetail).toMatch(/<ChangedFilesBlock door=\{door\} runId=\{runId\}[^\n]*reviewOn=\{reviewOn\}/)
    expect(app).toMatch(/reviewOn=\{workspaceFeatures\?\.agentReview === true\}/)
  })
})
