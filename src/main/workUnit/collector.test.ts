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
import type { SessionWorkUnit } from '../../core/workUnit/types'

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
    range: { commits: string[]; changedFiles: string[]; authors?: string[] }
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
  file = storeFile,
  watchGit?: (projectPath: string) => Promise<(() => Promise<void>) | null>
): Promise<{ collector: WorkUnitCollector; store: WorkUnitStore; closed: SessionWorkUnit[] }> {
  const store = new WorkUnitStore(file)
  await store.load()
  // 하류(설명 생성)로 나가는 알림. 여기에 들어오는 Unit 하나가 에이전트 왕복 하나다
  const closed: SessionWorkUnit[] = []
  // 자기 참조다 — pendingGitOps 는 collector 자신의 등록 목록을 그대로 돌려준다. ipc.ts 가
  // workUnitCollector 를 wiring 하는 것과 같은 자리, 같은 이유다.
  const collector: WorkUnitCollector = new WorkUnitCollector({
    store,
    listSessions: async () => fake.sessions,
    git: fake.git,
    now: () => fake.clock,
    pendingGitOps: () => collector.getPendingGitOps(),
    watchGit,
    onUnitClosed: (_p, u) => closed.push(u)
  })
  return { collector, store, closed }
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
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('로그인 기능 만들어줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    // 이 세션은 커밋을 한 번도 만들지 않는다 — HEAD 는 처음부터 끝까지 c0 이다.
    // 바뀌는 것은 작업 트리뿐이고, **Unit 이 열린 뒤에** 바뀐다 — 열릴 때 잡는 기준선 너머의
    // 변경만 그 Unit 의 관찰이다
    fake.git.files = ['src/login.ts']
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

    // 에이전트가 그 요청을 받아 한 턴을 돈다 — 아래 세 커밋은 **이 세션이 만드는 것이다**
    collector.onSessionBusy('s1', projectPath, true)

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
    // **이 테스트의 이름이 말하는 것을 코드도 말해야 한다.** 이 커밋들은 이 세션의 것이고, 남이
    // 옮긴 저장소가 아니다. 외부 변경으로 기록되면 그 id 가 이 Unit 에 "겪은 것"으로 달리고,
    // 다음 계획이 그 집합을 성과에서 빼면서 이 Unit 이 실제로 한 일을 지운다.
    expect(state.externalGitChanges).toEqual([])
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
    const first = await makeCollector(fake)
    await first.collector.start()
    await fs.appendFile(transcript, human('첫 작업'), 'utf8')
    first.collector.onTranscriptChanged()
    await first.collector.flush()
    fake.git.files = ['src/a.ts'] // Unit 이 연 뒤의 변경이어야 관찰로 세어 유휴가 완료 후보를 만든다
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

  // 바로 위 테스트와 같은 자리, 같은 이유다 — readRange 가 낸 author 목록이 실제로 기록까지
  // threading 되는지는 이 자리 말고는 볼 데가 없다(gitProbe.test.ts 는 readRange 자신만 본다).
  // 그리고 **커밋과 같은 조건으로 버리는지**를 함께 본다: `git log before..after` 에서 온 값이라
  // fast-forward 밖에서는 커밋과 마찬가지로 뜻이 없다(EG §6·§7).
  it('fast-forward 의 author 는 저장되고, 브랜치 전환의 author 는 버려진다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선 (main, c0)
    await collector.flush()

    fake.git.range = { commits: ['c1'], changedFiles: ['pulled.ts'], authors: ['Kim', 'Lee'] }
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    // HEAD 까지 옮긴 브랜치 전환 — 같은 range 를 돌려받아도 이름은 남지 않아야 한다
    fake.git.ref = { branch: 'feature', head: 'c2' }
    fake.git.ancestor = false
    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(2)
    expect(state.externalGitChanges[0].type).toBe('fast-forward')
    expect(state.externalGitChanges[0].authors).toEqual(['Kim', 'Lee'])
    expect(state.externalGitChanges[1].type).toBe('branch-switch')
    expect(state.externalGitChanges[1].authors).toEqual([])
    // 파일 목록은 두 트리의 비교라 브랜치 전환에서도 남는다 — 함께 버려지지 않았음을 못박는다
    expect(state.externalGitChanges[1].changedFiles).toEqual(['pulled.ts'])
  })

  // 브랜치만 갈아타 HEAD 가 그대로면 견줄 트리가 하나뿐이라 범위를 아예 묻지 않는다.
  // fake.git.range 를 채워 둬도 이 기록에는 그것이 새지 않아야 한다 — readRange 를 부르지
  // 않았다는 것의 관찰 가능한 증거다. (HEAD 까지 움직인 브랜치 전환은 바로 아래 테스트가 본다.)
  it('HEAD 가 그대로인 브랜치 전환에는 범위를 묻지 않는다 — 둘 다 빈다', async () => {
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

// ── 에이전트가 도는 동안의 HEAD 이동 (task 17) ──────────────────────────

// 브랜치 전체 리뷰가 찾은 자리다. Astera 가 직접 돌린 동작만 원장에 있으니, **세션의 에이전트가
// 터미널에 친 커밋**은 그 목록에 없어 외부 변경으로 기록되고 그 id 가 방금 그 커밋을 만든 Unit 에
// "겪은 것"으로 달렸다. 다음 계획이 그 집합을 Unit 의 성과에서 빼도록 명세돼 있어, 그대로 두면
// 그 Unit 이 실제로 한 일이 지워진다.
describe('WorkUnitCollector — 세션이 바쁜 동안의 HEAD 이동', () => {
  it('세션이 바쁜 동안 옮겨진 HEAD 는 외부 변경이 아니다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선 (main, c0)
    await collector.flush()

    // 에이전트가 한 턴을 시작한다 — 그 안에서 커밋한다
    collector.onSessionBusy('s1', projectPath, true)
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    expect(store.get(projectPath)!.externalGitChanges).toEqual([])
  })

  // 실제 배선의 순서가 이것이다: 감시자의 awaitWriteFinish 와 수집기의 디바운스 때문에 `.git`
  // 회차는 busy → false 보다 **뒤에** 온다. 유예가 없으면 이 자리가 전부 오판된다 —
  // OPERATION_GRACE_MS 가 job-merge 에 있어야 하는 이유와 같은 이유, 같은 폭이다.
  it('바쁜 구간이 끝난 직후의 이동도 유예 안에서는 그 세션의 것이다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선
    await collector.flush()

    collector.onSessionBusy('s1', projectPath, true)
    await collector.onSessionIdle('s1')
    fake.clock += OPERATION_GRACE_MS - 1 // 아직 유예 안이다

    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    expect(store.get(projectPath)!.externalGitChanges).toEqual([])
  })

  it('바쁜 구간이 끝나고 유예가 지난 뒤의 이동은 외부다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선
    await collector.flush()

    collector.onSessionBusy('s1', projectPath, true)
    await collector.onSessionIdle('s1')
    fake.clock += OPERATION_GRACE_MS + 1 // 유예 너머 — 이 이동은 그 턴의 것이 아니다

    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    expect(store.get(projectPath)!.externalGitChanges).toHaveLength(1)
  })

  // **끝나지 않은 등록은 그 프로젝트의 모든 외부 변경을 조용히 삼킨다** — endGitOperation 의
  // 주석이 "지어낸 외부 기록 하나보다 훨씬 나쁜 실패"라고 적어 둔 그것이다. 바쁜 채로 죽은 세션은
  // 유휴 신호를 영영 보내지 않으므로, 종료가 그 자리를 대신 닫아야 한다.
  it('바쁜 채로 끝난 세션의 등록도 닫힌다 — 외부 변경을 영영 삼키지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선
    await collector.flush()

    collector.onSessionBusy('s1', projectPath, true)
    await collector.onSessionExit('s1')
    fake.clock += OPERATION_GRACE_MS + 1

    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    expect(store.get(projectPath)!.externalGitChanges).toHaveLength(1)
  })

  // **codex 의 창 제목은 장식이다** (`ProviderDescriptor.busyTitleReliable` 이 false 인 이유가 그
  // 선언 자리에 실측으로 적혀 있다). 스피너가 초당 열 프레임쯤 흐르고 **턴이 끝난 뒤에도 계속
  // 흐르며**, codex 가 띄운 자식 프로세스들이 그 제목을 제 것으로 덮어쓴다. 그래서 앱은 그 세션이
  // 초당 여러 번 일했다 쉬었다 하는 것으로 본다.
  //
  // rising edge 마다 유예를 새로 열면, 다음 edge 가 유예보다 빨리 오므로 **그 프로젝트는 세션이
  // 사는 동안 영구 사면 상태가 된다** — 마지막에 찍힌 것이 스피너면 닫히는 자리조차 오지 않는다.
  // 그 사이 남이 pull 하든 rebase 하든 한 줄도 적히지 않는다. `externalGitChanges` 는 **프로젝트**
  // 단위라 피해가 codex 세션에 머물지도 않는다: 같은 cwd 를 쓰는 claude 세션의 Unit 이 겪은 기록도
  // 함께 사라진다. `endGitOperation` 의 주석이 "훨씬 나쁜 실패"라고 부른 바로 그것이다.
  it('busy 신호를 믿을 수 없는 세션은 그 프로젝트의 외부 변경을 가리지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session({ idleSignalTrusted: false })]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 기준선
    await collector.flush()

    // 깜빡임. 유휴는 오지 않는다 — 마지막에 찍힌 것이 스피너인 경우다
    for (let i = 0; i < 5; i++) {
      collector.onSessionBusy('s1', projectPath, false)
      fake.clock += 100
    }
    fake.clock += OPERATION_GRACE_MS * 1000 // 열린 등록은 아무리 지나도 만료되지 않는다

    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    expect(store.get(projectPath)!.externalGitChanges).toHaveLength(1)
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
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('켜져 있는 동안의 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units[0].status).toBe('active')
    fake.git.files = ['src/a.ts'] // 이 Unit 이 연 뒤의 변경 — 끌 때 completed 로 닫히는 근거다

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

  // **끄기는 지갑을 열지 않는다.** 열려 있던 Unit 은 completed 로 닫히지만(위 테스트), 그 하나하나가
  // 하류의 에이전트 왕복이 되면 "이제 그만 추적하겠다"고 누른 그 순간에 프로젝트 수만큼의 왕복이
  // 시작된다 — 사용자가 산 것과 정반대이고, 그 왕복은 시간과 사용량을 실제로 쓴다.
  it('기능을 끄며 닫힌 Unit 은 설명 생성으로 흘러가지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()
    await fs.appendFile(transcript, human('끄기 직전의 요청'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    fake.git.files = ['src/a.ts'] // 이것이 있어야 completed 로 닫힌다

    await collector.onEnabledChanged(false)

    expect(store.get(projectPath)!.units[0].status).toBe('completed') // 기록으로는 남는다
    expect(closed).toHaveLength(0) // 그러나 아무것도 생성하지 않는다
  })

  // 위의 가드가 헛돌지 않는지 — 평소에는 알림이 실제로 나가야 한다
  it('평소에 닫힌 Unit 은 설명 생성으로 흘러간다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, closed } = await makeCollector(fake)
    await collector.start()
    await fs.appendFile(transcript, human('첫 작업'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    fake.git.files = ['src/a.ts']
    await collector.onSessionIdle('s1')

    await fs.appendFile(transcript, human('다음 작업'), 'utf8') // 이 요청이 앞 Unit 을 확정한다
    collector.onTranscriptChanged()
    await collector.flush()

    expect(closed).toHaveLength(1)
    expect(closed[0].title).toBe('첫 작업')
    expect(closed[0].status).toBe('completed')
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
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('작업 하나'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    fake.git.files = ['src/mine.ts'] // 이 세션이 (Unit 을 연 뒤에) 만지고 있는 파일

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

  // **그 반대쪽.** 재시작 직후 사람이 `.git` 이벤트보다 먼저 말을 걸면 그 Unit 은 **이미 옮겨진
  // HEAD 에서** 열린다(startHead = c1). 그 뒤 첫 회차가 꺼져 있던 동안의 이동을 잡아도 그 변화는
  // 이 Unit 이 생기기 전에 끝난 일이다 — EG §27 의 "겪었다"가 아니다.
  it('꺼져 있던 동안의 변경은 그 뒤에 열린 Unit 에 달리지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const first = await makeCollector(fake)
    await first.collector.start()
    first.collector.onGitChanged() // 마지막으로 안 상태 — main, c0
    await first.collector.flush()

    // 앱이 꺼져 있는 사이의 pull
    fake.git.ref = { branch: 'main', head: 'c1' }

    const second = await makeCollector(fake)
    await second.collector.start()

    // `.git` 이벤트보다 사람의 말이 먼저 온다
    await fs.appendFile(transcript, human('다시 켠 뒤 첫 요청'), 'utf8')
    second.collector.onTranscriptChanged()
    await second.collector.flush()
    expect(second.store.get(projectPath)!.units[0].git.startHead).toBe('c1') // 옮겨진 자리에서 열렸다

    second.collector.onGitChanged()
    await second.collector.flush()

    const state = second.store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1) // 변경 자체는 잡힌다 — 놓치지 않는다
    expect(state.units[0].encounteredExternalGitChangeIds).toEqual([])
  })

  // **가르는 줄에는 틀릴 수 있는 방향이 둘 있다.** `gitRound` 의
  // `open.filter((u) => (u.git.endHead ?? u.git.startHead) === before.head)` 가 **넓어지면** 겪지도
  // 않은 Unit 에 남의 변경이 달리고, **좁아지면** 실제로 겪은 Unit 이 그것을 못 받는다.
  //
  // 위 둘이 한 갈래씩 이미 맡고 있다 — 넓어지는 쪽은 `꺼져 있던 동안의 변경은 …` 이 막고(빈
  // 목록을 단언한다), 좁아지는 쪽은 `작업 중의 외부 변경은 …` 이 막는다. 뒤엣것은 기준선 회차가
  // 일찍 빠져나가 그 Unit 의 `endHead` 가 비어 있는 채로 필터에 닿으므로 **`?? startHead` 되짚음을
  // 이미 지난다** — 그 되짚음을 지우면 저 테스트가 함께 깨진다. 즉 좁아지는 갈래가 통째로 탐침
  // 뿐이었던 것은 아니다.
  //
  // **덮이지 않던 것은 그 갈래의 두 경로다.** 재시작을 건너뛴 되살림(아래 첫째)과 한 Unit 위로
  // 회차가 거듭될 때의 `endHead` 전진(아래 둘째) — 이 둘만이 임시 탐침으로 확인하고 지운 자리였다.

  // **좁아지는 갈래 (1) — `?? u.git.startHead`.** 앱이 강제로 꺼지면 열린 Unit 은 `endHead` 가
  // 없는 채로 디스크에 남는다(정상 종료의 onSessionExit 를 못 거쳤다). 그 Unit 이 앉아 있는 자리는
  // 마지막 회차의 head 이고 그것은 저장된 스냅샷의 head 와 같으므로, 다시 켠 첫 회차가 잡는 변경은
  // 이 Unit 이 **겪은** 것이 맞다(EG §27). 되짚음이 `endHead` 만 본다면 이 Unit 은 조용히 빠진다.
  it('강제 종료로 endHead 가 비어 있던 Unit 도 다시 켠 뒤의 외부 변경을 받는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const first = await makeCollector(fake)
    await first.collector.start()

    // 열린 Unit 하나. HEAD 는 c0 이고 아직 어떤 회차도 endHead 를 채우지 않았다
    await fs.appendFile(transcript, human('꺼지기 전에 시작한 작업'), 'utf8')
    first.collector.onTranscriptChanged()
    await first.collector.flush()
    first.collector.onGitChanged() // 기준선 — 스냅샷이 c0 으로 남는다
    await first.collector.flush()

    const before = first.store.get(projectPath)!
    expect(before.units[0].git.startHead).toBe('c0')
    expect(before.units[0].git.endHead).toBeUndefined() // 강제 종료가 남기는 모양 그대로다
    expect(before.units[0].status).toBe('active')

    // 앱이 강제로 꺼진다 — onSessionExit 도 stop 도 부르지 않고 수집기를 그냥 버린다
    fake.git.range = { commits: ['c1'], changedFiles: ['pulled.ts'] }
    fake.git.ref = { branch: 'main', head: 'c1' }

    const second = await makeCollector(fake)
    await second.collector.start()
    second.collector.onGitChanged()
    await second.collector.flush()

    const state = second.store.get(projectPath)!
    expect(state.units).toHaveLength(1) // 같은 Unit 이다 — 다시 열린 것이 아니다
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.units[0].encounteredExternalGitChangeIds).toEqual([state.externalGitChanges[0].id])
    // 그 변경이 들여온 파일은 여전히 이 Unit 이 만든 것이 아니다
    expect(state.units[0].git.observedChangedFiles).toEqual([])
  })

  // **좁아지는 갈래 (2) — 회차마다 `endHead` 를 전진시키는 것.** 한 Unit 이 열려 있는 동안 남이
  // 두 번 저장소를 옮기면 둘 다 그 Unit 이 겪은 것이다. 매 회차 `endHead` 가 after.head 로
  // 전진하므로 다음 회차의 before.head 와 계속 맞는다 — 전진이 없으면 둘째부터 조용히 빠진다.
  it('연속된 두 외부 변경이 열린 Unit 하나에 모두 달린다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('작업 하나'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    collector.onGitChanged() // 기준선 (main, c0)
    await collector.flush()

    fake.git.range = { commits: ['c1'], changedFiles: ['first.ts'] }
    fake.git.ref = { branch: 'main', head: 'c1' } // 남의 pull 하나
    collector.onGitChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units[0].git.endHead).toBe('c1') // 전진했다

    fake.git.range = { commits: ['c2'], changedFiles: ['second.ts'] }
    fake.git.ref = { branch: 'main', head: 'c2' } // 이어서 또 하나
    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.externalGitChanges).toHaveLength(2)
    expect(state.units[0].encounteredExternalGitChangeIds).toEqual([
      state.externalGitChanges[0].id,
      state.externalGitChanges[1].id
    ])
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

// ── 수집기 자신의 `.git` 감시자 (task 17) ──────────────────────────────

// 지금까지 `.git` 방아쇠는 **탐색기 패널이 열려 있을 때만** 살아 있었다 — 그 감시자를 여닫는 것은
// 렌더러의 useGitStatus 이고, 사이드바를 Jobs 로 바꾸면 git.unwatch 가 불려 수집기는 그 순간부터
// git 이벤트를 하나도 받지 못했다(외부 변경도, 스냅샷 전진도, 새 Unit 의 startHead 도).
// 트랜스크립트 쪽처럼 상시가 되려면 수명이 수집기의 start()/stop() 에 걸려야 한다.
describe('WorkUnitCollector — 자기 git 감시자', () => {
  /** 감시 요청과 닫기만 적는 가짜. 진짜 GitWatcher(chokidar)는 여기까지 오지 않는다 —
   *  만드는 일을 주입으로 남긴 이유가 이것이다 */
  const spyWatcher = (): {
    watched: string[]
    closed: string[]
    watchGit: (p: string) => Promise<(() => Promise<void>) | null>
  } => {
    const watched: string[] = []
    const closed: string[] = []
    return {
      watched,
      closed,
      watchGit: async (p: string) => {
        watched.push(p)
        return async () => {
          closed.push(p)
        }
      }
    }
  }

  it('켜면 세션의 프로젝트를 보고, 끄면 닫는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const spy = spyWatcher()
    const { collector } = await makeCollector(fake, storeFile, spy.watchGit)

    expect(spy.watched).toEqual([]) // 토글이 꺼져 있으면 띄우지 않는다

    await collector.start()
    expect(spy.watched).toEqual([projectPath])

    await collector.flush() // 회차가 더 돌아도 같은 프로젝트를 두 번 열지 않는다
    expect(spy.watched).toEqual([projectPath])

    await collector.stop()
    expect(spy.closed).toEqual([projectPath])
  })

  it('세션이 사라진 프로젝트의 감시자는 닫는다', async () => {
    const fake = makeFake()
    const other = path.join(dir, 'other')
    fake.sessions = [
      session(),
      session({ sessionId: 's2', projectPath: other, transcriptPath: null })
    ]
    const spy = spyWatcher()
    const { collector } = await makeCollector(fake, storeFile, spy.watchGit)
    await collector.start()
    expect([...spy.watched].sort()).toEqual([other, projectPath].sort())

    fake.sessions = [session()] // s2 가 끝났다 — 그 프로젝트에는 볼 세션이 남지 않았다
    await collector.flush()
    expect(spy.closed).toEqual([other])
  })

  // **끄는 회차의 저장이 실패해도 감시자는 닫혀야 한다.** closeAll 은 프로젝트마다 저장하는데,
  // 저장소의 쓰기는 실패하면 거절하고(store.ts) 그 거절을 회차 큐가 삼켜 로그만 남긴다. 처분이
  // 그 루프 **뒤에** 있으면 한 번의 쓰기 실패로 감시자가 전부 살아남아, 추적이 꺼진 채로 계속
  // 수집기를 두드린다 — closeAll 의 주석이 그러지 않는다고 약속한 바로 그것이다.
  it('저장이 실패해도 감시자는 닫힌다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const spy = spyWatcher()
    const { collector, store } = await makeCollector(fake, storeFile, spy.watchGit)
    await collector.start()
    expect(spy.watched).toEqual([projectPath])

    store.set = async () => {
      throw new Error('쓰기 실패') // 디스크가 찼거나 rename 이 실패했다
    }
    await collector.stop()

    expect(spy.closed).toEqual([projectPath])
  })

  // 아직 저장소가 아닌 프로젝트에서는 볼 것이 없다 — `GitWatcher` 는 던지지 않고 조용히 아무것도
  // 보지 않는다. 그때 자리를 잡아 버리면 그 키가 남아, 나중에 그 프로젝트에서 `git init` 을 해도
  // 토글이나 앱을 다시 돌리기 전까지 영영 감시되지 않는다.
  it('아직 저장소가 아닌 프로젝트는 자리를 잡지 않는다 — git init 뒤 다음 회차가 다시 본다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    let isRepo = false
    const watched: string[] = []
    const watchGit = async (p: string): Promise<(() => Promise<void>) | null> => {
      if (!isRepo) return null // 볼 것이 없었다
      watched.push(p)
      return async () => {}
    }
    const { collector } = await makeCollector(fake, storeFile, watchGit)
    await collector.start()
    expect(watched).toEqual([])

    isRepo = true // git init
    await collector.flush()
    expect(watched).toEqual([projectPath])
  })
})

// ── 열릴 때의 기준선 (설계 §6 "git 스냅샷 비교", §7 의 WU §4.5 근사) ──────
//
// 관찰이 "작업 트리 전체의 더러움"이면 앞 Unit 이 커밋하지 않고 남긴 파일이 다음 Unit 에도 세어져,
// 파일을 하나도 안 바꾼 질문 Unit 이 completed 로 확정돼 하류로 흐른다. 세션이 커밋 없이 진행되는
// 것이 보통이므로 이것은 가장자리가 아니라 두 번째 Unit 부터의 모든 Unit 이다.

describe('WorkUnitCollector — 열릴 때의 기준선', () => {
  it('앞 Unit 이 남긴 더러움은 다음 Unit 의 개수에 세지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    // Unit A — 파일 셋을 바꾸고 완료 후보가 된다
    await fs.appendFile(transcript, human('기능 만들어줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    fake.git.files = ['a.ts', 'b.ts', 'c.ts']
    await collector.onSessionIdle('s1')
    expect(store.get(projectPath)!.units[0].status).toBe('completed-candidate')

    // Unit B — 질문만 한다. 작업 트리는 A 가 남긴 그대로다(커밋하지 않았다)
    await fs.appendFile(transcript, human('왜 이렇게 구현했어?'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    await collector.onSessionIdle('s1')

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[0].status).toBe('completed') // A 는 B 의 도착이 확정했다
    // B 는 아무것도 바꾸지 않았다 — A 의 더러움이 세어졌다면 여기가 completed-candidate 가 된다
    expect(state.units[1].status).toBe('active')
    expect(state.units[1].git.observedChangedFiles).toEqual([])
  })

  it('기준선 너머의 진짜 변경은 완료 후보를 만든다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    // 열리기 전부터 더러웠던 파일 둘
    fake.git.files = ['left-over.ts', 'stale.ts']
    await fs.appendFile(transcript, human('버그 고쳐줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    // 이 Unit 의 작업이 새 파일 하나를 더한다
    fake.git.files = ['left-over.ts', 'stale.ts', 'fixed.ts']
    await collector.onSessionIdle('s1')

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('completed-candidate')
    expect(state.units[0].git.observedChangedFiles).toEqual(['fixed.ts'])
  })

  it('질문만 한 Unit 은 세션이 끝날 때 abandoned 다 (설계 §7)', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    // 세션이 시작하기 전부터 작업 트리가 더럽다 — 이 더러움은 누구의 관찰도 아니다
    fake.git.files = ['dirty-before.ts']
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('이 코드 뭐 하는 거야?'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    await collector.onSessionExit('s1')

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('abandoned')
  })
})

// ── 쓰지 않을 답은 git 에게 묻지 않는다 (transition.ts 의 갈래 순서) ──────

describe('WorkUnitCollector — isAncestor 를 묻는 조건', () => {
  it('전이가 없거나 브랜치가 바뀐 회차에는 묻지 않고, 같은 브랜치에서 head 가 움직였을 때만 묻는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    let asks = 0
    fake.git.isAncestor = async () => {
      asks += 1
      return fake.git.ancestor
    }
    const { collector } = await makeCollector(fake)
    await collector.start()

    collector.onGitChanged() // 처음 본 저장소 — 기준선만 잡는다, 견줄 앞이 없다
    await collector.flush()
    collector.onGitChanged() // 아무것도 안 움직였다 — none, 조상 답은 읽히지 않는다
    await collector.flush()
    fake.git.ref = { branch: 'feature', head: 'c0' } // 브랜치 전환 — 조상 답은 읽히지 않는다
    collector.onGitChanged()
    await collector.flush()
    expect(asks).toBe(0)

    fake.git.ref = { branch: 'feature', head: 'c1' } // 같은 브랜치에서 head 이동 — 이때만 묻는다
    collector.onGitChanged()
    await collector.flush()
    expect(asks).toBe(1)
  })
})

// ── codex 세션 ─────────────────────────────────────────────────────────
//
// codex 는 창 제목의 유휴 신호를 믿을 수 없다(busyTitleReliable=false). 대신 rollout 이 턴마다
// `task_complete` 를 적으므로 그것을 유휴로 읽는다 — 추측이 아니라 codex 자신이 쓴 신호다.

/** codex rollout 의 사람 메시지 한 줄 */
const codexHuman = (text: string, at = '2026-08-30T00:00:00.000Z'): string =>
  JSON.stringify({
    timestamp: at,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: 't1', content_item_kinds: ['user.text'] }
    }
  }) + '\n'

/** 재개 되쓰기 — 지난 대화를 user.text 조각 여럿으로 묶어 한 레코드에 넣는다 */
const codexReplay = (): string =>
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'The following is the Codex agent history…' }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: Array(12).fill('user.text')
      }
    }
  }) + '\n'

/** codex 가 턴을 끝냈다고 적는 줄 */
const codexTurnComplete = (): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }) + '\n'

describe('WorkUnitCollector — codex', () => {
  it('codex 세션도 사람의 요청으로 Unit 을 연다', async () => {
    const fake = makeFake()
    // codex 는 유휴 신호를 믿을 수 없다 — 그런데도 Unit 이 서야 한다
    fake.sessions = [session({ idleSignalTrusted: false })]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexHuman('로그인 고쳐줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].title).toBe('로그인 고쳐줘')
    expect(state.units[0].status).toBe('active')
  })

  // **이것이 새면 켜기 전의 대화가 Unit 이 된다** (스펙 §16.1)
  it('재개 되쓰기와 주입은 Unit 을 열지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session({ idleSignalTrusted: false })]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexReplay(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    expect(store.get(projectPath)?.units ?? []).toHaveLength(0)
  })

  // claude 라면 session:busy 의 유휴 전환이 하는 일을, codex 는 기록 안에서 한다
  it('task_complete 가 유휴 판정을 대신한다 — 바뀐 것이 있으면 완료 후보가 된다', async () => {
    const fake = makeFake()
    fake.sessions = [session({ idleSignalTrusted: false })]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexHuman('버그 고쳐줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units[0].status).toBe('active')

    // 에이전트가 파일을 고치고 턴을 끝냈다
    fake.git.files = ['src/fixed.ts']
    await fs.appendFile(transcript, codexTurnComplete(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('completed-candidate')
    expect(state.units[0].git.observedChangedFiles).toEqual(['src/fixed.ts'])
  })

  it('바뀐 것이 없으면 턴이 끝나도 진행 중이다 — 질문만 한 턴이다', async () => {
    const fake = makeFake()
    fake.sessions = [session({ idleSignalTrusted: false })]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexHuman('이 코드 뭐야?') + codexTurnComplete(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    expect(store.get(projectPath)!.units[0].status).toBe('active')
  })
})
