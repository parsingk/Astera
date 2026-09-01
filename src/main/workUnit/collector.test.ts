// The collector no longer guesses where a session task ends — it records declarations
// (`startTask`/`completeTask`/`cancelTask`) — so this file lost every test that used to drive a
// unit open/closed/appended through a transcript message or a turn ending. What is left: the
// declaration methods themselves, and everything about git/session bookkeeping that never
// depended on that guessing (EG §26 registration, busy-turn HEAD attribution, the saved git
// snapshot, the collector's own `.git` watcher). The last two tests in the declarations describe
// are the regression guard for the whole plan: a human request line and a codex `task_complete`
// line must not move a unit at all.
//
// **감시자를 띄우지 않는다.** 수집기는 의존을 밖에서 받고 방아쇠를 메서드로 노출하므로, 진짜
// 트랜스크립트 파일을 임시 디렉터리에 쓰고 그 메서드를 직접 부르면 전부 확인된다. 디바운스는
// `flush()` 로 건너뛴다 — 테스트가 150ms 를 기다리지 않게 하려고 남겨 둔 길이다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkUnitStore } from './store'
import {
  WorkUnitCollector,
  type CollectorDeps,
  type CollectorGit,
  type CollectorSession
} from './collector'
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

/** The session wrote something. A unit closes as a record only when its own transcript shows this
 *  (SessionWorkUnit.sawWrite) — observed git changes land on every open unit and so cannot say which
 *  session made them. Most fixtures below pair a request with this, because that is what a session
 *  that did any work looks like. */
const wrote = (tool = 'Edit'): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: tool, input: {} }] }
  }) + '\n'

/** The line codex writes to say a turn ended, by itself — codex's own regression guard uses this */
const codexTurnComplete = (): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }) + '\n'

/** A claude goal boundary — the `goal_status` attachment measured in spec §3.1 */
const claudeGoal = (a: Record<string, unknown>): string =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'goal_status', ...a } }) + '\n'

/** A codex goal boundary — the `thread_goal_updated` event measured in spec §3.2 */
const codexGoal = (status: string, objective = 'rpg 게임을 만들어줘'): string =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'thread_goal_updated',
      goal: { objective, status, tokensUsed: 0, timeUsedSeconds: 0 }
    }
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
  watchGit?: (projectPath: string) => Promise<(() => Promise<void>) | null>,
  extra: Partial<CollectorDeps> = {}
): Promise<{
  collector: WorkUnitCollector
  store: WorkUnitStore
  closed: SessionWorkUnit[]
  tasksChanged: string[]
  ignored: { projectPath: string; objective: string }[]
}> {
  const store = new WorkUnitStore(file)
  await store.load()
  // 하류(설명 생성)로 나가는 알림. 여기에 들어오는 Unit 하나가 에이전트 왕복 하나다
  const closed: SessionWorkUnit[] = []
  // The screen's redraw signal (Item 9). How many times a project path lands here, and in what
  // order, is exactly how many times the screen had to re-read.
  const tasksChanged: string[] = []
  // A goal arrived while a unit was already open — see onGoalIgnored's own doc for why it fires.
  const ignored: { projectPath: string; objective: string }[] = []
  // 자기 참조다 — pendingGitOps 는 collector 자신의 등록 목록을 그대로 돌려준다. ipc.ts 가
  // workUnitCollector 를 wiring 하는 것과 같은 자리, 같은 이유다.
  const collector: WorkUnitCollector = new WorkUnitCollector({
    store,
    listSessions: async () => fake.sessions,
    git: fake.git,
    now: () => fake.clock,
    pendingGitOps: () => collector.getPendingGitOps(),
    watchGit,
    onUnitClosed: (_p, u) => closed.push(u),
    onTasksChanged: (p) => tasksChanged.push(p),
    onGoalIgnored: (p, objective) => ignored.push({ projectPath: p, objective }),
    ...extra
  })
  return { collector, store, closed, tasksChanged, ignored }
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

// ── Opened and closed by declaration (task 1) ─────────────────────────

describe('WorkUnitCollector — 선언으로 여닫는다', () => {
  it('startTask 가 목표를 든 Unit 을 연다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    const result = await collector.startTask('s1', '  로그인 기능 만들어줘  ')
    expect(result.ok).toBe(true)

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].objective).toBe('로그인 기능 만들어줘')
    expect(state.units[0].status).toBe('active')
    expect(state.units[0].git.startHead).toBe('c0')
  })

  it('startTask 는 열려 있던 Unit 을 중단으로 밀어 놓는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    const first = await collector.startTask('s1', '첫 작업')
    if (!first.ok) throw new Error('unexpected')
    const second = await collector.startTask('s1', '두 번째 작업')
    if (!second.ok) throw new Error('unexpected')
    expect(second.interruptedId).toBe(first.id)

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[0].status).toBe('interrupted')
    expect(state.units[0].reason).toBe('INTERRUPTED_BY_NEW_TASK')
    expect(state.units[1].status).toBe('active')
  })

  // **Two regressions pinned by one scenario.** Before the transcript-catchup fix, `startTask`'s
  // interrupt branch did not catch up the transcript first, so a write-evidence line already
  // sitting in the file at interrupt time was read on a later round and credited to whichever unit
  // happened to be open then — the newly started one, not the one that actually made the change.
  // The unit that did the real work carried no sawWrite of its own, and completing it later dropped
  // it in `finish`.
  //
  // Fixing that exposed a second gap (coordinator follow-up on Critical 1): `onSessionExit` and
  // `closeAll` both take a live `changedFiles()` look immediately before interrupting, but
  // `startTask`'s new-task branch did not — it only ran `catchUpTranscripts()`. That was harmless
  // while `finish` only checked `sawWrite`. Once it also drops a unit with no observed changed
  // files, a real edit already sitting in the working tree — but not yet seen by a `.git` round,
  // which is debounced up to ~1s — froze the interrupted unit at zero observed files forever
  // (`observe` never touches anything but `active`). This test's fixture reaches exactly that state
  // (`fake.git.files` is set but no `onGitChanged`/`flush` ever runs before the interrupt), so it
  // now also pins that `startTask` takes its own live look.
  it('startTask 는 중단하기 전에 밀린 트랜스크립트와 git 상태를 먼저 따라잡는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    const first = await collector.startTask('s1', '첫 작업')
    if (!first.ok) throw new Error('unexpected')
    // The first task's write-evidence line is written to the file, but the debounced watcher has
    // not read it yet — onTranscriptChanged()/flush() are deliberately not called
    await fs.appendFile(transcript, wrote(), 'utf8')
    // Likewise, a real edit sits in the working tree but no `.git` round has looked yet — no
    // onGitChanged()/flush() either
    fake.git.files = ['src/first.ts']

    const second = await collector.startTask('s1', '두 번째 작업')
    if (!second.ok) throw new Error('unexpected')
    expect(second.interruptedId).toBe(first.id)

    const result = await collector.completeTaskById(projectPath, first.id)
    expect(result.ok).toBe(true)

    const state = store.get(projectPath)!
    const firstUnit = state.units.find((u) => u.id === first.id)
    // Not dropped — sawWrite was caught before the interrupt, and the interrupt itself took a live
    // look at the changed files (both regressions this test guards)
    expect(firstUnit).toBeDefined()
    expect(firstUnit!.status).toBe('completed')
    expect(closed.some((u) => u.id === first.id)).toBe(true)

    const secondUnit = state.units.find((u) => u.id === second.id)!
    expect(secondUnit.sawWrite).toBeFalsy() // 두 번째 Unit 이 첫 번째의 증거를 가로채지 않았다
  })

  it('completeTask 는 열린 것이 없으면 아무것도 만들지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    const result = await collector.completeTask('s1', { source: 'agent' })
    expect(result).toEqual({ ok: false, reason: 'NO_ACTIVE_TASK' })
    expect(store.get(projectPath)?.units ?? []).toHaveLength(0)
  })

  it('completeTask 가 검사와 요약을 싣고 하류에 넘긴다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '로또 번호 뽑는 기능 만들기')
    await fs.appendFile(transcript, wrote(), 'utf8') // 이 세션이 파일을 건드렸다는 증거
    fake.git.files = ['src/lotto.ts']

    const result = await collector.completeTask('s1', {
      source: 'agent',
      checks: [{ name: 'tests', status: 'passed' }],
      summary: '6개 번호를 오름차순으로 출력한다'
    })
    expect(result.ok).toBe(true)

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].status).toBe('completed')
    expect(state.units[0].completion?.source).toBe('agent')
    expect(state.units[0].checks).toEqual([{ name: 'tests', status: 'passed' }])
    expect(state.units[0].resultSummary).toBe('6개 번호를 오름차순으로 출력한다')
    expect(closed).toHaveLength(1)
    expect(closed[0].objective).toBe('로또 번호 뽑는 기능 만들기')
  })

  it('쓰기 증거가 없는 Unit 은 완료해도 기록되지 않고 지워진다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '이 프로젝트 한 줄 설명해') // 도구를 쓰지 않는다
    fake.git.files = ['src/a.ts', 'src/b.ts'] // 옆 세션이 고친 파일들이 관찰로는 들어온다

    const result = await collector.completeTask('s1', { source: 'agent' })
    expect(result.ok).toBe(true)

    expect(store.get(projectPath)!.units).toHaveLength(0)
    expect(closed).toHaveLength(0) // 설명 생성으로도 흘러가지 않는다
  })

  // Critical 1: `sawWrite` alone is not the rule spec §12 asks for. `CLAUDE_WRITE_TOOLS`
  // (humanRequest.ts) counts `Bash`/`PowerShell`, so a session that only ran a read-only shell
  // command — `grep`, `git log`, the task-stub skill's own step-1 `echo "$ASTERA_CLI"` — sets
  // `sawWrite` true without changing a single file. This unit must still be dropped: nothing
  // changed, so there is nothing to record (spec §12 — "The person may have started a record and
  // then only talked").
  it('아무 파일도 바뀌지 않은 Unit 은 쓰기 증거가 있어도 완료해도 기록되지 않고 지워진다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '무엇이 문제인지 살펴봐줘')
    await fs.appendFile(transcript, wrote('Bash'), 'utf8') // a read-only shell command — sawWrite still turns on
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)!.units[0].sawWrite).toBe(true)
    // fake.git.files stays at its default [] — nothing changed

    const result = await collector.completeTask('s1', { source: 'agent' })
    expect(result.ok).toBe(true)

    expect(store.get(projectPath)!.units).toHaveLength(0) // sawWrite alone does not save it
    expect(closed).toHaveLength(0)
  })

  it('completeTaskById 는 중단된 것도 닫는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    const first = await collector.startTask('s1', '첫 작업')
    if (!first.ok) throw new Error('unexpected')
    await fs.appendFile(transcript, wrote(), 'utf8')
    // Critical 1's second guard needs an observed change — recorded now, while the unit is still
    // active, since `observe` never touches an already-interrupted unit (isOpen excludes it)
    fake.git.files = ['src/first.ts']
    collector.onTranscriptChanged()
    collector.onGitChanged()
    await collector.flush()
    await collector.startTask('s1', '두 번째 작업') // 첫 작업을 중단으로 민다
    expect(store.get(projectPath)!.units[0].status).toBe('interrupted')

    const result = await collector.completeTaskById(projectPath, first.id)
    expect(result.ok).toBe(true)

    const unit = store.get(projectPath)!.units.find((u) => u.id === first.id)!
    expect(unit.status).toBe('completed')
    expect(unit.completion?.source).toBe('user')
    expect(closed).toHaveLength(1)
  })

  it('cancelTask 는 하류에 넘기지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '방향을 바꾼 작업')
    const result = await collector.cancelTask('s1', '방향을 바꿨다')
    expect(result.ok).toBe(true)

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('cancelled')
    expect(state.units[0].reason).toBe('방향을 바꿨다')
    expect(state.units[0].completion).toBeUndefined()
    expect(closed).toHaveLength(0)
  })

  it('세션이 끝나면 열린 Unit 은 중단이 된다 — 완료가 아니다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '세션이 끝나기 전 작업')
    fake.sessions = [] // 끝난 세션은 listSessions 에서 이미 빠져 있다
    await collector.onSessionExit('s1')

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].status).toBe('interrupted')
    expect(state.units[0].reason).toBe('INTERRUPTED_BY_SESSION_END')
    expect(closed).toHaveLength(0)
  })

  it('추적을 끄면 열린 Unit 은 중단이 되고 하류를 깨우지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed, tasksChanged } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '추적을 끄기 전 작업')
    tasksChanged.length = 0 // clear startTask's own notification — this test wants only the off-switch one
    await collector.onEnabledChanged(false)

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('interrupted')
    expect(state.units[0].reason).toBe('INTERRUPTED_BY_TRACKING_OFF')
    expect(closed).toHaveLength(0)
    // Item 9 (final review): closeAll used to interrupt without telling the screen — it kept
    // showing a stale "in progress" row until some other event triggered a re-read.
    expect(tasksChanged).toEqual([projectPath])
  })

  it('앱을 다시 켜면 세션이 사라진 active Unit 은 중단이 된다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const first = await makeCollector(fake)
    await first.collector.start()
    await first.collector.startTask('s1', '재시작 전 작업')

    // s1 is gone, but another session (s2) remains in the same project — the common path by which
    // groupByProject(sessions) visits this project at all
    fake.sessions = [session({ sessionId: 's2' })]
    const second = await makeCollector(fake)
    await second.collector.start()

    const state = second.store.get(projectPath)!
    const orphan = state.units.find((u) => u.sessionId === 's1')!
    expect(orphan.status).toBe('interrupted')
    expect(orphan.reason).toBe('INTERRUPTED_BY_APP_RESTART')
    // Item 9 (final review): seed's restart-interrupt used to skip this notification too.
    expect(second.tasksChanged).toEqual([projectPath])
  })

  // **Regression.** If every session in this project is gone, groupByProject(sessions) never
  // visits it at all — WorkUnitStore gives no way to enumerate its keys, so seed() has to ask
  // store.projectPaths() separately to sweep such a project. Without that question, this unit
  // stays active forever in a project with no session left in it.
  it('세션이 하나도 남지 않은 프로젝트의 active Unit 도 재시작하면 중단이 된다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const first = await makeCollector(fake)
    await first.collector.start()
    await first.collector.startTask('s1', '재시작 전 작업')

    // Every session in this project is gone — only another project's session remains
    const otherProject = path.join(dir, 'other-project')
    await fs.mkdir(otherProject, { recursive: true })
    fake.sessions = [session({ sessionId: 's2', projectPath: otherProject, transcriptPath: null })]
    const second = await makeCollector(fake)
    await second.collector.start()

    const state = second.store.get(projectPath)!
    expect(state.units[0].status).toBe('interrupted')
    expect(state.units[0].reason).toBe('INTERRUPTED_BY_APP_RESTART')
    // Item 9 (final review): this is seed's *second* pass (the orphaned-project loop, a separate
    // code path from the previous test's) — it needs the same notification, not shared code that
    // would have fixed both at once.
    expect(second.tasksChanged).toEqual([projectPath])
  })

  // **Regression guard (1/2) — the whole point of this plan.** A request line the person typed
  // into the transcript no longer opens or closes a unit at all. On 2026-08-31 one feature was
  // split into two records because of this line.
  it('사용자 메시지가 와도 Unit 은 열리지도 닫히지도 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, human('로그인 기능 만들어줘'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    expect(store.get(projectPath)?.units ?? []).toHaveLength(0) // a message alone opens nothing

    await collector.startTask('s1', '선언으로 연 작업')
    await fs.appendFile(transcript, human('두 번째 메시지'), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1) // neither the count nor the status moves when a message arrives
    expect(state.units[0].status).toBe('active')
    expect(state.units[0].objective).toBe('선언으로 연 작업')
  })

  // **Regression guard (2/2).** A turn ending that codex records for itself (`task_complete`) also
  // no longer turns a unit into a completion candidate or closes it.
  it('turn 이 끝나도 Unit 은 닫히지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session({ idleSignalTrusted: false })]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', 'codex 로 연 작업')
    fake.git.files = ['src/fixed.ts']
    await fs.appendFile(transcript, codexTurnComplete(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].status).toBe('active') // 턴이 끝나도 상태는 움직이지 않는다
    expect(closed).toHaveLength(0)
  })

  it('listOpen 은 active 와 interrupted 만 돌려준다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '첫 작업')
    await collector.startTask('s1', '두 번째 작업') // 첫 작업을 중단으로 민다
    await collector.cancelTask('s1', '취소') // 두 번째 작업을 취소한다
    await collector.startTask('s1', '세 번째 작업')

    const open = collector.listOpen(projectPath)
    expect(open.map((t) => t.status).sort()).toEqual(['active', 'interrupted'])
    expect(open.find((t) => t.status === 'active')?.objective).toBe('세 번째 작업')
  })

  // Item 6 (final review): `core/types.ts` documents this as newest-first, but the store itself is
  // oldest-first (new units are pushed onto the end) — this pins the sort that makes the doc true.
  it('listOpen 은 최근에 시작한 것이 앞에 온다', async () => {
    const fake = makeFake()
    fake.sessions = [session(), session({ sessionId: 's2' })]
    const { collector } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '먼저 시작한 작업')
    fake.clock += 1000
    const second = await collector.startTask('s2', '나중에 시작한 작업')
    if (!second.ok) throw new Error('unexpected')

    const open = collector.listOpen(projectPath)
    expect(open.map((t) => t.objective)).toEqual(['나중에 시작한 작업', '먼저 시작한 작업'])
  })

  // Review fix (Task 5, round 1): ipc.ts's sessionTasks.* handlers used to fold this path through
  // understandingKeyOf before calling here, on the mistaken belief that workUnits.json is keyed the
  // same way understanding.json is. It is not — `projectPath` here is a session's raw cwd (the
  // `workUnitSessions` builder in ipc.ts sets it verbatim), and nothing in this file transforms it.
  // ipc.ts has no handler-level test harness (registerIpc wires real electron ipcMain), so this pins
  // the contract one layer down: asking with a different path — standing in for a worktree's origin
  // repo, which is what a fold would have substituted — must see nothing.
  it('listOpen 은 받은 경로 그대로 찾는다 — 접지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '워크트리에서 시작한 작업')

    expect(collector.listOpen(projectPath)).toHaveLength(1)
    expect(collector.listOpen(path.join(dir, 'not-the-same-project'))).toEqual([])
  })
})

// ── HEAD moving forward while open — still true once opened by declaration ──

describe('WorkUnitCollector — 열려 있는 동안의 HEAD 전진', () => {
  it('여러 커밋이 한 Unit 을 유지한다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    const opened = await collector.startTask('s1', '리팩터링해줘')
    if (!opened.ok) throw new Error('unexpected')

    // 에이전트가 그 요청을 받아 한 턴을 돈다 — 아래 세 커밋은 **이 세션이 만드는 것이다**
    collector.onSessionBusy('s1', projectPath, true)
    for (const head of ['c1', 'c2', 'c3']) {
      fake.git.ref = { branch: 'main', head }
      collector.onGitChanged()
      await collector.flush()
    }

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1) // a commit does not open a unit — only a declaration does
    expect(state.units[0].id).toBe(opened.id)
    expect(state.units[0].status).toBe('active')
    expect(state.units[0].git.startHead).toBe('c0')
    expect(state.units[0].git.endHead).toBe('c3')
    // these commits belong to this session — not a repository someone else moved
    expect(state.externalGitChanges).toEqual([])
  })
})

// ── Cursor machinery, pinned via sawWrite (fix round 1, Important 3) ──
//
// seed()/anchorFor/onSessionForked/tail's `restarted` branch is still real and still has to be
// right — a unit no longer opening from a message does not make the question "is it safe to read
// this line" go away. These three tests pin that question the same way they always did, just
// through the sawWrite of a task opened by startTask instead of "did a unit get created" — that
// observation is the only one still standing.

describe('WorkUnitCollector — 커서 기계장치, sawWrite 로 고정한다', () => {
  it('이미 돌던 세션의 켜기 전 트랜스크립트는 나중에 연 Task 의 sawWrite 를 켜지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()] // a session already running when tracking turns on
    // Write evidence already exists before turning on — content earlier than the file end seed() anchors on
    await fs.appendFile(transcript, wrote(), 'utf8')
    const sizeAtStart = (await fs.stat(transcript)).size
    const { collector, store } = await makeCollector(fake)
    await collector.start() // cursor = the file's end at this moment

    expect(store.get(projectPath)!.cursors[0].offset).toBe(sizeAtStart)

    const result = await collector.startTask('s1', '켠 뒤 작업')
    expect(result.ok).toBe(true)
    let state = store.get(projectPath)!
    expect(state.units[0].sawWrite).toBeFalsy() // a line from before turning on is never read

    // Something actually written after turning on is caught normally — showing the result above was no accident
    await fs.appendFile(transcript, wrote(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    state = store.get(projectPath)!
    expect(state.units[0].sawWrite).toBe(true)
  })

  it('이어받은 세션의 되쓰인 옛 줄은 새로 연 Task 의 sawWrite 를 켜지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    // The original session left write evidence — before it was rolled into a new session
    await fs.appendFile(transcript, wrote(), 'utf8')
    const sizeAtFork = (await fs.stat(transcript)).size
    const rolled = path.join(dir, 'transcript-rolled.jsonl')
    await fs.copyFile(transcript, rolled) // --resume rewrites the whole old conversation
    collector.onSessionForked('s2', rolled) // anchors on the size before the rewrite (sizeAtFork)

    // the statusline reports s2's path only later
    fake.sessions = [session({ sessionId: 's2', transcriptPath: rolled })]
    collector.onTranscriptChanged()
    await collector.flush() // the round that first sees s2 — if the anchor is right, this round reads nothing

    expect(store.get(projectPath)!.cursors.find((c) => c.sessionId === 's2')!.offset).toBe(sizeAtFork)

    const result = await collector.startTask('s2', '이어받은 뒤 작업')
    expect(result.ok).toBe(true)
    let state = store.get(projectPath)!
    let unit = state.units.find((u) => u.sessionId === 's2')!
    expect(unit.sawWrite).toBeFalsy() // the rewritten old wrote() line did not land on the new unit

    // Something actually written after the resume is caught normally — showing the result above was no accident
    await fs.appendFile(rolled, wrote(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    state = store.get(projectPath)!
    unit = state.units.find((u) => u.sessionId === 's2')!
    expect(unit.sawWrite).toBe(true)
  })

  it('잘리거나 다시 쓰인 트랜스크립트는 잘리기 전 줄을 sawWrite 로 다시 읽지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()] // a session already running when tracking turns on — goes into startAtEnd
    await fs.appendFile(
      transcript,
      human('켜기 전 긴 대화') + wrote() + human('또 다른 줄') + wrote(),
      'utf8'
    )
    const { collector, store } = await makeCollector(fake)
    await collector.start() // cursor = the (long) file's end at this moment

    const result = await collector.startTask('s1', '작업')
    expect(result.ok).toBe(true)
    expect(store.get(projectPath)!.units[0].sawWrite).toBeFalsy()

    // Replaced by a much shorter file of the same name — truncated, or a different file was put in
    // its place. This content has write evidence too, but for a session already running, "a
    // rewrite after truncation" is not ours to read
    await fs.writeFile(transcript, wrote(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()

    let state = store.get(projectPath)!
    expect(state.units[0].sawWrite).toBeFalsy() // this one line is never read, before or after the truncation
    expect(state.cursors[0].offset).toBe((await fs.stat(transcript)).size) // skipped straight to the end

    // What genuinely arrives afterward is caught normally
    await fs.appendFile(transcript, wrote(), 'utf8')
    collector.onTranscriptChanged()
    await collector.flush()
    state = store.get(projectPath)!
    expect(state.units[0].sawWrite).toBe(true)
  })
})

// Important 3: design's "Never" list is explicit that a usage-limit roll is not a completion, and
// the active unit belongs to the same session task across it. `onSessionForked`'s `oldSessionId`
// re-keys that unit onto the resumed session's id, ahead of the old session's own (later, async)
// exit — see that method's doc for why the ordering holds.
describe('WorkUnitCollector — 한도로 굴렀을 때 열린 작업이 살아남는다 (Important 3)', () => {
  it('재키잉된 활성 작업은 옛 세션의 종료로 중단되지 않고, 새 세션으로 계속 완료할 수 있다', async () => {
    const fake = makeFake()
    fake.sessions = [session()] // s1
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    const started = await collector.startTask('s1', '한도 전에 하던 작업')
    expect(started.ok).toBe(true)

    // rolling.ts's roll() goes kill → spawn → send('session:rolled') with no await in between —
    // the old session's real (asynchronous) exit event is guaranteed to arrive after this
    // notification. Passing oldSessionId relies on exactly that ordering (see onSessionForked's doc).
    collector.onSessionForked('s2', undefined, 's1')
    fake.sessions = [session({ sessionId: 's2' })] // s1 is already dead — it drops out of the list

    // only now does s1's exit event arrive
    await collector.onSessionExit('s1')

    let state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].sessionId).toBe('s2') // re-keyed
    expect(state.units[0].status).toBe('active') // a usage limit is not a completion — not interrupted

    // still completable, now as s2
    await fs.appendFile(transcript, wrote(), 'utf8')
    fake.git.files = ['src/after-roll.ts']
    const result = await collector.completeTask('s2', { source: 'agent' })
    expect(result.ok).toBe(true)
    state = store.get(projectPath)!
    expect(state.units[0].status).toBe('completed')
    expect(closed).toHaveLength(1)
  })

  it('굴러 넘어가기 직전에 쓰인 증거도 재키잉된 뒤의 Unit 에 붙는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    const started = await collector.startTask('s1', '한도 직전 작업')
    expect(started.ok).toBe(true)
    // the last write-evidence line right before hitting the limit — the debounced watcher has not
    // read it yet
    await fs.appendFile(transcript, wrote(), 'utf8')

    collector.onSessionForked('s2', undefined, 's1')
    fake.sessions = [session({ sessionId: 's2' })]
    await collector.onSessionExit('s1')

    const state = store.get(projectPath)!
    const unit = state.units.find((u) => u.sessionId === 's2')!
    expect(unit.sawWrite).toBe(true) // read under the old session's own name before the rename
  })

  it('사람이 기록에서 다시 여는 이어받기는 oldSessionId 를 건네지 않아, 옛 작업을 재키잉하지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    const started = await collector.startTask('s1', '옛 작업')
    expect(started.ok).toBe(true)

    collector.onSessionForked('s2') // the shape of a history resume — no oldSessionId
    const state = store.get(projectPath)!
    expect(state.units[0].sessionId).toBe('s1') // left untouched
    expect(state.units[0].status).toBe('active')
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

// ── Two spots that lived only in wiring, never reached by a test ──────

describe('WorkUnitCollector — 배선 두 자리', () => {
  // EG §42-3's mis-attribution guard hangs on this wiring. A repository someone else moved
  // **during** the task is left on the unit as something it **encountered** (EG §27 — "encountered",
  // not "made"), but the files that change brought in must not get mixed into the unit's own
  // observed-changes list. Mixed in, a later plan's interpreter would read someone else's work as
  // this unit's own.
  it('작업 중의 외부 변경은 id 로만 Unit 에 담긴다 — 그 파일 목록은 섞이지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '작업 하나')
    fake.git.files = ['src/mine.ts'] // the file this session is touching (after opening the unit)

    collector.onGitChanged() // baseline
    await collector.flush()

    // someone else pulled — the file that range brought in is not something this unit made
    fake.git.range = { commits: ['c1'], changedFiles: ['vendor/pulled.ts'] }
    fake.git.ref = { branch: 'main', head: 'c1' }
    collector.onGitChanged()
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.externalGitChanges).toHaveLength(1)
    expect(state.units[0].encounteredExternalGitChangeIds).toEqual([state.externalGitChanges[0].id])
    expect(state.units[0].git.observedChangedFiles).toEqual(['src/mine.ts'])
  })

  // **The opposite side.** If the person declares a new task right after a restart, that unit
  // opens **already at the moved HEAD** (startHead = c1). The first round afterward can still catch
  // the move that happened while the app was off, but that move finished before this unit even
  // existed — not something it "encountered" under EG §27.
  it('꺼져 있던 동안의 변경은 그 뒤에 열린 Unit 에 달리지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const first = await makeCollector(fake)
    await first.collector.start()
    first.collector.onGitChanged() // the last known state — main, c0
    await first.collector.flush()

    // a pull while the app was off
    fake.git.ref = { branch: 'main', head: 'c1' }

    const second = await makeCollector(fake)
    await second.collector.start()

    // the person's declaration arrives before the `.git` event does
    await second.collector.startTask('s1', '다시 켠 뒤 첫 요청')
    expect(second.store.get(projectPath)!.units[0].git.startHead).toBe('c1') // opened already at the moved spot

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
    await first.collector.startTask('s1', '꺼지기 전에 시작한 작업')
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

    await collector.startTask('s1', '작업 하나')
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

// ── 네이티브 /goal 이 여닫는 Unit (task 2) ─────────────────────────────

describe('네이티브 /goal 이 작업 하나를 연다', () => {
  it('claude 의 sentinel 은 그 문장 그대로 Unit 을 연다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: 'rpg 게임을 만들어줘' }),
      'utf8'
    )
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].objective).toBe('rpg 게임을 만들어줘')
    expect(state.units[0].status).toBe('active')
  })

  it('met 은 그 Unit 을 완료로 닫고, 평가자의 이유를 요약으로 남긴다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: 'rpg 게임을 만들어줘' }),
      'utf8'
    )
    await collector.flush()

    await fs.appendFile(transcript, wrote(), 'utf8') // evidence that this session touched a file
    fake.git.files = ['src/game.ts']
    await fs.appendFile(
      transcript,
      claudeGoal({ met: true, condition: 'rpg 게임을 만들어줘', reason: '충족됐다' }),
      'utf8'
    )
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('completed')
    expect(state.units[0].completion?.source).toBe('agent')
    expect(state.units[0].resultSummary).toBe('충족됐다')
    expect(closed).toHaveLength(1)
  })

  it('이미 열린 작업이 있으면 목표는 새 Unit 을 열지 않고, 그 사실을 알린다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, ignored } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '결제 붙이기')
    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: '테스트가 통과할 때까지' }),
      'utf8'
    )
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1) // neither interrupted nor joined by a second unit
    expect(state.units[0].objective).toBe('결제 붙이기')
    expect(state.units[0].status).toBe('active')
    expect(ignored).toEqual([{ projectPath, objective: '테스트가 통과할 때까지' }])
  })

  // Final review, item 4: codex re-sends `thread_goal_updated` with `status: "active"` on every
  // turn boundary, not only when the goal itself changes. Retrying while blocked is correct and
  // must keep happening, but the toast telling the person about it must not repeat every turn.
  it('막힌 채로 같은 목표가 반복돼도 알림은 한 번만 뜬다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, ignored } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '결제 붙이기') // an already-open unit blocks the goal

    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush()
    // codex resends the identical record on the next turn boundary too — still blocked, same text
    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush()

    expect(store.get(projectPath)!.units).toHaveLength(1) // still just the /astera-task unit
    expect(ignored).toHaveLength(1) // one notice, not two
    expect(ignored[0]).toEqual({ projectPath, objective: 'rpg 게임을 만들어줘' })
  })

  it('목표의 끝은 /astera-task 가 연 Unit 을 닫지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await collector.startTask('s1', '결제 붙이기')
    await fs.appendFile(transcript, wrote(), 'utf8')
    fake.git.files = ['src/pay.ts']
    await fs.appendFile(transcript, claudeGoal({ met: true, condition: '테스트가 통과할 때까지' }), 'utf8')
    await collector.flush()

    expect(store.get(projectPath)!.units[0].status).toBe('active')
  })

  it('Run 안의 세션에서 온 목표는 무시하고 알리지도 않는다 — 사람이 친 것이 아니다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, ignored } = await makeCollector(fake, undefined, undefined, {
      inRun: () => true
    })
    await collector.start()

    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: 'rpg 게임을 만들어줘' }),
      'utf8'
    )
    await collector.flush()

    expect(store.get(projectPath)?.units ?? []).toHaveLength(0)
    expect(ignored).toEqual([])
  })

  it('codex 가 같은 목표로 active 를 반복해도 Unit 은 하나다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush()
    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush()

    expect(store.get(projectPath)!.units).toHaveLength(1)
  })

  it('되돌아올 수 있는 codex 상태는 Unit 을 닫지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush()
    await fs.appendFile(transcript, codexGoal('paused'), 'utf8')
    await collector.flush()

    expect(store.get(projectPath)!.units[0].status).toBe('active')
  })

  // Final review, item 7: only claude's `met` had ever driven a goal's end through the collector —
  // codex's own end (`status: "complete"`) is the same code path but had never been exercised.
  it('codex 의 complete 도 같은 경로로 Unit 을 완료로 닫는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush()

    await fs.appendFile(transcript, wrote(), 'utf8') // evidence that this session touched a file
    fake.git.files = ['src/game.ts']
    await fs.appendFile(transcript, codexGoal('complete'), 'utf8')
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units[0].status).toBe('completed')
    expect(state.units[0].completion?.source).toBe('agent')
    expect(closed).toHaveLength(1)
  })

  // Final review, item 3: the screen's own [complete]/[cancel] closes a goal's unit through a
  // route the goal never sees. Claude's `sentinel` is a declaration, not a broadcast (spec §4), so
  // a repeat of it always counts as a new start — even the very same objective, even after the
  // goal's earlier unit already closed — unlike codex's `active` below, which does not.
  it('claude 에서 goal 이 연 Unit 을 화면에서 닫은 뒤 같은 목표를 다시 선언하면 새 Unit 이 열린다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: '테스트가 통과할 때까지' }),
      'utf8'
    )
    await collector.flush() // the goal opens its own unit

    // The person closes it from the screen — a route the goal's own end never takes.
    const opened = store.get(projectPath)!.units[0]
    await collector.cancelTaskById(projectPath, opened.id)

    // The very same objective arrives again.
    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: '테스트가 통과할 때까지' }),
      'utf8'
    )
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[0].status).toBe('cancelled') // untouched further
    expect(state.units[1].objective).toBe('테스트가 통과할 때까지')
    expect(state.units[1].status).toBe('active') // a fresh unit, not silently dropped
  })

  // This is the defect this round fixes. codex's `active` is a state broadcast, re-sent on every
  // turn boundary whether or not the goal changed — unlike claude's `sentinel` above, it is not a
  // declaration. Treating the repeat as a fresh start would find nothing open once the person closes
  // the row and silently mint a duplicate for a goal they just dismissed (spec §4).
  it('codex 가 연 Unit 을 화면에서 닫은 뒤 같은 목표로 active 가 반복돼도 새 Unit 은 열리지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush() // the goal opens its own unit

    // The person closes it from the screen — a route the goal's own end never takes.
    const opened = store.get(projectPath)!.units[0]
    await collector.cancelTaskById(projectPath, opened.id)

    // codex re-sends the same status broadcast on the next turn boundary, naming the same objective.
    await fs.appendFile(transcript, codexGoal('active'), 'utf8')
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1) // no duplicate row for a goal the person just dismissed
    expect(state.units[0].status).toBe('cancelled') // untouched further
  })

  // The rule above is per-objective, not a blanket "ignore codex after a close" — a broadcast
  // naming a genuinely different objective is still a new goal and still opens its own unit.
  it('codex 에서 Unit 을 닫은 뒤 다른 목표로 active 가 오면 새 Unit 이 열린다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexGoal('active', '첫 번째 목표'), 'utf8')
    await collector.flush() // the goal opens its own unit

    const opened = store.get(projectPath)!.units[0]
    await collector.cancelTaskById(projectPath, opened.id)

    await fs.appendFile(transcript, codexGoal('active', '두 번째 목표'), 'utf8')
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[0].status).toBe('cancelled') // untouched further
    expect(state.units[1].objective).toBe('두 번째 목표')
    expect(state.units[1].status).toBe('active') // a fresh unit for a genuinely different goal
  })

  // Re-review regression: a start signal naming a different objective while the goal's own unit is
  // still open must hit the already-open guard and leave `goalUnits` alone — deleting it there (as
  // a prior version of this fix did) severs the only link telling the goal's end which unit is its
  // own, and the unit is then stuck open until the person closes it by hand. Claude reaches the
  // already-open guard here because `sentinel` is always a declaration, regardless of objective.
  it('claude 에서 Unit 이 열린 채로 다른 목표가 다시 선언돼도, 끝은 여전히 그 Unit 을 닫는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: '첫 번째 목표' }),
      'utf8'
    )
    await collector.flush() // opens the unit

    // The person refines the goal while its unit is still open — a fresh declaration, but one unit
    // is already open so it must be ignored, not opened as a second unit.
    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: '두 번째 목표' }),
      'utf8'
    )
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1) // still just the one unit

    await fs.appendFile(transcript, wrote(), 'utf8')
    fake.git.files = ['src/x.ts']
    await fs.appendFile(
      transcript,
      claudeGoal({ met: true, condition: '두 번째 목표', reason: '끝났다' }),
      'utf8'
    )
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].status).toBe('completed') // not left open for the person to close by hand
    expect(closed).toHaveLength(1)
  })

  // Same regression, codex's route to the already-open guard: not a declaration, but a broadcast
  // naming an objective that no longer matches the remembered one, so the repeat guard does not
  // catch it either — both vendors must land on the guard that preserves `goalUnits`.
  it('codex 에서 Unit 이 열린 채로 다른 목표로 active 가 다시 와도, complete 는 여전히 그 Unit 을 닫는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(transcript, codexGoal('active', '첫 번째 목표'), 'utf8')
    await collector.flush() // opens the unit

    await fs.appendFile(transcript, codexGoal('active', '두 번째 목표'), 'utf8')
    await collector.flush()
    expect(store.get(projectPath)!.units).toHaveLength(1) // still just the one unit

    await fs.appendFile(transcript, wrote(), 'utf8')
    fake.git.files = ['src/x.ts']
    await fs.appendFile(transcript, codexGoal('complete', '두 번째 목표'), 'utf8')
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].status).toBe('completed') // not left open for the person to close by hand
    expect(closed).toHaveLength(1)
  })

  // Fix round 1, finding 2: a goal's unit used to be identified by its objective text alone, so a
  // goal's end could close a same-worded `/astera-task` unit that was never the goal's own.
  it('같은 글자의 목표라도, /astera-task 가 새로 연 Unit 은 id 가 달라 목표의 끝이 닫지 않는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()]
    const { collector, store } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: '테스트가 통과할 때까지' }),
      'utf8'
    )
    await collector.flush() // the goal opens its own unit, first in the list

    // The person then types the very same sentence into /astera-task — same text, a different unit.
    // This interrupts the goal's unit and opens a second one with the identical objective.
    await collector.startTask('s1', '테스트가 통과할 때까지')

    await fs.appendFile(transcript, wrote(), 'utf8')
    fake.git.files = ['src/x.ts']
    await fs.appendFile(
      transcript,
      claudeGoal({ met: true, condition: '테스트가 통과할 때까지' }),
      'utf8'
    )
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(2)
    expect(state.units[0].status).toBe('interrupted') // the goal's own unit — untouched further
    expect(state.units[1].status).toBe('active') // the /astera-task unit — not closed by the goal
  })

  // Fix round 1, finding 4: a usage-limit roll re-keys the active unit onto the new session id
  // (`reKeyRolledUnit`), but used to leave `goalUnits` behind under the old id — a goal outlives a
  // roll (it is on the ignore list precisely for `usageLimited`), so its end must still find the
  // unit under the resumed session.
  it('한도로 굴러도 목표는 재키잉된 세션 아래에서 그 Unit 을 마저 닫는다', async () => {
    const fake = makeFake()
    fake.sessions = [session()] // s1
    const { collector, store, closed } = await makeCollector(fake)
    await collector.start()

    await fs.appendFile(
      transcript,
      claudeGoal({ sentinel: true, met: false, condition: '한도 전에 하던 목표' }),
      'utf8'
    )
    await collector.flush() // opens the unit under s1

    // rolling.ts's roll(): kill(old) → spawn(new) → send('session:rolled'), no await in between —
    // the old session's own exit event is guaranteed to arrive after this notification.
    collector.onSessionForked('s2', undefined, 's1')
    fake.sessions = [session({ sessionId: 's2' })] // s1 is already dead
    await collector.onSessionExit('s1')

    await fs.appendFile(transcript, wrote(), 'utf8')
    fake.git.files = ['src/after-roll.ts']
    await fs.appendFile(
      transcript,
      claudeGoal({ met: true, condition: '한도 전에 하던 목표', reason: '끝났다' }),
      'utf8'
    )
    await collector.flush()

    const state = store.get(projectPath)!
    expect(state.units).toHaveLength(1)
    expect(state.units[0].sessionId).toBe('s2')
    expect(state.units[0].status).toBe('completed')
    expect(state.units[0].resultSummary).toBe('끝났다')
    expect(closed).toHaveLength(1)
  })
})

