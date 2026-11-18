/** Line diff for the confirmation dialog: an LCS over lines, refused above MAX_DIFF_LINES before any table exists. */

export interface DiffRow {
  kind: 'ctx' | 'add' | 'del'
  text: string
  oldNo?: number
  newNo?: number
}

export const MAX_DIFF_LINES = 4000

export type LineDiff = DiffRow[] | { tooLarge: true; added: number; removed: number }

function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function lineDiff(before: string, after: string): LineDiff {
  const a = toLines(before)
  const b = toLines(after)
  // Common head and tail never enter the table, so a one-line change in a big file stays cheap.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { tooLarge: true, added: b.length - head - tail, removed: a.length - head - tail }
  }

  const rows: DiffRow[] = []
  for (let i = 0; i < head; i++) rows.push({ kind: 'ctx', text: a[i], oldNo: i + 1, newNo: i + 1 })

  const n = a.length - head - tail
  const m = b.length - head - tail
  // lcs[i * w + j] = LCS length of a-middle[i..] and b-middle[j..]
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      rows.push({ kind: 'ctx', text: a[head + i], oldNo: head + i + 1, newNo: head + j + 1 })
      i++
      j++
    } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      rows.push({ kind: 'del', text: a[head + i], oldNo: head + i + 1 })
      i++
    } else {
      rows.push({ kind: 'add', text: b[head + j], newNo: head + j + 1 })
      j++
    }
  }

  for (let t = 0; t < tail; t++) {
    const oi = a.length - tail + t
    const ni = b.length - tail + t
    rows.push({ kind: 'ctx', text: a[oi], oldNo: oi + 1, newNo: ni + 1 })
  }
  return rows
}
