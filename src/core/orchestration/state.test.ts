import { describe, it, expect } from 'vitest'
import {
  emptyState,
  createRun,
  createTask,
  openDispatch,
  applyWorkerDone,
  applyValidationResult,
  blockForValidation,
  openReviewDispatch,
  applyReviewResult,
  blockForReview,
  closeDispatch,
  rekeyDispatch,
  recordStopSnapshot,
  recordResume,
  nextDelivery,
  ackDelivery,
  createQuestion,
  applyReply,
  createGate,
  resolveGate,
  deleteRuns,
  spawnScheduledRun,
  latestOrdinaryRun,
  setRunWorktree,
  attachCoordinator,
  detachCoordinator,
  type OrchState
} from './state'
import { DELIVERY_MAX, FAILURE_LIMIT, canTransition, type Task } from './types'

const NOW = '2026-08-04T00:00:00.000Z'
const LATER = '2026-08-04T01:00:00.000Z'
const EVEN_LATER = '2026-08-04T02:00:00.000Z'
const LATEST = '2026-08-04T03:00:00.000Z'
const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}

/** run + task + dispatch가 준비된 상태를 만든다 */
const seed = (): { s: OrchState; runId: string; taskId: string; dispatchId: string } => {
  let { state: s, value: run } = unwrap<{ id: string }>(
    createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
  )
  const t = unwrap<{ id: string }>(
    createTask(s, { runId: run.id, title: 't', spec: 'do it', deps: [] }, NOW) as never
  )
  s = t.state
  const d = unwrap<{ id: string }>(
    openDispatch(
      s,
      {
        taskId: t.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/x.md'
      },
      NOW
    ) as never
  )
  return { s: d.state, runId: run.id, taskId: t.value.id, dispatchId: d.value.id }
}

describe('Delivery 배치', () => {
  it('ack 전에는 같은 배치를 다시 돌려준다', () => {
    const { s, runId, taskId, dispatchId } = seed()
    const done = unwrap<'accepted'>(
      applyWorkerDone(
        s,
        { taskId, dispatchId, outcome: 'succeeded', subject: 'a', body: 'b' },
        NOW
      ) as never
    )
    const first = unwrap<{ delivery: { id: string }; messages: unknown[] }>(
      nextDelivery(done.state, { runId }, NOW) as never
    )
    const second = unwrap<{ delivery: { id: string } }>(
      nextDelivery(first.state, { runId }, NOW) as never
    )
    expect(second.value.delivery.id).toBe(first.value.delivery.id)
  })
  it('ack 후에는 빈 결과를 돌려준다', () => {
    const { s, runId, taskId, dispatchId } = seed()
    let cur = unwrap<'accepted'>(
      applyWorkerDone(
        s,
        { taskId, dispatchId, outcome: 'succeeded', subject: 'a', body: 'b' },
        NOW
      ) as never
    ).state
    const first = unwrap<{ delivery: { id: string } }>(nextDelivery(cur, { runId }, NOW) as never)
    cur = unwrap<unknown>(
      ackDelivery(first.state, { deliveryId: first.value.delivery.id }, NOW) as never
    ).state
    const after = nextDelivery(cur, { runId }, NOW)
    expect(after.ok && after.value).toBeNull()
  })
  it(`한 배치는 최대 ${DELIVERY_MAX}통이다`, () => {
    let { s, runId, taskId, dispatchId } = seed()
    for (let i = 0; i < DELIVERY_MAX + 5; i++) {
      s = unwrap<unknown>(
        createQuestion(s, { taskId, dispatchId, question: `q${i}` }, NOW) as never
      ).state
      // 다음 질문을 만들려면 앞 질문에 답이 있어야 한다 (Dispatch당 미응답 1개 규칙)
      const pending = s.messages.filter((m) => m.type === 'question' && !m.answered)
      s = unwrap<unknown>(applyReply(s, { messageId: pending[0].id, body: 'a' }, NOW) as never).state
    }
    const d = unwrap<{ messages: unknown[] }>(nextDelivery(s, { runId }, NOW) as never)
    expect(d.value.messages.length).toBe(DELIVERY_MAX)
  })
  it('types 필터는 깨어날 조건만 정하고 배치는 전체를 준다', () => {
    let { s, runId, taskId, dispatchId } = seed()
    s = unwrap<unknown>(
      createQuestion(s, { taskId, dispatchId, question: 'q' }, NOW) as never
    ).state
    s = unwrap<unknown>(applyReply(s, { messageId: s.messages[0].id, body: 'a' }, NOW) as never)
      .state
    s = unwrap<unknown>(
      applyWorkerDone(
        s,
        { taskId, dispatchId, outcome: 'succeeded', subject: 'a', body: 'b' },
        NOW
      ) as never
    ).state
    const d = unwrap<{ messages: { type: string }[] }>(
      nextDelivery(s, { runId, types: ['worker_done'] }, NOW) as never
    )
    // question·answer·worker_done 이 모두 들어 있다 — 필터는 깨어날 조건이었을 뿐
    expect(d.value.messages.map((m) => m.type)).toContain('question')
    expect(d.value.messages.map((m) => m.type)).toContain('worker_done')
  })
  it('미ack 배치 안의 질문이 종결돼도 재생 배치 크기가 줄지 않는다 — 메시지를 삭제하지 않는다', () => {
    const { s, runId, taskId, dispatchId } = seed()
    const q = unwrap<{ id: string }>(
      createQuestion(s, { taskId, dispatchId, question: 'q' }, NOW) as never
    )
    const first = unwrap<{ delivery: { id: string }; messages: { id: string }[] }>(
      nextDelivery(q.state, { runId }, NOW) as never
    )
    expect(first.value.messages.length).toBe(1)
    // 세션이 죽어 미응답 질문이 종결된다 — 이 메시지는 이미 미ack 배치에 들어가 있다
    const closed = unwrap<unknown>(
      closeDispatch(first.state, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    const replay = unwrap<{ delivery: { id: string }; messages: unknown[] }>(
      nextDelivery(closed.state, { runId }, NOW) as never
    )
    expect(replay.value.delivery.id).toBe(first.value.delivery.id)
    expect(replay.value.messages.length).toBe(first.value.messages.length)
    const settled = closed.state.messages.find((m) => m.id === q.value.id)!
    expect(settled.answered).toBe(true)
    expect(settled.answerBody).toBe('')
  })
})

describe('worker_done', () => {
  it('Task와 Dispatch를 자동으로 종단 상태로 옮긴다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap<'accepted'>(
      applyWorkerDone(
        s,
        { taskId, dispatchId, outcome: 'succeeded', subject: 'a', body: 'b' },
        NOW
      ) as never
    )
    expect(r.state.tasks.find((t) => t.id === taskId)!.status).toBe('completed')
    expect(r.state.dispatches.find((d) => d.id === dispatchId)!.outcome).toBe('succeeded')
  })
  it('두 번째 보고는 alreadyReported로 무시한다', () => {
    const { s, taskId, dispatchId } = seed()
    const once = unwrap<'accepted'>(
      applyWorkerDone(
        s,
        { taskId, dispatchId, outcome: 'succeeded', subject: 'a', body: 'b' },
        NOW
      ) as never
    )
    const twice = applyWorkerDone(
      once.state,
      { taskId, dispatchId, outcome: 'failed', subject: 'c', body: 'd' },
      NOW
    )
    expect(twice.ok && twice.value).toBe('alreadyReported')
    expect(twice.ok && twice.state.tasks[0].status).toBe('completed')
  })
  it('낡은 dispatch id로 온 보고는 거부한다', () => {
    const { s, taskId } = seed()
    const r = applyWorkerDone(
      s,
      { taskId, dispatchId: 'dsp_deadbeef', outcome: 'succeeded', subject: 'a', body: 'b' },
      NOW
    )
    expect(r.ok).toBe(false)
  })
  it('실패 보고는 consecutiveFailures를 올리고 3회면 재시도를 막는다', () => {
    let { s, taskId, dispatchId } = seed()
    for (let i = 0; i < 3; i++) {
      s = unwrap<unknown>(
        applyWorkerDone(
          s,
          { taskId, dispatchId, outcome: 'failed', subject: 'x', body: 'y' },
          NOW
        ) as never
      ).state
      if (i < 2) {
        const d = unwrap<{ id: string }>(
          openDispatch(
            s,
            {
              taskId,
              provider: 'codex',
              accountId: 'acc1',
              sessionId: `sess${i + 2}`,
              cwd: 'D:/p',
              specPath: 'D:/p/orch/specs/x.md',
              retryOf: dispatchId
            },
            NOW
          ) as never
        )
        s = d.state
        dispatchId = d.value.id
      }
    }
    expect(s.tasks[0].consecutiveFailures).toBe(3)
    const blocked = openDispatch(
      s,
      {
        taskId,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sessX',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/x.md',
        retryOf: dispatchId
      },
      NOW
    )
    expect(blocked.ok).toBe(false)
  })
  it('성공 보고는 consecutiveFailures를 0으로 되돌린다', () => {
    let { s, taskId, dispatchId } = seed()
    s = unwrap<unknown>(
      applyWorkerDone(s, { taskId, dispatchId, outcome: 'failed', subject: 'x', body: 'y' }, NOW) as never
    ).state
    const d = unwrap<{ id: string }>(
      openDispatch(
        s,
        {
          taskId,
          provider: 'claude',
          accountId: 'acc2',
          sessionId: 'sess2',
          cwd: 'D:/p',
          specPath: 'D:/p/orch/specs/y.md',
          retryOf: dispatchId
        },
        NOW
      ) as never
    )
    const ok = unwrap<unknown>(
      applyWorkerDone(
        d.state,
        { taskId, dispatchId: d.value.id, outcome: 'succeeded', subject: 'a', body: 'b' },
        NOW
      ) as never
    )
    expect(ok.state.tasks[0].consecutiveFailures).toBe(0)
  })
  it('세션 종료로 닫힌 낡은 dispatch로 지연 도착한 worker_done은 alreadyReported로 무시되고 Task 종단 상태를 탈취하지 않는다', () => {
    const { s, taskId, dispatchId } = seed()
    // 세션이 보고 없이 죽는다 — dispatchId는 endedAt만 있고 outcome은 없다
    const closed = unwrap<unknown>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 137 }, NOW) as never
    )
    // 살아있는 retry를 새로 연다
    const retry = unwrap<{ id: string }>(
      openDispatch(
        closed.state,
        {
          taskId,
          provider: 'codex',
          accountId: 'acc1',
          sessionId: 'sess2',
          cwd: 'D:/p',
          specPath: 'D:/p/orch/specs/x.md',
          retryOf: dispatchId
        },
        NOW
      ) as never
    )
    // 낡은 dispatchId(dispatch1)로 지연 도착한 worker_done — alreadyReported로 무시돼야 한다
    const stale = applyWorkerDone(
      retry.state,
      { taskId, dispatchId, outcome: 'succeeded', subject: 'stale', body: 'stale result' },
      NOW
    )
    expect(stale.ok && stale.value).toBe('alreadyReported')
    // retry(살아있는 dispatch)의 진짜 보고는 여전히 받아들여져야 한다 — 낡은 보고가 종단을
    // 선점하지 않았다
    const real = unwrap<'accepted'>(
      applyWorkerDone(
        stale.ok ? stale.state : retry.state,
        { taskId, dispatchId: retry.value.id, outcome: 'failed', subject: 'real', body: 'real result' },
        NOW
      ) as never
    )
    expect(real.state.tasks.find((t) => t.id === taskId)!.status).toBe('failed')
    expect(real.state.tasks.find((t) => t.id === taskId)!.result).toBe('real result')
  })
})

describe('ask / reply', () => {
  it('질문에 답하면 answered와 answerBody가 채워진다', () => {
    const { s, taskId, dispatchId } = seed()
    const q = unwrap<{ id: string }>(
      createQuestion(s, { taskId, dispatchId, question: '어느 쪽?', options: ['a', 'b'] }, NOW) as never
    )
    const r = unwrap<'accepted'>(
      applyReply(q.state, { messageId: q.value.id, body: 'a' }, NOW) as never
    )
    const msg = r.state.messages.find((m) => m.id === q.value.id)!
    expect(msg.answered).toBe(true)
    expect(msg.answerBody).toBe('a')
  })
  it('Dispatch당 미응답 질문은 1개만 허용한다', () => {
    const { s, taskId, dispatchId } = seed()
    const q = unwrap<unknown>(
      createQuestion(s, { taskId, dispatchId, question: 'q1' }, NOW) as never
    )
    const second = createQuestion(q.state, { taskId, dispatchId, question: 'q2' }, NOW)
    expect(second.ok).toBe(false)
  })
  it('이미 답한 질문에 또 답하면 alreadyAnswered로 무시한다', () => {
    const { s, taskId, dispatchId } = seed()
    const q = unwrap<{ id: string }>(
      createQuestion(s, { taskId, dispatchId, question: 'q' }, NOW) as never
    )
    const once = unwrap<'accepted'>(
      applyReply(q.state, { messageId: q.value.id, body: 'a' }, NOW) as never
    )
    const twice = applyReply(once.state, { messageId: q.value.id, body: 'b' }, NOW)
    expect(twice.ok && twice.value).toBe('alreadyAnswered')
    expect(twice.ok && twice.state.messages.find((m) => m.id === q.value.id)!.answerBody).toBe('a')
  })
  it('존재하지 않는 질문에 답하면 거부한다', () => {
    const { s } = seed()
    expect(applyReply(s, { messageId: 'msg_deadbeef', body: 'a' }, NOW).ok).toBe(false)
  })
  it('Dispatch가 닫히면 미응답 질문을 답변 없이 종결한다 — 메시지를 삭제하지 않는다', () => {
    // 원래는 "폐기한다"(삭제) 였으나, 미ack Delivery의 messageIds가 이 id를 참조하고 있으면
    // 삭제가 재생 배치를 비워버리는 결함으로 이어진다. 삭제 대신 답변 없이
    // 종결(answered:true, answerBody:'')하는 것이 이제 계약이다.
    const { s, taskId, dispatchId } = seed()
    const q = unwrap<{ id: string }>(
      createQuestion(s, { taskId, dispatchId, question: 'q' }, NOW) as never
    )
    const closed = unwrap<unknown>(
      closeDispatch(q.state, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    const msg = closed.state.messages.find((m) => m.id === q.value.id)
    expect(msg).toBeDefined()
    expect(msg!.answered).toBe(true)
    expect(msg!.answerBody).toBe('')
  })
  it('세션 종료로 닫힌 dispatch에는 새 질문을 만들 수 없다', () => {
    const { s, taskId, dispatchId } = seed()
    const closed = unwrap<unknown>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    const q = createQuestion(closed.state, { taskId, dispatchId, question: 'q' }, NOW)
    expect(q.ok).toBe(false)
  })
})

describe('closeDispatch — 세션 exit 반영', () => {
  it('종료 코드 0이면 stopped, 아니면 failed로 표시한다', () => {
    const a = seed()
    const zero = unwrap<unknown>(
      closeDispatch(a.s, { sessionId: 'sess1', exitCode: 0 }, NOW) as never
    )
    expect(zero.state.dispatches[0].workerState).toBe('stopped')

    const b = seed()
    const one = unwrap<unknown>(
      closeDispatch(b.s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    expect(one.state.dispatches[0].workerState).toBe('failed')
  })
  it('Task를 자동으로 failed로 옮기지 않는다 — 증명할 수 없는 결과는 단정하지 않는다', () => {
    const { s, taskId } = seed()
    const closed = unwrap<unknown>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    expect(closed.state.tasks.find((t) => t.id === taskId)!.status).toBe('dispatched')
  })
  it('exit 사실을 status 메시지로 inbox에 남긴다', () => {
    const { s } = seed()
    const closed = unwrap<unknown>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 137 }, NOW) as never
    )
    const msg = closed.state.messages.find((m) => m.type === 'status')!
    expect(msg.body).toContain('137')
  })
  it('이미 닫힌 Dispatch면 null을 돌려주고 상태를 바꾸지 않는다', () => {
    const { s, taskId, dispatchId } = seed()
    const done = unwrap<unknown>(
      applyWorkerDone(
        s,
        { taskId, dispatchId, outcome: 'succeeded', subject: 'a', body: 'b' },
        NOW
      ) as never
    )
    const r = closeDispatch(done.state, { sessionId: 'sess1', exitCode: 0 }, NOW)
    expect(r.ok && r.value).toBeNull()
  })

  describe('보고 없는 죽음도 서킷 브레이커에 센다', () => {
    it('consecutiveFailures를 올린다 — status는 그대로다', () => {
      const { s, taskId } = seed()
      const closed = unwrap<unknown>(
        closeDispatch(s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
      )
      const t = closed.state.tasks.find((x) => x.id === taskId)!
      expect(t.consecutiveFailures).toBe(1)
      expect(t.status).toBe('dispatched')
    })

    it('세션 종료로 닫힌 Dispatch 3개 뒤 --retry-of가 circuit break로 거부된다', () => {
      // 카운트하지 않으면 Task가 dispatched에 남고 moveTask의 `t.status === to` 통과 덕에
      // --retry-of가 몇 번이든 받아들여진다 — 막으려 한 무한 재시도다.
      let { s, taskId, dispatchId } = seed()
      for (let i = 1; i <= FAILURE_LIMIT; i++) {
        const closed = unwrap<unknown>(
          closeDispatch(s, { sessionId: `sess${i}`, exitCode: 1 }, NOW) as never
        )
        s = closed.state
        expect(s.tasks.find((t) => t.id === taskId)!.consecutiveFailures).toBe(i)
        if (i === FAILURE_LIMIT) break
        const retried = unwrap<{ id: string }>(
          openDispatch(
            s,
            {
              taskId,
              provider: 'codex',
              accountId: 'acc1',
              sessionId: `sess${i + 1}`,
              cwd: 'D:/p',
              specPath: 'D:/p/orch/specs/x.md',
              retryOf: dispatchId
            },
            NOW
          ) as never
        )
        s = retried.state
        dispatchId = retried.value.id
      }
      const blocked = openDispatch(
        s,
        {
          taskId,
          provider: 'codex',
          accountId: 'acc1',
          sessionId: 'sess_last',
          cwd: 'D:/p',
          specPath: 'D:/p/orch/specs/x.md',
          retryOf: dispatchId
        },
        NOW
      )
      expect(blocked.ok).toBe(false)
      expect(!blocked.ok && blocked.error).toContain('circuit break')
    })
  })
})

describe('closeDispatch — limitResetsAt', () => {
  it('limitResetsAt을 넘기면 Dispatch에 실리고 status 메시지가 한도 문구로 바뀐다', () => {
    const { s } = seed()
    const limitResetsAt = 1_700_000_000_000
    const closed = unwrap<{ limitResetsAt?: number }>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 1, limitResetsAt }, NOW) as never
    )
    expect(closed.value.limitResetsAt).toBe(limitResetsAt)
    const msg = closed.state.messages.find((m) => m.type === 'status')!
    expect(msg.subject).toBe('session ended at a usage limit')
    expect(msg.body).toContain(new Date(limitResetsAt).toISOString())
  })
  it('넘기지 않으면 필드가 아예 없다', () => {
    const { s } = seed()
    const closed = unwrap<Record<string, unknown>>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    expect('limitResetsAt' in closed.value).toBe(false)
  })
  it('넘기지 않을 때 기존 subject·body가 그대로다', () => {
    const { s } = seed()
    const closed = unwrap<unknown>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    const msg = closed.state.messages.find((m) => m.type === 'status')!
    expect(msg.subject).toBe('session ended without reporting')
    expect(msg.body).toBe('exitCode=1. No worker_done was received.')
  })
  it('한도여도 Task의 status는 자동으로 바뀌지 않는다', () => {
    // **status 불변만 단정한다**. 이 테스트의 본질은 "Task를 자동 실패 처리하지
    // 않는다"이고 그것은 status 하나에 실려 있다. 원래는 updatedAt 불변도 함께 단정했는데,
    // closeDispatch가 consecutiveFailures를 올리게 되면서(§8 "한도도 3회에 센다" — 안 올리면
    // --retry-of가 무한히 통과한다) updatedAt도 함께 갱신된다: store의 TTL이 Run의 마지막 활동
    // 시각을 updatedAt에서 파생하므로 갱신하는 것이 맞다. 그 둘 외의 필드는 여전히 불변이다.
    const seeded = seed()
    // 이전 시도가 남긴 값을 심는다 — 비어 있으면 "불변" 단정이 undefined === undefined로 공허해진다
    const s: OrchState = {
      ...seeded.s,
      tasks: seeded.s.tasks.map((t) =>
        t.id === seeded.taskId
          ? { ...t, result: '이전 시도의 결과', filesModified: ['src/a.ts'] }
          : t
      )
    }
    const taskId = seeded.taskId
    const before = s.tasks.find((t) => t.id === taskId)!
    const closed = unwrap<unknown>(
      closeDispatch(
        s,
        { sessionId: 'sess1', exitCode: 1, limitResetsAt: 1_700_000_000_000 },
        NOW
      ) as never
    )
    const after = closed.state.tasks.find((t) => t.id === taskId)!
    expect(after.status).toBe(before.status)
    expect(after.result).toBe('이전 시도의 결과')
    expect(after.filesModified).toEqual(['src/a.ts'])
    expect(after.deps).toBe(before.deps)
  })
})

describe('Gate', () => {
  it('열린 dispatch가 있으면 Gate 생성을 거부한다 — Gate는 진행 중인 워커를 막는 장치가 아니다', () => {
    const { s, taskId } = seed() // seed()는 항상 열린 dispatch를 남긴다
    const g = createGate(s, { taskId, question: '진행할까?' }, NOW)
    expect(g.ok).toBe(false)
  })
  it('Gate를 만들면 Task가 blocked가 되고 dispatch를 막는다', () => {
    // 열린 dispatch가 있으면 Gate 자체가 거부되므로(위 테스트), 아직 dispatch되지 않은
    // (ready) Task로 준비한다 — seed()는 쓸 수 없다.
    const run = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const t = unwrap<{ id: string }>(
      createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW) as never
    )
    const g = unwrap<{ id: string }>(
      createGate(
        t.state,
        { taskId: t.value.id, question: '진행할까?', options: ['yes', 'no'] },
        NOW
      ) as never
    )
    expect(g.state.tasks.find((x) => x.id === t.value.id)!.status).toBe('blocked')
    const blocked = openDispatch(
      g.state,
      {
        taskId: t.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sessY',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/z.md'
      },
      NOW
    )
    expect(blocked.ok).toBe(false)
  })
  it('gate-resolve가 Task를 ready로 되돌린다', () => {
    const run = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const t = unwrap<{ id: string }>(
      createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW) as never
    )
    const g = unwrap<{ id: string }>(
      createGate(t.state, { taskId: t.value.id, question: 'q' }, NOW) as never
    )
    const r = unwrap<unknown>(
      resolveGate(g.state, { gateId: g.value.id, resolution: 'yes' }, NOW) as never
    )
    expect(r.state.gates[0].status).toBe('resolved')
    expect(r.state.tasks.find((x) => x.id === t.value.id)!.status).toBe('ready')
  })
  it('실패한 Task는 Gate로 감쌀 수 있다 — 재시도할지 포기할지 사람에게 묻고, 풀리면 재시도까지 간다 (2026-08-04 판정)', () => {
    const { s, taskId, dispatchId } = seed()
    const failed = unwrap<'accepted'>(
      applyWorkerDone(s, { taskId, dispatchId, outcome: 'failed', subject: 'x', body: 'y' }, NOW) as never
    )
    expect(failed.state.tasks.find((t) => t.id === taskId)!.status).toBe('failed')
    // failed에는 열린 dispatch가 없으므로 createGate가 열린-dispatch 가드에 걸리지 않고 성공한다
    const g = unwrap<{ id: string }>(
      createGate(
        failed.state,
        { taskId, question: '재시도할까 포기할까?', options: ['retry', 'abandon'] },
        NOW
      ) as never
    )
    expect(g.state.tasks.find((t) => t.id === taskId)!.status).toBe('blocked')
    const resolved = unwrap<unknown>(
      resolveGate(g.state, { gateId: g.value.id, resolution: 'retry' }, NOW) as never
    )
    expect(resolved.state.tasks.find((t) => t.id === taskId)!.status).toBe('ready')
    const retry = openDispatch(
      resolved.state,
      {
        taskId,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess2',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/x.md',
        retryOf: dispatchId
      },
      NOW
    )
    expect(retry.ok).toBe(true)
  })

  describe('gate-resolve가 deps를 뛰어넘지 않는다', () => {
    /** A(pending) ← B(deps:[A]) 를 만들고 B에 Gate를 걸어 blocked로 둔다 */
    const blockedWithPendingDep = (): { s: OrchState; gateId: string; a: string; b: string } => {
      const run = unwrap<{ id: string }>(
        createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
      )
      const a = unwrap<{ id: string }>(
        createTask(run.state, { runId: run.value.id, title: 'A', spec: 's', deps: [] }, NOW) as never
      )
      const b = unwrap<{ id: string }>(
        createTask(
          a.state,
          { runId: run.value.id, title: 'B', spec: 's', deps: [a.value.id] },
          NOW
        ) as never
      )
      // A는 deps가 없어 곧바로 ready다 — 아직 completed가 아니므로 B는 pending에 머문다
      expect(b.state.tasks.find((t) => t.id === b.value.id)!.status).toBe('pending')
      const g = unwrap<{ id: string }>(
        createGate(b.state, { taskId: b.value.id, question: '진행할까?' }, NOW) as never
      )
      return { s: g.state, gateId: g.value.id, a: a.value.id, b: b.value.id }
    }

    it('deps가 아직 completed가 아니면 pending으로 풀린다 — ready가 아니다', () => {
      // 무조건 ready로 옮기면 task-list --ready가 B를 보여주고 worker-start가 통과해
      // 워커가 A의 산출물 없이 작업한다(DAG 순서 강제가 사라진다).
      const { s, gateId, b } = blockedWithPendingDep()
      const r = unwrap<unknown>(resolveGate(s, { gateId, resolution: 'yes' }, NOW) as never)
      expect(r.state.tasks.find((t) => t.id === b)!.status).toBe('pending')
      expect(r.state.tasks.filter((t) => t.status === 'ready').map((t) => t.id)).not.toContain(b)
    })

    it('그 뒤 A가 완료되면 B가 ready로 올라온다', () => {
      const { s, gateId, a, b } = blockedWithPendingDep()
      const resolved = unwrap<unknown>(resolveGate(s, { gateId, resolution: 'yes' }, NOW) as never)
      const dispatched = unwrap<{ id: string }>(
        openDispatch(
          resolved.state,
          {
            taskId: a,
            provider: 'codex',
            accountId: 'acc1',
            sessionId: 'sessA',
            cwd: 'D:/p',
            specPath: 'D:/p/orch/specs/a.md'
          },
          NOW
        ) as never
      )
      const done = unwrap<'accepted'>(
        applyWorkerDone(
          dispatched.state,
          { taskId: a, dispatchId: dispatched.value.id, outcome: 'succeeded', subject: 'x', body: 'y' },
          NOW
        ) as never
      )
      expect(done.state.tasks.find((t) => t.id === b)!.status).toBe('ready')
    })
  })
})

describe('createTask — deps 검증', () => {
  it('존재하지 않는 dep을 거부한다', () => {
    const run = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const r = createTask(
      run.state,
      { runId: run.value.id, title: 't', spec: 's', deps: ['tsk_nope'] },
      NOW
    )
    expect(r.ok).toBe(false)
  })
  it('자기 자신을 dep으로 두는 순환을 거부한다', () => {
    const run = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const a = unwrap<{ id: string }>(
      createTask(run.state, { runId: run.value.id, title: 'a', spec: 's', deps: [] }, NOW) as never
    )
    // b -> a 는 정상
    const b = unwrap<{ id: string; deps: string[] }>(
      createTask(
        a.state,
        { runId: run.value.id, title: 'b', spec: 's', deps: [a.value.id] },
        NOW
      ) as never
    )
    // a 의 deps 를 b 로 만들려면 task-update 가 필요하고 그건 이 함수의 책임이 아니다.
    // 여기서는 생성 시점에 이미 있는 Task 만 참조할 수 있으므로 순환이 원리적으로 불가능하다.
    expect(b.value.deps).toEqual([a.value.id])
  })
  it('validateConfigId 를 그대로 저장한다', () => {
    const run = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const r = createTask(
      run.state,
      { runId: run.value.id, title: 't', spec: 's', deps: [], validateConfigId: 'cfg1' },
      NOW
    )
    expect(r.ok && r.value.validateConfigId).toBe('cfg1')
  })
  it('validateConfigId 가 없으면 필드 자체가 없다', () => {
    const run = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const r = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW)
    expect(r.ok && 'validateConfigId' in r.value).toBe(false)
  })
})

describe('openDispatch — retryOf·sessionId 검증', () => {
  it('retryOf가 아직 열려 있는 dispatch를 가리키면 거부한다', () => {
    const { s, taskId, dispatchId } = seed() // seed()의 dispatch는 아직 열려 있다
    const r = openDispatch(
      s,
      {
        taskId,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess2',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/x.md',
        retryOf: dispatchId
      },
      NOW
    )
    expect(r.ok).toBe(false)
  })
  it('retryOf가 존재하지 않는 dispatch를 가리키면 거부한다', () => {
    const { s, taskId } = seed()
    const closed = unwrap<unknown>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    const r = openDispatch(
      closed.state,
      {
        taskId,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess2',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/x.md',
        retryOf: 'dsp_deadbeef'
      },
      NOW
    )
    expect(r.ok).toBe(false)
  })
  it('retryOf가 다른 Task 소속 dispatch를 가리키면 거부한다', () => {
    const { s, dispatchId } = seed()
    const run2 = unwrap<{ id: string }>(
      createRun(s, { objective: 'o2', cwd: 'D:/p' }, NOW) as never
    )
    const t2 = unwrap<{ id: string }>(
      createTask(run2.state, { runId: run2.value.id, title: 't2', spec: 's', deps: [] }, NOW) as never
    )
    const r = openDispatch(
      t2.state,
      {
        taskId: t2.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess2',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/y.md',
        retryOf: dispatchId // seed()의 Task 소속, t2 소속이 아니다
      },
      NOW
    )
    expect(r.ok).toBe(false)
  })
  it('sessionId가 이미 열린 dispatch에 쓰이고 있으면 거부한다', () => {
    const { s, taskId } = seed() // sessionId 'sess1'이 이미 열려 있다
    const run2 = unwrap<{ id: string }>(
      createRun(s, { objective: 'o2', cwd: 'D:/p' }, NOW) as never
    )
    const t2 = unwrap<{ id: string }>(
      createTask(run2.state, { runId: run2.value.id, title: 't2', spec: 's', deps: [] }, NOW) as never
    )
    // 다른 Task에 같은 sessionId로 dispatch를 열려는 시도 — 여전히 거부돼야 한다
    const r = openDispatch(
      t2.state,
      {
        taskId: t2.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/y.md'
      },
      NOW
    )
    expect(r.ok).toBe(false)
    // taskId를 참조는 하지만 아무 상태도 바뀌지 않았음을 확인 (미사용 변수 경고 방지 겸 확인)
    expect(s.tasks.find((x) => x.id === taskId)!.status).toBe('dispatched')
  })
})

describe('검증을 거치는 전이', () => {
  /** seed() 가 만드는 Task 에 검증 구성을 달아 준다 — seed 자체는 건드리지 않는다 */
  const withValidate = (s: OrchState, taskId: string, extra: Partial<Task> = {}): OrchState => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, validateConfigId: 'cfg1', ...extra } : t))
  })
  const done = (taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed') => ({
    taskId, dispatchId, outcome, subject: 's', body: 'b'
  })

  it('검증이 걸린 Task 는 worker_done(succeeded) 에 validating 으로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(applyWorkerDone(withValidate(s, taskId), done(taskId, dispatchId, 'succeeded'), NOW) as never)
    expect(r.state.tasks[0].status).toBe('validating')
  })

  it('검증이 없으면 지금처럼 completed 로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(applyWorkerDone(s, done(taskId, dispatchId, 'succeeded'), NOW) as never)
    expect(r.state.tasks[0].status).toBe('completed')
  })

  // 워커가 실패했다는데 검증할 이유가 없다
  it('worker_done(failed) 는 검증이 걸려 있어도 failed 로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(applyWorkerDone(withValidate(s, taskId), done(taskId, dispatchId, 'failed'), NOW) as never)
    expect(r.state.tasks[0].status).toBe('failed')
  })

  // **회로 차단이 걸리려면 이것이 필요하다.** 성공 보고에 카운터를 0 으로 되돌리면, 이어진 검증
  // 실패가 1 을 만들고 다음 시도도 0 -> 1 이라 FAILURE_LIMIT 에 닿을 수 없다
  it('validating 으로 갈 때 consecutiveFailures 를 초기화하지 않는다', () => {
    const { s, taskId, dispatchId } = seed()
    const withCount = withValidate(s, taskId, { consecutiveFailures: 2 })
    const r = unwrap(applyWorkerDone(withCount, done(taskId, dispatchId, 'succeeded'), NOW) as never)
    expect(r.state.tasks[0].consecutiveFailures).toBe(2)
  })

  // **선택적 의존성은 무해하게 저하해야 한다.** 검증기가 없는 배선에서 validating 으로 보내면
  // 결과를 가져다줄 것이 아무것도 없어 Task 가 영원히 validating 이고, recomputeReady 는 completed
  // 만 승격시키므로 그 의존 서브트리 전체가 pending 에 멈춘다 — 앱 재시작 말고는 회복 수단이 없다.
  it('canValidate 가 false 면 검증이 걸려 있어도 곧바로 completed 로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(
      applyWorkerDone(
        withValidate(s, taskId),
        { ...done(taskId, dispatchId, 'succeeded'), canValidate: false },
        NOW
      ) as never
    )
    expect(r.state.tasks[0].status).toBe('completed')
  })

  // 검증 없이 completed 에 도달한 것이므로 카운터도 그때와 똑같이 초기화된다
  it('canValidate 가 false 면 consecutiveFailures 도 초기화한다', () => {
    const { s, taskId, dispatchId } = seed()
    const withCount = withValidate(s, taskId, { consecutiveFailures: 2 })
    const r = unwrap(
      applyWorkerDone(
        withCount,
        { ...done(taskId, dispatchId, 'succeeded'), canValidate: false },
        NOW
      ) as never
    )
    expect(r.state.tasks[0].consecutiveFailures).toBe(0)
  })

  // 인자를 모르는 순수 계층의 호출자에게는 지금까지의 동작이 유지된다
  it('canValidate 를 주지 않으면 검증이 걸린 Task 는 validating 으로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(
      applyWorkerDone(withValidate(s, taskId), { ...done(taskId, dispatchId, 'succeeded'), canValidate: true }, NOW) as never
    )
    expect(r.state.tasks[0].status).toBe('validating')
  })

  it('검증 없이 completed 로 갈 때는 초기화한다', () => {
    const { s, taskId, dispatchId } = seed()
    const withCount: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, consecutiveFailures: 2 } : t))
    }
    const r = unwrap(applyWorkerDone(withCount, done(taskId, dispatchId, 'succeeded'), NOW) as never)
    expect(r.state.tasks[0].consecutiveFailures).toBe(0)
  })
})

describe('applyValidationResult', () => {
  /** worker_done 까지 흘려 Task 를 validating 으로 만든 상태 */
  const validating = (extra: Partial<Task> = {}): { s: OrchState; taskId: string } => {
    const { s, taskId, dispatchId } = seed()
    const armed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, validateConfigId: 'cfg1', ...extra } : t))
    }
    const r = unwrap(
      applyWorkerDone(armed, { taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' }, NOW) as never
    )
    return { s: r.state, taskId }
  }

  it('종료 코드 0 이면 completed 이고 카운터를 초기화한다', () => {
    const { s, taskId } = validating({ consecutiveFailures: 2 })
    const r = unwrap(applyValidationResult(s, { taskId, exitCode: 0, output: 'ok' }, NOW) as never)
    expect(r.state.tasks[0].status).toBe('completed')
    expect(r.state.tasks[0].consecutiveFailures).toBe(0)
  })

  it('종료 코드가 0 이 아니면 failed 이고 카운터가 오른다', () => {
    const { s, taskId } = validating({ consecutiveFailures: 1 })
    const r = unwrap(applyValidationResult(s, { taskId, exitCode: 1, output: '실패 로그' }, NOW) as never)
    expect(r.state.tasks[0].status).toBe('failed')
    expect(r.state.tasks[0].consecutiveFailures).toBe(2)
  })

  // 재시도하는 워커가 무엇이 틀렸는지 읽을 수 있어야 한다
  it('실패하면 출력을 result 에 담는다', () => {
    const { s, taskId } = validating()
    const r = unwrap(applyValidationResult(s, { taskId, exitCode: 1, output: '실패 로그' }, NOW) as never)
    expect(r.state.tasks[0].result).toContain('실패 로그')
  })

  // **이것이 요점이다** — 검증되지 않은 결과 위에 다음 작업이 쌓이면 안 된다
  it('의존 Task 는 검증이 통과해야 ready 가 된다', () => {
    const { s, taskId } = validating()
    const next = unwrap<{ id: string }>(
      createTask(s, { runId: s.runs[0].id, title: 'next', spec: 'x', deps: [taskId] }, NOW) as never
    )
    expect(next.state.tasks[1].status).toBe('pending')
    const done = unwrap(applyValidationResult(next.state, { taskId, exitCode: 0, output: '' }, NOW) as never)
    expect(done.state.tasks[1].status).toBe('ready')
  })

  // **C1 — 코디네이터를 깨우는 수단은 메시지뿐이다.** check 는 nextDelivery 를 통해 s.messages 만
  // 읽으므로, 메시지가 없으면 검증이 Task 를 failed 로 보냈다는 사실이 코디네이터에게 영원히
  // 도착하지 않는다. 그 코디네이터가 받은 마지막 소식은 "워커가 성공했다"다.
  it('실패하면 종료 코드와 출력을 담은 status 메시지를 붙인다', () => {
    const { s, taskId } = validating()
    const r = unwrap(applyValidationResult(s, { taskId, exitCode: 2, output: '실패 로그' }, NOW) as never)
    const m = r.state.messages[r.state.messages.length - 1]
    expect(m.type).toBe('status')
    expect(m.taskId).toBe(taskId)
    expect(m.runId).toBe(s.runs[0].id)
    expect(m.subject).toBe('validation failed')
    expect(m.body).toContain('exitCode=2')
    expect(m.body).toContain('실패 로그')
  })

  // 통과도 알려야 한다 — 의존 Task 가 풀린 것을 모르면 코디네이터는 다음 Task 를 띄우지 않는다
  it('통과해도 status 메시지를 붙인다', () => {
    const { s, taskId } = validating()
    const r = unwrap(applyValidationResult(s, { taskId, exitCode: 0, output: 'ok' }, NOW) as never)
    const m = r.state.messages[r.state.messages.length - 1]
    expect(m.type).toBe('status')
    expect(m.subject).toBe('validation passed')
    expect(m.taskId).toBe(taskId)
  })

  // 메시지는 미배달 상태로 붙어야 nextDelivery 가 배치를 만든다 — deliveryId 가 이미 있으면
  // check 가 그것을 건너뛰고 코디네이터는 그대로 잠들어 있는다
  it('붙은 메시지는 nextDelivery 의 배치에 들어간다', () => {
    const { s, taskId } = validating()
    const r = unwrap(applyValidationResult(s, { taskId, exitCode: 1, output: 'x' }, NOW) as never)
    const d = unwrap<{ messages: { subject: string }[] }>(
      nextDelivery(r.state, { runId: s.runs[0].id, types: ['status'] }, NOW) as never
    )
    expect(d.value.messages.map((m) => m.subject)).toContain('validation failed')
  })

  it('validating 이 아닌 Task 는 거절한다', () => {
    const { s, taskId } = seed()
    const r = applyValidationResult(s, { taskId, exitCode: 0, output: '' }, NOW)
    expect(r.ok).toBe(false)
  })

  // 거절된 호출은 메시지도 남기지 않는다 — 거절인데 코디네이터를 깨우면 안 된다
  it('거절되면 메시지도 붙지 않는다', () => {
    const { s, taskId } = validating()
    const settled = unwrap(applyValidationResult(s, { taskId, exitCode: 0, output: '' }, NOW) as never)
    const before = settled.state.messages.length
    const again = applyValidationResult(settled.state, { taskId, exitCode: 1, output: '' }, NOW)
    expect(again.ok).toBe(false)
    expect(settled.state.messages).toHaveLength(before)
  })

  it('없는 Task 는 거절한다', () => {
    const { s } = validating()
    const r = applyValidationResult(s, { taskId: 'nope', exitCode: 0, output: '' }, NOW)
    expect(r.ok).toBe(false)
  })
})

describe('reviewing', () => {
  /** seed() 가 만드는 Task 에 검토 요청을 달아 준다 — withValidate 와 같은 모양이다 */
  const withReview = (s: OrchState, taskId: string, extra: Partial<Task> = {}): OrchState => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, reviewRequested: true, ...extra } : t))
  })
  const done = (taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed') => ({
    taskId, dispatchId, outcome, subject: 's', body: 'b'
  })

  it('검토가 걸린 Task 는 성공 보고에 completed 가 아니라 reviewing 으로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(
      applyWorkerDone(withReview(s, taskId), done(taskId, dispatchId, 'succeeded'), NOW) as never
    )
    expect(r.state.tasks[0].status).toBe('reviewing')
  })

  it('검토가 걸리지 않은 Task 는 지금과 똑같이 completed 로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(applyWorkerDone(s, done(taskId, dispatchId, 'succeeded'), NOW) as never)
    expect(r.state.tasks[0].status).toBe('completed')
  })

  // 배선이 검토기를 주입하지 않은 경우 — reviewing 으로 보내면 꺼내 줄 것이 없어 그 자리에 멈춘다
  it('canReview: false 면 검토가 없는 Task 와 똑같이 동작한다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(
      applyWorkerDone(
        withReview(s, taskId),
        { ...done(taskId, dispatchId, 'succeeded'), canReview: false },
        NOW
      ) as never
    )
    expect(r.state.tasks[0].status).toBe('completed')
  })

  // 워커 자신이 안 됐다고 하는데 다른 에이전트에게 읽히는 것은 세션 낭비다
  it('워커가 실패를 보고하면 검토하지 않는다', () => {
    const { s, taskId, dispatchId } = seed()
    const r = unwrap(
      applyWorkerDone(withReview(s, taskId), done(taskId, dispatchId, 'failed'), NOW) as never
    )
    expect(r.state.tasks[0].status).toBe('failed')
  })

  // **검증이 먼저다.** 컴파일도 안 되는 코드를 읽으라고 세션을 태우지 않는다
  it('검증과 검토가 둘 다 걸리면 먼저 validating 으로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const armed = withReview(s, taskId, { validateConfigId: 'cfg1' })
    const r = unwrap(applyWorkerDone(armed, done(taskId, dispatchId, 'succeeded'), NOW) as never)
    expect(r.state.tasks[0].status).toBe('validating')
  })

  it('검증이 통과하면 completed 가 아니라 reviewing 으로 간다', () => {
    const { s, taskId, dispatchId } = seed()
    const armed = withReview(s, taskId, { validateConfigId: 'cfg1' })
    const toValidating = unwrap(
      applyWorkerDone(armed, done(taskId, dispatchId, 'succeeded'), NOW) as never
    )
    const r = unwrap(
      applyValidationResult(
        toValidating.state,
        { taskId, exitCode: 0, output: 'ok', canReview: true },
        NOW
      ) as never
    )
    expect(r.state.tasks[0].status).toBe('reviewing')
  })

  // 이 셋이 이 슬라이스에서 가장 틀리기 쉬운 자리다
  it('reviewing 으로 갈 때 연속 실패 카운터를 초기화하지 않는다 (worker_done 경로)', () => {
    const { s, taskId, dispatchId } = seed()
    const armed = withReview(s, taskId, { consecutiveFailures: 2 })
    const r = unwrap(applyWorkerDone(armed, done(taskId, dispatchId, 'succeeded'), NOW) as never)
    expect(r.state.tasks[0].status).toBe('reviewing')
    expect(r.state.tasks[0].consecutiveFailures).toBe(2)
  })

  it('reviewing 으로 갈 때 연속 실패 카운터를 초기화하지 않는다 (검증 통과 경로)', () => {
    // applyValidationResult 는 지금 passed ? 0 : ... 로 초기화한다 — reviewing 으로 갈 때는 넘겨야
    // 한다. 안 그러면 검증은 통과하고 검토는 실패하는 Task 가 매 시도마다 0 -> 1 을 반복해
    // FAILURE_LIMIT 에 영원히 닿지 않는다
    const { s, taskId, dispatchId } = seed()
    const armed = withReview(s, taskId, { validateConfigId: 'cfg1', consecutiveFailures: 2 })
    const toValidating = unwrap(
      applyWorkerDone(armed, done(taskId, dispatchId, 'succeeded'), NOW) as never
    )
    const r = unwrap(
      applyValidationResult(toValidating.state, { taskId, exitCode: 0, output: 'ok' }, NOW) as never
    )
    expect(r.state.tasks[0].status).toBe('reviewing')
    expect(r.state.tasks[0].consecutiveFailures).toBe(2)
  })

  it('검증이 통과해 completed 로 갈 때는 카운터를 0 으로 되돌린다', () => {
    // 위 두 개의 반대 — 실제로 completed 에 도달할 때만 초기화한다
    const { s, taskId, dispatchId } = seed()
    const armed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, validateConfigId: 'cfg1', consecutiveFailures: 2 } : t
      )
    }
    const toValidating = unwrap(
      applyWorkerDone(armed, done(taskId, dispatchId, 'succeeded'), NOW) as never
    )
    const r = unwrap(
      applyValidationResult(toValidating.state, { taskId, exitCode: 0, output: 'ok' }, NOW) as never
    )
    expect(r.state.tasks[0].status).toBe('completed')
    expect(r.state.tasks[0].consecutiveFailures).toBe(0)
  })
})

describe('blockForValidation', () => {
  it('Gate 를 열고 Task 를 blocked 로 보낸다', () => {
    const { s, taskId, dispatchId } = seed()
    const armed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, validateConfigId: 'cfg1' } : t))
    }
    const v = unwrap(
      applyWorkerDone(armed, { taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' }, NOW) as never
    )
    const r = unwrap<{ question: string }>(
      blockForValidation(v.state, { taskId, reason: '구성 cfg1 이 없습니다' }, NOW) as never
    )
    expect(r.state.tasks[0].status).toBe('blocked')
    expect(r.value.question).toContain('cfg1')
  })
})

describe('openReviewDispatch', () => {
  /** seed() 로 만든 Task 를 reviewing 까지 보낸 상태 — applyValidationResult 의 validating 헬퍼와
   *  같은 모양이다. worker_done 경로만 쓴다 — 검증을 거치는지는 이 describe 의 관심사가 아니다. */
  const reviewing = (extra: Partial<Task> = {}): { s: OrchState; taskId: string } => {
    const { s, taskId, dispatchId } = seed()
    const armed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, reviewRequested: true, ...extra } : t))
    }
    const r = unwrap(
      applyWorkerDone(
        armed,
        { taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' },
        NOW
      ) as never
    )
    return { s: r.state, taskId }
  }
  const review = (taskId: string, sessionId = 'sess2') => ({
    taskId,
    provider: 'claude' as const,
    accountId: 'acc2',
    sessionId,
    cwd: 'D:/p',
    specPath: 'D:/p/orch/specs/review.md'
  })

  it('reviewing 인 Task 에 review: true 인 Dispatch 를 연다', () => {
    const { s, taskId } = reviewing()
    const r = unwrap<{ id: string; taskId: string; review?: boolean }>(
      openReviewDispatch(s, review(taskId), NOW) as never
    )
    expect(r.value.taskId).toBe(taskId)
    expect(r.value.review).toBe(true)
  })

  // openDispatch 와 가장 크게 다른 점이다. 옮기면 의존 Task 를 막는 장치가 사라진다
  it('Task 를 dispatched 로 옮기지 않는다 — reviewing 그대로다', () => {
    const { s, taskId } = reviewing()
    const r = unwrap(openReviewDispatch(s, review(taskId), NOW) as never)
    expect(r.state.tasks.find((t) => t.id === taskId)!.status).toBe('reviewing')
  })

  it('reviewing 이 아닌 Task 에는 열 수 없다', () => {
    const { s, taskId } = seed() // seed() 직후는 dispatched 다
    const r = openReviewDispatch(s, review(taskId), NOW)
    expect(r.ok).toBe(false)
  })

  it('그 Task 에 열린 Dispatch 가 있으면 거절한다', () => {
    const { s, taskId } = reviewing()
    const first = unwrap(openReviewDispatch(s, review(taskId), NOW) as never)
    const second = openReviewDispatch(first.state, review(taskId, 'sess3'), NOW)
    expect(second.ok).toBe(false)
  })

  it('같은 sessionId 를 쓰는 열린 Dispatch 가 있으면 거절한다', () => {
    const { s, taskId } = reviewing()
    const t2 = unwrap<{ id: string }>(
      createTask(s, { runId: s.runs[0].id, title: 't2', spec: 's2', deps: [] }, NOW) as never
    )
    const d2 = unwrap(
      openDispatch(
        t2.state,
        {
          taskId: t2.value.id,
          provider: 'codex',
          accountId: 'acc1',
          sessionId: 'sess2',
          cwd: 'D:/p',
          specPath: 'x'
        },
        NOW
      ) as never
    )
    const r = openReviewDispatch(d2.state, review(taskId, 'sess2'), NOW)
    expect(r.ok).toBe(false)
  })
})

describe('applyReviewResult', () => {
  /** reviewing 인 Task 에 검토 Dispatch 까지 열어 둔 상태 */
  const reviewDispatched = (
    extra: Partial<Task> = {}
  ): { s: OrchState; taskId: string; reviewDispatchId: string } => {
    const { s, taskId, dispatchId } = seed()
    const armed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, reviewRequested: true, ...extra } : t))
    }
    const toReviewing = unwrap(
      applyWorkerDone(
        armed,
        { taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' },
        NOW
      ) as never
    )
    const opened = unwrap<{ id: string }>(
      openReviewDispatch(
        toReviewing.state,
        {
          taskId,
          provider: 'claude',
          accountId: 'acc2',
          sessionId: 'sess2',
          cwd: 'D:/p',
          specPath: 'D:/p/orch/specs/review.md'
        },
        NOW
      ) as never
    )
    return { s: opened.state, taskId, reviewDispatchId: opened.value.id }
  }

  it('통과하면 completed 로 가고 카운터가 0 이 된다', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched({ consecutiveFailures: 2 })
    const r = unwrap(
      applyReviewResult(
        s,
        { taskId, dispatchId: reviewDispatchId, outcome: 'succeeded', subject: 's', body: 'ok' },
        NOW
      ) as never
    )
    expect(r.state.tasks.find((t) => t.id === taskId)!.status).toBe('completed')
    expect(r.state.tasks.find((t) => t.id === taskId)!.consecutiveFailures).toBe(0)
  })

  it('실패하면 failed 로 가고 카운터가 오른다', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched({ consecutiveFailures: 1 })
    const r = unwrap(
      applyReviewResult(
        s,
        { taskId, dispatchId: reviewDispatchId, outcome: 'failed', subject: 's', body: '부족합니다' },
        NOW
      ) as never
    )
    expect(r.state.tasks.find((t) => t.id === taskId)!.status).toBe('failed')
    expect(r.state.tasks.find((t) => t.id === taskId)!.consecutiveFailures).toBe(2)
  })

  it('실패의 이유를 Task.result 에 남긴다', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched()
    const r = unwrap(
      applyReviewResult(
        s,
        {
          taskId,
          dispatchId: reviewDispatchId,
          outcome: 'failed',
          subject: 's',
          body: '요구사항 미충족'
        },
        NOW
      ) as never
    )
    expect(r.state.tasks.find((t) => t.id === taskId)!.result).toContain('요구사항 미충족')
  })

  // **양쪽 다 메시지가 되어야 한다.** 메시지가 코디네이터의 유일한 깨우기 수단이다 —
  // 통과를 알리지 않으면 의존 Task 가 풀린 것을 모르고 다음 Task 를 띄우지 않는다
  it('통과와 실패 양쪽에서 status 메시지를 남긴다', () => {
    const pass = reviewDispatched()
    const passR = unwrap(
      applyReviewResult(
        pass.s,
        {
          taskId: pass.taskId,
          dispatchId: pass.reviewDispatchId,
          outcome: 'succeeded',
          subject: 's',
          body: 'ok'
        },
        NOW
      ) as never
    )
    const passMsg = passR.state.messages[passR.state.messages.length - 1]
    expect(passMsg.type).toBe('status')
    expect(passMsg.subject).toBe('review passed')

    const fail = reviewDispatched()
    const failR = unwrap(
      applyReviewResult(
        fail.s,
        {
          taskId: fail.taskId,
          dispatchId: fail.reviewDispatchId,
          outcome: 'failed',
          subject: 's',
          body: 'no'
        },
        NOW
      ) as never
    )
    const failMsg = failR.state.messages[failR.state.messages.length - 1]
    expect(failMsg.type).toBe('status')
    expect(failMsg.subject).toBe('review failed')
  })

  it('그 메시지 본문에 검토자가 쓴 이유가 담긴다', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched()
    const r = unwrap(
      applyReviewResult(
        s,
        {
          taskId,
          dispatchId: reviewDispatchId,
          outcome: 'failed',
          subject: 's',
          body: '에러 처리가 빠졌습니다'
        },
        NOW
      ) as never
    )
    const m = r.state.messages[r.state.messages.length - 1]
    expect(m.body).toContain('에러 처리가 빠졌습니다')
  })

  it('구현 Dispatch(review 가 없는)의 id 로 오면 거절한다', () => {
    const { s, taskId, dispatchId } = seed()
    const armed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, reviewRequested: true } : t))
    }
    const toReviewing = unwrap(
      applyWorkerDone(
        armed,
        { taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' },
        NOW
      ) as never
    )
    const r = applyReviewResult(
      toReviewing.state,
      { taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'x' },
      NOW
    )
    expect(r.ok).toBe(false)
  })

  it('reviewing 이 아닌 Task 면 거절한다', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched()
    // 열린 검토 Dispatch 는 그대로 두고 Task 만 옮긴다 — API 로는 나올 수 없는 조합이지만,
    // applyReviewResult 의 가드가 Dispatch 가 아니라 Task 의 상태로 판정한다는 것을 확인한다
    const detached: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: 'dispatched' } : t))
    }
    const r = applyReviewResult(
      detached,
      { taskId, dispatchId: reviewDispatchId, outcome: 'succeeded', subject: 's', body: 'x' },
      NOW
    )
    expect(r.ok).toBe(false)
  })

  // applyWorkerDone 과 같은 판정 — closeDispatch 가 닫아 둔 Dispatch 에 늦게 도착한 보고가
  // Task 의 종료 상태를 가로채는 것을 막는다
  it('이미 닫힌 Dispatch 의 보고는 alreadyReported 다', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched()
    const settled = unwrap(
      applyReviewResult(
        s,
        { taskId, dispatchId: reviewDispatchId, outcome: 'succeeded', subject: 's', body: 'ok' },
        NOW
      ) as never
    )
    const again = unwrap<'accepted' | 'alreadyReported'>(
      applyReviewResult(
        settled.state,
        { taskId, dispatchId: reviewDispatchId, outcome: 'succeeded', subject: 's', body: 'ok' },
        NOW
      ) as never
    )
    expect(again.value).toBe('alreadyReported')
  })

  // 위 테스트는 outcome 이 찍힌 Dispatch 만 본다 — 그것만으로는 가드의 절반(`|| dispatch.endedAt`)을
  // 지워도 통과한다. 그리고 지워지면 안 되는 쪽이 이 절반이다: closeDispatch 는 endedAt 만 찍고
  // outcome 은 남기지 않으므로(세션이 보고 없이 죽은 경우), 그 뒤에 늦게 도착한 보고가 Task 의
  // 종료 상태를 가로챈다. applyWorkerDone 에서 실제로 났던 결함이다.
  it('endedAt 만 찍힌 Dispatch(보고 없이 죽은 세션)의 지연 보고도 alreadyReported 다', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched()
    // closeDispatch 가 만드는 모양 — endedAt 은 있고 outcome 은 없다
    const closed: OrchState = {
      ...s,
      dispatches: s.dispatches.map((d) =>
        d.id === reviewDispatchId ? { ...d, endedAt: NOW, workerState: 'failed' as const } : d
      )
    }
    const late = unwrap<'accepted' | 'alreadyReported'>(
      applyReviewResult(
        closed,
        { taskId, dispatchId: reviewDispatchId, outcome: 'succeeded', subject: 's', body: 'ok' },
        NOW
      ) as never
    )
    expect(late.value).toBe('alreadyReported')
    // Task 는 건드려지지 않는다 — 그것이 이 가드가 막는 것이다
    expect(late.state.tasks.find((t) => t.id === taskId)!.status).toBe('reviewing')
  })

  it('검토 Dispatch 를 닫는다 (outcome, endedAt, workerState)', () => {
    const { s, taskId, reviewDispatchId } = reviewDispatched()
    const r = unwrap(
      applyReviewResult(
        s,
        { taskId, dispatchId: reviewDispatchId, outcome: 'failed', subject: 's', body: 'no' },
        NOW
      ) as never
    )
    const d = r.state.dispatches.find((x) => x.id === reviewDispatchId)!
    expect(d.outcome).toBe('failed')
    expect(d.endedAt).toBe(NOW)
    expect(d.workerState).toBe('failed')
  })
})

describe('blockForReview', () => {
  /** 검토를 아예 돌릴 수 없는 자리 — reviewing 이지만 (아직) 열린 Dispatch 가 없다. createGate 가
   *  열린 Dispatch 를 거절하므로, 이 describe 는 이 모양의 상태로만 blockForReview 를 부른다. */
  const reviewingNoDispatch = (): { s: OrchState; taskId: string } => {
    const { s, taskId, dispatchId } = seed()
    const armed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, reviewRequested: true } : t))
    }
    const r = unwrap(
      applyWorkerDone(
        armed,
        { taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' },
        NOW
      ) as never
    )
    return { s: r.state, taskId }
  }

  it('Task 를 blocked 로 옮기고 이유를 담은 Gate 를 만든다', () => {
    const { s, taskId } = reviewingNoDispatch()
    const r = unwrap<{ question: string }>(
      blockForReview(s, { taskId, reason: '검토자로 쓸 계정이 없습니다' }, NOW) as never
    )
    expect(r.state.tasks.find((t) => t.id === taskId)!.status).toBe('blocked')
    expect(r.value.question).toContain('검토자로 쓸 계정이 없습니다')
  })

  // 끝나고 검증까지 통과한 일을 버리지 않고 Task 를 닫는 길
  it('Gate 질문이 task-update 로 빠져나가는 길을 말한다', () => {
    const { s, taskId } = reviewingNoDispatch()
    const r = unwrap<{ question: string }>(
      blockForReview(s, { taskId, reason: '검토자로 쓸 계정이 없습니다' }, NOW) as never
    )
    expect(r.value.question).toContain('task-update')
    expect(r.value.question).toContain('completed')
  })
})

// Run 하나를 사람이 물러나게 하는 것. **TTL prune 과 같은 규칙을 쓴다** — 그 규칙이 store.ts 안에만
// 있어 테스트가 닿지 않았고, 여기로 옮기면서 둘이 함께 이 테스트를 얻는다.
describe('deleteRuns', () => {
  it('그 Run 에 딸린 여섯 배열을 모두 지운다', () => {
    const { s, runId } = seed()
    // 메시지·전달·Gate 를 **실제로 채워 넣고** 본다 — 비어 있는 배열에 toEqual([]) 은 아무것도
    // 증명하지 않는다. 하나라도 남으면 그 Run 의 흔적이 화면 밖에서 산다
    const withQ = unwrap<{ id: string }>(
      createQuestion(s, { taskId: s.tasks[0].id, dispatchId: s.dispatches[0].id, question: 'q' }, NOW) as never
    ).state
    const withDelivery = unwrap<unknown>(nextDelivery(withQ, { runId }, NOW) as never).state
    // Gate 는 열린 Dispatch 가 있는 Task 에 걸 수 없다(createGate) — 그래서 Task 를 하나 더 만든다
    const t2 = unwrap<{ id: string }>(
      createTask(withDelivery, { runId, title: 't2', spec: 's2', deps: [] }, NOW) as never
    )
    const withGate = unwrap<unknown>(
      createGate(t2.state, { taskId: t2.value.id, question: 'why' }, NOW) as never
    ).state
    expect(withGate.messages.length).toBeGreaterThan(0)
    expect(withGate.deliveries.length).toBeGreaterThan(0)
    expect(withGate.gates.length).toBeGreaterThan(0)
    const next = deleteRuns(withGate, new Set([runId]))
    expect(next.runs).toEqual([])
    expect(next.tasks).toEqual([])
    expect(next.dispatches).toEqual([])
    expect(next.messages).toEqual([])
    expect(next.deliveries).toEqual([])
    expect(next.gates).toEqual([])
  })

  // Dispatch 는 runId 를 들고 있지 않다 — taskId 로만 그 Run 에 매인다. 이것이 이 함수에서 유일하게
  // 간접적인 자리이고, 놓치면 지워진 Task 를 가리키는 고아 Dispatch 가 남는다
  it('Dispatch 는 taskId 를 통해 함께 지워진다', () => {
    const { s, runId, dispatchId } = seed()
    expect(s.dispatches.some((d) => d.id === dispatchId)).toBe(true)
    expect(deleteRuns(s, new Set([runId])).dispatches).toEqual([])
  })

  it('다른 Run 은 건드리지 않는다', () => {
    const { s: s1, runId: keep } = seed()
    const { state: s2, value: gone } = unwrap<{ id: string }>(
      createRun(s1, { objective: 'o2', cwd: 'D:/q' }, NOW) as never
    )
    const withTask = unwrap<{ id: string }>(
      createTask(s2, { runId: gone.id, title: 't2', spec: 's2', deps: [] }, NOW) as never
    ).state
    const next = deleteRuns(withTask, new Set([gone.id]))
    expect(next.runs.map((r) => r.id)).toEqual([keep])
    expect(next.tasks.map((t) => t.runId)).toEqual([keep])
    expect(next.dispatches).toHaveLength(1)
  })

  it('없는 id 는 무해하다 — 상태가 그대로다', () => {
    const { s } = seed()
    expect(deleteRuns(s, new Set(['run_nope']))).toEqual(s)
  })

  it('빈 집합이면 상태가 그대로다', () => {
    const { s } = seed()
    expect(deleteRuns(s, new Set())).toEqual(s)
  })
})

const FIRE = '2026-08-21T09:00:00.000Z'

/** Task 둘(A, 그리고 A 에 의존하는 B)을 가진 예약 템플릿 */
const template = (): { s: OrchState; templateId: string; aId: string; bId: string } => {
  const r = unwrap<{ id: string }>(
    createRun(
      emptyState(),
      {
        objective: '매일 점검',
        cwd: 'D:/p',
        concurrency: 2,
        schedule: { kind: 'daily', time: '09:00' }
      },
      NOW
    ) as never
  )
  const a = unwrap<{ id: string }>(
    createTask(r.state, { runId: r.value.id, title: 'A', spec: 'do a', deps: [] }, NOW) as never
  )
  const b = unwrap<{ id: string }>(
    createTask(
      a.state,
      { runId: r.value.id, title: 'B', spec: 'do b', deps: [a.value.id] },
      NOW
    ) as never
  )
  return { s: b.state, templateId: r.value.id, aId: a.value.id, bId: b.value.id }
}

describe('spawnScheduledRun', () => {
  it('템플릿의 값을 물려받은 자식 Run 을 만든다', () => {
    const { s, templateId } = template()
    const { state, value: child } = unwrap<{ id: string }>(
      spawnScheduledRun(s, templateId, FIRE) as never
    )
    const saved = state.runs.find((r) => r.id === child.id)!
    expect(saved.objective).toBe('매일 점검')
    expect(saved.cwd).toBe('D:/p')
    expect(saved.concurrency).toBe(2)
    expect(saved.autoDispatch).toBe(true)
    expect(saved.templateId).toBe(templateId)
    expect(saved.createdAt).toBe(FIRE)
  })

  // 자식이 schedule 을 물려받으면 자식이 또 발화해 회차가 무한히 증식한다
  it('자식에는 schedule 이 없다', () => {
    const { s, templateId } = template()
    const { value: child } = unwrap<{ id: string; schedule?: unknown }>(
      spawnScheduledRun(s, templateId, FIRE) as never
    )
    expect(child.schedule).toBeUndefined()
  })

  // 이 파일에서 조용히 틀리기 가장 쉬운 곳이다. 옛 id 를 그대로 두면 자식의 의존이 템플릿의 Task 를
  // 가리키고, 그 Task 는 배치되지 않으니 영원히 completed 가 되지 않아 자식이 pending 에 갇힌다
  it('deps 를 자식의 새 id 로 다시 매핑한다', () => {
    const { s, templateId, aId } = template()
    const { state, value: child } = unwrap<{ id: string }>(
      spawnScheduledRun(s, templateId, FIRE) as never
    )
    const copies = state.tasks.filter((t) => t.runId === child.id)
    const copyA = copies.find((t) => t.title === 'A')!
    const copyB = copies.find((t) => t.title === 'B')!
    expect(copyB.deps).toEqual([copyA.id])
    expect(copyB.deps).not.toContain(aId)
  })

  it('deps 없는 사본은 ready, deps 있는 사본은 pending', () => {
    const { s, templateId } = template()
    const { state, value: child } = unwrap<{ id: string }>(
      spawnScheduledRun(s, templateId, FIRE) as never
    )
    const copies = state.tasks.filter((t) => t.runId === child.id)
    expect(copies.find((t) => t.title === 'A')!.status).toBe('ready')
    expect(copies.find((t) => t.title === 'B')!.status).toBe('pending')
  })

  // 지난 회차의 결과가 새 회차에 붙으면 진행률과 회로 차단이 거짓말을 한다
  it('결과 필드는 물려주지 않는다', () => {
    const { s, templateId, aId } = template()
    const dirty: OrchState = {
      ...s,
      tasks: s.tasks.map((t) =>
        t.id === aId
          ? { ...t, result: '지난 회차 결과', filesModified: ['a.ts'], consecutiveFailures: 2 }
          : t
      )
    }
    const { state, value: child } = unwrap<{ id: string }>(
      spawnScheduledRun(dirty, templateId, FIRE) as never
    )
    const copyA = state.tasks.find((t) => t.runId === child.id && t.title === 'A')!
    expect(copyA.result).toBeUndefined()
    expect(copyA.filesModified).toBeUndefined()
    expect(copyA.consecutiveFailures).toBe(0)
  })

  // 템플릿에서 **fireCount 하나만** 움직인다. 발화 횟수는 템플릿에 새기는 값이라 여기서 늘어나는
  // 것이 맞고, 나머지는 그대로여야 한다 — 특히 Task 는 정의이므로 손대면 다음 회차가 달라진다.
  it('템플릿은 fireCount 만 늘고 나머지와 Task 는 그대로다', () => {
    const { s, templateId } = template()
    const before = s.runs.find((r) => r.id === templateId)!
    const { state } = unwrap<{ id: string }>(spawnScheduledRun(s, templateId, FIRE) as never)
    const after = state.runs.find((r) => r.id === templateId)!
    expect(after).toEqual({ ...before, fireCount: 1 })
    expect(state.tasks.filter((t) => t.runId === templateId)).toEqual(
      s.tasks.filter((t) => t.runId === templateId)
    )
  })

  // 사이드바가 적는 "N회 실행" 이 이 값이다. **기록을 지워도 줄지 않는 것**이 이 필드가 있는 이유고,
  // 그것을 자식 개수로 세던 동안 회차를 지우면 숫자가 뒤로 갔다.
  it('발화마다 fireCount 가 1씩 늘고 자식이 그 서수를 갖는다', () => {
    const { s, templateId } = template()
    let st = s
    const ordinals: (number | undefined)[] = []
    for (let i = 0; i < 3; i++) {
      const r = unwrap<{ id: string; fireOrdinal?: number }>(
        spawnScheduledRun(st, templateId, FIRE) as never
      )
      st = r.state
      ordinals.push(r.value.fireOrdinal)
    }
    expect(ordinals).toEqual([1, 2, 3])
    expect(st.runs.find((r) => r.id === templateId)!.fireCount).toBe(3)
  })

  // 이 필드가 생기기 전에 만들어진 템플릿 — fireCount 가 없다. 1 부터 세기 시작해야 한다
  it('fireCount 가 없는 템플릿은 1 부터 센다', () => {
    const { s, templateId } = template()
    const stripped: OrchState = {
      ...s,
      runs: s.runs.map((r) => {
        if (r.id !== templateId) return r
        const { fireCount: _drop, ...rest } = r
        return rest
      })
    }
    const { state, value: child } = unwrap<{ id: string; fireOrdinal?: number }>(
      spawnScheduledRun(stripped, templateId, FIRE) as never
    )
    expect(child.fireOrdinal).toBe(1)
    expect(state.runs.find((r) => r.id === templateId)!.fireCount).toBe(1)
  })

  // 회차를 지워도 발화 횟수는 그대로여야 한다 — 이 결함의 재현이다
  it('회차를 지워도 fireCount 는 줄지 않는다', () => {
    const { s, templateId } = template()
    let st = s
    const kids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = unwrap<{ id: string }>(spawnScheduledRun(st, templateId, FIRE) as never)
      st = r.state
      kids.push(r.value.id)
    }
    const pruned = deleteRuns(st, new Set(kids.slice(0, 2)))
    expect(pruned.runs.filter((r) => r.templateId === templateId)).toHaveLength(1)
    expect(pruned.runs.find((r) => r.id === templateId)!.fireCount).toBe(3)
  })

  it('예약이 아닌 Run 은 거절한다', () => {
    const r = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    const res = spawnScheduledRun(r.state, r.value.id, FIRE)
    expect(res.ok).toBe(false)
  })

  it('없는 Run 은 거절한다', () => {
    expect(spawnScheduledRun(emptyState(), 'run_nope', FIRE).ok).toBe(false)
  })

  // deps 의 id 가 템플릿 밖을 가리키면(손으로 고친 값) 떨어뜨린다
  it('표에 없는 dep 은 떨어뜨린다', () => {
    const { s, templateId, bId } = template()
    const outsideId = 'tsk_outside'
    const dirty: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === bId ? { ...t, deps: [t.deps[0], outsideId] } : t))
    }
    const { state, value: child } = unwrap<{ id: string }>(
      spawnScheduledRun(dirty, templateId, FIRE) as never
    )
    const copyB = state.tasks.find((t) => t.runId === child.id && t.title === 'B')!
    expect(copyB.deps.length).toBe(1)
    expect(copyB.deps).not.toContain(outsideId)
  })

  // parentId 가 템플릿의 다른 Task 를 가리키면 자식의 id 로 매핑한다
  it('parentId 를 자식의 새 id 로 다시 매핑한다', () => {
    const { s, templateId, aId } = template()
    const bTask = s.tasks.find((t) => t.title === 'B')!
    const dirty: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === bTask.id ? { ...t, parentId: aId } : t))
    }
    const { state, value: child } = unwrap<{ id: string }>(
      spawnScheduledRun(dirty, templateId, FIRE) as never
    )
    const copies = state.tasks.filter((t) => t.runId === child.id)
    const copyA = copies.find((t) => t.title === 'A')!
    const copyB = copies.find((t) => t.title === 'B')!
    expect(copyB.parentId).toBe(copyA.id)
    expect(copyB.parentId).not.toBe(aId)
  })

  // parentId 가 템플릿 밖을 가리키면 떨어뜨린다
  it('표에 없는 parentId 는 떨어뜨린다', () => {
    const { s, templateId } = template()
    const bTask = s.tasks.find((t) => t.title === 'B')!
    const outsideParentId = 'tsk_parent_outside'
    const dirty: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === bTask.id ? { ...t, parentId: outsideParentId } : t))
    }
    const { state, value: child } = unwrap<{ id: string }>(
      spawnScheduledRun(dirty, templateId, FIRE) as never
    )
    const copyB = state.tasks.find((t) => t.runId === child.id && t.title === 'B')!
    expect('parentId' in copyB).toBe(false)
  })
})

describe('latestOrdinaryRun', () => {
  const plain = (state: OrchState, objective: string): { state: OrchState; id: string } => {
    const r = unwrap<{ id: string }>(
      createRun(state, { objective, cwd: 'D:/p' }, NOW) as never
    )
    return { state: r.state, id: r.value.id }
  }

  it('평범한 Run 중 가장 나중에 만든 것을 준다', () => {
    const first = plain(emptyState(), 'A')
    const second = plain(first.state, 'B')
    expect(latestOrdinaryRun(second.state)?.id).toBe(second.id)
  })

  // 템플릿은 정의를 담는 그릇이고 그 편집은 지목해서만 되어야 한다 — 여기서 집히면 --run 없는
  // task-create 가 템플릿에 떨어져 그 뒤 모든 회차로 복사된다
  it('예약 템플릿은 건너뛴다', () => {
    const first = plain(emptyState(), 'A')
    const tmpl = unwrap<{ id: string }>(
      createRun(
        first.state,
        { objective: '매일 점검', cwd: 'D:/p', schedule: { kind: 'daily', time: '09:00' } },
        NOW
      ) as never
    )
    expect(latestOrdinaryRun(tmpl.state)?.id).toBe(first.id)
  })

  // 회차는 15초 ticker 가 만들고 배열의 끝에 붙는다 — 사람의 동작 없이 이 답이 움직이면
  // check --wait 가 방금 생긴 회차의 배달을 기다리며 영원히 선다
  it('예약 회차는 건너뛴다', () => {
    const first = plain(emptyState(), 'A')
    const tmpl = unwrap<{ id: string }>(
      createRun(
        first.state,
        { objective: '매일 점검', cwd: 'D:/p', schedule: { kind: 'daily', time: '09:00' } },
        NOW
      ) as never
    )
    const spawned = unwrap<{ id: string }>(
      spawnScheduledRun(tmpl.state, tmpl.value.id, FIRE) as never
    )
    expect(latestOrdinaryRun(spawned.state)?.id).toBe(first.id)
  })

  // 부르는 쪽의 "Run 이 없다" 오류 경로가 그대로 살아 있어야 한다
  it('템플릿과 회차뿐이면 undefined', () => {
    const tmpl = unwrap<{ id: string }>(
      createRun(
        emptyState(),
        { objective: '매일 점검', cwd: 'D:/p', schedule: { kind: 'daily', time: '09:00' } },
        NOW
      ) as never
    )
    const spawned = unwrap<{ id: string }>(
      spawnScheduledRun(tmpl.state, tmpl.value.id, FIRE) as never
    )
    expect(latestOrdinaryRun(spawned.state)).toBeUndefined()
    expect(latestOrdinaryRun(emptyState())).toBeUndefined()
  })
})

describe('setRunWorktree', () => {
  const withRun = (): { s: OrchState; id: string } => {
    const { state, value } = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
    )
    return { s: state, id: value.id }
  }

  it('워크트리를 기록한다', () => {
    const { s, id } = withRun()
    const { state } = unwrap<{ worktree?: string }>(
      setRunWorktree(s, id, 'D:/wt/a') as never
    )
    expect(state.runs.find((x) => x.id === id)?.worktree).toBe('D:/wt/a')
  })

  it('이미 있으면 거절한다 — 두 번째 워크트리가 조용히 버려지지 않게', () => {
    const { s, id } = withRun()
    const { state } = unwrap<{ worktree?: string }>(
      setRunWorktree(s, id, 'D:/wt/a') as never
    )
    const second = setRunWorktree(state, id, 'D:/wt/b')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error).toContain('already has a worktree')
  })

  it('없는 Run 은 거절한다', () => {
    expect(setRunWorktree(emptyState(), 'run_nope', 'D:/wt/a').ok).toBe(false)
  })
})

describe('rekeyDispatch — 롤링이 세션을 갈아탈 때', () => {
  it('열린 Dispatch 의 sessionId·accountId 를 옮긴다', () => {
    const { s, dispatchId } = seed()
    const r = unwrap<{ id: string; sessionId: string; accountId: string }>(
      rekeyDispatch(s, { oldSessionId: 'sess1', newSessionId: 'sess2', accountId: 'acc2' }, NOW) as never
    )
    expect(r.value.id).toBe(dispatchId)
    expect(r.value.sessionId).toBe('sess2')
    expect(r.value.accountId).toBe('acc2')
    // 상태에도 반영돼 있어야 한다 — 반환값만 고친 것이 아니다
    const inState = r.state.dispatches.find((d) => d.id === dispatchId)
    expect(inState?.sessionId).toBe('sess2')
    expect(inState?.accountId).toBe('acc2')
  })

  it('Task 의 상태와 실패 카운터를 건드리지 않는다', () => {
    const { s, taskId } = seed()
    const before = s.tasks.find((t) => t.id === taskId)
    const r = unwrap<unknown>(
      rekeyDispatch(s, { oldSessionId: 'sess1', newSessionId: 'sess2', accountId: 'acc2' }, LATER) as never
    )
    const after = r.state.tasks.find((t) => t.id === taskId)
    expect(after?.status).toBe(before?.status)
    expect(after?.consecutiveFailures).toBe(before?.consecutiveFailures)
    // updatedAt 만 새로 찍힌다 — store 의 TTL 이 이 값을 마지막 활동 시각으로 읽는다
    expect(after?.updatedAt).toBe(LATER)
  })

  it('Dispatch 를 닫지 않는다', () => {
    const { s, dispatchId } = seed()
    const r = unwrap<unknown>(
      rekeyDispatch(s, { oldSessionId: 'sess1', newSessionId: 'sess2', accountId: 'acc2' }, NOW) as never
    )
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.endedAt).toBeUndefined()
    expect(d?.outcome).toBeUndefined()
    expect(d?.workerState).toBe('ready')
  })

  it('그 세션에 열린 Dispatch 가 없으면 null 이고 상태는 그대로다', () => {
    const { s } = seed()
    const r = rekeyDispatch(s, { oldSessionId: 'nope', newSessionId: 'sess2', accountId: 'acc2' }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.value).toBeNull()
    expect(r.state).toBe(s) // 같은 객체 — 아무것도 바꾸지 않았다
  })

  it('이미 닫힌 Dispatch 는 옮기지 않는다', () => {
    const { s } = seed()
    const closed = unwrap<unknown>(
      closeDispatch(s, { sessionId: 'sess1', exitCode: 1 }, NOW) as never
    )
    const r = rekeyDispatch(
      closed.state,
      { oldSessionId: 'sess1', newSessionId: 'sess2', accountId: 'acc2' },
      NOW
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.value).toBeNull()
  })

  it('새 sessionId 를 이미 다른 열린 Dispatch 가 쓰고 있으면 거절한다', () => {
    const { s, runId } = seed()
    // 같은 Run 에 두 번째 Task + Dispatch 를 열어 sessionId 'sess2' 를 선점시킨다
    const t2 = unwrap<{ id: string }>(
      createTask(s, { runId, title: 't2', spec: 'do it too', deps: [] }, NOW) as never
    )
    const d2 = unwrap<unknown>(
      openDispatch(
        t2.state,
        {
          taskId: t2.value.id,
          provider: 'codex',
          accountId: 'acc1',
          sessionId: 'sess2',
          cwd: 'D:/p',
          specPath: 'D:/p/orch/specs/y.md'
        },
        NOW
      ) as never
    )
    const r = rekeyDispatch(
      d2.state,
      { oldSessionId: 'sess1', newSessionId: 'sess2', accountId: 'acc2' },
      NOW
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected err')
    expect(r.error).toContain('already in use')
  })
})

describe('recordStopSnapshot — 정지 시점에만 잡을 수 있는 것', () => {
  it('HEAD 와 정지 사유를 열린 Dispatch 에 남긴다', () => {
    const { s, dispatchId } = seed()
    const r = unwrap<{ id: string }>(
      recordStopSnapshot(
        s,
        { sessionId: 'sess1', headCommit: 'abc1234', reason: 'waiting', resetsAt: LATER },
        NOW
      ) as never
    )
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.stopSnapshot).toEqual({ headCommit: 'abc1234', reason: 'waiting', resetsAt: LATER })
  })

  it('리셋 시각이 없는 정지(계정 전환)는 resetsAt 칸을 만들지 않는다', () => {
    const { s, dispatchId } = seed()
    const r = unwrap<unknown>(
      recordStopSnapshot(s, { sessionId: 'sess1', headCommit: 'abc1234', reason: 'switching' }, NOW) as never
    )
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.stopSnapshot).toEqual({ headCommit: 'abc1234', reason: 'switching' })
  })

  it('Task 를 건드리지 않는다 — 상태도 실패 카운터도', () => {
    const { s, taskId } = seed()
    const before = s.tasks.find((t) => t.id === taskId)
    const r = unwrap<unknown>(
      recordStopSnapshot(s, { sessionId: 'sess1', headCommit: 'abc1234', reason: 'waiting' }, NOW) as never
    )
    const after = r.state.tasks.find((t) => t.id === taskId)
    expect(after?.status).toBe(before?.status)
    expect(after?.consecutiveFailures).toBe(before?.consecutiveFailures)
  })

  it('Dispatch 를 닫지 않는다', () => {
    const { s, dispatchId } = seed()
    const r = unwrap<unknown>(
      recordStopSnapshot(s, { sessionId: 'sess1', headCommit: null, reason: 'switching' }, NOW) as never
    )
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.endedAt).toBeUndefined()
  })

  it('그 세션에 열린 Dispatch 가 없으면 null 이고 상태는 그대로다', () => {
    const { s } = seed()
    const r = recordStopSnapshot(s, { sessionId: 'nope', headCommit: 'x', reason: 'waiting' }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.value).toBeNull()
    expect(r.state).toBe(s)
  })

  it('다음 정지는 스냅샷을 덮어쓴다 — 마지막 정지가 기준점이다', () => {
    const { s, dispatchId } = seed()
    const first = unwrap<unknown>(
      recordStopSnapshot(
        s,
        { sessionId: 'sess1', headCommit: 'aaa', reason: 'waiting', resetsAt: NOW },
        NOW
      ) as never
    )
    const second = unwrap<unknown>(
      recordStopSnapshot(
        first.state,
        { sessionId: 'sess1', headCommit: 'bbb', reason: 'switching' },
        LATER
      ) as never
    )
    const d = second.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.stopSnapshot).toEqual({ headCommit: 'bbb', reason: 'switching' })
  })

  it('정지가 이력에 항목을 하나 남긴다 (스냅샷과 함께)', () => {
    // 열린 Dispatch 하나가 있는 상태에서 시작한다 — 이력에 이미 닫힌 항목 하나를 미리 심어 둔다.
    // 빈 배열에서 시작하면 "새로 열었다" 와 "통째로 바꿔치기했다" 가 둘 다 [entry] 로 같아 보여서,
    // 이 테스트 혼자서는 append 인지 replace 인지 가릴 수 없다.
    const { s: seeded, dispatchId } = seed()
    const prior = unwrap<unknown>(
      recordStopSnapshot(
        seeded,
        { sessionId: 'sess1', headCommit: null, reason: 'waiting', resetsAt: LATER },
        NOW
      ) as never
    )
    const closed = unwrap<unknown>(
      recordResume(prior.state, { sessionId: 'sess1', accountId: 'acc1' }, LATER) as never
    )
    const r = unwrap<unknown>(
      recordStopSnapshot(
        closed.state,
        { sessionId: 'sess1', headCommit: 'abc', reason: 'waiting', resetsAt: LATEST },
        EVEN_LATER
      ) as never
    )
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes).toEqual([
      {
        stoppedAt: NOW,
        reason: 'waiting',
        resetsAt: LATER,
        fromAccountId: 'acc1',
        resumedAt: LATER,
        toAccountId: 'acc1'
      },
      { stoppedAt: EVEN_LATER, reason: 'waiting', resetsAt: LATEST, fromAccountId: 'acc1' }
    ])
    // 기존 필드는 그대로다 — Phase 2 의 조립기가 이것을 읽는다
    expect(d?.stopSnapshot).toEqual({ headCommit: 'abc', reason: 'waiting', resetsAt: LATEST })
  })

  // 이 두 테스트가 막는 사고: 열린 항목이 있을 때 새로 쌓지 않으면, 재개 없이 끝난 에피소드 하나가
  // 그 뒤의 정지를 전부 삼킨다 — 리셋 시각이 화면까지 오지 못하고, 다음 재개가 몇 시간 전의 항목을
  // 닫아 타임라인이 그 사이의 실제 작업 시간을 통째로 한 번의 정지 구간으로 그린다.
  it('마지막 항목이 열린 채여도 다음 정지는 새 항목을 쌓는다', () => {
    const { s, dispatchId } = seed()
    const first = unwrap<unknown>(
      recordStopSnapshot(
        s,
        { sessionId: 'sess1', headCommit: null, reason: 'waiting', resetsAt: LATER },
        NOW
      ) as never
    )
    // 재개 없이 다음 정지가 온다 — 'stalled' 로 끝난 에피소드가 그 갈래다
    const second = unwrap<unknown>(
      recordStopSnapshot(
        first.state,
        { sessionId: 'sess1', headCommit: null, reason: 'waiting', resetsAt: LATEST },
        EVEN_LATER
      ) as never
    )
    const d = second.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes).toHaveLength(2)
    expect(d?.resumes?.[0].resumedAt).toBeUndefined() // 끝내 이어지지 않은 정지로 남는다
    expect(d?.resumes?.[1]).toEqual({
      stoppedAt: EVEN_LATER,
      reason: 'waiting',
      resetsAt: LATEST,
      fromAccountId: 'acc1'
    })
  })

  it('그 뒤의 재개는 옛 항목이 아니라 마지막 항목을 닫는다', () => {
    const { s, dispatchId } = seed()
    const first = unwrap<unknown>(
      recordStopSnapshot(s, { sessionId: 'sess1', headCommit: null, reason: 'waiting' }, NOW) as never
    )
    const second = unwrap<unknown>(
      recordStopSnapshot(
        first.state,
        { sessionId: 'sess1', headCommit: null, reason: 'switching' },
        EVEN_LATER
      ) as never
    )
    const resumed = unwrap<unknown>(
      recordResume(second.state, { sessionId: 'sess1', accountId: 'acc2' }, LATEST) as never
    )
    const d = resumed.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes?.[0].resumedAt).toBeUndefined()
    expect(d?.resumes?.[1].resumedAt).toBe(LATEST)
    expect(d?.resumes?.[1].toAccountId).toBe('acc2')
  })
})

describe('recordResume — 정지 이력의 마지막 항목을 닫는다', () => {
  it('재개가 그 항목을 닫는다 — 계정이 바뀌면 새 계정이 함께 적힌다', () => {
    const { s, dispatchId } = seed()
    const stopped = unwrap<unknown>(
      recordStopSnapshot(s, { sessionId: 'sess1', headCommit: null, reason: 'switching' }, NOW) as never
    )
    const r = unwrap<unknown>(
      recordResume(stopped.state, { sessionId: 'sess1', accountId: 'acc2' }, LATER) as never
    )
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes?.at(-1)).toEqual({
      stoppedAt: NOW,
      reason: 'switching',
      fromAccountId: 'acc1',
      resumedAt: LATER,
      toAccountId: 'acc2'
    })
  })

  it('같은 계정으로 이어가도 재개다 (제자리 재개)', () => {
    const { s, dispatchId } = seed()
    const stopped = unwrap<unknown>(
      recordStopSnapshot(
        s,
        { sessionId: 'sess1', headCommit: null, reason: 'waiting', resetsAt: LATER },
        NOW
      ) as never
    )
    const r = unwrap<unknown>(
      recordResume(stopped.state, { sessionId: 'sess1', accountId: 'acc1' }, LATER) as never
    )
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes?.at(-1)?.toAccountId).toBe('acc1')
  })

  it('열려 있는 항목이 없으면 재개는 아무것도 하지 않는다', () => {
    // 정지 없이 재개 신호만 온 경우 — 항목을 지어내면 "0번 멈추고 1번 이어졌다" 가 된다
    const { s, dispatchId } = seed()
    const r = recordResume(s, { sessionId: 'sess1', accountId: 'acc1' }, LATER)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    const d = r.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes).toBeUndefined()
  })

  it('두 번 정지하면 항목이 둘이다 (스냅샷은 덮어써도 이력은 남는다)', () => {
    const { s, dispatchId } = seed()
    const a = unwrap<unknown>(
      recordStopSnapshot(
        s,
        { sessionId: 'sess1', headCommit: null, reason: 'waiting', resetsAt: LATER },
        NOW
      ) as never
    )
    const b = unwrap<unknown>(
      recordResume(a.state, { sessionId: 'sess1', accountId: 'acc1' }, LATER) as never
    )
    const c = unwrap<unknown>(
      recordStopSnapshot(
        b.state,
        { sessionId: 'sess1', headCommit: null, reason: 'switching' },
        EVEN_LATER
      ) as never
    )
    const d = c.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes).toHaveLength(2)
  })

  it('두 번째 재개는 두 번째 항목만 닫는다 — 첫 항목은 그대로 남는다', () => {
    // 이 배열이 존재하는 이유가 이 테스트다: 몇 번 이어졌는지 세려면 이전 항목이 남아 있어야 한다.
    const { s, dispatchId } = seed()
    const stop1 = unwrap<unknown>(
      recordStopSnapshot(
        s,
        { sessionId: 'sess1', headCommit: null, reason: 'waiting', resetsAt: LATER },
        NOW
      ) as never
    )
    const resume1 = unwrap<unknown>(
      recordResume(stop1.state, { sessionId: 'sess1', accountId: 'acc1' }, LATER) as never
    )
    const stop2 = unwrap<unknown>(
      recordStopSnapshot(
        resume1.state,
        { sessionId: 'sess1', headCommit: null, reason: 'switching' },
        EVEN_LATER
      ) as never
    )
    const resume2 = unwrap<unknown>(
      recordResume(stop2.state, { sessionId: 'sess1', accountId: 'acc2' }, LATEST) as never
    )
    const d = resume2.state.dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes).toHaveLength(2)
    expect(d?.resumes?.[0]).toEqual({
      stoppedAt: NOW,
      reason: 'waiting',
      resetsAt: LATER,
      fromAccountId: 'acc1',
      resumedAt: LATER,
      toAccountId: 'acc1'
    })
    expect(d?.resumes?.[1]).toEqual({
      stoppedAt: EVEN_LATER,
      reason: 'switching',
      fromAccountId: 'acc1',
      resumedAt: LATEST,
      toAccountId: 'acc2'
    })
  })

  it('알 수 없는 세션은 조용히 넘어간다 (사용자 탭 세션)', () => {
    const { s } = seed()
    const r = recordResume(s, { sessionId: 'nope', accountId: 'acc1' }, LATER)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.state).toBe(s) // 같은 객체 — 아무것도 바꾸지 않았다
  })
})

describe('코디네이터 세션 붙이기·떼기', () => {
  const withRun = (over: Record<string, unknown> = {}): { s: OrchState; runId: string } => {
    const r = unwrap<{ id: string }>(
      createRun(emptyState(), { objective: 'o', cwd: 'D:/p', ...over }, NOW) as never
    )
    return { s: r.state, runId: r.value.id }
  }

  it('run-create 가 코디네이터 계정을 싣는다', () => {
    const { s, runId } = withRun({ coordinatorAccountId: 'acc1' })
    expect(s.runs.find((r) => r.id === runId)?.coordinatorAccountId).toBe('acc1')
  })

  // 빈 문자열이 "지정 없음" 과 갈라지면, 그 구분으로 코디네이터를 띄울지 정하는 자리가 흔들린다
  it('빈 문자열은 싣지 않는다 — 지정 없음과 같다', () => {
    const { s, runId } = withRun({ coordinatorAccountId: '' })
    expect(s.runs.find((r) => r.id === runId)).not.toHaveProperty('coordinatorAccountId')
  })

  it('붙이면 세션 id 가 실린다', () => {
    const { s, runId } = withRun()
    const r = unwrap<{ id: string }>(attachCoordinator(s, { runId, sessionId: 'sess1' }) as never)
    expect(r.state.runs[0].coordinatorSessionId).toBe('sess1')
  })

  it('사라지면 세션 id 가 지워진다', () => {
    const { s, runId } = withRun()
    let st = unwrap<{ id: string }>(attachCoordinator(s, { runId, sessionId: 'sess1' }) as never).state
    st = unwrap<{ id: string }>(detachCoordinator(st, { runId }) as never).state
    expect(st.runs[0]).not.toHaveProperty('coordinatorSessionId')
  })

  // **왜 사라졌는지 묻지 않는다.** 사람이 닫았는지 크래시인지 구별할 방법이 없고(kill 은 표시를
  // 남기지 않는다), 어느 쪽이든 앱이 하는 일은 같다 — 칸을 비우고 사람이 다시 띄울 버튼을 낸다.
  it('떼는 것은 두 번 불러도 같다 — 셀 것이 없다', () => {
    const { s, runId } = withRun()
    let st = unwrap<{ id: string }>(detachCoordinator(s, { runId }) as never).state
    st = unwrap<{ id: string }>(detachCoordinator(st, { runId }) as never).state
    expect(st.runs[0]).not.toHaveProperty('coordinatorSessionId')
    expect(st.runs[0]).not.toHaveProperty('coordinatorFailures')
  })

  it('다시 붙이면 그 세션이 실린다', () => {
    const { s, runId } = withRun()
    let st = unwrap<{ id: string }>(attachCoordinator(s, { runId, sessionId: 'sess1' }) as never).state
    st = unwrap<{ id: string }>(detachCoordinator(st, { runId }) as never).state
    st = unwrap<{ id: string }>(attachCoordinator(st, { runId, sessionId: 'sess2' }) as never).state
    expect(st.runs[0].coordinatorSessionId).toBe('sess2')
  })

  it('모르는 Run 이면 거절한다', () => {
    expect(attachCoordinator(emptyState(), { runId: 'nope', sessionId: 's' }).ok).toBe(false)
    expect(detachCoordinator(emptyState(), { runId: 'nope' }).ok).toBe(false)
  })

  // 회차는 자신이 도는 Run 이므로 관리자가 필요하고, 누구로 할지는 템플릿을 만든 사람이 정했다.
  // 세션 id 와 실패 횟수는 정의가 아니라 지난 회차의 결과라 물려주지 않는다
  it('예약 회차가 코디네이터 계정을 물려받고 세션·실패는 물려받지 않는다', () => {
    const t = unwrap<{ id: string }>(
      createRun(
        emptyState(),
        {
          objective: '매일',
          cwd: 'D:/p',
          coordinatorAccountId: 'acc1',
          schedule: { kind: 'daily', time: '09:00' }
        },
        NOW
      ) as never
    )
    let st = unwrap<{ id: string }>(
      attachCoordinator(t.state, { runId: t.value.id, sessionId: 'sess-template' }) as never
    ).state
    st = unwrap<{ id: string }>(detachCoordinator(st, { runId: t.value.id }) as never).state
    const child = unwrap<{ id: string }>(spawnScheduledRun(st, t.value.id, FIRE) as never)
    const saved = child.state.runs.find((r) => r.id === child.value.id)!
    expect(saved.coordinatorAccountId).toBe('acc1')
    expect(saved).not.toHaveProperty('coordinatorSessionId')
    expect(saved).not.toHaveProperty('coordinatorFailures')
  })
})
