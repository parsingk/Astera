import { describe, it, expect } from 'vitest'
import { jobsViewScreen } from './jobsView'
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
