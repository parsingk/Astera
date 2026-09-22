import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from '../core/orchestration/state'
import type { OrchCaller } from '../core/host/orchProtocol'
import type { HostMessage } from '../core/host/protocol'

const NOW = '2026-09-22T00:00:00.000Z'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostorch-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A profile with one Job, one Run and one Task in it — written the way the app writes it, through
 *  the pure layer, so the fixture cannot drift from the shape the store reads. */
const seed = async (): Promise<{ jobId: string; taskId: string }> => {
  const job = createJob(emptyState(), { objective: '무언가', cwd: 'D:/p' }, NOW)
  if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW)
  if (!run.ok) throw new Error(run.error)
  const task = createTask(run.state, { runId: run.value.id, title: '하나', spec: 's', deps: [] }, NOW)
  if (!task.ok) throw new Error(task.error)
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(task.state, null, 2), 'utf8')
  return { jobId: job.value.id, taskId: task.value.id }
}

const orchOver = (over: Partial<Parameters<typeof createHostOrch>[0]> = {}): ReturnType<typeof createHostOrch> =>
  createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => NOW,
    runningSessions: () => 2,
    act: async () => ({}),
    hasApp: () => true,
    onState: () => {},
    ...over
  })

describe('createHostOrch', () => {
  it('파일에 있던 Job 을 그대로 답한다', async () => {
    const { jobId } = await seed()
    const orch = orchOver()
    await orch.ready()
    const r = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
    expect(r.status).toBe(200)
    expect((r.body as { id: string }[]).map((j) => j.id)).toEqual([jobId])
  })

  // 설계 §8: 상태가 실리기 전에 온 호출은 실패하는 대신 기다린다. ready() 를 부르지 않는 것이
  // 여기서 요점이다 — 실제 Host 도 부르지 않는다.
  it('ready() 전에 온 호출도 상태를 보고 답한다', async () => {
    const { jobId } = await seed()
    const r = await orchOver().call({ cmd: 'jobs-list', args: {}, sessionId: '' })
    expect((r.body as { id: string }[]).map((j) => j.id)).toEqual([jobId])
  })

  // ready() 는 한 번만 읽는다 — 부를 때마다 읽으면 명령 하나마다 파일을 다시 읽고, 그 사이 Host 가
  // 메모리에서 바꾼 것을 디스크의 옛 내용이 덮는다.
  it('파일은 한 번만 읽는다', async () => {
    await seed()
    const orch = orchOver()
    await orch.ready()
    // 파일을 통째로 비워도 이미 읽은 상태는 그대로여야 한다.
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')
    await orch.ready()
    const r = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
    expect((r.body as unknown[]).length).toBe(1)
  })

  // 앱이 없으면 **그 명령이** 거절당해야 한다 — 409 는 "지금 상태로는 못 한다"이고, CLI 는 그것을
  // CONFLICT(6)로 떨어뜨린다(설계 §5). 400 으로 나가면 사람이 인자를 고치려 든다.
  it('앱이 없으면 worker-start 를 409 APP_REQUIRED 로 거절한다', async () => {
    const { taskId } = await seed()
    const orch = orchOver({ hasApp: () => false, act: vi.fn() })
    const r = await orch.call({
      cmd: 'worker-start',
      args: { task: taskId, agent: 'codex', account: 'acc1', worktree: 'current' },
      sessionId: ''
    })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('APP_REQUIRED')
  })

  // 거절은 남기는 것이 없어야 한다 — worker-start 는 Dispatch 를 열고 시작에 실패하면 되돌린다.
  it('앱 없이 거절한 worker-start 는 Dispatch 를 남기지 않는다', async () => {
    const { taskId } = await seed()
    const orch = orchOver({ hasApp: () => false })
    await orch.call({
      cmd: 'worker-start',
      args: { task: taskId, agent: 'codex', account: 'acc1', worktree: 'current' },
      sessionId: ''
    })
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
    expect(saved.dispatches).toEqual([])
  })

  it('모르는 명령은 501 이다 — 없는 id 의 404 와 가른다', async () => {
    const orch = orchOver()
    expect((await orch.call({ cmd: 'no-such-command', args: {}, sessionId: '' })).status).toBe(501)
  })

  // Host 는 자기 버전과 자기 세션 수로 답한다 — 앱이 없어도 답해야 하는 두 가지다.
  it('status 는 앱이 없어도 Host 자신의 값으로 답한다', async () => {
    await seed()
    const r = await orchOver({ hasApp: () => false }).call({ cmd: 'status', args: {}, sessionId: '' })
    expect(r.body).toMatchObject({ version: '9.9.9', sessionsRunning: 2, jobs: 1 })
  })

  describe('state-put', () => {
    const appCaller = (): OrchCaller & { pushed: HostMessage[] } => {
      const pushed: HostMessage[] = []
      return { role: 'app', toOthers: (m) => pushed.push(m), pushed }
    }

    it('앱이 민 상태가 그대로 저장되고 나머지 클라이언트에게 간다', async () => {
      const from = appCaller()
      const orch = orchOver()
      const made = createJob(emptyState(), { objective: 'x', cwd: 'D:/p' }, NOW)
      const state = made.ok ? made.state : emptyState()
      const r = await orch.call({ cmd: 'state-put', args: { state }, sessionId: '', from })
      expect(r.status).toBe(200)
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
      expect(saved.jobs).toHaveLength(1)
      expect(from.pushed).toEqual([{ t: 'orch-state', state }])
    })

    // 민 쪽에게 되돌려 보내면 앱이 자기 상태를 자기 위에 다시 쓴다.
    it('민 클라이언트에게는 되돌려 보내지 않는다', async () => {
      const from = appCaller()
      await orchOver().call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '', from })
      expect(from.pushed).toHaveLength(1) // toOthers 로만 나갔다 — 그 자리로는 아무것도 안 간다
    })

    // **CLI 는 상태의 주인이 아니다.** 앱만이 자기 미러를 Host 에 밀 수 있다(F2).
    it('CLI 가 부르면 403 이다', async () => {
      const cli: OrchCaller = { role: 'cli', toOthers: () => {} }
      const r = await orchOver().call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '', from: cli })
      expect(r.status).toBe(403)
    })

    // 소켓이 없는 호출자(테스트, 스텁)도 앱이 아니다 — 모르면 거절한다.
    it('누구인지 모르면 403 이다', async () => {
      const r = await orchOver().call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '' })
      expect(r.status).toBe(403)
    })

    it('상태가 아닌 것은 400 이다 — 파일에 아무것도 쓰지 않는다', async () => {
      await seed()
      const before = await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')
      const r = await orchOver().call({ cmd: 'state-put', args: { state: { nope: 1 } }, sessionId: '', from: appCaller() })
      expect(r.status).toBe(400)
      expect(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')).toBe(before)
    })

    // 앱이 통째로 건네준 뒤에 파일을 읽으면, 그것은 방금 받은 것의 옛 사본이다 — 그리고 load 는
    // 재시작 정리를 돌리며 파일을 쓴다(F13).
    it('상태를 받은 뒤에는 파일을 읽지 않는다', async () => {
      await seed()
      const orch = orchOver()
      const state = emptyState()
      await orch.call({ cmd: 'state-put', args: { state }, sessionId: '', from: appCaller() })
      await orch.ready()
      const r = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
      expect(r.body).toEqual([]) // 파일의 Job 이 아니라 앱이 민 빈 상태다
    })
  })
})
