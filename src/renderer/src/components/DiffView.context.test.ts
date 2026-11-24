import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(path.join(here, f), 'utf8')

// W4 "diff hunk → Repair Job draft": a hunk of a Job's diff opens a new Job whose objective is filled in; nothing is
// created until the person presses Create in that form.
describe('a hunk to a repair Job draft', () => {
  it('offers a draft button on each hunk header row, only where a handler is given', () => {
    expect(read('DiffView.tsx')).toMatch(/r\.kind === 'hunk' && onDraftRepair && \(\s*<button type="button" className="diff-draft" onClick=\{\(\) => onDraftRepair\(i\)\}>/)
  })

  it('passes the file and its diff up from the changed files, and the handler down from the Job detail', () => {
    expect(read('ChangedFilesBlock.tsx')).toMatch(/onDraftRepair=\{onDraftRepair \? \(i\) => onDraftRepair\(f\.path, diff\.diff, i\) : undefined\}/)
    expect(read('RunDetail.tsx')).toMatch(/<ChangedFilesBlock door=\{door\} runId=\{runId\}[^>]*onDraftRepair=\{onDraftRepair\}/)
  })

  it('starts the new Job form from the objective it is given', () => {
    expect(read('NewRunModal.tsx')).toMatch(/const \[objective, setObjective\] = useState\(initialObjective \?\? ''\)/)
  })

  it('drafts only for this computer\'s Jobs of the explorer\'s project, closes the detail, and fills the form', () => {
    const app = read('../App.tsx')
    expect(app).toMatch(/\.\.\.\(openRun\.runtimeId === undefined\s*\?\s*\{\s*onOpenAuditLogs:[\s\S]{0,600}onDraftRepair: \(file: string, diff: string, rowIndex: number\) => openRepairDraft\(openRun, file, diff, rowIndex\)/)
    const open = app.slice(app.indexOf('const openRepairDraft = '), app.indexOf('const openRepairDraft = ') + 1200)
    expect(open).toMatch(/hunkAt\(diffLines\(diff\), rowIndex\)/)
    expect(open).toMatch(/setOpenRun\(null\)/)
    expect(open).toMatch(/setNewRunDraft\(repairObjective\(/)
    expect(open).toMatch(/setNewRunOpen\(true\)/)
    expect(app).toMatch(/initialObjective=\{newRunDraft \?\? undefined\}/)
  })
})
