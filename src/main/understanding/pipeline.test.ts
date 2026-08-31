// 파이프라인을 끝에서 끝까지 — 에이전트만 가짜로 두고 나머지는 진짜다(진짜 저장소 파일,
// 진짜 순수 함수, 진짜 검증).
//
// **에이전트를 가짜로 두는 이유**: 진짜 CLI 왕복은 수십 초이고 답이 매번 다르다. 여기서 물어야
// 하는 것은 "에이전트가 좋은 설명을 쓰는가"가 아니라 "그 답이 어떻게 흐르고, 실패하면 어떻게
// 되는가"다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import type { WorkRecord } from '../../core/understanding/types'
import { UnderstandingStore } from './store'
import { UnderstandingPipeline, type RunRecordInput } from './pipeline'

// runAgent 를 가짜로 — 파이프라인이 부르는 유일한 프로세스 자리다
const agentReply = vi.hoisted(() => ({
  value: null as unknown,
  fail: null as string | null,
  calls: 0,
  /** 에이전트가 도는 **동안** 벌어지는 일. 실제로는 여기가 수십 초라 그 사이에 사용자가
   *  설명을 고치거나 다시 분석할 수 있다 — 그 틈을 이 자리에서 만든다 */
  during: null as null | (() => Promise<void>)
}))
vi.mock('./agent', () => ({
  runAgent: async (): Promise<{ ok: boolean; value?: unknown; reason?: string }> => {
    agentReply.calls += 1
    if (agentReply.during) await agentReply.during()
    return agentReply.fail ? { ok: false, reason: agentReply.fail } : { ok: true, value: agentReply.value }
  }
}))

let dir: string
let storeFile: string
let projectRoot: string

const account = { id: 'a1', label: 'acc', configDir: 'C:\\cfg', color: '#fff', createdAt: '2026-01-01T00:00:00.000Z' }

const unit = (over: Partial<SessionWorkUnit> = {}): SessionWorkUnit => ({
  id: 'wu-1',
  sessionId: 'sess-abcd1234',
  projectPath: projectRoot,
  title: '한도 감지를 고쳐줘',
  status: 'completed',
  startedAt: '2026-08-31T10:00:00.000Z',
  completedAt: '2026-08-31T10:05:00.000Z',
  firstMessageIndex: 0,
  messageCount: 2,
  sawWrite: true,
  git: { startHead: 'a', endHead: 'b', observedChangedFiles: ['src/auth/login.ts'] },
  encounteredExternalGitChangeIds: [],
  ...over
})

const runInput = (over: Partial<RunRecordInput> = {}): RunRecordInput => ({
  runId: 'run-1',
  jobName: '단축키 충돌 정리',
  objective: '단축키가 겹치는 곳을 찾아 정리해줘',
  at: '2026-08-31T11:00:00.000Z',
  taskIds: ['t1', 't2'],
  tasks: [{ title: '충돌 찾기', outcome: 'completed' }],
  changedFiles: ['src/auth/login.ts'],
  validation: { status: 'passed' },
  ...over
})

const explanation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  overview: '한도 대화상자를 신호로 삼도록 바꿨다.',
  userVisibleChanges: ['세션이 스스로 풀린다'],
  flow: [{ id: 's', label: '대화상자 감지', type: 'start', next: [], evidencePaths: ['src/auth/login.ts'] }],
  decisions: [],
  implementation: [{ role: '감지', path: 'src/auth/login.ts' }],
  evidencePaths: ['src/auth/login.ts'],
  needsReview: false,
  ...over
})

async function make(generator: { accountId?: string } = { accountId: 'a1' }): Promise<{
  store: UnderstandingStore
  pipeline: UnderstandingPipeline
  /** 화면으로 나간 알림. 여기가 비면 배경 재생성의 결과는 화면에 닿지 않는다 */
  changed: string[]
}> {
  const store = new UnderstandingStore(storeFile)
  await store.load()
  const changed: string[] = []
  const pipeline = new UnderstandingPipeline({
    store,
    accountOf: (id) => (id === 'a1' ? account : null),
    descriptors: {} as never,
    generator: () => generator,
    now: () => '2026-08-30T12:00:00.000Z',
    onChanged: (root) => changed.push(root)
  })
  return { store, pipeline, changed }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hiw-pipe-'))
  storeFile = path.join(dir, 'understanding.json')
  projectRoot = path.join(dir, 'project')
  await fs.mkdir(path.join(projectRoot, 'src', 'auth'), { recursive: true })
  await fs.writeFile(path.join(projectRoot, 'src', 'auth', 'login.ts'), '// login', 'utf8')
  agentReply.value = null
  agentReply.fail = null
  agentReply.calls = 0
  agentReply.during = null
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('onUnitClosed — 닫힌 작업이 기록이 된다', () => {
  it('기록이 즉시 생기고, 에이전트가 답하면 설명이 붙는다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation()

    await pipeline.onUnitClosed(projectRoot, unit())

    const r = store.get(projectRoot)!.records
    expect(r).toHaveLength(1)
    expect(r[0].request).toBe('한도 감지를 고쳐줘') // 사용자의 말 그대로
    // sessionLabelOf takes the id's first eight characters (changeRecord.ts) — 'sess-abcd1234'.slice(0,8) === 'sess-abc'
    expect(r[0].source).toEqual({ kind: 'session', sessionId: 'sess-abcd1234', label: '세션 sess-abc' })
    expect(r[0].changedFiles).toEqual(['src/auth/login.ts'])
    expect(r[0].status).toBe('ready')
    expect(r[0].explanation!.overview).toBe('한도 대화상자를 신호로 삼도록 바꿨다.')
    expect(r[0].explanation!.userVisibleChanges).toEqual(['세션이 스스로 풀린다'])
  })

  // The agent takes 3-4 minutes. If the screen shows nothing during that time, it reads as failure
  it('에이전트가 도는 동안 기록은 이미 있고 상태는 만드는 중이다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation()
    let seen: string | undefined
    agentReply.during = async (): Promise<void> => {
      seen = store.get(projectRoot)!.records[0].status
    }
    await pipeline.onUnitClosed(projectRoot, unit())
    expect(seen).toBe('generating')
  })

  it('completed 가 아닌 Unit 은 기록하지 않는다', async () => {
    const { store, pipeline } = await make()
    await pipeline.onUnitClosed(projectRoot, unit({ status: 'abandoned' }))
    expect(store.get(projectRoot)?.records ?? []).toHaveLength(0)
    expect(agentReply.calls).toBe(0)
  })

  it('에이전트가 실패해도 기록은 남는다 — 사유와 함께', async () => {
    const { store, pipeline } = await make()
    agentReply.fail = '600초 안에 끝나지 않았다'
    await pipeline.onUnitClosed(projectRoot, unit())
    const r = store.get(projectRoot)!.records[0]
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('600초')
    expect(r.request).toBe('한도 감지를 고쳐줘') // 무엇을 시켰는지는 남는다
  })

  it('생성 계정이 없으면 그 사유가 기록에 남는다', async () => {
    const { store, pipeline } = await make({})
    await pipeline.onUnitClosed(projectRoot, unit())
    expect(store.get(projectRoot)!.records[0].reason).toBe('NO_GENERATOR_ACCOUNT')
  })

  it('근거가 모자라다고 하면 needs-review 다 (§24-13)', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation({ needsReview: true, needsReviewReason: '커밋을 찾지 못했다' })
    await pipeline.onUnitClosed(projectRoot, unit())
    const r = store.get(projectRoot)!.records[0]
    expect(r.status).toBe('needs-review')
    expect(r.reason).toContain('커밋')
  })

  // Using insideProject instead of isProjectFile would have let an existing directory pass —
  // then the screen's implementation link would be saved pointing at nothing it can open
  it('근거가 디렉터리면 거부한다 — 있어도 파일이 아니면 안 된다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation({
      evidencePaths: ['src/auth', 'src/auth/login.ts'],
      implementation: [{ role: '감지', path: 'src/auth' }]
    })
    await pipeline.onUnitClosed(projectRoot, unit())
    const r = store.get(projectRoot)!.records[0]
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('src/auth')
  })

  it('새 기록이 앞에 온다 — 목록의 축은 시간이다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation()
    await pipeline.onUnitClosed(projectRoot, unit({ id: 'wu-1', title: '먼저' }))
    await pipeline.onUnitClosed(projectRoot, unit({ id: 'wu-2', title: '나중' }))
    expect(store.get(projectRoot)!.records.map((x) => x.request)).toEqual(['나중', '먼저'])
  })

  it('저장할 때마다 화면에 알린다', async () => {
    const { pipeline, changed } = await make()
    agentReply.value = explanation()
    await pipeline.onUnitClosed(projectRoot, unit())
    expect(changed.length).toBeGreaterThanOrEqual(2) // 만드는 중 + 결과
  })
})

describe('onRunFinished — 끝난 Job Run 이 기록이 된다', () => {
  it('기록이 즉시 생기고, 만드는 동안 출처는 job 이며 상태는 만드는 중이다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation()
    let seen: WorkRecord | undefined
    agentReply.during = async (): Promise<void> => {
      seen = store.get(projectRoot)!.records[0]
    }
    await pipeline.onRunFinished(projectRoot, runInput())
    expect(seen?.status).toBe('generating')
    expect(seen?.source).toEqual({
      kind: 'job',
      runId: 'run-1',
      jobName: '단축키 충돌 정리',
      taskIds: ['t1', 't2']
    })
    expect(seen?.request).toBe('단축키가 겹치는 곳을 찾아 정리해줘') // Run 의 objective 그대로
  })

  it('jobTasks 와 validation 이 기록에 그대로 실린다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation()
    await pipeline.onRunFinished(projectRoot, runInput())
    const r = store.get(projectRoot)!.records[0]
    expect(r.status).toBe('ready')
    expect(r.jobTasks).toEqual([{ title: '충돌 찾기', outcome: 'completed' }])
    expect(r.validation).toEqual({ status: 'passed' })
  })

  it('changedFiles 는 입력 그대로 실린다 — Job 의 각 task 가 이미 무엇을 건드렸는지 보고한다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation()
    await pipeline.onRunFinished(projectRoot, runInput({ changedFiles: ['src/auth/login.ts', 'src/a.ts'] }))
    expect(store.get(projectRoot)!.records[0].changedFiles).toEqual(['src/auth/login.ts', 'src/a.ts'])
  })

  // fill() 은 onUnitClosed 와 같은 코드를 타므로, 그 실패 경로 전부를 여기서 다시 확인하지는
  // 않는다 — 대표로 하나만, Job 도 같은 계정 확인을 거친다는 것만 확인한다
  it('생성 계정이 없으면 그 사유가 기록에 남는다', async () => {
    const { store, pipeline } = await make({})
    await pipeline.onRunFinished(projectRoot, runInput())
    const r = store.get(projectRoot)!.records[0]
    expect(r.status).toBe('failed')
    expect(r.reason).toBe('NO_GENERATOR_ACCOUNT')
  })
})

describe('regenerate — 사용자가 [다시] 를 눌렀다', () => {
  it('사람이 고친 설명도 덮는다 — 그렇게 하라고 누른 버튼이다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = explanation()
    await pipeline.onUnitClosed(projectRoot, unit())
    const id = store.get(projectRoot)!.records[0].id
    const u = store.get(projectRoot)!
    await store.set(projectRoot, {
      records: [{ ...u.records[0], explanation: { ...u.records[0].explanation!, overview: '사람이 쓴 것', userEdited: true } }]
    })

    agentReply.value = explanation({ overview: '다시 만든 것' })
    await pipeline.regenerate(projectRoot, id)

    expect(store.get(projectRoot)!.records[0].explanation!.overview).toBe('다시 만든 것')
    expect(store.get(projectRoot)!.records[0].explanation!.userEdited).toBe(false)
  })

  it('없는 기록이면 아무것도 하지 않는다', async () => {
    const { pipeline } = await make()
    await pipeline.regenerate(projectRoot, '없음')
    expect(agentReply.calls).toBe(0)
  })
})
