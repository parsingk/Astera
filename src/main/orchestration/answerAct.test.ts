import { describe, it, expect, vi } from 'vitest'
import { answerOrchAct, orchActionOf } from './answerAct'
import type { OrchServerDeps } from '../../core/orchestration/command'

const depsWith = (over: Record<string, unknown>): OrchServerDeps => over as unknown as OrchServerDeps

describe('answerOrchAct', () => {
  // **F21.** 인자는 언제나 도착한 배열 그대로 펼쳐진다 — 모양을 보고 고르지 않는다.
  //
  // 이 자리는 원래 `backup` 이었다. 그것은 Host 가 제 것으로 가져가서(host/orchDeps.ts 의 OWNED)
  // 더 이상 전달되지 않는다 — 지키는 것은 전달표 자체가 아니라 그 아래 일반 디스패처이므로,
  // 테스트를 지우는 대신 실제로 전달되는 무인수 호출로 옮긴다.
  it('인수가 없는 호출은 인수 없이 부른다', async () => {
    const trackingEnabled = vi.fn().mockResolvedValue(true)
    await answerOrchAct({ deps: depsWith({ trackingEnabled }), act: 'trackingEnabled', args: [] })
    expect(trackingEnabled).toHaveBeenCalledWith()
  })

  it('인수가 둘이면 둘로 부른다', async () => {
    const mergeWorktrees = vi.fn().mockResolvedValue({ ok: true })
    await answerOrchAct({ deps: depsWith({ mergeWorktrees }), act: 'mergeWorktrees', args: ['D:/p', ['a', 'b']] })
    expect(mergeWorktrees).toHaveBeenCalledWith('D:/p', ['a', 'b'])
  })

  // 이 하나가 규칙을 정했다: 인수 하나가 그 자체로 배열이면, 인수 둘인 호출과 선 위에서 구별되지
  // 않는다. 모양을 보는 순간 한쪽을 다른 쪽으로 부르게 된다.
  it('배열 하나를 받는 호출을 두 인수로 풀지 않는다', async () => {
    const removeWorktrees = vi.fn().mockResolvedValue({ failed: [] })
    await answerOrchAct({ deps: depsWith({ removeWorktrees }), act: 'removeWorktrees', args: [['a', 'b']] })
    expect(removeWorktrees).toHaveBeenCalledWith(['a', 'b'])
  })

  it('점이 있는 이름은 그 객체의 메서드를 부른다', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, savedAt: 'now' })
    const r = await answerOrchAct({ deps: depsWith({ handoffs: { save } }), act: 'handoffs.save', args: ['ses1', {}] })
    expect(save).toHaveBeenCalledWith('ses1', {})
    expect(r).toEqual({ ok: true, value: { ok: true, savedAt: 'now' } })
  })

  it('메서드는 제 객체에 묶여서 불린다', async () => {
    const sessionTasks = {
      mine: 'yes',
      start(this: { mine: string }) {
        return Promise.resolve(this.mine)
      }
    }
    const r = await answerOrchAct({ deps: depsWith({ sessionTasks }), act: 'sessionTasks.start', args: [] })
    expect(r).toEqual({ ok: true, value: 'yes' })
  })

  // 던지는 것은 Host 를 영영 기다리게 한다 — 실패는 값으로 답한다.
  it('실패는 던지지 않고 ok:false 로 답한다', async () => {
    const startWorker = vi.fn().mockRejectedValue(new Error('no account'))
    const r = await answerOrchAct({ deps: depsWith({ startWorker }), act: 'startWorker', args: [{}] })
    expect(r).toEqual({ ok: false, error: 'no account' })
  })

  // 배열이 아닌 것을 "인수 없음" 으로 읽으면 startWorker() 가 빈손으로 불린다 — 그 실패는 한참
  // 뒤에서 엉뚱한 문장으로 나온다.
  it('배열이 아닌 인수는 인수 없음으로 읽지 않고 거절한다', async () => {
    const startWorker = vi.fn()
    const r = await answerOrchAct({ deps: depsWith({ startWorker }), act: 'startWorker', args: { taskId: 't' } })
    expect(startWorker).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('startWorker')
  })

  it('이름이 없으면 그렇게 답한다', async () => {
    const r = await answerOrchAct({ deps: depsWith({}), act: 'noSuchThing', args: [] })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('noSuchThing')
  })

  // orchestration 이 안 돌고 있는 앱과, 그 이름을 모르는 앱은 사람이 읽을 때 다른 이야기다.
  it('orchestration 이 없으면 그 이유를 말한다', async () => {
    const r = await answerOrchAct({ deps: null, act: 'trackingEnabled', args: [] })
    expect((r as { error: string }).error).toContain('orchestration is not running')
  })

  // The m6 ruling (S4+S5 Task 13 review → Task 14): an app that yields dispatch to a Host announcing
  // it does not run the S5 starts that Host forwards to it. It leaves the Task for the Host that drives
  // next, the same way a retiring Host leaves it (Task 13).
  it.each(['startValidation', 'startReview', 'startRepair'])(
    'an app that yields dispatch does not run a forwarded %s, and says why',
    async (act) => {
      const start = vi.fn()
      const r = await answerOrchAct({ deps: depsWith({ [act]: start }), act, args: [{ taskId: 't', dispatchId: 'd' }], yieldsDispatch: true })
      expect(start).not.toHaveBeenCalled()
      expect(r.ok).toBe(false)
      expect((r as { error: string }).error).toMatch(/yields dispatch/)
    }
  )

  // Mixed versions (D5): in front of an older Host the app keeps its validator, review and repair.
  it.each(['startValidation', 'startReview', 'startRepair'])(
    'an app that does not yield dispatch runs a forwarded %s as before',
    async (act) => {
      const start = vi.fn()
      const r = await answerOrchAct({ deps: depsWith({ [act]: start }), act, args: [{ taskId: 't' }], yieldsDispatch: false })
      expect(start).toHaveBeenCalledWith({ taskId: 't' })
      expect(r.ok).toBe(true)
    }
  )

  it('yielding dispatch touches only the three starts', async () => {
    const startWorker = vi.fn().mockResolvedValue({ sessionId: 's' })
    const repairTargetFor = vi.fn().mockReturnValue(null)
    expect((await answerOrchAct({ deps: depsWith({ startWorker }), act: 'startWorker', args: [{}], yieldsDispatch: true })).ok).toBe(true)
    expect((await answerOrchAct({ deps: depsWith({ repairTargetFor }), act: 'repairTargetFor', args: ['t'], yieldsDispatch: true })).ok).toBe(true)
    expect(startWorker).toHaveBeenCalled()
    expect(repairTargetFor).toHaveBeenCalled()
  })

  it('함수가 아닌 속성은 행동이 아니다', () => {
    expect(orchActionOf(depsWith({ handoffs: {} }), 'handoffs.save')).toBeNull()
    expect(orchActionOf(depsWith({ lang: 'ko' }), 'lang')).toBeNull()
  })
})
