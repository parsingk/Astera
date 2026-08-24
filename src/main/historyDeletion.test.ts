import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteProjectHistory, type DeletionDeps } from './historyDeletion'

const ROOT = path.join('C:', 'u', 'me', '.claude', 'projects')
const slug = (name: string): string => path.join(ROOT, name)
const file = (name: string, f: string): string => path.join(slug(name), f)

/** 실제로 무엇을 만졌는지 남기는 스텁. 되돌릴 수 없는 동작이라, 결과값만이 아니라 **무엇을 건드리지
 *  않았는지**까지 확인해야 한다. */
function deps(over: Partial<DeletionDeps> = {}): DeletionDeps & { trashed: string[] } {
  const trashed: string[] = []
  return {
    trashed,
    inUse: () => null,
    targetsOf: async (p: string) => ({
      files: [file(p, 'a.jsonl'), file(p, 'b.jsonl')],
      dirs: [slug(p)],
      scanRoots: [ROOT]
    }),
    trash: async (p: string) => {
      trashed.push(p)
    },
    isEmptyDir: async () => true,
    ...over
  }
}

describe('deleteProjectHistory', () => {
  it('그 프로젝트의 트랜스크립트를 휴지통으로 보내고 지웠다고 보고한다', async () => {
    const d = deps()
    const r = await deleteProjectHistory(['proj'], d)
    expect(r.deleted).toEqual(['proj'])
    expect(r.skipped).toEqual([])
    expect(d.trashed).toContain(file('proj', 'a.jsonl'))
    expect(d.trashed).toContain(file('proj', 'b.jsonl'))
  })

  // 되돌릴 수 없는 동작이므로 "건너뛰었다"로 끝나면 안 된다 — 파일을 하나도 만지지 않아야 한다
  it('실행 중인 프로젝트는 파일을 하나도 건드리지 않고 건너뛴다', async () => {
    const d = deps({ inUse: () => 'SESSION:작업 중' })
    const r = await deleteProjectHistory(['proj'], d)
    expect(r.deleted).toEqual([])
    expect(r.skipped).toEqual([{ projectPath: 'proj', reason: 'SESSION:작업 중' }])
    expect(d.trashed).toEqual([])
  })

  it('실행 중인 것만 건너뛰고 나머지는 지운다', async () => {
    const d = deps({ inUse: (p) => (p === 'busy' ? 'RUN:도는 중' : null) })
    const r = await deleteProjectHistory(['busy', 'free'], d)
    expect(r.deleted).toEqual(['free'])
    expect(r.skipped).toEqual([{ projectPath: 'busy', reason: 'RUN:도는 중' }])
    expect(d.trashed.every((t) => t.includes('free'))).toBe(true)
  })

  // deletion.ts 의 판정을 통과하지 못한 경로 — 스캔 루트 밖이면 지우지 않는다
  it('스캔 루트 밖의 파일은 지우지 않는다', async () => {
    const outside = path.join('C:', 'u', 'me', 'Documents', 'secret.jsonl')
    const d = deps({
      targetsOf: async () => ({ files: [outside], dirs: [], scanRoots: [ROOT] })
    })
    await deleteProjectHistory(['proj'], d)
    expect(d.trashed).toEqual([])
  })

  it('.jsonl 이 아닌 파일은 지우지 않는다', async () => {
    const cfg = file('proj', 'settings.json')
    const d = deps({ targetsOf: async () => ({ files: [cfg], dirs: [], scanRoots: [ROOT] }) })
    await deleteProjectHistory(['proj'], d)
    expect(d.trashed).toEqual([])
  })

  it('파일을 지운 뒤 빈 슬러그 디렉터리도 함께 치운다', async () => {
    const d = deps()
    await deleteProjectHistory(['proj'], d)
    expect(d.trashed).toContain(slug('proj'))
  })

  it('디렉터리가 비어 있지 않으면 두고 간다', async () => {
    const d = deps({ isEmptyDir: async () => false })
    await deleteProjectHistory(['proj'], d)
    expect(d.trashed).not.toContain(slug('proj'))
  })

  // codex 의 날짜 디렉터리 — 스캔 루트의 직계 자식이 아니므로 비어 보여도 건드리지 않는다
  it('스캔 루트 두 단계 아래의 디렉터리는 비어 있어도 두고 간다', async () => {
    const codexRoot = path.join('C:', 'u', 'me', '.codex', 'sessions')
    const dateDir = path.join(codexRoot, '2026', '08', '24')
    const d = deps({
      targetsOf: async () => ({
        files: [path.join(dateDir, 'rollout-1.jsonl')],
        dirs: [dateDir],
        scanRoots: [codexRoot]
      })
    })
    await deleteProjectHistory(['proj'], d)
    expect(d.trashed).toEqual([path.join(dateDir, 'rollout-1.jsonl')])
  })

  it('휴지통으로 보내기가 실패하면 지웠다고 보고하지 않는다', async () => {
    const d = deps({
      trash: async (p: string) => {
        if (p.endsWith('b.jsonl')) throw new Error('locked')
      }
    })
    const r = await deleteProjectHistory(['proj'], d)
    expect(r.deleted).toEqual([])
    expect(r.skipped).toEqual([{ projectPath: 'proj', reason: 'FAILED' }])
  })

  // 실패한 프로젝트의 디렉터리는 아직 파일이 남아 있다. 지우려 들면 남은 기록까지 잃는다.
  it('파일 삭제가 실패한 프로젝트의 디렉터리는 치우지 않는다', async () => {
    const d = deps({
      trash: async (p: string) => {
        if (p.endsWith('.jsonl')) throw new Error('locked')
      }
    })
    await deleteProjectHistory(['proj'], d)
    expect(d.trashed).toEqual([])
  })

  // 목록에는 있지만 기록은 이미 없는 경우 — 지울 것이 없으니 성공이다. 그래야 부르는 쪽이 그 항목을
  // 숨김 목록에서 뺀다.
  it('지울 기록이 없으면 성공으로 보고한다', async () => {
    const d = deps({ targetsOf: async () => ({ files: [], dirs: [], scanRoots: [ROOT] }) })
    const r = await deleteProjectHistory(['proj'], d)
    expect(r.deleted).toEqual(['proj'])
    expect(d.trashed).toEqual([])
  })

  it('빈 목록을 주면 아무것도 하지 않는다', async () => {
    const d = deps()
    const r = await deleteProjectHistory([], d)
    expect(r).toEqual({ deleted: [], skipped: [] })
    expect(d.trashed).toEqual([])
  })

  it('디렉터리가 비었는지 묻는 것 자체가 실패해도 지운 것은 지운 것이다', async () => {
    const d = deps({
      isEmptyDir: async () => {
        throw new Error('EACCES')
      }
    })
    const r = await deleteProjectHistory(['proj'], d)
    expect(r.deleted).toEqual(['proj'])
  })
})
