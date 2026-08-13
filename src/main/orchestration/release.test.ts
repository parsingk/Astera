import { describe, it, expect } from 'vitest'
import { releaseArgsFor } from './release'
import type { Dispatch } from '../../core/orchestration/types'

const dsp = (o: Partial<Dispatch> & { id: string; sessionId: string }): Dispatch => ({
  taskId: 'tsk_1',
  provider: 'claude',
  accountId: 'acc1',
  cwd: 'C:/repo',
  specPath: 'C:/repo/orch/specs/s.md',
  startedAt: '2026-08-04T00:00:00.000Z',
  workerState: 'ready',
  retained: false,
  ...o
})

describe('releaseArgsFor', () => {
  it('알 수 없는 dispatch는 null이다 — 닫을 세션이 없다', () => {
    // worker-release는 서버가 dispatch 존재를 검증하지 않고 곧장 배선으로 보내는 유일한 명령이다
    expect(releaseArgsFor([dsp({ id: 'dsp_1', sessionId: 'sess_A' })], 'dsp_없음')).toBeNull()
  })

  it('세션을 혼자 쓰는 dispatch는 최신 소유자다', () => {
    const ds = [dsp({ id: 'dsp_1', sessionId: 'sess_A' })]
    expect(releaseArgsFor(ds, 'dsp_1')).toEqual({
      sessionId: 'sess_A',
      retained: false,
      isLatestOwner: true
    })
  })

  it('재사용된 세션의 옛 dispatch는 최신 소유자가 아니다 (보존)', () => {
    const ds = [
      dsp({ id: 'dsp_A', sessionId: 'sess_S', endedAt: '2026-08-04T01:00:00.000Z', outcome: 'succeeded' }),
      dsp({ id: 'dsp_B', sessionId: 'sess_S' })
    ]
    expect(releaseArgsFor(ds, 'dsp_A')?.isLatestOwner).toBe(false)
    expect(releaseArgsFor(ds, 'dsp_B')?.isLatestOwner).toBe(true)
  })

  it('세 번 재사용해도 마지막 하나만 소유자다', () => {
    const ds = [
      dsp({ id: 'dsp_A', sessionId: 'sess_S', endedAt: '2026-08-04T01:00:00.000Z' }),
      dsp({ id: 'dsp_B', sessionId: 'sess_S', endedAt: '2026-08-04T02:00:00.000Z' }),
      dsp({ id: 'dsp_C', sessionId: 'sess_S' })
    ]
    expect(releaseArgsFor(ds, 'dsp_A')?.isLatestOwner).toBe(false)
    expect(releaseArgsFor(ds, 'dsp_B')?.isLatestOwner).toBe(false)
    expect(releaseArgsFor(ds, 'dsp_C')?.isLatestOwner).toBe(true)
  })

  it('다른 세션의 dispatch는 소유 판정에 끼어들지 않는다', () => {
    const ds = [
      dsp({ id: 'dsp_A', sessionId: 'sess_S' }),
      dsp({ id: 'dsp_B', sessionId: 'sess_T' })
    ]
    expect(releaseArgsFor(ds, 'dsp_A')?.isLatestOwner).toBe(true)
    expect(releaseArgsFor(ds, 'dsp_B')?.isLatestOwner).toBe(true)
  })

  it('startedAt이 같아도 배열 순서로 갈린다 — 문자열 비교는 동률에서 순서를 잃는다', () => {
    const same = '2026-08-04T00:00:00.000Z'
    const ds = [
      dsp({ id: 'dsp_A', sessionId: 'sess_S', startedAt: same, endedAt: same }),
      dsp({ id: 'dsp_B', sessionId: 'sess_S', startedAt: same })
    ]
    expect(releaseArgsFor(ds, 'dsp_A')?.isLatestOwner).toBe(false)
    expect(releaseArgsFor(ds, 'dsp_B')?.isLatestOwner).toBe(true)
  })

  it('retained를 그대로 실어 보낸다 — 코디네이터가 그것만 보고 건너뛴다', () => {
    const ds = [dsp({ id: 'dsp_1', sessionId: 'sess_A', retained: true })]
    expect(releaseArgsFor(ds, 'dsp_1')).toEqual({
      sessionId: 'sess_A',
      retained: true,
      isLatestOwner: true
    })
  })
})
