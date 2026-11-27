import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The diff needs a DOM; its wiring is pinned by its text, as ProblemsPanel's is. Where a finding goes is decided by the
// command (core/review/diffFindings.ts) and grouped by lib/agentReview.ts.
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'DiffView.tsx'), 'utf8')
const block = readFileSync(path.join(here, 'ChangedFilesBlock.tsx'), 'utf8')
const runDetail = readFileSync(path.join(here, 'RunDetail.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')

describe('review findings on the diff (Phase 3 Part 4)', () => {
  it('shows a finding under its line with its state, history and fix button, and none for a dismissed or verified one', () => {
    expect(src).toMatch(/const grouped = useMemo\(\(\) => findingsByLine\(findings \?\? \[\]\), \[findings\]\)/)
    expect(src).toMatch(/grouped\.inline\.get\(r\.newNo\)/)
    // The chip by Problems' rule: none for a finding no one acted on
    expect(src).toMatch(/const chip = chipKeyOf\(f\.state, f\.history\)/)
    expect(src).toMatch(/\{chip !== null && <span className="diff-finding-state">\{t\(chip\)\}<\/span>\}/)
    expect(src).toMatch(/t\('agentReview\.finding\.history'\)/)
    expect(src).toMatch(/onFix !== undefined && f\.state !== 'dismissed' && f\.state !== 'verified'/)
    expect(src).toMatch(/t\('agentReview\.finding\.fix'\)/)
  })

  it('shows each history change with who, when, the move and its revision', () => {
    expect(src).toMatch(/t\('problems\.finding\.change', \{\s*when: localTime\(c\.at\),\s*who: t\(findingWhoKey\(c\.by\)\)/)
    expect(src).toMatch(/c\.revision !== undefined && <span className="diff-finding-revision">\{t\('agentReview\.finding\.revision', \{ sha: shortSha\(c\.revision\) \}\)\}<\/span>/)
  })

  it('lists findings of another revision and of the file above the rows', () => {
    expect(src).toMatch(/t\('agentReview\.finding\.otherRevision', \{ head: shortSha\(f\.head \?\? null\) \}\)/)
    expect(src).toMatch(/t\('agentReview\.finding\.file'\)/)
  })

  it('asks the diff for findings with the switch on, and hands a fix up through the Run detail to App', () => {
    expect(block).toMatch(/\.\.\.\(reviewOn \? \{ findings: true \} : \{\}\)/)
    expect(block).toMatch(/findings=\{diff\.findings\}/)
    expect(block).toMatch(/onFixFinding=\{onFixFinding\}/)
    expect(runDetail).toMatch(/onFixFinding=\{onFixFinding \? \(f\) => onFixFinding\(f, \{ job: run \? jobName\(run\) : runId, task: selectedTask\?\.title \?\? f\.taskId \}\) : undefined\}/)
    // Only with sending to an agent on as well (Part 1's switch): it is a repair request, this computer's Runs only
    expect(app).toMatch(/\.\.\.\(contextOn && workspaceFeatures\?\.agentReview === true\s*\? \{\s*onFixFinding: \(f: DiffFinding, names: \{ job: string; task: string \}\) =>/)
    expect(app).toMatch(/requestRepair\(\s*openRun\.projectPath,\s*\{ task: f\.taskId, finding: \[f\.ref\], texts: \{ \[f\.ref\]: f\.text \} \}/)
  })
})
