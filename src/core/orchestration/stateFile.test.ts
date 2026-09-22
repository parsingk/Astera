import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { answerFromFile, fileAnswerable, readStateFile } from './stateFile'
import { emptyState } from './state'

describe('fileAnswerable', () => {
  // 아무도 안 쓰는 파일은 기다려도 바뀌지 않는다 — 기다리는 명령은 여기서 답할 수 없다.
  it('기다리는 명령은 파일로 답할 수 없다', () => {
    expect(fileAnswerable('jobs-wait')).toBe(false)
    expect(fileAnswerable('runs-wait')).toBe(false)
    expect(fileAnswerable('check')).toBe(false)
    expect(fileAnswerable('ask')).toBe(false)
  })

  it('보기만 하는 명령은 파일로 답한다', () => {
    for (const cmd of ['jobs-list', 'jobs-get', 'runs-list', 'runs-get', 'tasks-list',
                       'questions-list', 'questions-get', 'projects-list', 'projects-get',
                       'projects-find', 'status', 'dispatch-show', 'inbox', 'run-configs'])
      expect(fileAnswerable(cmd)).toBe(true)
  })

  // 쓰는 명령은 물어볼 것도 없다. 파일을 고치는 것은 Host 의 일이다.
  it('쓰는 명령은 파일로 답하지 않는다', () => {
    expect(fileAnswerable('questions-answer')).toBe(false)
    expect(fileAnswerable('task-create')).toBe(false)
    expect(fileAnswerable('worker-start')).toBe(false)
  })

  // 목록에 없는 것은 전부 아니다 — 나중에 붙는 명령이 조용히 옛 답을 내지 않게.
  it('모르는 명령은 파일로 답하지 않는다', () => {
    expect(fileAnswerable('something-new')).toBe(false)
  })
})

describe('readStateFile', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-statefile-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('없는 파일은 빈 상태가 아니라 null 이다', () => {
    expect(readStateFile(path.join(dir, 'nope.json'))).toBeNull()
  })

  it('읽을 수 없는 파일도 null 이다 — 빈 Job 목록이 아니다', async () => {
    const p = path.join(dir, 'orchestration.json')
    await fs.writeFile(p, '{ not json', 'utf8')
    expect(readStateFile(p)).toBeNull()
  })

  it('상태가 아닌 것도 null 이다', async () => {
    const p = path.join(dir, 'orchestration.json')
    await fs.writeFile(p, JSON.stringify({ hello: 'world' }), 'utf8')
    expect(readStateFile(p)).toBeNull()
  })

  // F3: 맨 JSON.parse 면 Job 이 갈리기 전에 쓰인 파일이 CLI 에서만 빈 목록으로 보인다.
  // store.load() 가 쓰는 이행을 그대로 태워야 같은 파일이 두 프로세스에 같게 보인다.
  it('Job 이 갈리기 전에 쓰인 파일도 store 와 같은 이행을 거쳐 읽힌다', async () => {
    const p = path.join(dir, 'orchestration.json')
    await fs.writeFile(
      p,
      JSON.stringify({
        runs: [{ id: 'run_old', objective: '옛 회차', cwd: 'D:/p', createdAt: '2026-01-01T00:00:00.000Z' }],
        tasks: [],
        dispatches: [],
        messages: [],
        deliveries: [],
        gates: []
      }),
      'utf8'
    )
    const state = readStateFile(p)
    expect(state?.jobs).toHaveLength(1)
    expect(state?.jobs[0].objective).toBe('옛 회차')
    expect(state?.runs[0].id).toBe('run_old')
    // projects 도 같은 이행이 채운다 — 없으면 projects-list 가 터진다.
    expect(state?.projects).toEqual([])
  })
})

describe('answerFromFile', () => {
  const call = (cmd: string, args: Record<string, unknown> = {}, state = emptyState()) =>
    answerFromFile({ state, cmd, args, sessionId: '' })

  it('읽기 명령을 Host 가 답하는 것과 같은 모양으로 답한다', async () => {
    const r = await call('jobs-list')
    expect(r.status).toBe(200)
    expect(r.body).toEqual([])
  })

  it('인자를 틀리면 그 명령 자신의 오류가 그대로 나온다', async () => {
    const r = await call('projects-get')
    expect(r.status).toBe(400)
  })

  // 이 답은 Host 가 없어서 파일에서 꺼낸 것이다. running: true 는 handleCommand 가 "여기 닿았으면
  // 앱이 있다"는 전제로 적은 값이고, 이 길에서는 그 전제가 거짓이다.
  it('status 는 Host 가 돌고 있다고 말하지 않는다', async () => {
    const r = await call('status')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ running: false, pid: null })
  })

  it('status 의 나머지 숫자는 파일에서 센 그대로다', async () => {
    const state = emptyState()
    state.projects = [
      { id: 'proj_1', path: 'D:/p', name: 'p', addedAt: '2026-01-01T00:00:00.000Z' }
    ]
    const r = await call('status', {}, state)
    expect(r.body).toMatchObject({ projects: 1, jobs: 0, questionsOpen: 0 })
  })
})
