import { describe as d, expect, it } from 'vitest'
import { t } from '../i18n'
import {
  MAX_DEPTH,
  describe as describeEntry,
  describeRestored,
  invert,
  pushEntry,
  splitByExistence,
  undoSourceParents,
  type UndoEntry,
  type UndoOp
} from './undo'

const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('\\'))
const nameOf = (p: string): string => p.slice(p.lastIndexOf('\\') + 1)

d('pushEntry', () => {
  it('앞쪽에 쌓는다 (최근이 먼저)', () => {
    const j = pushEntry(pushEntry([], { kind: 'created', paths: ['a'] }), {
      kind: 'created',
      paths: ['b']
    })
    expect(j[0]).toEqual({ kind: 'created', paths: ['b'] })
  })

  it('깊이 상한을 넘으면 가장 오래된 것을 버린다', () => {
    let j: UndoEntry[] = []
    for (let i = 0; i < MAX_DEPTH + 5; i++) j = pushEntry(j, { kind: 'created', paths: [`f${i}`] })
    expect(j.length).toBe(MAX_DEPTH)
    expect(j[0]).toEqual({ kind: 'created', paths: [`f${MAX_DEPTH + 4}`] })
  })

  it('입력 저널을 변형하지 않는다', () => {
    const before: UndoEntry[] = [{ kind: 'created', paths: ['a'] }]
    const after = pushEntry(before, { kind: 'created', paths: ['b'] })
    expect(before).toEqual([{ kind: 'created', paths: ['a'] }])
    expect(after).not.toBe(before)
  })

  it('deleted 항목도 담는다 — 삭제도 저널에 들어간다', () => {
    const j = pushEntry([], {
      kind: 'deleted',
      items: [{ id: '00000000000001-a.txt', originalPath: 'D:\\p\\a.txt' }]
    })
    expect(j[0]).toEqual({
      kind: 'deleted',
      items: [{ id: '00000000000001-a.txt', originalPath: 'D:\\p\\a.txt' }]
    })
  })
})

d('invert', () => {
  it('생성 되돌리기는 삭제다 (Local History가 안전망)', () => {
    expect(invert({ kind: 'created', paths: ['D:\\p\\a.txt'] }, parentOf, nameOf)).toEqual([
      { op: 'remove', path: 'D:\\p\\a.txt' }
    ])
  })

  it('복사 되돌리기도 삭제다 — 복사본만 지운다', () => {
    expect(
      invert({ kind: 'copied', paths: ['D:\\p\\a copy.txt', 'D:\\p\\b copy.txt'] }, parentOf, nameOf)
    ).toEqual([
      { op: 'remove', path: 'D:\\p\\a copy.txt' },
      { op: 'remove', path: 'D:\\p\\b copy.txt' }
    ])
  })

  it('이름 변경 되돌리기는 원래 이름으로 rename', () => {
    expect(
      invert({ kind: 'renamed', from: 'D:\\p\\old.txt', to: 'D:\\p\\new.txt' }, parentOf, nameOf)
    ).toEqual([{ op: 'rename', from: 'D:\\p\\new.txt', newName: 'old.txt' }])
  })

  it('이동 되돌리기는 원래 부모로 move', () => {
    expect(
      invert(
        { kind: 'moved', items: [{ from: 'D:\\p\\src\\a.txt', to: 'D:\\p\\lib\\a.txt' }] },
        parentOf,
        nameOf
      )
    ).toEqual([{ op: 'move', from: 'D:\\p\\lib\\a.txt', destDir: 'D:\\p\\src' }])
  })

  it('다중 이동은 항목마다 하나씩 낸다', () => {
    const ops = invert(
      {
        kind: 'moved',
        items: [
          { from: 'D:\\p\\s\\a', to: 'D:\\p\\d\\a' },
          { from: 'D:\\p\\s\\b', to: 'D:\\p\\d\\b' }
        ]
      },
      parentOf,
      nameOf
    )
    expect(ops).toHaveLength(2)
    expect(ops[0]).toEqual({ op: 'move', from: 'D:\\p\\d\\a', destDir: 'D:\\p\\s' })
  })

  it('삭제 되돌리기는 Local History 복구다', () => {
    expect(
      invert(
        { kind: 'deleted', items: [{ id: 'stamp-a.txt', originalPath: 'D:\\p\\a.txt' }] },
        parentOf,
        nameOf
      )
    ).toEqual([{ op: 'restore', id: 'stamp-a.txt' }])
  })

  it('다중 삭제 되돌리기는 항목마다 하나씩, 순서를 보존한다', () => {
    const ops = invert(
      {
        kind: 'deleted',
        items: [
          { id: 'stamp-a.txt', originalPath: 'D:\\p\\a.txt' },
          { id: 'stamp-b.txt', originalPath: 'D:\\p\\b.txt' }
        ]
      },
      parentOf,
      nameOf
    )
    expect(ops).toEqual([
      { op: 'restore', id: 'stamp-a.txt' },
      { op: 'restore', id: 'stamp-b.txt' }
    ])
  })
})

d('describe', () => {
  it('생성 — 단일은 이름을, 다중은 개수를 담는 Message를 낸다', () => {
    expect(describeEntry({ kind: 'created', paths: ['D:\\p\\a.txt'] }, nameOf)).toEqual({
      key: 'files.undo.desc.createdOne',
      params: { name: 'a.txt' }
    })
    expect(describeEntry({ kind: 'created', paths: ['a', 'b'] }, nameOf)).toEqual({
      key: 'files.undo.desc.createdMany',
      params: { count: 2 }
    })
  })

  it('복사 — 단일은 이름을, 다중은 개수를 담는다', () => {
    expect(describeEntry({ kind: 'copied', paths: ['D:\\p\\a.txt'] }, nameOf)).toEqual({
      key: 'files.undo.desc.copiedOne',
      params: { name: 'a.txt' }
    })
    expect(describeEntry({ kind: 'copied', paths: ['a', 'b', 'c'] }, nameOf)).toEqual({
      key: 'files.undo.desc.copiedMany',
      params: { count: 3 }
    })
  })

  it('이름 변경은 from·to를 담는다', () => {
    expect(
      describeEntry({ kind: 'renamed', from: 'D:\\p\\o.txt', to: 'D:\\p\\n.txt' }, nameOf)
    ).toEqual({
      key: 'files.undo.desc.renamed',
      params: { from: 'o.txt', to: 'n.txt' }
    })
  })

  it('이동 — 단일은 이름을, 다중은 개수를 담는다', () => {
    expect(
      describeEntry(
        { kind: 'moved', items: [{ from: 'D:\\p\\a.txt', to: 'D:\\q\\a.txt' }] },
        nameOf
      )
    ).toEqual({ key: 'files.undo.desc.movedOne', params: { name: 'a.txt' } })
    expect(
      describeEntry(
        {
          kind: 'moved',
          items: [
            { from: 'a', to: 'x' },
            { from: 'b', to: 'y' }
          ]
        },
        nameOf
      )
    ).toEqual({ key: 'files.undo.desc.movedMany', params: { count: 2 } })
  })

  it('삭제 — 단일은 이름을 담는다', () => {
    expect(
      describeEntry({ kind: 'deleted', items: [{ id: 's', originalPath: 'D:\\p\\a.txt' }] }, nameOf)
    ).toEqual({ key: 'files.undo.desc.deletedOne', params: { name: 'a.txt' } })
  })

  it('삭제 — 다중은 개수를 담는다', () => {
    expect(
      describeEntry(
        {
          kind: 'deleted',
          items: [
            { id: 's1', originalPath: 'a' },
            { id: 's2', originalPath: 'b' }
          ]
        },
        nameOf
      )
    ).toEqual({ key: 'files.undo.desc.deletedMany', params: { count: 2 } })
  })
})

// 삭제 되돌리기(restore)는 store.restore의 uniqueName 회피로 원래 이름과 다른 곳에 착지할 수 있다 —
// describe()는 원래 이름만 알아 이 경우를 감춘다. describeRestored가 실제 착지 경로를 반영하는지
// 검증한다 (리뷰에서 Critical로 지적된 부분).
d('describeRestored', () => {
  it('이름이 그대로면 restored.one 키에 이름을 담는다 (흔한 경우, 단일)', () => {
    expect(
      describeRestored([{ originalPath: 'D:\\p\\a.txt', to: 'D:\\p\\a.txt' }], nameOf)
    ).toEqual({ key: 'files.undo.restored.one', params: { name: 'a.txt' } })
  })

  it('이름이 그대로면 restored.many 키에 개수를 담는다 (흔한 경우, 다중)', () => {
    const items = [
      { originalPath: 'D:\\p\\a.txt', to: 'D:\\p\\a.txt' },
      { originalPath: 'D:\\p\\b.txt', to: 'D:\\p\\b.txt' }
    ]
    expect(describeRestored(items, nameOf)).toEqual({
      key: 'files.undo.restored.many',
      params: { count: 2 }
    })
  })

  it('단일 항목의 이름이 달라졌으면 실제 착지 경로를 그대로 담는다', () => {
    expect(
      describeRestored([{ originalPath: 'D:\\p\\foo.txt', to: 'D:\\p\\foo copy.txt' }], nameOf)
    ).toEqual({
      key: 'files.undo.restored.renamedOne',
      params: { name: 'foo.txt', to: 'D:\\p\\foo copy.txt' }
    })
  })

  it('다중 항목 중 일부만 이름이 달라져도 그 항목의 실제 이름을 담는다', () => {
    const items = [
      { originalPath: 'D:\\p\\a.txt', to: 'D:\\p\\a.txt' }, // 그대로
      { originalPath: 'D:\\p\\b.txt', to: 'D:\\p\\b copy.txt' } // 회피됨
    ]
    expect(describeRestored(items, nameOf)).toEqual({
      key: 'files.undo.restored.renamedMany',
      params: { count: 2, renamedCount: 1, shown: 'b copy.txt' }
    })
  })

  // 경계값(renamed.length 정확히 3 vs 4) — 원본은 more를 빈 문자열로 조립해 같은 문장에 붙였지만
  // (undo.ts:170의 이관 전 코드), 이제는 키가 renamedMany/renamedManyWithMore로 갈린다. 두 키를
  // t()로 번역한 결과가 원본 문구(외 n건 유무)와 정확히 같은지 고정한다.
  it('renamed가 정확히 3개면 원본과 같은 문구(외 없음)를 내는 renamedMany 키를 낸다', () => {
    const items = [
      { originalPath: 'D:\\p\\a.txt', to: 'D:\\p\\a copy.txt' },
      { originalPath: 'D:\\p\\b.txt', to: 'D:\\p\\b copy.txt' },
      { originalPath: 'D:\\p\\c.txt', to: 'D:\\p\\c copy.txt' }
    ]
    const msg = describeRestored(items, nameOf)
    expect(msg).toEqual({
      key: 'files.undo.restored.renamedMany',
      params: { count: 3, renamedCount: 3, shown: 'a copy.txt, b copy.txt, c copy.txt' }
    })
    expect(t('ko', msg.key, msg.params)).toBe(
      '3개 항목 삭제 되돌림 — 3개는 같은 이름이 있어 다른 이름으로 복구됨: a copy.txt, b copy.txt, c copy.txt'
    )
  })

  it('renamed가 4개면 원본과 같은 문구(외 1건)를 내는 renamedManyWithMore 키를 낸다', () => {
    const items = [
      { originalPath: 'D:\\p\\a.txt', to: 'D:\\p\\a copy.txt' },
      { originalPath: 'D:\\p\\b.txt', to: 'D:\\p\\b copy.txt' },
      { originalPath: 'D:\\p\\c.txt', to: 'D:\\p\\c copy.txt' },
      { originalPath: 'D:\\p\\d.txt', to: 'D:\\p\\d copy.txt' }
    ]
    const msg = describeRestored(items, nameOf)
    expect(msg).toEqual({
      key: 'files.undo.restored.renamedManyWithMore',
      params: {
        count: 4,
        renamedCount: 4,
        shown: 'a copy.txt, b copy.txt, c copy.txt',
        moreCount: 1
      }
    })
    expect(t('ko', msg.key, msg.params)).toBe(
      '4개 항목 삭제 되돌림 — 4개는 같은 이름이 있어 다른 이름으로 복구됨: a copy.txt, b copy.txt, c copy.txt 외 1건'
    )
  })
})

// 다중 항목 조작의 undo가 하나만 어긋나도 전부 되돌리지 못하던 문제의
// 판정을 고정한다. useFileOps.undo()는 undoSourceParents로 조회할 부모를 정하고, files.list 결과를
// splitByExistence에 넘겨 실행 가능한 op와 어긋난 항목을 가른다.
d('undoSourceParents', () => {
  it('remove op는 대상 자신의 부모를 조회 대상으로 삼는다', () => {
    const ops: UndoOp[] = [{ op: 'remove', path: 'D:\\p\\a.txt' }]
    expect(undoSourceParents(ops, parentOf)).toEqual(['D:\\p'])
  })

  it('rename·move op는 from(되돌리기 전 위치)의 부모를 조회 대상으로 삼는다', () => {
    const ops: UndoOp[] = [
      { op: 'rename', from: 'D:\\p\\new.txt', newName: 'old.txt' },
      { op: 'move', from: 'D:\\dst\\a.txt', destDir: 'D:\\src' }
    ]
    expect(undoSourceParents(ops, parentOf)).toEqual(['D:\\p', 'D:\\dst'])
  })

  it('같은 부모를 공유하는 여러 op는 부모를 한 번만 조회한다 (첫 등장 순서 유지)', () => {
    const ops: UndoOp[] = [
      { op: 'move', from: 'D:\\dst\\b.txt', destDir: 'D:\\src' },
      { op: 'move', from: 'D:\\other\\c.txt', destDir: 'D:\\src2' },
      { op: 'move', from: 'D:\\dst\\a.txt', destDir: 'D:\\src' }
    ]
    expect(undoSourceParents(ops, parentOf)).toEqual(['D:\\dst', 'D:\\other'])
  })

  it('restore op는 출발지가 Local History 스냅샷(프로젝트 밖)이라 부모를 만들지 않는다', () => {
    const ops: UndoOp[] = [{ op: 'restore', id: 'stamp-a.txt' }]
    expect(undoSourceParents(ops, parentOf)).toEqual([])
  })

  it('restore op가 다른 kind의 op와 섞여도 그 op의 부모만 조회 대상이 된다', () => {
    const ops: UndoOp[] = [
      { op: 'restore', id: 'stamp-a.txt' },
      { op: 'move', from: 'D:\\dst\\a.txt', destDir: 'D:\\src' }
    ]
    expect(undoSourceParents(ops, parentOf)).toEqual(['D:\\dst'])
  })
})

d('splitByExistence', () => {
  it('전부 존재하면 doable에 원래 순서 그대로, missing은 빈 배열', () => {
    const ops: UndoOp[] = [
      { op: 'move', from: 'D:\\dst\\a.txt', destDir: 'D:\\src' },
      { op: 'move', from: 'D:\\dst\\b.txt', destDir: 'D:\\src' }
    ]
    const listings = new Map([['D:\\dst', ['a.txt', 'b.txt']]])
    expect(splitByExistence(ops, parentOf, nameOf, listings)).toEqual({ doable: ops, missing: [] })
  })

  it('전부 어긋나면 doable은 빈 배열, missing에 표시용 이름이 원래 순서로', () => {
    const ops: UndoOp[] = [
      { op: 'move', from: 'D:\\dst\\a.txt', destDir: 'D:\\src' },
      { op: 'move', from: 'D:\\dst\\b.txt', destDir: 'D:\\src' }
    ]
    const listings = new Map([['D:\\dst', ['other.txt']]])
    expect(splitByExistence(ops, parentOf, nameOf, listings)).toEqual({
      doable: [],
      missing: ['a.txt', 'b.txt']
    })
  })

  it('일부만 어긋나면 나머지는 되돌릴 수 있게 doable에 남고 순서를 보존한다', () => {
    const ops: UndoOp[] = [
      { op: 'move', from: 'D:\\dst\\a.txt', destDir: 'D:\\src' },
      { op: 'move', from: 'D:\\dst\\b.txt', destDir: 'D:\\src' }, // 외부에서 이름 변경돼 사라짐
      { op: 'move', from: 'D:\\dst\\c.txt', destDir: 'D:\\src' }
    ]
    const listings = new Map([['D:\\dst', ['a.txt', 'c.txt']]])
    expect(splitByExistence(ops, parentOf, nameOf, listings)).toEqual({
      doable: [ops[0], ops[2]],
      missing: ['b.txt']
    })
  })

  it('부모 조회 실패(빈 배열)는 그 부모의 대상 전부를 부정합으로 본다', () => {
    const ops: UndoOp[] = [{ op: 'move', from: 'D:\\gone\\a.txt', destDir: 'D:\\src' }]
    const listings = new Map([['D:\\gone', [] as string[]]]) // 부모째 없어짐 — 호출부가 빈 배열로 넣는다
    expect(splitByExistence(ops, parentOf, nameOf, listings)).toEqual({
      doable: [],
      missing: ['a.txt']
    })
  })

  it('대소문자만 다른 이름은 부정합으로 본다', () => {
    const ops: UndoOp[] = [{ op: 'move', from: 'D:\\dst\\a.txt', destDir: 'D:\\src' }]
    const listings = new Map([['D:\\dst', ['A.txt']]]) // 디스크의 실제 이름은 대문자 A
    expect(splitByExistence(ops, parentOf, nameOf, listings)).toEqual({
      doable: [],
      missing: ['a.txt']
    })
  })

  it('listings에 부모 키가 아예 없어도(누락) 빈 목록과 같이 부정합으로 본다', () => {
    const ops: UndoOp[] = [{ op: 'rename', from: 'D:\\p\\new.txt', newName: 'old.txt' }]
    expect(splitByExistence(ops, parentOf, nameOf, new Map())).toEqual({
      doable: [],
      missing: ['new.txt']
    })
  })

  it('restore op는 listings와 무관하게 항상 doable이다 — 삭제 되돌리기가 실행되려면 필수', () => {
    const ops: UndoOp[] = [{ op: 'restore', id: 'stamp-a.txt' }]
    expect(splitByExistence(ops, parentOf, nameOf, new Map())).toEqual({ doable: ops, missing: [] })
  })

  it('restore op가 부정합 move op와 섞여도 restore만 doable에 남고 move는 missing으로 빠진다', () => {
    const ops: UndoOp[] = [
      { op: 'restore', id: 'stamp-a.txt' },
      { op: 'move', from: 'D:\\dst\\b.txt', destDir: 'D:\\src' }
    ]
    const listings = new Map([['D:\\dst', ['other.txt']]]) // b.txt가 외부에서 사라짐
    expect(splitByExistence(ops, parentOf, nameOf, listings)).toEqual({
      doable: [ops[0]],
      missing: ['b.txt']
    })
  })
})
