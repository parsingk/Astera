// A unified diff (`git diff` output) split into the rows the diff view draws (remote runtime design Phase 10). A hunk's
// header says how many lines each side has, and lines are read as hunk lines until both are used up, so a removed line
// that starts `---` is not taken for a file header.
export interface DiffRow {
  kind: 'meta' | 'hunk' | 'ctx' | 'add' | 'del'
  text: string
  oldNo?: number
  newNo?: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function diffLines(text: string): DiffRow[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        rows.push({ kind: 'add', text: line, newNo: newNo++ })
        newLeft--
        continue
      }
      if (line.startsWith('-')) {
        rows.push({ kind: 'del', text: line, oldNo: oldNo++ })
        oldLeft--
        continue
      }
      if (line.startsWith(' ') || line === '') {
        rows.push({ kind: 'ctx', text: line, oldNo: oldNo++, newNo: newNo++ })
        oldLeft--
        newLeft--
        continue
      }
    }
    const h = HUNK.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[3])
      oldLeft = h[2] === undefined ? 1 : Number(h[2])
      newLeft = h[4] === undefined ? 1 : Number(h[4])
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    rows.push({ kind: 'meta', text: line })
  }
  return rows
}

/** Rows drawn at a time: a diff of a megabyte is tens of thousands of rows, and drawing them all at once stalls the
 *  window (Phase 10 review I4). The rest come a page at a time on request. */
export const DIFF_ROWS_STEP = 2_000
