import { describe, it, expect } from 'vitest'
import { jobsStall, jobsViewScreen } from './jobsView'
import type { JobRow, OrchHostGate, OrchSnapshot } from '../types'

const gate: OrchHostGate = { state: 'unreachable', reason: 'no connection', logPath: 'C:/o.log' }

/** 프로젝트가 없을 때 App.tsx 가 스스로 끼워 넣는 스냅샷. 이 값이 결함의 현장이다 — Host 상태가
 *  스냅샷의 칸이던 동안, 이것이 그 칸을 통째로 덮어 화면에서 지웠다. */
const noProject: OrchSnapshot = { runs: [], projectFolderBusy: false }
const withRuns: OrchSnapshot = {
  runs: [{ id: 'run_1', objective: 'o', tasks: [] } as unknown as JobRow],
  projectFolderBusy: false
}

describe('jobsViewScreen', () => {
  // **F41 이 잡은 그 경우다.** 열린 프로젝트가 없으면 렌더러는 자기가 만든 빈 스냅샷을 들고 있고,
  // Host 가 없어 네 기능이 다 죽었는데도 화면은 "열린 프로젝트가 없습니다" 만 적고 있었다.
  it('열린 프로젝트가 없어도 Host 상태를 그린다', () => {
    expect(jobsViewScreen({ hostGate: gate, snapshot: noProject })).toBe('host')
  })

  it('스냅샷이 아직 오지 않았어도 Host 상태를 그린다', () => {
    expect(jobsViewScreen({ hostGate: gate, snapshot: null })).toBe('host')
  })

  it('Host 상태는 목록보다 앞선다', () => {
    expect(jobsViewScreen({ hostGate: gate, snapshot: withRuns })).toBe('host')
  })

  it('Host 가 멀쩡하면 스냅샷이 정한다', () => {
    expect(jobsViewScreen({ hostGate: null, snapshot: null })).toBe('blank')
    expect(jobsViewScreen({ hostGate: null, snapshot: noProject })).toBe('empty')
    expect(jobsViewScreen({ hostGate: null, snapshot: withRuns })).toBe('runs')
  })
})

// 한도 L3: 아무것도 움직이지 않을 때 사이드바가 그 까닭을 적는다.
describe('jobsStall', () => {
  const ok = { unresponsive: false, features: ['dispatch'] }
  const silent = { unresponsive: true, features: ['dispatch'] }

  it('Host 가 작업을 멈춰 두면 그 사유를 준다', () => {
    expect(jobsStall({ hostStatus: ok, driver: { driver: 'parked', gate: 'unreadable' } })).toEqual({ kind: 'parked', gate: 'unreadable' })
    expect(jobsStall({ hostStatus: ok, driver: { driver: 'parked', gate: 'not-migrated' } })).toEqual({ kind: 'parked', gate: 'not-migrated' })
  })

  it('Host 가 응답하지 않으면 그 알림을 준다', () => {
    expect(jobsStall({ hostStatus: silent, driver: null })).toEqual({ kind: 'unresponsive' })
  })

  // 응답하지 않는 Host 가 마지막으로 한 말은 낡았다: 멈춰 둔 사유보다 응답하지 않는다는 사실이 앞선다.
  it('응답하지 않는다는 사실이 멈춰 둔 사유보다 앞선다', () => {
    expect(jobsStall({ hostStatus: silent, driver: { driver: 'parked', gate: 'unreadable' } })).toEqual({ kind: 'unresponsive' })
  })

  // 최종 리뷰 M1. dispatch 를 알리지 않은 Host(spawner 가 없거나 옛 Host)에게 앱은 양보하지 않고
  // 스스로 몬다. 그런 Host 가 응답하지 않아도 작업은 움직이므로 "작업이 움직이지 않는다" 는 거짓이다.
  it('앱이 스스로 모는 동안에는 응답하지 않는 Host 도 적지 않는다', () => {
    expect(jobsStall({ hostStatus: { unresponsive: true, features: [] }, driver: null })).toBeNull()
    expect(jobsStall({ hostStatus: { unresponsive: true, features: ['proc'] }, driver: null })).toBeNull()
  })

  it('Host 가 몰거나 앱이 몰면 아무것도 적지 않는다', () => {
    expect(jobsStall({ hostStatus: ok, driver: { driver: 'host', gate: 'migrated' } })).toBeNull()
    expect(jobsStall({ hostStatus: ok, driver: { driver: 'host', gate: 'no-settings' } })).toBeNull()
    expect(jobsStall({ hostStatus: ok, driver: { driver: 'app', gate: 'unreadable' } })).toBeNull()
  })

  // 첫 읽기 전의 parked 는 잠깐이다(N2): 사유가 없는 것을 사유처럼 적지 않는다. 옛 Host 는 아무 말도 하지 않는다.
  it('설정을 아직 읽지 않은 parked 와 아무 말도 없는 옛 Host 에는 아무것도 적지 않는다', () => {
    expect(jobsStall({ hostStatus: ok, driver: { driver: 'parked', gate: null } })).toBeNull()
    expect(jobsStall({ hostStatus: ok, driver: null })).toBeNull()
    expect(jobsStall({ hostStatus: null, driver: null })).toBeNull()
  })
})
