import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './server'
import { emptyState, type OrchState } from '../../core/orchestration/state'

const makeDeps = (): OrchServerDeps => {
  const box = { state: emptyState() as OrchState }
  return {
    getState: () => box.state,
    setState: async (next) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'sess1', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc1', label: '계정1', provider: 'codex' }],
    readWorker: async () => '',
    enabled: () => true
  }
}

/** run + task + worker 를 만들고 dispatch id 를 돌려준다 */
const seed = async (deps: OrchServerDeps): Promise<{ taskId: string; dispatchId: string }> => {
  const run = await handleCommand(deps, { sessionId: 'coord' }, 'run-create', {
    objective: 'o',
    cwd: 'D:/p'
  })
  const runId = (run.body as { id: string }).id
  const task = await handleCommand(deps, { sessionId: 'coord' }, 'task-create', {
    runId,
    title: 't',
    spec: 's'
  })
  const taskId = (task.body as { id: string }).id
  await handleCommand(deps, { sessionId: 'coord' }, 'worker-start', {
    taskId,
    agent: 'codex',
    account: 'acc1',
    worktree: 'current'
  })
  return { taskId, dispatchId: deps.getState().dispatches[0].id }
}

describe('check --wait', () => {
  it('메시지가 없으면 타임아웃까지 기다리고 count 0을 돌려준다', async () => {
    const deps = makeDeps()
    await seed(deps)
    const t0 = Date.now()
    const r = await handleCommand(deps, { sessionId: 'coord' }, 'check', {
      wait: true,
      timeoutMs: 300
    })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(r.status).toBe(200)
    expect((r.body as { count: number }).count).toBe(0)
  })
  it('기다리는 중에 메시지가 오면 즉시 깨어난다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    const waiting = handleCommand(deps, { sessionId: 'coord' }, 'check', {
      wait: true,
      timeoutMs: 5000,
      types: 'worker_done'
    })
    setTimeout(() => {
      void handleCommand(deps, { sessionId: 'sess1' }, 'send', {
        type: 'worker_done',
        taskId,
        dispatchId,
        outcome: 'succeeded',
        subject: 'a',
        body: 'b'
      })
    }, 50)
    const r = await waiting
    expect((r.body as { count: number }).count).toBeGreaterThan(0)
  })
})

describe('ask', () => {
  it('답이 오면 answer를 돌려준다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    const asking = handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: '어느 쪽?',
      options: 'a,b',
      timeoutMs: 5000
    })
    setTimeout(() => {
      const q = deps.getState().messages.find((m) => m.type === 'question')!
      void handleCommand(deps, { sessionId: 'coord' }, 'reply', { id: q.id, body: 'a' })
    }, 50)
    const r = await asking
    expect(r.body).toMatchObject({ answered: true, answer: 'a' })
  })
  it('타임아웃이면 answered false·timedOut true·questionId를 돌려주고 status 200이다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    const r = await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: 'q',
      timeoutMs: 200
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ answered: false, timedOut: true })
    expect((r.body as { questionId: string }).questionId).toMatch(/^msg_/)
  })
  it('타임아웃 후에도 질문은 미응답으로 남아 있다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: 'q',
      timeoutMs: 150
    })
    const q = deps.getState().messages.find((m) => m.type === 'question')!
    expect(q.answered).toBe(false)
  })
  it('--resume은 새 질문을 만들지 않고 같은 질문을 이어 기다린다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: 'q',
      timeoutMs: 100
    })
    const q = deps.getState().messages.find((m) => m.type === 'question')!
    const resuming = handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      resume: q.id,
      timeoutMs: 5000
    })
    setTimeout(() => {
      void handleCommand(deps, { sessionId: 'coord' }, 'reply', { id: q.id, body: 'yes' })
    }, 50)
    const r = await resuming
    expect(r.body).toMatchObject({ answered: true, answer: 'yes' })
    expect(deps.getState().messages.filter((m) => m.type === 'question')).toHaveLength(1)
  })
  it('--resume이 이미 답한 질문을 가리키면 그 답을 즉시 돌려준다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: 'q',
      timeoutMs: 100
    })
    const q = deps.getState().messages.find((m) => m.type === 'question')!
    await handleCommand(deps, { sessionId: 'coord' }, 'reply', { id: q.id, body: 'done' })
    const r = await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      resume: q.id,
      timeoutMs: 100
    })
    expect(r.body).toMatchObject({ answered: true, answer: 'done' })
  })
})

// T7 리뷰 발견 — Critical 1 + Important 4: --resume이 없는 id를 검증 없이 "답이 왔다(내용 없음)"로
// 접어버리면(옛 probe: `if (!q) return { answer: '' }`), 워커가 id를 한 글자만 잘못 옮겨도
// 즉시 {answered:true, answer:''}를 진짜 답으로 받는다. 존재·타입·소유권 세 검증으로 막는다.
describe('ask --resume 검증', () => {
  it('존재하지 않는 id를 가리키면 거부한다 — 답이 온 것으로 접지 않는다', async () => {
    const deps = makeDeps()
    await seed(deps)
    const r = await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      resume: 'msg_doesnotexist',
      timeoutMs: 100
    })
    expect(r.status).toBe(400)
    expect(r.body).not.toMatchObject({ answered: true })
  })

  it('question이 아닌 메시지 id를 가리키면 거부한다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    await handleCommand(deps, { sessionId: 'sess1' }, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'succeeded',
      subject: 'a',
      body: 'b'
    })
    const doneMsg = deps.getState().messages.find((m) => m.type === 'worker_done')!
    const r = await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      resume: doneMsg.id,
      timeoutMs: 100
    })
    expect(r.status).toBe(400)
    expect(r.body).not.toMatchObject({ answered: true })
  })

  it('다른 세션이 소유한 dispatch의 질문이면 거부한다', async () => {
    const deps = makeDeps()
    await seed(deps) // sess1을 워커로 만든다(자기 dispatch 하나를 갖게)
    const run2 = await handleCommand(deps, { sessionId: 'coord' }, 'run-create', {
      objective: 'o2',
      cwd: 'D:/p'
    })
    const task2 = await handleCommand(deps, { sessionId: 'coord' }, 'task-create', {
      runId: (run2.body as { id: string }).id,
      title: 't2',
      spec: 's2'
    })
    const taskId2 = (task2.body as { id: string }).id
    // startWorker mock이 항상 sess1을 돌려주므로 worker-start로는 두 번째 세션을 만들 수 없다 —
    // server.test.ts의 "다른(남의) dispatchId" 테스트와 같은 방식으로 sess2 소유 dispatch를
    // 직접 주입한다.
    const otherDispatch = {
      id: 'dsp_other',
      taskId: taskId2,
      provider: 'codex' as const,
      accountId: 'acc1',
      sessionId: 'sess2',
      cwd: 'D:/p2',
      specPath: 'D:/p2/orch/specs/a.md',
      startedAt: new Date().toISOString(),
      workerState: 'ready' as const,
      retained: false
    }
    await deps.setState({
      ...deps.getState(),
      dispatches: [...deps.getState().dispatches, otherDispatch]
    })
    const created = await handleCommand(deps, { sessionId: 'sess2' }, 'ask', {
      taskId: taskId2,
      dispatchId: otherDispatch.id,
      question: 'q2',
      timeoutMs: 100
    })
    expect(created.status).toBe(200) // 사전조건: sess2가 자기 질문을 만들었다
    const q2 = deps
      .getState()
      .messages.find((m) => m.type === 'question' && m.dispatchId === otherDispatch.id)!
    const r = await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      resume: q2.id,
      timeoutMs: 100
    })
    expect(r.status).toBe(403)
  })

  it('기다리는 중에 dispatch가 종단되면 abandoned로 조기 종료하고 진짜 답과 구분된다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: 'q',
      timeoutMs: 100
    })
    const q = deps.getState().messages.find((m) => m.type === 'question')!
    const resuming = handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      resume: q.id,
      timeoutMs: 5000
    })
    // 같은 워커가 답을 기다리는 동시에 worker_done을 보낸다(병렬 도구 호출 시나리오) —
    // applyWorkerDone이 settlePendingQuestions로 이 질문을 {answered:true, answerBody:''}로
    // 종결하지만, 이건 진짜 답이 아니다. probe가 dispatch 종단을 answered보다 먼저 봐야 한다.
    setTimeout(() => {
      void handleCommand(deps, { sessionId: 'sess1' }, 'send', {
        type: 'worker_done',
        taskId,
        dispatchId,
        outcome: 'failed',
        subject: 'a',
        body: 'b'
      })
    }, 50)
    const r = await resuming
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ answered: false, abandoned: true })
    expect(r.body).not.toMatchObject({ answered: true })
  })

  // 재리뷰 발견 — 위 abandoned 수정이 순서를 잘못 잡으면(dispatch 종단을 answered보다 먼저
  // 보면) 이미 도착한 진짜 답까지 가려버린다. reply로 답이 도착한 *뒤* 무관한 사유로 dispatch가
  // 종단돼도 그 답이 그대로 나와야 한다.
  it('진짜 답을 받은 뒤 dispatch가 종단돼도 그 답을 돌려준다(abandoned가 아니다)', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: 'q',
      timeoutMs: 100
    })
    const q = deps.getState().messages.find((m) => m.type === 'question')!
    await handleCommand(deps, { sessionId: 'coord' }, 'reply', { id: q.id, body: 'yes' })
    // 답이 도착한 뒤 무관한 사유로 dispatch가 종단된다(같은 워커의 worker_done 전송)
    await handleCommand(deps, { sessionId: 'sess1' }, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'succeeded',
      subject: 'a',
      body: 'b'
    })
    const r = await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      resume: q.id,
      timeoutMs: 100
    })
    expect(r.body).toMatchObject({ answered: true, answer: 'yes' })
  })

  // 불변식 고정 — probe의 순서 판정("진짜 answerBody는 빈 문자열일 수 없다")이 이 검증에
  // 의존한다. 누군가 나중에 reply의 빈 본문 검증을 느슨하게 하면 이 테스트가 먼저 깨져
  // probe의 구분이 조용히 무너지는 것을 막는다.
  it('reply --body가 빈 문자열이면 거부한다', async () => {
    const deps = makeDeps()
    const { taskId, dispatchId } = await seed(deps)
    await handleCommand(deps, { sessionId: 'sess1' }, 'ask', {
      taskId,
      dispatchId,
      question: 'q',
      timeoutMs: 100
    })
    const q = deps.getState().messages.find((m) => m.type === 'question')!
    const r = await handleCommand(deps, { sessionId: 'coord' }, 'reply', { id: q.id, body: '' })
    expect(r.status).toBe(400)
  })
})

// T7 리뷰 발견 — Important 3: take()가 안에서 `void deps.setState(...)`를 부르면 응답이 그
// 완료를 기다리지 않는다. 겹쳐 실행된 나중 setState의 디스크 쓰기가 먼저 착륙해 이 배치 생성이
// 유실될 수 있다(실구현에서). setState를 일부러 늦추는 deps로 이를 검증한다 —
// 고쳤다면 응답이 그 늦은 setState보다 먼저 올 수 없다.
describe('check --wait 커밋 순서', () => {
  it('배치를 커밋하는 setState가 응답보다 먼저 끝난다', async () => {
    // setState를 50ms 지연시킨다. send가 자기 메시지를 커밋하는 setState는 원래부터
    // await됐으므로(버그가 아니다) 그것과 섞이지 않도록, check의 응답이 실어 온 deliveryId가
    // 응답을 받은 그 시점에 이미 상태에 반영돼 있는지를 직접 확인한다 — take() 안의
    // `void deps.setState(...)`가 되돌아오면(회귀) 응답은 오지만 그 배치가 아직 상태에
    // 없어야 하므로 이 단정이 실패한다.
    const box = { state: emptyState() as OrchState }
    const deps: OrchServerDeps = {
      getState: () => box.state,
      setState: (next) =>
        new Promise((resolve) => {
          setTimeout(() => {
            box.state = next
            resolve()
          }, 50)
        }),
      startWorker: async () => ({ sessionId: 'sess1', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }),
      releaseWorker: async () => {},
      listAccounts: () => [{ id: 'acc1', label: '계정1', provider: 'codex' }],
      readWorker: async () => '',
      enabled: () => true
    }
    const { taskId, dispatchId } = await seed(deps)
    const waiting = handleCommand(deps, { sessionId: 'coord' }, 'check', {
      wait: true,
      timeoutMs: 5000,
      types: 'worker_done'
    })
    setTimeout(() => {
      void handleCommand(deps, { sessionId: 'sess1' }, 'send', {
        type: 'worker_done',
        taskId,
        dispatchId,
        outcome: 'succeeded',
        subject: 'a',
        body: 'b'
      })
    }, 20)
    const r = await waiting
    const deliveryId = (r.body as { deliveryId: string; count: number }).deliveryId
    expect((r.body as { count: number }).count).toBeGreaterThan(0)
    expect(deliveryId).toMatch(/^dlv_/)
    expect(deps.getState().deliveries.some((d) => d.id === deliveryId)).toBe(true)
  })
})
