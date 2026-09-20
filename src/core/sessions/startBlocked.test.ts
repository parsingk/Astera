import { describe, it, expect } from 'vitest'
import { isWaitingReason, startBlockedBy, type StartBlocked } from './startBlocked'

const ok = {
  cwd: 'D:/p', starting: false, resolvingRepo: false,
  accountIds: ['acc1'], cliMissing: false, schedOn: false, hasSchedule: false
}

describe('startBlockedBy', () => {
  it('아무것도 안 막으면 null', () => {
    expect(startBlockedBy(ok)).toBeNull()
  })

  // 사람이 할 일이 있는 것을 먼저 말한다 — "폴더 확인 중"은 기다리면 되는 것이라 맨 뒤다
  it('사람이 고칠 수 있는 것을 먼저 말한다', () => {
    expect(startBlockedBy({ ...ok, cwd: '' })).toBe('no-cwd')
    expect(startBlockedBy({ ...ok, accountIds: [''] })).toBe('no-account')
    expect(startBlockedBy({ ...ok, cliMissing: true })).toBe('cli-missing')
    expect(startBlockedBy({ ...ok, schedOn: true, hasSchedule: false })).toBe('no-schedule')
    expect(startBlockedBy({ ...ok, resolvingRepo: true })).toBe('checking-folder')
  })

  it('계정이 먼저, 폴더 확인은 맨 뒤', () => {
    expect(startBlockedBy({ ...ok, accountIds: [''], resolvingRepo: true })).toBe('no-account')
  })

  // 이미 시작을 눌렀으면 버튼이 죽어 있는 것이 정상이고, 사유를 말할 것이 없다
  it('시작하는 중에는 사유가 없다', () => {
    expect(startBlockedBy({ ...ok, starting: true, resolvingRepo: true })).toBeNull()
  })

  it('계정 칸이 하나라도 비어 있으면 막힌다', () => {
    expect(startBlockedBy({ ...ok, accountIds: ['acc1', ''] })).toBe('no-account')
  })
})

describe('isWaitingReason', () => {
  // 사유를 말하는 이유가 곧 이 구분이다 — 넷은 사람이 할 일이고 하나는 앱이 하는 일인데, 회색 글씨
  // 한 줄로는 둘이 똑같이 읽힌다(리뷰어가 "폴더를 확인하는 중" 앞에서 자기가 뭘 빠뜨렸나 찾았다).
  it('폴더 확인만 기다리면 풀리는 것이고 나머지 넷은 사람이 할 일이다', () => {
    expect(isWaitingReason('checking-folder')).toBe(true)
    const actionable: StartBlocked[] = ['no-cwd', 'no-account', 'cli-missing', 'no-schedule']
    for (const r of actionable) expect(isWaitingReason(r)).toBe(false)
  })
})
