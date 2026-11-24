import { contextText, type ContextRef } from '../../../core/context/contextRef'
import type { DiffRow } from './diffLines'

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** One hunk of a diff, from the rows diffLines made: its header row at `index` and the rows up to the next hunk or file.
 *  `startLine`/`endLine` are on the new side (the file as the Job left it), 1-based; a hunk that only removes lines
 *  covers the one line where they were. null when that row is not a hunk header. */
export function hunkAt(
  rows: readonly DiffRow[],
  index: number
): { header: string; text: string; startLine: number; endLine: number } | null {
  const head = rows[index]
  if (!head || head.kind !== 'hunk') return null
  const m = HUNK.exec(head.text)
  if (!m) return null
  const startLine = Number(m[3])
  const count = m[4] === undefined ? 1 : Number(m[4])
  const body: string[] = []
  for (let i = index + 1; i < rows.length && rows[i].kind !== 'hunk' && rows[i].kind !== 'meta'; i++) body.push(rows[i].text)
  return { header: head.text, text: [head.text, ...body].join('\n'), startLine, endLine: Math.max(startLine, startLine + count - 1) }
}

/**
 * The objective of a repair Job drafted from a hunk (spec W4 "diff hunk → Repair Job draft"): which file and lines, which
 * Job made the change, a line left for the person to say what is wrong, and the hunk itself as context, masked and
 * capped as every piece handed to an agent is (core/context/contextRef.ts). English, as every prompt Astera writes for
 * an agent is; the person edits it in the form before anything is created.
 */
export function repairObjective(input: {
  file: string
  hunk: { text: string; startLine: number; endLine: number }
  projectPath: string
  runId: string
}): string {
  const { file, hunk } = input
  const lines = hunk.startLine === hunk.endLine ? `line ${hunk.startLine}` : `lines ${hunk.startLine}-${hunk.endLine}`
  const ref: ContextRef = {
    schemaVersion: 1,
    kind: 'diff',
    root: input.projectPath,
    path: file,
    range: { startLine: hunk.startLine, endLine: hunk.endLine },
    sourceId: input.runId,
    label: `${file}:${hunk.startLine === hunk.endLine ? hunk.startLine : `${hunk.startLine}-${hunk.endLine}`}`
  }
  return [`Repair the change below in ${file} (${lines}), made by Job ${input.runId}.`, 'What is wrong: ', '', contextText(ref, hunk.text, 'diff').text].join('\n')
}
