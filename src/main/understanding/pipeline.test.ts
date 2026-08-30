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
import { UnderstandingStore } from './store'
import { UnderstandingPipeline } from './pipeline'

// runAgent 를 가짜로 — 파이프라인이 부르는 유일한 프로세스 자리다
const agentReply = vi.hoisted(() => ({ value: null as unknown, fail: null as string | null, calls: 0 }))
vi.mock('./agent', () => ({
  runAgent: async (): Promise<{ ok: boolean; value?: unknown; reason?: string }> => {
    agentReply.calls += 1
    return agentReply.fail ? { ok: false, reason: agentReply.fail } : { ok: true, value: agentReply.value }
  }
}))

let dir: string
let storeFile: string
let projectRoot: string

const account = { id: 'a1', label: 'acc', configDir: 'C:\\cfg', color: '#fff', createdAt: '2026-01-01T00:00:00.000Z' }

const unit = (over: Partial<SessionWorkUnit> = {}): SessionWorkUnit => ({
  id: 'wu-1',
  sessionId: 's-1',
  projectPath: projectRoot,
  title: '로그인 고쳐줘',
  status: 'completed',
  startedAt: '2026-08-30T10:00:00.000Z',
  completedAt: '2026-08-30T10:05:00.000Z',
  firstMessageIndex: 0,
  messageCount: 2,
  git: { startHead: 'a', endHead: 'b', observedChangedFiles: ['src/auth/login.ts'] },
  encounteredExternalGitChangeIds: [],
  ...over
})

/** 검증을 통과하는 설명 출력 */
const explanation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  overview: '사용자가 로그인하면 서버가 세션을 만든다.',
  userFlow: [{ id: 's', label: '로그인 요청', type: 'start', next: [] }],
  failureFlows: [],
  keyDecisions: [{ title: '세션은 서버에', reason: '강제 로그아웃', sourceLabel: '세션 s-1' }],
  implementation: [{ role: '인증', path: 'src/auth/login.ts' }],
  evidencePaths: ['src/auth/login.ts'],
  needsReview: false,
  ...over
})

async function make(generator: { accountId?: string } = { accountId: 'a1' }): Promise<{
  store: UnderstandingStore
  pipeline: UnderstandingPipeline
}> {
  const store = new UnderstandingStore(storeFile)
  await store.load()
  const pipeline = new UnderstandingPipeline({
    store,
    accountOf: (id) => (id === 'a1' ? account : null),
    descriptors: {} as never,
    generator: () => generator,
    now: () => '2026-08-30T12:00:00.000Z'
  })
  return { store, pipeline }
}

/** 기능 하나가 이미 있는 상태를 만든다 — 첫 분석이 끝난 뒤의 모양 */
async function seedFeature(store: UnderstandingStore, over: Record<string, unknown> = {}): Promise<void> {
  await store.set(projectRoot, {
    features: [
      { id: 'f-auth', name: '인증', summary: '로그인', status: 'up-to-date', updatedAt: 'x', evidenceCount: 1 }
    ],
    explanations: {
      'f-auth': {
        featureId: 'f-auth',
        overview: '옛 설명',
        userFlow: [],
        failureFlows: [],
        keyDecisions: [],
        implementation: [{ role: '인증', path: 'src/auth' }],
        recentChanges: [],
        evidence: [],
        userEdited: false,
        generatedAt: 'x',
        ...over
      }
    },
    recentChanges: []
  })
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
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('onUnitClosed — 완료된 Unit 이 설명이 된다', () => {
  it('겹치는 기능의 설명을 다시 쓰고 최근 변경에 한 줄 남긴다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation()

    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.recentChanges).toHaveLength(1)
    expect(u.recentChanges[0].body).toBe('로그인 고쳐줘') // 사용자의 요청 원문
    expect(u.recentChanges[0].featureName).toBe('인증') // 어느 기능의 변화인지
    expect(u.explanations['f-auth'].overview).toBe('사용자가 로그인하면 서버가 세션을 만든다.')
    expect(u.features[0].status).toBe('up-to-date')
    expect(u.features[0].evidenceCount).toBe(1)
  })

  // 스펙 §7 — 질문만 하다 버려진 Unit 은 하류로 흐르지 않는다
  it('completed 가 아닌 Unit 은 아무것도 하지 않는다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    await pipeline.onUnitClosed(projectRoot, unit({ status: 'abandoned' }))
    expect(store.get(projectRoot)!.recentChanges).toHaveLength(0)
    expect(agentReply.calls).toBe(0)
  })

  // **스펙 §56** — 사람이 고친 설명은 재생성이 덮지 못한다
  it('사람이 고친 설명은 덮지 않고 update-available 로만 표시한다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store, { userEdited: true, overview: '사람이 쓴 설명' })
    agentReply.value = explanation()

    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.explanations['f-auth'].overview).toBe('사람이 쓴 설명') // 그대로다
    expect(u.features[0].status).toBe('update-available')
    expect(agentReply.calls).toBe(0) // 에이전트를 부르지도 않았다
    expect(u.recentChanges).toHaveLength(1) // 변화 자체는 기록된다
  })

  it('어느 기능에도 안 겹치면 기록만 남기고 기능을 만들지 않는다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    await pipeline.onUnitClosed(projectRoot, unit({ git: { startHead: 'a', observedChangedFiles: ['docs/readme.md'] } }))

    const u = store.get(projectRoot)!
    expect(u.features).toHaveLength(1) // 늘지 않았다
    expect(u.recentChanges).toHaveLength(1)
    expect(u.recentChanges[0].featureName).toBeUndefined()
    expect(agentReply.calls).toBe(0)
  })

  it('아직 분석하지 않은 프로젝트도 최근 변경은 쌓인다', async () => {
    const { store, pipeline } = await make()
    await pipeline.onUnitClosed(projectRoot, unit())
    const u = store.get(projectRoot)!
    expect(u.features).toHaveLength(0)
    expect(u.recentChanges).toHaveLength(1)
  })

  it('생성 계정이 없으면 그 사유가 기능에 남는다 — 조용히 넘어가지 않는다', async () => {
    const { store, pipeline } = await make({})
    await seedFeature(store)
    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.features[0].status).toBe('generation-failed')
    expect(u.features[0].staleReason).toBe('NO_GENERATOR_ACCOUNT')
  })

  it('에이전트가 실패하면 사유와 함께 generation-failed 다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.fail = '180초 안에 끝나지 않았다'
    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.features[0].status).toBe('generation-failed')
    expect(u.features[0].staleReason).toContain('180초')
    expect(u.explanations['f-auth'].overview).toBe('옛 설명') // 옛 설명은 남는다
  })

  // §24-12·§28 — 유령 경로를 대면 그 설명은 실리지 않는다
  it('근거로 댄 경로가 실재하지 않으면 싣지 않는다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation({ evidencePaths: ['src/auth/does-not-exist.ts'] })
    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.features[0].status).toBe('generation-failed')
    expect(u.features[0].staleReason).toContain('does-not-exist')
  })

  it('근거가 모자라다고 스스로 말하면 needs-review 다 (§24-13)', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation({ needsReview: true, needsReviewReason: '실패 경로의 근거를 찾지 못했다' })
    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.features[0].status).toBe('needs-review')
    expect(u.features[0].staleReason).toContain('실패 경로')
    expect(u.explanations['f-auth'].overview).not.toBe('옛 설명') // 설명 자체는 실린다
  })

  it('최근 변경은 20줄까지만 든다 — 무한히 자라지 않는다', async () => {
    const { store, pipeline } = await make()
    for (let i = 0; i < 25; i++)
      await pipeline.onUnitClosed(projectRoot, unit({ title: `작업 ${i}`, sessionId: `s-${i}` }))
    const u = store.get(projectRoot)!
    expect(u.recentChanges).toHaveLength(20)
    expect(u.recentChanges[0].body).toBe('작업 24') // 최신이 앞이다
  })
})

describe('analyzeProject — 첫 분석 (스펙 §21)', () => {
  const draft = { features: [{ name: '인증', summary: '로그인과 세션', implementationPaths: ['src/auth'] }] }

  it('기능 목록을 만들고 구현 경로를 심어 둔다', async () => {
    const { store, pipeline } = await make()
    agentReply.value = draft

    const r = await pipeline.analyzeProject(projectRoot)
    expect(r).toEqual({ ok: true, count: 1 })

    const u = store.get(projectRoot)!
    expect(u.features[0].name).toBe('인증')
    expect(u.features[0].status).toBe('needs-review') // 설명이 아직 없다
    expect(u.analyzedAt).toBe('2026-08-30T12:00:00.000Z')
    // 다음 매핑이 읽을 자리 — 이것이 없으면 어떤 변화도 이 기능에 걸리지 않는다
    expect(u.explanations[u.features[0].id].implementation).toEqual([{ role: '인증', path: 'src/auth' }])
  })

  it('실재하지 않는 경로를 대면 거부한다', async () => {
    const { pipeline } = await make()
    agentReply.value = { features: [{ name: 'x', summary: 'y', implementationPaths: ['src/nope'] }] }
    const r = await pipeline.analyzeProject(projectRoot)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/nope')
  })

  it('계정이 없으면 그 사유를 돌려준다 — 사용자가 기다리는 일이다', async () => {
    const { pipeline } = await make({})
    const r = await pipeline.analyzeProject(projectRoot)
    expect(r).toEqual({ ok: false, reason: 'NO_GENERATOR_ACCOUNT' })
  })

  // 재분석이 사람이 고친 설명을 잃게 하지 않는다 (스펙 §56)
  it('다시 분석해도 같은 이름의 기능은 id 와 설명을 지킨다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store, { userEdited: true, overview: '사람이 쓴 설명' })
    agentReply.value = draft

    await pipeline.analyzeProject(projectRoot)

    const u = store.get(projectRoot)!
    expect(u.features[0].id).toBe('f-auth') // id 가 유지됐다
    expect(u.explanations['f-auth'].overview).toBe('사람이 쓴 설명')
    expect(u.explanations['f-auth'].userEdited).toBe(true)
  })
})
