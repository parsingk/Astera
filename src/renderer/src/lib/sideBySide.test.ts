import { describe, it, expect } from 'vitest'
import type { DiffRow } from '../../../core/kube/lineDiff'
import { toSideBySide } from './sideBySide'

describe('toSideBySide', () => {
  it('pairs a del run with the add run after it and pads the shorter side', () => {
    const rows: DiffRow[] = [
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'b', oldNo: 2 },
      { kind: 'del', text: 'c', oldNo: 3 },
      { kind: 'add', text: 'B', newNo: 2 },
      { kind: 'ctx', text: 'd', oldNo: 4, newNo: 3 }
    ]
    const out = toSideBySide(rows)
    expect(out).toHaveLength(4)
    expect(out[1]).toEqual({ left: { no: 2, text: 'b', kind: 'del' }, right: { no: 2, text: 'B', kind: 'add' } })
    expect(out[2].left).toEqual({ no: 3, text: 'c', kind: 'del' })
    expect(out[2].right.kind).toBe('empty')
    expect(out[3].left).toEqual({ no: 4, text: 'd', kind: 'ctx' })
    expect(out[3].right).toEqual({ no: 3, text: 'd', kind: 'ctx' })
  })

  it('an add run with no del before it has an empty left side', () => {
    const out = toSideBySide([{ kind: 'add', text: 'x', newNo: 1 }])
    expect(out).toEqual([{ left: { no: 0, text: '', kind: 'empty' }, right: { no: 1, text: 'x', kind: 'add' } }])
  })
})
