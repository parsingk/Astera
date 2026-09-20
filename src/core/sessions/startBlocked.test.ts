import { describe, it, expect } from 'vitest'
import { startBlockedBy } from './startBlocked'

const ok = {
  cwd: 'D:/p', starting: false, resolvingRepo: false,
  accountIds: ['acc1'], cliMissing: false, schedOn: false, hasSchedule: false, checkingCli: false
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
    expect(startBlockedBy({ ...ok, checkingCli: true })).toBe('checking-cli')
  })

  it('계정이 먼저, 폴더 확인은 맨 뒤', () => {
    expect(startBlockedBy({ ...ok, accountIds: [''], resolvingRepo: true })).toBe('no-account')
  })

  // 폴더를 고른 순간 그 폴더의 CLI 검사가 최대 10초 걸릴 수 있다(shell:true 셔틀이 매달리는 경우).
  // git 검사는 그보다 훨씬 먼저 끝나므로, 그 사이엔 checkingCli 만 남아 있어야 한다 — cliMissing 이
  // 이전 폴더의 답을 들고 있어도 그것으로 시작 버튼을 살려 두면 안 된다(설계 D3 가 막으려던 경주).
  it('CLI 검사가 끝나기 전엔 폴더 확인이 끝나도 막혀 있다', () => {
    expect(startBlockedBy({ ...ok, resolvingRepo: false, checkingCli: true })).toBe('checking-cli')
  })

  // 완료된 사유(cliMissing)는 사람이 할 일이 있으므로 아직 답이 없는 checkingCli 보다 앞선다
  it('cliMissing 이 확정됐으면 checkingCli 보다 먼저 말한다', () => {
    expect(startBlockedBy({ ...ok, cliMissing: true, checkingCli: true })).toBe('cli-missing')
  })

  // 이미 시작을 눌렀으면 버튼이 죽어 있는 것이 정상이고, 사유를 말할 것이 없다
  it('시작하는 중에는 사유가 없다', () => {
    expect(startBlockedBy({ ...ok, starting: true, resolvingRepo: true })).toBeNull()
  })

  it('계정 칸이 하나라도 비어 있으면 막힌다', () => {
    expect(startBlockedBy({ ...ok, accountIds: ['acc1', ''] })).toBe('no-account')
  })
})
