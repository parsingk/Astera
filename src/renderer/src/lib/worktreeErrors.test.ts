import { describe, it, expect } from 'vitest'
import { worktreeErrorMessage, dirtyCount, isOrphanUnverifiable } from './worktreeErrors'

describe('worktreeErrorMessage', () => {
  it('IPC 프리픽스가 붙어도 코드를 찾는다', () => {
    expect(
      worktreeErrorMessage("Error invoking remote method 'worktrees.create': Error: NO_BASE: x")
    ).toEqual({ key: 'worktree.error.noBase' })
  })

  // base f6c9c5e의 'IN_USE는 상세 사유를 그대로 보여준다' 케이스 — 옛 계약(문자열 그대로 통과)은
  // 새 계약과 모순되어 그대로 유지할 수 없지만, 입력 자체(태그 없는 자유 텍스트 사유)는 여전히
  // 검증할 값이 있다: SESSION:/RUN: 리터럴이 없어 IN_USE 정규식이 매치하지 않고 폴백 키로 가는지.
  it('태그 없는 자유 텍스트 IN_USE도 폴백 키로 간다', () => {
    expect(worktreeErrorMessage('IN_USE: 세션 A가 사용 중')).toEqual({ key: 'worktree.inUse.unknown' })
  })

  it('IN_USE:SESSION 태그에서 세션 제목을 파라미터로 뽑는다', () => {
    expect(worktreeErrorMessage('IN_USE:SESSION:세션 A')).toEqual({
      key: 'worktree.inUse.session',
      params: { title: '세션 A' }
    })
  })

  it('IN_USE:RUN 태그는 실행구성 이름을 뽑는다', () => {
    expect(worktreeErrorMessage('IN_USE:RUN:dev server')).toEqual({
      key: 'worktree.inUse.run',
      params: { name: 'dev server' }
    })
  })

  it('세션 제목에 콜론·개행이 있어도 전체를 값으로 받는다', () => {
    expect(worktreeErrorMessage('IN_USE:SESSION:a: b\nc')).toEqual({
      key: 'worktree.inUse.session',
      params: { title: 'a: b\nc' }
    })
  })

  it('태그 없는 IN_USE는 폴백 문구', () => {
    expect(worktreeErrorMessage('IN_USE:')).toEqual({ key: 'worktree.inUse.unknown' })
  })

  // remove.ts는 `IN_USE: ${inUse}`로 조립한다 — 콜론 뒤에 공백이 있고, isWorktreeInUse가 돌려주는
  // 'SESSION:제목' 태그는 그 뒤에 바로 붙는다. IPC 경유 시 Electron 프리픽스도 앞에 붙는다.
  // 이 실제 형태를 정규식이 못 잡으면 IN_USE 케이스가 전부 raw 폴백으로 새버린다.
  it('remove.ts가 실제로 조립하는 형태(IN_USE: 뒤 공백 + IPC 프리픽스)도 파싱한다', () => {
    expect(
      worktreeErrorMessage(
        "Error invoking remote method 'worktrees.remove': Error: IN_USE: SESSION:세션 A"
      )
    ).toEqual({ key: 'worktree.inUse.session', params: { title: '세션 A' } })
  })

  it('모르는 에러는 원문을 detail로 담는다', () => {
    expect(worktreeErrorMessage('boom')).toEqual({
      key: 'worktree.error.raw',
      params: { detail: 'boom' }
    })
  })

  it('DIRTY는 전용 키 (개수는 dirtyCount가 별도로 다룬다)', () => {
    expect(
      worktreeErrorMessage("Error invoking remote method 'worktrees.remove': Error: DIRTY: 3")
    ).toEqual({ key: 'worktree.error.dirty' })
  })

  it('ORPHAN_UNVERIFIABLE과 ORPHAN_UNPROVEN은 서로 다른 키를 반환한다', () => {
    const unverifiable = worktreeErrorMessage(
      "Error invoking remote method 'worktrees.remove': Error: ORPHAN_UNVERIFIABLE: D:\\wt\\a"
    )
    const unproven = worktreeErrorMessage(
      "Error invoking remote method 'worktrees.remove': Error: ORPHAN_UNPROVEN: D:\\wt\\a"
    )
    expect(unverifiable).toEqual({ key: 'worktree.error.orphanUnverifiable' })
    expect(unproven).toEqual({ key: 'worktree.error.orphanUnproven' })
  })

  it('ROLL_MIXED_PROVIDER는 세션 롤링 전용 키로 매핑된다', () => {
    expect(
      worktreeErrorMessage(
        "Error invoking remote method 'sessions.spawn': Error: ROLL_MIXED_PROVIDER: Claude와 Codex 계정을 섞어 롤링할 수 없습니다"
      )
    ).toEqual({ key: 'session.roll.mixedProvider' })
  })
})

describe('dirtyCount', () => {
  it('DIRTY에서 개수를 뽑는다', () => {
    expect(dirtyCount('DIRTY: 3')).toBe(3)
  })
  it('없으면 null', () => {
    expect(dirtyCount('NO_BASE')).toBeNull()
  })
})

describe('isOrphanUnverifiable', () => {
  it('ORPHAN_UNVERIFIABLE만 true', () => {
    expect(isOrphanUnverifiable('ORPHAN_UNVERIFIABLE: x')).toBe(true)
    expect(isOrphanUnverifiable('ORPHAN_UNPROVEN: x')).toBe(false)
  })
  // 기존 테스트에 있던 케이스 — isOrphanUnverifiable은 이 태스크에서 변경하지 않으므로 유지한다.
  it('DIRTY는 false', () => {
    expect(isOrphanUnverifiable('DIRTY: 3')).toBe(false)
  })
})
