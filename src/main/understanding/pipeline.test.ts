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
  agentReply.during = null
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

describe('재분석이 잃거나 뭉개지 않는가', () => {
  it('초안에 같은 이름이 둘 오면 각각 다른 줄로 선다 — 하나로 뭉개지지 않는다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = {
      features: [
        { name: '인증', summary: '로그인과 세션', implementationPaths: ['src/auth'] },
        { name: '인증', summary: '토큰 갱신', implementationPaths: ['src/auth'] }
      ]
    }

    const r = await pipeline.analyzeProject(projectRoot)
    expect(r).toEqual({ ok: true, count: 2 })

    const u = store.get(projectRoot)!
    // 두 줄이 같은 곳을 가리키면 사이드바에서 하나를 눌러도 다른 하나가 열린다
    expect(u.features[0].id).not.toBe(u.features[1].id)
    expect(u.features[0].id).toBe('f-auth') // 먼저 온 것이 옛 이름을 가진다
    expect(u.explanations[u.features[1].id].overview).toBe('토큰 갱신') // 뒤엣것은 새로 선다
  })

  it('이름이 바뀐 기능 하나는 설명을 데리고 간다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store, { userEdited: true, overview: '사람이 쓴 설명' })
    agentReply.value = { features: [{ name: '로그인', summary: '세션', implementationPaths: ['src/auth'] }] }

    await pipeline.analyzeProject(projectRoot)

    const u = store.get(projectRoot)!
    const id = u.features[0].id
    expect(id).not.toBe('f-auth') // 이름이 달라 새 id 다
    expect(u.explanations[id].overview).toBe('사람이 쓴 설명') // 그래도 설명은 따라왔다
    expect(u.explanations[id].userEdited).toBe(true)
    expect(u.explanations[id].featureId).toBe(id) // 자기 자신을 가리킨다
    expect(u.explanations['f-auth']).toBeUndefined() // 옛 자리는 남지 않는다
  })

  it('짝을 못 찾은 설명이 여럿이면 잇지 않고 걷는다 — 엉뚱한 설명을 붙이는 것보다 낫다', async () => {
    const { store, pipeline } = await make()
    await store.set(projectRoot, {
      features: [
        { id: 'f-a', name: 'A', summary: '', status: 'up-to-date', updatedAt: 'x', evidenceCount: 0 },
        { id: 'f-b', name: 'B', summary: '', status: 'up-to-date', updatedAt: 'x', evidenceCount: 0 }
      ],
      explanations: {
        'f-a': { featureId: 'f-a', overview: 'A 설명', userFlow: [], failureFlows: [], keyDecisions: [], implementation: [], recentChanges: [], evidence: [], userEdited: false, generatedAt: 'x' },
        'f-b': { featureId: 'f-b', overview: 'B 설명', userFlow: [], failureFlows: [], keyDecisions: [], implementation: [], recentChanges: [], evidence: [], userEdited: false, generatedAt: 'x' }
      },
      recentChanges: []
    })
    agentReply.value = { features: [{ name: 'C', summary: 'C 요약', implementationPaths: ['src/auth'] }] }

    expect(await pipeline.analyzeProject(projectRoot)).toEqual({ ok: true, count: 1 })

    const u = store.get(projectRoot)!
    expect(Object.keys(u.explanations)).toEqual([u.features[0].id]) // 옛 둘은 사라졌다
    expect(u.explanations[u.features[0].id].overview).toBe('C 요약') // 초안이 준 그대로
  })

  // **저장소 밖은 근거가 아니다.** path.join 만으로는 ../ 가 통과한다 — 그것이 화면에 뜨고
  // 다음 재생성의 "여기서부터 읽어라" 목록에도 실린다
  it('저장소 밖으로 나가는 경로는 실재해도 거부한다', async () => {
    const { pipeline } = await make()
    agentReply.value = {
      features: [{ name: 'x', summary: 'y', implementationPaths: ['../understanding.json'] }]
    }
    const r = await pipeline.analyzeProject(projectRoot)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('understanding.json')
  })
})

describe('에이전트가 도는 동안 저장 파일이 바뀌면', () => {
  it('그 사이에 사람이 고친 설명은 덮지 않는다 (스펙 §56)', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation()
    // 실제로는 여기가 30~180초다. 그동안 사용자가 설명을 고쳤다
    agentReply.during = async (): Promise<void> => {
      const u = store.get(projectRoot)!
      await store.set(projectRoot, {
        ...u,
        explanations: { 'f-auth': { ...u.explanations['f-auth'], overview: '사람이 쓴 설명', userEdited: true } }
      })
    }

    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.explanations['f-auth'].overview).toBe('사람이 쓴 설명')
    expect(u.features[0].status).toBe('update-available')
  })

  it('그 사이에 기능이 사라졌으면 결과를 버린다 — 유령 설명을 남기지 않는다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation()
    agentReply.during = async (): Promise<void> => {
      await store.set(projectRoot, { features: [], explanations: {}, recentChanges: [] })
    }

    await pipeline.onUnitClosed(projectRoot, unit())

    const u = store.get(projectRoot)!
    expect(u.features).toHaveLength(0)
    expect(u.explanations['f-auth']).toBeUndefined() // 아무도 가리키지 않는 자리에 쓰지 않았다
  })

  it('첫 분석과 재생성은 같은 줄에 선다 — 겹치면 서로의 id 를 죽인다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation()
    const order: string[] = []
    agentReply.during = async (): Promise<void> => {
      order.push('start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('end')
    }

    const a = pipeline.onUnitClosed(projectRoot, unit())
    const b = pipeline.analyzeProject(projectRoot)
    await Promise.all([a, b])

    expect(order).toEqual(['start', 'end', 'start', 'end']) // 겹치지 않았다
  })
})

describe('[다시] — 사용자가 직접 시킨 재생성', () => {
  it('사람이 고친 설명도 덮는다 — 그렇게 하라고 누른 버튼이다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store, { userEdited: true, overview: '사람이 쓴 설명' })
    agentReply.value = explanation()

    await pipeline.regenerate(projectRoot, 'f-auth')

    const u = store.get(projectRoot)!
    expect(u.explanations['f-auth'].overview).toBe('사용자가 로그인하면 서버가 세션을 만든다.')
    expect(u.explanations['f-auth'].userEdited).toBe(false)
    expect(u.features[0].status).toBe('up-to-date')
  })

  it('만들지 못했던 줄을 다시 세운다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.fail = '180초 안에 끝나지 않았다'
    await pipeline.regenerate(projectRoot, 'f-auth')
    expect(store.get(projectRoot)!.features[0].status).toBe('generation-failed')

    agentReply.fail = null
    agentReply.value = explanation()
    await pipeline.regenerate(projectRoot, 'f-auth')
    expect(store.get(projectRoot)!.features[0].status).toBe('up-to-date')
  })

  it('없는 기능이면 아무것도 하지 않는다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    await pipeline.regenerate(projectRoot, 'f-없음')
    expect(agentReply.calls).toBe(0)
    expect(store.get(projectRoot)!.features[0].status).toBe('up-to-date')
  })

  // 도는 동안 화면이 그것을 보여 줘야 한다 — 아무 표시가 없으면 사용자는 다시 누른다
  it('도는 동안 그 줄은 "만드는 중"이다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation()
    let seen: string | undefined
    agentReply.during = async (): Promise<void> => {
      seen = store.get(projectRoot)!.features[0].status
    }

    await pipeline.regenerate(projectRoot, 'f-auth')
    expect(seen).toBe('generating')
  })
})

describe('화면에 닿는가', () => {
  // 재생성은 배경에서 수십 초 걸려 끝난다. 이 알림이 없으면 그 결과는 사용자가 프로젝트를
  // 바꿨다 돌아올 때까지 화면에 없다 — 사용자에게는 실패한 것으로 보인다
  it('저장할 때마다 화면에 알린다', async () => {
    const { store, pipeline, changed } = await make()
    await seedFeature(store)
    agentReply.value = explanation()
    changed.length = 0

    await pipeline.onUnitClosed(projectRoot, unit())

    expect(changed.length).toBeGreaterThanOrEqual(2) // "만드는 중" 과 그 결과
    expect(new Set(changed)).toEqual(new Set([projectRoot]))
  })
})

describe('기능마다의 최근 변경', () => {
  // 사이드바 아래 목록은 프로젝트 전체의 것이라, 기능 하나를 열었을 때
  // "이 기능이 최근에 왜 바뀌었나"에는 답하지 못한다
  it('그 기능의 설명에도 변경이 쌓인다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation()

    await pipeline.onUnitClosed(projectRoot, unit({ title: '로그인 고쳐줘' }))

    const e = store.get(projectRoot)!.explanations['f-auth']
    expect(e.recentChanges).toHaveLength(1)
    expect(e.recentChanges[0].body).toBe('로그인 고쳐줘')
    // 그 줄의 근거가 실려야 단계를 눌렀을 때 "이 단계를 바꾼 변경" 칸이 선다
    expect(e.recentChanges[0].evidenceIds).toEqual(['file:src/auth/login.ts'])
  })

  it('새 설명이 그 이력을 지우지 않는다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store)
    agentReply.value = explanation()
    await pipeline.onUnitClosed(projectRoot, unit({ title: '첫 번째' }))
    await pipeline.onUnitClosed(projectRoot, unit({ title: '두 번째', sessionId: 's-2' }))

    const e = store.get(projectRoot)!.explanations['f-auth']
    expect(e.recentChanges.map((c) => c.body)).toEqual(['두 번째', '첫 번째'])
  })

  it('사람이 고쳐 생성을 건너뛰어도 변경은 남는다 — 일어난 일은 일어난 일이다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store, { userEdited: true })
    await pipeline.onUnitClosed(projectRoot, unit({ title: '그래도 바뀐 것' }))

    const e = store.get(projectRoot)!.explanations['f-auth']
    expect(e.recentChanges.map((c) => c.body)).toEqual(['그래도 바뀐 것'])
    expect(agentReply.calls).toBe(0)
  })

  it('다섯 줄까지만 든다', async () => {
    const { store, pipeline } = await make()
    await seedFeature(store, { userEdited: true }) // 에이전트를 부르지 않아 빠르다
    for (let i = 0; i < 7; i++)
      await pipeline.onUnitClosed(projectRoot, unit({ title: `변경 ${i}`, sessionId: `s-${i}` }))

    const e = store.get(projectRoot)!.explanations['f-auth']
    expect(e.recentChanges).toHaveLength(5)
    expect(e.recentChanges[0].body).toBe('변경 6')
  })
})
