// 설계 문서 §18 이 이름까지 정해 준 셋(WU §23 의 나머지)과, 스펙 §16.1 의 커서 규칙 셋.
//
// **감시자를 띄우지 않는다.** 수집기는 의존을 밖에서 받고 방아쇠를 메서드로 노출하므로, 진짜
// 트랜스크립트 파일을 임시 디렉터리에 쓰고 그 메서드를 직접 부르면 전부 확인된다. 디바운스는
// `flush()` 로 건너뛴다 — 테스트가 150ms 를 기다리지 않게 하려고 남겨 둔 길이다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkUnitStore } from './store'
import { WorkUnitCollector, type CollectorGit, type CollectorSession } from './collector'
import { isOpen } from '../../core/workUnit/status'
import { OPERATION_GRACE_MS } from '../../core/git/provenance'
import type { GitRef } from '../../core/git/types'

let dir: string
let storeFile: string
let projectPath: string
let transcript: string

/** 사람의 요청 한 줄. `promptSource: 'typed'` 가 humanRequest.ts 의 허용 목록을 통과하는 표지다 */
const human = (text: string, at = '2026-08-30T00:00:00.000Z'): string =>
  JSON.stringify({
    type: 'user',
    promptSource: 'typed',
    timestamp: at,
    message: { role: 'user', content: text }
  }) + '\n'

/** 사람의 요청이 아닌 줄 — 도구 결과. 걸러지는지 보려고 섞는다 */
const toolResult = (): string =>
  JSON.stringify({
    type: 'user',
    promptSource: 'typed',
    toolUseResult: { ok: true },
    message: { role: 'user', content: 'tool output' }
  }) + '\n'

interface Fake {
  git: CollectorGit & {
    ref: GitRef
    files: string[]
    ancestor: boolean | null
    range: { commits: string[]; changedFiles: string[] }
  }
  sessions: CollectorSession[]
  clock: number
}

function makeFake(): Fake {
  const fake: Fake = {
    git: {
      ref: { branch: 'main', head: 'c0' },
      files: [],
      ancestor: true,
      range: { commits: [], changedFiles: [] },
      readRef: async () => fake.git.ref,
      isAncestor: async () => fake.git.ancestor,
      changedFiles: async () => fake.git.files,
      readRange: async () => fake.git.range
    },
    sessions: [],
    clock: Date.parse('2026-08-30T09:00:00.000Z')
  }
  return fake
}

async function makeCollector(
  fake: Fake,
  file = storeFile
): Promise<{ collector: WorkUnitCollector; store: WorkUnitStore }> {
  const store = new WorkUnitStore(file)
  await store.load()
  // 자기 참조다 — pendingGitOps 는 collector 자신의 등록 목록을 그대로 돌려준다. ipc.ts 가
  // workUnitCollector 를 wiring 하는 것과 같은 자리, 같은 이유다.
  const collector: WorkUnitCollector = new WorkUnitCollector({
    store,
    listSessions: async () => fake.sessions,
    git: fake.git,
    now: () => fake.clock,
    pendingGitOps: () => collector.getPendingGitOps()
  })
  return { collector, store }
}

const session = (overrides: Partial<CollectorSession> = {}): CollectorSession => ({
  sessionId: 's1',
  projectPath,
  transcriptPath: transcript,
  idleSignalTrusted: true,
  ...overrides
})

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-wu-collector-'))
  storeFile = path.join(dir, 'workUnits.json')
  projectPath = path.join(dir, 'project')
  transcript = path.join(dir, 'transcript.jsonl')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.writeFile(transcript, '', 'utf8')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// ── WU §23 의 나머지 셋 ────────────────────────────────────────────────

describe('WorkUnitCollector — WU §23', () => {
  it('커밋이 없어도 정상 동작한다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    // 이 세션은 커밋을 한 번도 만들지 않는다 — HEAD 는 처음부터 끝까지 c0 이다.
    // 바뀌는 것은 작업 트리뿐이고, 그것이 관찰된 변경의 전부다.
    fake.git.files = ['src/login.ts']
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('로그인 기능 만들어줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    await collector.onSessionIdle('s1')

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].title).toBe('로그인 기능 만들어줘')
    // WU §7 이 "Commit 을 작업 경계의 주 기준으로 쓰지 않는다"고 한 것의 실제 확인이다
    expect(state.units[0].status).toBe('completed-candidate')
    expect(state.units[0].git.observedChangedFiles).toEqual(['src/login.ts'])
    expect(state.externalGitChanges).toHaveLength(0)
  })

  it('여러 커밋이 한 Unit 을 유지한다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('리팩터링해줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    const openedId = store.get(projectPath)!.units[0].id

    for (const head of ['c1', 'c2', 'c3']) {
      fake.git.ref = { branch: 'main', head }
      collector.onGitChanged()
      await collector.flush()
    }

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1) // 커밋은 Unit 을 열지 않는다 — 여는 것은 사람의 요청뿐이다
    expect(state.units[0].id).toBe(openedId)
    expect(state.units[0].status).toBe('active')
    expect(state.units[0].git.startHead).toBe('c0')
    expect(state.units[0].git.endHead).toBe('c3')
  })

  it('재시작 후 활성 Unit 이 복구된다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const first = await makeCollector(fake)
    await first.collector.start()
    await fs.appendFile(transcript, human('설정 화면 추가해줘'), 'utf8')
    first.collector.onTranscriptChanged()
    await first.collector.flush()
    const openedId = first.store.get(projectPath)!.units[0].id
    expect(first.store.get(projectPath)!.units[0].status).toBe('active')

    // 수집기를 버리고, 같은 저장소 파일로 새로 세운다 — 앱 재시작이다
    const second = await makeCollector(fake)
    await second.collector.start()

    await fs.appendFile(transcript, human('버튼 색도 바꿔줘'), 'utf8')
    second.collector.onTranscriptChanged()
    await second.collector.flush()

    const state = second.store.get(projectPath)!
    // decideBoundary 의 Case C — 새 Unit 을 열지 않고 그 Unit 에 붙는다
    expect(state.units).toHaveLength(1)
    expect(state.units[0].id).toBe(openedId)
    expect(state.units[0].messageCount).toBe(2)
  })

  // 재시작하면 lastRef 캐시가 비어 있다. 경계에서 HEAD 를 묻기 전에 앞 Unit 을 닫으면 그 Unit 의
  // endHead 는 영영 비어 있게 되고, 그 자리가 채워졌는지 보는 테스트가 없어 되돌려도 조용했다.
  it('재시작 뒤 첫 경계에서도 앞 Unit 의 endHead 가 채워진다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    fake.git.files = ['src/a.ts'] // 관찰된 변경이 있어야 유휴가 완료 후보를 만든다
    const first = await makeCollector(fake)
    await first.collector.start()
    await fs.appendFile(transcript, human('첫 작업'), 'utf8')
    first.collector.onTranscriptChanged()
    await first.collector.flush()
    await first.collector.onSessionIdle('s1')
    expect(first.store.get(projectPath)!.units[0].status).toBe('completed-candidate')

    // 앱 재시작 — 새 수집기의 git 캐시는 비어 있고, 그동안 HEAD 도 움직였다
    fake.git.ref = { branch: 'main', head: 'c9' }
    const second = await makeCollector(fake)
    await second.collector.start()

    // 이 요청이 앞 Unit 을 확정한다 (decideBoundary 의 close-and-open)
    await fs.appendFile(transcript, human('다음 작업'), 'utf8')
    second.collector.onTranscriptChanged()
    await second.collector.flush()

    const state = second.store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[0].status).toBe('completed')
    expect(state.units[0].git.endHead).toBe('c9') // 경계가 물은 HEAD 가 닫히는 Unit 에도 들어간다
    expect(state.units[1].git.startHead).toBe('c9')
  })
})

// ── Astera 자신의 git 동작 (EG §26·§41-9) ─────────────────────────────

describe('WorkUnitCollector — beginGitOperation/endGitOperation', () => {
  it('Astera 의 병합은 외부 변경이 되지 않는다 (EG §41-9)', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    // 기준선을 잡는다 — 처음 보는 저장소는 전이를 만들지 않는다
    collector.onGitChanged()
    await collector.flush()
    expect(store.get(projectPath)!.externalGitChanges).toHaveLength(0)

    // Astera 자신의 병합이 도는 중이라고 등록한 채로 HEAD 를 옮긴다 — ipc.ts 의 job-merge 자리와 같다
    const opId = collector.beginGitOperation('job-merge', projectPath)
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()
    collector.endGitOperation(opId)

    expect(store.get(projectPath)!.externalGitChanges).toHaveLength(0)
  })

  // 수집기의 주입된 시계(now)가 유예 경계를 실제로 넘기는 테스트가 없었다. isAsteraOperation 의
  // 유예(OPERATION_GRACE_MS)는 provenance.test.ts 가 순수 함수로도 확인하지만, 여기서는 수집기
  // 자신의 begin/end + 주입된 clock 을 통해 끝에서 끝까지 확인하고, fast-forward 의 commits·
  // changedFiles 가 실제로 저장되는 기록까지 함께 본다(readRange 의 결과를 그대로 threading 하는지는
  // 이 자리 말고는 볼 데가 없다 — commits·changedFiles 를 빈 배열로 바꿔도 이 단언 없이는 스위트가
  // 그대로 초록이었다).
  it('유예가 지난 뒤의 전이는 외부다 — commits·changedFiles 도 함께 저장된다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선
    await collector.flush()

    const opId = collector.beginGitOperation('job-merge', projectPath)
    collector.endGitOperation(opId)
    fake.clock += OPERATION_GRACE_MS + 1 // 유예 너머로 시각을 옮긴다

    fake.git.range = { commits: ['c1'], changedFiles: ['a.txt', 'b.txt'] }
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.externalGitChanges[0].commits).toEqual(['c1'])
    expect(state.externalGitChanges[0].changedFiles).toEqual(['a.txt', 'b.txt'])
  })

  // ExternalGitChange.commits/changedFiles 의 주석 그대로다: fast-forward 가 아니면 before..after
  // 범위를 신뢰할 수 없다. fake.git.range 를 채워 둬도 branch-switch 에는 그것이 새지 않아야 한다 —
  // readRange 를 부르지 않았다는 것의 관찰 가능한 증거다.
  it('branch-switch 에는 commits·changedFiles 를 채우지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    fake.git.range = { commits: ['should-not-appear'], changedFiles: ['should-not-appear.txt'] }
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선 (main, c0)
    await collector.flush()

    fake.git.ref = { branch: 'feature', head: 'c0' } // 브랜치만 바뀐다 — HEAD 는 그대로
    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.externalGitChanges[0].type).toBe('branch-switch')
    expect(state.externalGitChanges[0].commits).toEqual([])
    expect(state.externalGitChanges[0].changedFiles).toEqual([])
  })

  // 위 테스트의 반대쪽이다. `commits` 와 `changedFiles` 는 믿을 수 있는 정도가 다르다 —
  // `git log before..after` 는 브랜치를 갈아타면 뜻이 없지만, `git diff --name-only before..after`
  // 는 **두 트리의 비교**라 그때도 정확하다. 다음 계획의 기능 매핑이 브랜치 전환에서 그 파일
  // 목록을 받아야 한다(EG §18·§19). 위 테스트가 여전히 빈 목록인 것은 그쪽 HEAD 가 움직이지
  // 않아서다 — 같은 트리끼리는 견줄 것이 없다.
  it('브랜치 전환에도 changedFiles 는 채운다 — 버리는 것은 commits 뿐이다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    fake.git.range = { commits: ['범위를-믿을-수-없다'], changedFiles: ['src/a.ts', 'src/b.ts'] }
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선 (main, c0)
    await collector.flush()

    fake.git.ref = { branch: 'feature', head: 'c5' } // 브랜치도 HEAD 도 바뀐다
    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.externalGitChanges[0].type).toBe('branch-switch')
    expect(state.externalGitChanges[0].changedFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(state.externalGitChanges[0].commits).toEqual([])
  })

  // **CRITICAL 회귀 테스트.** endGitOperation 이 `!running` 가드를 갖고 있으면, 추적을 끄는 사이에
  // 끝난 병합의 endedAt 이 영영 비고, isAsteraOperation 은 endedAt 없는 동작을 "아직 도는 중"으로
  // 영원히 읽는다 — 그 프로젝트의 모든 외부 변경이 그때부터 조용히 삼켜진다. ipc.ts 의 job-merge
  // 자리는 토글을 묻지 않고 beginGitOperation/endGitOperation 을 부르므로, 병합 도중 설정 체크박스가
  // 눌리는 창은 실제로 열려 있다.
  it('추적을 끄는 사이에 끝난 동작도 닫힌다 — 열린 채로 영원히 남지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선
    await collector.flush()

    const opId = collector.beginGitOperation('job-merge', projectPath)
    await collector.stop() // 병합이 도는 중에 추적을 끈다
    collector.endGitOperation(opId) // 꺼져 있어도 닫혀야 한다
    await collector.start() // 다시 켠다 — 저장된 스냅샷이 남아 있으므로 앞은 여전히 (main, c0) 이다

    collector.onGitChanged() // 그 사이 HEAD 는 움직이지 않았다 — 전이 없음(none)
    await collector.flush()

    fake.clock += OPERATION_GRACE_MS + 1 // 유예를 넘긴다
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    // 닫히지 않았다면 이 동작은 여전히 "도는 중"으로 읽혀 이 전이도 Astera 것으로 삼켜지고,
    // 길이는 0 으로 남는다.
    expect(store.get(projectPath)!.externalGitChanges).toHaveLength(1)
  })

  // ipc.ts 의 mergeInto(run.worktree ?? run.cwd)와 이 프로젝트의 cwd 는 따로 기록되고, 대소문자나
  // 구분자만 다르게 적힐 수 있다(core/orchestration/integrate.ts 의 worktreeDeps 주석과 같은 문제) —
  // isAsteraOperation 에 isSamePath 를 넘기지 않으면 이 등록은 아무 것도 못 막는다.
  it('등록된 경로 표기가 달라도(대소문자) Astera 의 병합으로 본다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선
    await collector.flush()

    const opId = collector.beginGitOperation('job-merge', projectPath.toUpperCase())
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()
    collector.endGitOperation(opId)

    expect(store.get(projectPath)!.externalGitChanges).toHaveLength(0)
  })

  // beginGitOperation 의 프룬(pending 목록에서 유예 지난 것을 치우는 자리)은 규칙이 둘이고 서로
  // 다르다 — 하나로는 둘 다 못 잡는다. 여기서는 등록 목록 자체(getPendingGitOps)를 본다, 그
  // 목록이 isAsteraOperation 의 판정에 미치는 영향(외부 변경 개수)이 아니라 — 판정을 통해서만
  // 보면 두 규칙이 뒤섞여 어느 쪽이 깨졌는지 가릴 수 없다.
  it('유예가 지난 뒤 끝난 동작은 다음 등록 때 목록에서 치워진다', async () => {
    const fake = makeFake()
    const { collector } = await makeCollector(fake)
    await collector.start()

    const first = collector.beginGitOperation('job-merge', projectPath)
    collector.endGitOperation(first)
    fake.clock += OPERATION_GRACE_MS + 1 // 유예를 넘긴다

    collector.beginGitOperation('job-merge', projectPath) // 프룬은 여기, 새로 넣기 직전에 돈다

    expect(collector.getPendingGitOps().some((o) => o.id === first)).toBe(false)
  })

  // **끝나지 않은 동작을 나이로 지우면 안 되는 이유가 이 테스트의 전부다.** 오래 걸리는 병합은
  // endGitOperation 이 불리기 전까지 유예보다 오래 열려 있을 수 있고, 그것을 나이만 보고 지우면
  // 그 병합이 끝나기도 전에 외부로 오판된다 — CRITICAL 회귀(위 "추적을 끄는 사이에...")가 막은
  // "영원히 삼켜짐"의 반대쪽, "너무 일찍 흘려보냄"이다.
  it('끝나지 않은 동작은 아무리 오래돼도 치우지 않는다', async () => {
    const fake = makeFake()
    const { collector } = await makeCollector(fake)
    await collector.start()

    const first = collector.beginGitOperation('job-merge', projectPath) // 끝내지 않는다 — 열어 둔다
    fake.clock += OPERATION_GRACE_MS * 100 // 유예를 한참 넘긴다

    const second = collector.beginGitOperation('job-merge', projectPath)

    const ops = collector.getPendingGitOps()
    expect(ops.some((o) => o.id === first)).toBe(true)
    expect(ops.some((o) => o.id === second)).toBe(true)
  })
})

// ── 저장된 git 스냅샷 (설계 §9 · EG §41-10·§42-17) ─────────────────────

describe('WorkUnitCollector — 앱이 꺼져 있던 동안의 변화', () => {
  // 스냅샷이 메모리에만 있으면 이 pull 은 없던 일이 된다 — 새 수집기에는 비교할 앞이 없어
  // 기준선만 잡고 나가기 때문이다. 저장된 스냅샷이 그 앞이 되어야 **보통의 전이**로 판정된다.
  it('꺼져 있는 동안 옮겨진 HEAD 가 다시 켠 첫 회차에 잡힌다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const first = await makeCollector(fake)
    await first.collector.start()
    first.collector.onGitChanged() // 마지막으로 안 상태 — main, c0
    await first.collector.flush()
    expect(first.store.get(projectPath)!.externalGitChanges).toHaveLength(0)

    // 앱을 끈다(수집기를 버린다). 그 사이에 다른 창에서 pull 이 돈다
    fake.git.ref = { branch: 'main', head: 'c1' }
    fake.git.range = { commits: ['c1'], changedFiles: ['pulled.ts'] }

    // 같은 저장 파일로 다시 켠다 — 앱 재시작이다
    const second = await makeCollector(fake)
    await second.collector.start()
    second.collector.onGitChanged()
    await second.collector.flush()

    const state = second.store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.externalGitChanges[0].type).toBe('fast-forward')
    expect(state.externalGitChanges[0].before).toEqual({ branch: 'main', head: 'c0' })
    expect(state.externalGitChanges[0].after).toEqual({ branch: 'main', head: 'c1' })
    expect(state.externalGitChanges[0].changedFiles).toEqual(['pulled.ts'])
  })

  it('처음 보는 프로젝트는 기준선만 잡는다 — 기록이 생기지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(0)
    // 비교할 앞은 없었지만 기준선은 남는다 — 다음 실행의 "앞"이 이것이다
    expect(state.gitSnapshot).toMatchObject({ projectPath, branch: 'main', head: 'c0' })
  })

  // **커서와 반대 방향의 규칙이고, 그것이 맞다.** 커서는 "켜기 전의 대화는 읽지 않는다"는 약속이
  // 걸려 있어 끌 때 버린다(스펙 §16.1). 스냅샷에 걸린 약속은 그 반대다 — "실제로 일어난 변화를
  // 놓치지 않는다". 대화는 사람의 말이고 저장소의 역사는 사실이다.
  it('껐다 켜는 사이의 변화도 잡는다 — 스냅샷은 커서와 달리 버리지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 마지막으로 안 상태 — main, c0
    await collector.flush()

    await collector.onEnabledChanged(false)
    expect(store.get(projectPath)!.cursors).toHaveLength(0) // 커서는 버렸다
    fake.git.ref = { branch: 'main', head: 'c1' } // 꺼져 있는 동안의 pull
    await collector.onEnabledChanged(true)

    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.externalGitChanges[0].before).toEqual({ branch: 'main', head: 'c0' })
  })
})

// ── 스펙 §16.1 의 커서 규칙 셋 ─────────────────────────────────────────

describe('WorkUnitCollector — 스펙 §16.1 커서', () => {
  it('켠 뒤 시작한 세션은 처음부터 읽는다 — 커서가 0 이다', async () => {
    const fake = makeFake()
    fake.sessions = [] // 켤 때는 아무 세션도 없다
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    // 그 뒤에 세션이 시작하고 파일을 쓴다
    await fs.appendFile(transcript, human('첫 요청') + toolResult() + human('두 번째 요청'), 'utf8')
    fake.sessions = [session()]
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1) // 둘째 요청은 같은 Unit 에 붙는다
    expect(state.units[0].title).toBe('첫 요청') // 파일의 첫 줄부터 읽었다
    expect(state.messages.map((m) => m.index)).toEqual([0, 1]) // 도구 결과는 세지 않는다
    expect(state.cursors[0].offset).toBe((await fs.stat(transcript)).size)
  })

  it('이미 돌던 세션은 켠 순간의 파일 끝부터 읽는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    // 켜기 전의 대화. 한 줄도 Unit 이 되어서는 안 된다
    await fs.appendFile(transcript, human('켜기 전 요청 하나') + human('켜기 전 요청 둘'), 'utf8')
    const sizeAtSwitch = (await fs.stat(transcript)).size

    const { collector, store } = await makeCollector(fake)
    await collector.start()
    expect(store.get(projectPath)!.cursors[0].offset).toBe(sizeAtSwitch)

    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(0)

    await fs.appendFile(transcript, human('켠 뒤 첫 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].title).toBe('켠 뒤 첫 요청')
    expect(state.units[0].firstMessageIndex).toBe(0)
    expect(state.messages).toHaveLength(1)
  })

  it('껐다 켜면 이전 커서를 버리고 그 순간의 끝을 다시 잡는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    fake.git.files = ['src/a.ts']
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('켜져 있는 동안의 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units[0].status).toBe('active')

    // 끈다 — 열려 있던 Unit 은 onFeatureDisabled 로 그 자리에서 닫히고 커서는 버려진다
    await collector.onEnabledChanged(false)
    const closed = store.get(projectPath)!
    expect(isOpen(closed.units[0].status)).toBe(false)
    expect(closed.units[0].status).toBe('completed') // 관찰된 변경이 있었다
    expect(closed.units[0].completedAt).toBeDefined()
    expect(closed.cursors).toHaveLength(0)

    // 꺼져 있는 동안 쌓인 줄
    await fs.appendFile(transcript, human('꺼진 동안 하나') + human('꺼진 동안 둘'), 'utf8')

    await collector.onEnabledChanged(true)
    expect(store.get(projectPath)!.cursors[0].offset).toBe((await fs.stat(transcript)).size)

    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1) // 꺼진 동안의 두 줄은 읽지 않았다

    await fs.appendFile(transcript, human('다시 켠 뒤의 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[1].title).toBe('다시 켠 뒤의 요청')
  })

  // 체크박스를 두 번 누르면 두 핸들러가 겹쳐 든다. 끄기가 아직 큐에 있는데 켜기가 먼저 상태를
  // 비우면, 닫아야 할 프로젝트를 찾을 길이 사라져 Unit 이 열린 채 남는다.
  it('끄기와 켜기가 겹쳐도 열려 있던 Unit 은 닫힌다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()
    await fs.appendFile(transcript, human('겹치는 토글'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    await Promise.all([collector.onEnabledChanged(false), collector.onEnabledChanged(true)])

    expect(isOpen(store.get(projectPath)!.units[0].status)).toBe(false)
  })

  // 한도에 걸려 세션을 굴리면(rolling.ts) 새 세션 id 가 생기고 `--resume` 이 이전 대화를 통째로
  // 되쓴다. 수집기는 그 id 를 처음 보므로 커서가 없고, 커서가 없다는 것만으로 0 부터 읽으면
  // **켜기 전의 대화가 Unit 이 되고 켠 뒤의 것은 두 번 읽힌다.**
  it('이어받은 세션은 --resume 이 되쓴 과거를 다시 읽지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('굴리기 전 요청 하나') + human('굴리기 전 요청 둘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1)

    // 굴리기 — 새 파일에 옛 대화가 그대로 다시 적히고, 앱은 그것이 이어진 세션임을 알고 있다
    const rolled = path.join(dir, 'transcript-rolled.jsonl')
    await fs.copyFile(transcript, rolled)
    collector.onSessionForked('s2', rolled)
    fake.sessions = [session({ sessionId: 's2', transcriptPath: rolled })]

    // 이어받은 뒤에 사람이 처음 한 말
    await fs.appendFile(rolled, human('이어받은 뒤 첫 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2) // 되읽힌 두 줄은 Unit 을 만들지 않았다
    expect(state.units[1].sessionId).toBe('s2')
    expect(state.units[1].title).toBe('이어받은 뒤 첫 요청')
    expect(state.messages.filter((m) => m.sessionId === 's2')).toHaveLength(1)
  })

  // statusline 캡처 파일이 아직 없거나 쓰이는 중이면 그 세션의 경로는 그 순간 null 로 온다.
  // seed 가 그 세션을 건너뛰면 다음 회차에 **커서 없는 세션**으로 보이고, 그것만으로 0 부터
  // 읽으면 켜기 전의 대화가 통째로 들어온다.
  it('켤 때 경로를 못 읽은 세션도 0 부터 읽지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session({ transcriptPath: null })]
    // 켜기 전의 대화. 한 줄도 Unit 이 되어서는 안 된다
    await fs.appendFile(transcript, human('켜기 전 요청 하나') + human('켜기 전 요청 둘'), 'utf8')

    const { collector, store } = await makeCollector(fake)
    await collector.start()
    expect(store.get(projectPath)!.cursors).toHaveLength(0) // 잡을 경로가 없었다

    // 다음 회차부터는 경로가 온다 — 켤 때 이미 돌던 세션이므로 파일 끝을 잡아야 한다
    fake.sessions = [session()]
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(0)

    await fs.appendFile(transcript, human('켠 뒤 첫 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].title).toBe('켠 뒤 첫 요청')
    expect(state.messages).toHaveLength(1)
  })

  // 한도에 걸려 자동으로 굴린 세션은 다르다 — 굴리기를 알리는 자리(index.ts 의 session:rolled 탭)가
  // 새 세션 id 만 들고 있고, 그 세션이 쓸 파일은 그 순간 아직 아무도 모른다(statusline 이 오기 전이다).
  // 그래도 **0 으로 떨어지면 안 된다** — 그 파일에는 `--resume` 이 되쓴 옆 대화가 이미 들어 있다.
  it('굴려서 생긴 세션은 경로를 모르는 채 알려줘도 되쓰인 내용을 읽지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('굴리기 전 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1)

    // session:rolled 가 왔다. 새 세션 id 만 안다 — 경로는 건네지 않는다
    collector.onSessionForked('s2')

    // 그 뒤 statusline 이 경로를 알려 준다. 그 파일에는 되쓰인 옆 대화가 이미 들어 있다
    const rolled = path.join(dir, 'transcript-rolled-by-limit.jsonl')
    await fs.copyFile(transcript, rolled)
    fake.sessions = [session({ sessionId: 's2', transcriptPath: rolled })]
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1) // 되쓰인 줄은 Unit 을 만들지 않았다

    // 굴린 뒤에 사람이 처음 한 말만 Unit 이 된다
    await fs.appendFile(rolled, human('굴린 뒤 첫 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[1].sessionId).toBe('s2')
    expect(state.units[1].title).toBe('굴린 뒤 첫 요청')
    expect(state.messages.filter((m) => m.sessionId === 's2')).toHaveLength(1)
  })

  // 이어받은 세션의 경로를 그 순간 stat 하지 못하는 일은 흔하다 — statusline 이 경로를 먼저
  // 알려 주고 파일은 조금 뒤에 생긴다. 그때 크기를 0 으로 읽어 커서로 남기면, 다음 회차에는
  // **경로가 맞는 커서**가 있으므로 이어받기 표시를 다시 보지 않고 그 0 에서 읽는다 — 되쓰인
  // 대화 전체다. 크기 0 과 못 읽음은 다른 답이어야 한다.
  it('이어받은 세션의 파일을 아직 stat 하지 못하면 그 회차를 건너뛴다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('굴리기 전 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1)

    collector.onSessionForked('s2')

    // statusline 이 경로를 알려 줬지만 그 파일은 아직 없다 — stat 이 실패한다
    const rolled = path.join(dir, 'transcript-rolled-late.jsonl')
    fake.sessions = [session({ sessionId: 's2', transcriptPath: rolled })]
    collector.onTranscriptChanged()
    await collector.flush()
    // 정할 수 없었으므로 커서를 남기지 않는다. 다음 회차가 다시 묻는다
    expect(store.get(projectPath)!.cursors.some((c) => c.sessionId === 's2')).toBe(false)

    // 그 뒤 --resume 이 옛 대화를 그 파일에 통째로 적는다
    await fs.copyFile(transcript, rolled)
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1) // 되쓰인 줄은 Unit 이 되지 않았다

    await fs.appendFile(rolled, human('굴린 뒤 첫 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[1].title).toBe('굴린 뒤 첫 요청')
  })

  // 0 이 옳은 경우는 하나뿐이다 — 세션 id 도 파일도 지금 처음 본다. 켠 뒤 시작한 세션이라도
  // 보고 있던 파일이 바뀌면 그 파일의 앞부분은 우리가 본 적 없는 대화이고, 그것을 읽는 것은
  // "켜기 전의 대화는 읽지 않는다"를 어기는 것이다. rolling.ts 의 applyMeta 가 경로가 바뀌면
  // since=now 로 tail 을 새로 세우는 것과 같은 판단이다.
  it('켠 뒤 시작한 세션이라도 파일이 바뀌면 그 파일은 끝부터 읽는다', async () => {
    const fake = makeFake()
    fake.sessions = [] // 켤 때는 아무 세션도 없다
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    // 켠 뒤에 시작한 세션 — 그 파일은 처음부터 읽는 것이 맞다
    await fs.appendFile(transcript, human('켠 뒤 시작한 세션의 요청'), 'utf8')
    fake.sessions = [session()]
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.messages).toHaveLength(1)

    // 그 세션이 다른 파일을 보게 됐다. 그 파일에는 우리가 본 적 없는 대화가 들어 있다
    const other = path.join(dir, 'transcript-other.jsonl')
    await fs.writeFile(other, human('그 파일에 있던 요청 하나') + human('그 파일에 있던 요청 둘'), 'utf8')
    fake.sessions = [session({ transcriptPath: other })]
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.messages).toHaveLength(1) // 그 둘은 읽지 않았다

    await fs.appendFile(other, human('바뀐 파일에 새로 온 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.messages.map((m) => m.text)).toEqual([
      '켠 뒤 시작한 세션의 요청',
      '바뀐 파일에 새로 온 요청'
    ])
    // 같은 세션의 열린 Unit 에 붙는다 (decideBoundary 의 Case C)
    expect(state.units).toHaveLength(1)
    expect(state.units[0].messageCount).toBe(2)
  })

  // tail 이 돌려주는 restarted 를 수집기가 여태 무시했다. 파일이 커서보다 작아지면 tail 은
  // 처음부터 다시 읽는데, 켤 때 이미 돌던 세션에게 그 "처음"은 우리 것이 아니다.
  it('파일이 커서보다 작아져도 켤 때 돌던 세션은 처음부터 읽지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    await fs.appendFile(
      transcript,
      human('켜기 전 요청 하나') + human('켜기 전 요청 둘') + human('켜기 전 요청 셋'),
      'utf8'
    )
    const { collector, store } = await makeCollector(fake)
    await collector.start() // 커서 = 지금 파일 끝

    // 같은 경로가 더 짧은 파일이 됐다 — 잘렸거나 다른 파일이 같은 이름으로 놓였다
    await fs.writeFile(transcript, human('짧아진 파일에 있던 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    expect(store.get(projectPath)!.units).toHaveLength(0) // 되감아 읽지 않았다
    expect(store.get(projectPath)!.cursors[0].offset).toBe((await fs.stat(transcript)).size)

    await fs.appendFile(transcript, human('그 뒤에 온 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].title).toBe('그 뒤에 온 요청')
  })
})

// ── 배선에만 있어 테스트가 닿지 않던 두 자리 ───────────────────────────

describe('WorkUnitCollector — 배선 두 자리', () => {
  // EG §42-3 의 오귀속 방지가 이 연결에 걸려 있다. 작업 중에 남이 옮긴 저장소를 **겪은** 것은 그
  // Unit 에 남기되(EG §27 — "겪었다"이지 "만들었다"가 아니다), 그 변경이 들여온 파일이 Unit 의
  // 관찰된 변경 목록으로 섞이면 안 된다. 섞이면 다음 계획의 해석기가 남의 작업을 이 Unit 의
  // 것으로 읽는다.
  it('작업 중의 외부 변경은 id 로만 Unit 에 담긴다 — 그 파일 목록은 섞이지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    fake.git.files = ['src/mine.ts'] // 이 세션이 만지고 있는 파일
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('작업 하나'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    collector.onGitChanged() // 기준선
    await collector.flush()

    // 남이 pull 했다 — 그 구간이 들여온 파일은 이 Unit 이 만든 것이 아니다
    fake.git.range = { commits: ['c1'], changedFiles: ['vendor/pulled.ts'] }
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.units[0].encounteredExternalGitChangeIds).toEqual([state.externalGitChanges[0].id])
    expect(state.units[0].git.observedChangedFiles).toEqual(['src/mine.ts'])
  })

  // WU §23 unit 8 의 배선. 순수 함수(completion.ts 의 onSessionEnd)는 그쪽 테스트가 덮지만,
  // 세션 종료가 그 함수까지 닿아 Unit 을 닫는지는 이 자리 말고는 볼 데가 없다.
  it('세션이 끝나면 열린 Unit 이 닫힌다 — 관찰된 변경이 없었으면 abandoned', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('아무것도 바꾸지 못한 작업'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units[0].status).toBe('active')

    fake.sessions = [] // 끝난 세션은 listSessions 에서 이미 빠져 있다
    await collector.onSessionExit('s1')

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('abandoned') // 관찰된 변경이 없었다
    expect(state.units[0].completedAt).toBeDefined()
    expect(state.cursors).toHaveLength(0) // 더 자랄 파일을 가리키지 않는 커서는 지운다
  })
})
