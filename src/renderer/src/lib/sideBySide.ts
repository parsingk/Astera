import type { DiffRow } from '../../../core/kube/lineDiff'

export interface SideRow {
  left: { no: number; text: string; kind: 'ctx' | 'del' | 'empty' }
  right: { no: number; text: string; kind: 'ctx' | 'add' | 'empty' }
}

const EMPTY = { no: 0, text: '', kind: 'empty' } as const

/** Lays unified diff rows out in two columns. A run of `del` followed by a run of `add` is paired line by line, the
 *  shorter side padded with `empty`; a lone run has an empty opposite side. */
export function toSideBySide(rows: DiffRow[]): SideRow[] {
  const out: SideRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.kind === 'ctx') {
      out.push({
        left: { no: row.oldNo ?? 0, text: row.text, kind: 'ctx' },
        right: { no: row.newNo ?? 0, text: row.text, kind: 'ctx' }
      })
      i++
      continue
    }
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++])
    while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k]
      const a = adds[k]
      out.push({
        left: d ? { no: d.oldNo ?? 0, text: d.text, kind: 'del' } : EMPTY,
        right: a ? { no: a.newNo ?? 0, text: a.text, kind: 'add' } : EMPTY
      })
    }
  }
  return out
}
