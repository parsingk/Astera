import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildResumeNote, buildResumePacket, buildTabResumeText } from './resumePacket'
import type { TranscriptResumeMaterial } from '../../core/history/parser'
import { LAUNCH_FORBIDDEN } from './coordinator'
import * as checkpointModule from '../../core/orchestration/checkpoint'
import { emptyState, createRun, createTask, openDispatch } from '../../core/orchestration/state'
import type { OrchState } from '../../core/orchestration/state'
import type { GitResult } from '../../core/worktrees/git'
import { git } from '../../core/worktrees/git'

const NOW = '2026-08-26T00:00:00.000Z'

// server.test.ts(같은 디렉토리)의 mkdtemp 선례와 같은 패턴 — 실제 fs 로 spec 파일을 읽고 쓴다.
let specDir: string
beforeEach(async () => {
  specDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-resumepacket-'))
})
afterEach(async () => {
  await fs.rm(specDir, { recursive: true, force: true })
})

const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}

/** run + task + 열린 dispatch 하나가 준비된 상태. specPath 는 호출자가 넘긴 실제 파일 경로다—
 *  state.test.ts 의 seed() 와 같은 모양이고, cwd/specPath 만 이 파일의 필요에 맞춘다. */
function seed(specPath: string): { s: OrchState; taskId: string; dispatchId: string } {
  const run = unwrap<{ id: string }>(
    createRun(emptyState(), { objective: 'ship the feature', cwd: specDir }, NOW) as never
  )
  const t = unwrap<{ id: string }>(
    createTask(run.state, { runId: run.value.id, title: 'do the thing', spec: 'implement it', deps: [] }, NOW) as never
  )
  const d = unwrap<{ id: string }>(
    openDispatch(
      t.state,
      {
        taskId: t.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: specDir,
        specPath
      },
      NOW
    ) as never
  )
  return { s: d.state, taskId: t.value.id, dispatchId: d.value.id }
}

/** gitSummary.test.ts 의 fakeGit 과 같은 모양 — 네 호출 중 지정한 것만 갈아끼우고 나머지는 정상값을
 *  돌려준다. 이 파일의 git 호출은 언제나 fake 를 쓴다: 실제 git 서브프로세스를 매 테스트마다 띄우지
 *  않기 위해서이고, "git 을 읽을 수 없다" 시나리오를 ambient 환경(실제 저장소 유무)에 기대지 않고
 *  결정론적으로 재현하기 위해서다. */
function fakeGit(overrides: Record<string, GitResult> = {}): typeof git {
  const defaults: Record<string, GitResult> = {
    'rev-parse HEAD': { ok: true, stdout: 'abc123', stderr: '' },
    'branch --show-current': { ok: true, stdout: 'main', stderr: '' },
    '-c core.quotepath=false status --short': { ok: true, stdout: '', stderr: '' },
    '-c core.quotepath=false diff HEAD --stat': { ok: true, stdout: '', stderr: '' }
  }
  const table = { ...defaults, ...overrides }
  return (async (args: string[]) => {
    const key = args.join(' ')
    const r = table[key]
    if (!r) throw new Error(`fakeGit: unexpected invocation "${key}"`)
    return r
  }) as typeof git
}

const UNREADABLE_GIT = fakeGit({ 'rev-parse HEAD': { ok: false, stdout: '', stderr: 'not a repository' } })

describe('buildResumePacket', () => {
  it('Job 워커면 spec 파일에 재개 절이 붙고 한 줄 프롬프트가 반환된다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)

    const line = await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW })

    expect(line).not.toBeNull()
    expect(typeof line).toBe('string')
    const content = await fs.readFile(specPath, 'utf8')
    expect(content).toContain('# do the thing') // 원래 내용은 남는다
    expect(content).toContain('## Resume briefing (assembled by the app — do not delete)')
    expect(content).toContain('ship the feature') // Checkpoint 의 JOB 절
  })

  it('두 번 재개하면 절이 쌓이지 않고 교체된다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s, taskId } = seed(specPath)

    const first = await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW })
    expect(first).not.toBeNull()

    // 두 번째 호출 전에 상태를 바꿔 둔다 — 두 번째 절이 실제로 다른 내용을 담는지까지 확인하기
    // 위해서다. createGate 는 열린 Dispatch 가 있는 Task 를 거절하므로(state.ts), Task.filesModified
    // 를 직접 바꿔 checkpoint 의 CHANGED FILES 절이 달라지게 한다.
    const changed: OrchState = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, filesModified: ['src/added.ts'] } : t))
    }
    const second = await buildResumePacket('sess1', changed, { git: fakeGit(), now: () => NOW })
    expect(second).not.toBeNull()

    const content = await fs.readFile(specPath, 'utf8')
    const headingCount = content.split('## Resume briefing (assembled by the app — do not delete)').length - 1
    expect(headingCount).toBe(1) // 쌓이지 않고 교체됐다
    expect(content).toContain('src/added.ts') // 최신(두 번째) 절의 내용이다
  })

  it('그 세션에 열린 Dispatch 가 없으면(Job 워커가 아니면) null', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)

    const line = await buildResumePacket('some-plain-tab-session', s, { git: fakeGit(), now: () => NOW })

    expect(line).toBeNull()
    const content = await fs.readFile(specPath, 'utf8')
    expect(content).toBe('# do the thing\n\nimplement it\n') // 손대지 않는다
  })

  it('git 을 읽을 수 없어도 절은 붙는다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)

    const line = await buildResumePacket('sess1', s, { git: UNREADABLE_GIT, now: () => NOW })

    expect(line).not.toBeNull()
    const content = await fs.readFile(specPath, 'utf8')
    expect(content).toContain('## Resume briefing (assembled by the app — do not delete)')
    // git 이 없으니 worktree 이동 여부에 대한 문장은 나오지 않는다(worktreeMoved 가 null 이라 비교
    // 자체가 없다 — checkpoint.ts/resumeSection.ts 의 계약).
    expect(content).not.toContain('The worktree has')
  })

  it('spec 파일 쓰기가 실패하면 null 을 돌리고 로그를 남긴다', async () => {
    // 부모 디렉터리가 없는 경로 — readFile 은 조용히 흡수되고(빈 문자열로 취급), writeFile 은
    // 실제로 실패한다.
    const specPath = path.join(specDir, 'missing-subdir', 'spec.md')
    const { s } = seed(specPath)
    const log = vi.fn()

    const line = await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW, log })

    expect(line).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('resume packet failed')
  })

  it('ENOENT 가 아닌 읽기 실패는 원본을 지우지 않고 null 을 돌린다', async () => {
    // fix round 1 — Finding 1: 이전 구현은 모든 읽기 실패를 "기존 내용 없음"으로 봤다. 그러면 이
    // 경로처럼(파일은 있고 쓰기도 되지만 읽기만 실패하는 경우 — 실제로는 파일 잠금·EMFILE·클라우드
    // 동기화 recall 등) upsertResumeSection('', section) 이 새 절만 담아 원본 지시문을 통째로
    // 덮어썼다. 이 테스트는 그 경로를 재현한다: 실제 파일은 그대로 두고 readFile 만 EACCES 로 갈아
    // 끼운다 — "경로는 쓸 수 있는데 읽기만 실패한다"를 결정론적으로 만들 유일한 방법이다(실제 OS
    // 잠금은 이 스위트가 두 플랫폼에서 안정적으로 재현할 수 없다).
    const specPath = path.join(specDir, 'spec.md')
    const original = '# do the thing\n\nimplement it\n'
    await fs.writeFile(specPath, original, 'utf8')
    const { s } = seed(specPath)
    const log = vi.fn()
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const readFile = vi.fn(() => Promise.reject(eacces))

    const line = await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW, log, readFile })

    expect(line).toBeNull()
    const content = await fs.readFile(specPath, 'utf8')
    expect(content).toBe(original) // 원본이 그대로 남는다 — 새 절로 덮어쓰지 않는다
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('resume packet failed')
  })

  it('Checkpoint 조립이 던져도 거부된 Promise 가 아니라 null 을 돌린다', async () => {
    // fix round 1 — Finding 2: 이전 구현은 fs 읽기/쓰기만 try 로 감쌌다. buildCheckpoint/
    // formatResumeSection(core/orchestration 의 순수 모듈)은 오늘은 던지지 않지만, 이 파일이 그것을
    // "이 함수가 절대 던지지 않는다"는 계약의 근거로 삼을 수는 없다 — rolling.ts 의 네 자리는 모두
    // fire-and-forget(`void this.resumeInPlace(...)` 등)으로 부르므로, 여기서 거부된 Promise 가
    // 나가면 처리되지 않는 예외가 된다. 순수 모듈을 고칠 수는 없으니(이 라운드의 허용 파일 밖) 여기서
    // spy 로 던지게 만들어, 그 경우에도 이 함수가 null 로 저하하고 원본 spec 파일은 그대로 두는지
    // 확인한다.
    const specPath = path.join(specDir, 'spec.md')
    const original = '# do the thing\n\nimplement it\n'
    await fs.writeFile(specPath, original, 'utf8')
    const { s } = seed(specPath)
    const log = vi.fn()
    const spy = vi.spyOn(checkpointModule, 'buildCheckpoint').mockImplementation(() => {
      throw new Error('boom from a future core/orchestration change')
    })
    try {
      const line = await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW, log })
      expect(line).toBeNull()
      const content = await fs.readFile(specPath, 'utf8')
      expect(content).toBe(original) // 손대지 않는다
      expect(log).toHaveBeenCalledTimes(1)
      expect(log.mock.calls[0]?.[0]).toContain('resume packet failed')
    } finally {
      spy.mockRestore()
    }
  })

  it('쓰다가 끊겨도 원본은 잘리지 않는다 — 임시 파일에 쓰고 rename 한다', async () => {
    // fix round 2: 이전 구현은 fs.writeFile 로 spec 파일을 제자리에서 truncate 했다. 그 사이에
    // 쓰기가 끊기면(디스크가 차거나 프로세스가 죽으면) 파일은 잘린 채 남고 되돌릴 사람이 없다 —
    // 보고 의무·커밋 의무·Task 지시문이 함께 사라진다. 끊긴 쓰기는 실제 fs 로 결정론적으로 만들
    // 수 없으므로 writeFile 을 갈아끼워 재현한다: 준 경로에 앞 10자만 쓰고 던진다. 임시 파일에
    // 쓰는 구현에서는 원본이 무사하고, 대상에 직접 쓰는 구현에서는 원본이 잘린다.
    const specPath = path.join(specDir, 'spec.md')
    const original = '# do the thing\n\nimplement it\n\n## Reporting obligation\n\nreport once.\n'
    await fs.writeFile(specPath, original, 'utf8')
    const { s } = seed(specPath)
    const log = vi.fn()
    const writeFile = vi.fn(async (p: string, c: string) => {
      await fs.writeFile(p, c.slice(0, 10), 'utf8')
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    })

    const line = await buildResumePacket('sess1', s, {
      git: fakeGit(),
      now: () => NOW,
      log,
      writeFile
    })

    expect(line).toBeNull()
    expect(await fs.readFile(specPath, 'utf8')).toBe(original)
    // 끊긴 쓰기가 남긴 임시 파일은 치운다 — spec 디렉터리에 spec.md 만 남아야 한다
    expect(await fs.readdir(specDir)).toEqual(['spec.md'])
    expect(log.mock.calls[0]?.[0]).toContain('resume packet failed')
  })

  it('반환된 문장에는 LAUNCH_FORBIDDEN 이 걸리는 문자가 없다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)

    const line = await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW })

    expect(line).not.toBeNull()
    expect(LAUNCH_FORBIDDEN.test(line as string)).toBe(false)
  })

  // fix round 2: 이 줄은 파일을 다시 읽으라고 요청할 수 있을 뿐 강제할 수 없다. 기억으로 이어가기로
  // 한 에이전트가 보고 명령을 어디서도 다시 보지 못하면 그 Task 는 영원히 닫히지 않는다(SPEC §9.2).
  it('보고 명령을 인라인으로 들고 있다 — 파일을 다시 읽지 않아도 보고할 수 있게', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s, taskId, dispatchId } = seed(specPath)

    const line = (await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW }))!

    expect(line).toContain('astera send --type worker_done')
    expect(line).toContain(`--task-id ${taskId}`)
    expect(line).toContain(`--dispatch-id ${dispatchId}`)
    expect(line).not.toContain('\n') // 한 줄이어야 한다 — claude 는 PTY 에 타이핑한다
  })
})

// fix round 2 — SPEC §11.5: `--resume` 없이 이어가는 재개 경로(claude 의 resumeInPlace·idle nudge·
// 리셋 앵커)는 살아 있는 세션이다. Job 워커의 체인은 계정이 하나라서 claude 워커는 언제나 그쪽으로
// 가므로, 이 함수가 claude 워커의 정상 경로다 — spec 파일을 건드리면 안 된다.
describe('buildResumeNote', () => {
  const withChanges = (): typeof git =>
    fakeGit({
      'rev-parse HEAD': { ok: true, stdout: 'head-now', stderr: '' },
      '-c core.quotepath=false status --short': {
        ok: true,
        stdout: ' M src/a.ts\n?? src/b.ts\n',
        stderr: ''
      }
    })

  it('한 줄을 돌려주고 spec 파일은 손대지 않는다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    const original = '# do the thing\n\nimplement it\n'
    await fs.writeFile(specPath, original, 'utf8')
    const { s } = seed(specPath)

    const note = await buildResumeNote('sess1', s, { git: withChanges(), now: () => NOW })

    expect(note).not.toBeNull()
    expect(note).toContain('src/a.ts')
    expect(note).not.toContain('\n')
    expect(await fs.readFile(specPath, 'utf8')).toBe(original)
  })

  it('전체 packet 을 담지 않는다 — Task 지시문도, 보고 명령도', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)

    const note = (await buildResumeNote('sess1', s, { git: withChanges(), now: () => NOW }))!

    expect(note).not.toContain('implement it')
    expect(note).not.toContain('start the task from scratch')
    expect(note).not.toContain('astera send')
  })

  it('git 을 읽을 수 없으면 null — 확인한 것이 없으므로 할 말이 없다, 그리고 로그를 남긴다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)
    const log = vi.fn()

    const note = await buildResumeNote('sess1', s, { git: UNREADABLE_GIT, now: () => NOW, log })

    expect(note).toBeNull()
    // follow-up round: 소리 없이 사라지는 노트가 이 함수의 실제 사고였다 — 유일하게 남은 폐기
    // 경로는 반드시 이유를 남긴다.
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('resume note skipped')
  })

  // follow-up round — Fix A: 이 문자열은 packet 쪽 한 줄과 달리 **파일 이름을 담는다.** 노트 전체를
  // LAUNCH_FORBIDDEN 으로 검사하던 동안, 저장소에 `docs/R&D notes.md` 하나만 있어도 `&` 때문에
  // 노트가 통째로 버려졌다 — 로그도 없이. 그 저장소에서는 이 Phase 의 claude 쪽 가치 전부가 사라진다.
  // 'update' 를 묻는 세 자리는 모두 살아 있는 PTY 에 타이핑하므로 codex 의 인자 sanitizer 가 도는
  // 자리가 아니고, 검사는 지킬 것 없이 기능을 껐다.
  it('파일 이름에 금지 문자가 있어도 노트는 그대로 도착한다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)
    const log = vi.fn()
    const gitWithAmpersand = fakeGit({
      'rev-parse HEAD': { ok: true, stdout: 'head-now', stderr: '' },
      '-c core.quotepath=false status --short': {
        ok: true,
        stdout: ' M "docs/R&D notes.md"\n?? src/b.ts\n',
        stderr: ''
      }
    })

    const note = await buildResumeNote('sess1', s, { git: gitWithAmpersand, now: () => NOW, log })

    expect(note).not.toBeNull()
    expect(note).toContain('docs/R&D notes.md')
    expect(log).not.toHaveBeenCalled()
  })

  it('Job 워커가 아니면 null', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)

    expect(await buildResumeNote('plain-tab', s, { git: withChanges(), now: () => NOW })).toBeNull()
  })

})

// Task 2 — Dispatch 가 없는 탭 세션도 브리핑을 받는다. buildResumePacket/buildResumeNote 와 달리
// OrchState 를 보지 않으므로 seed()/specDir 을 쓰지 않는다.
describe('buildTabResumeText', () => {
  const CWD = 'C:/projects/my-api'

  const material: TranscriptResumeMaterial = {
    title: 'fix-flaky-ci',
    requests: ['Fix the flaky CI test.'],
    editedFiles: ['src/a.ts'],
    tail: [{ role: 'user', text: 'It fails only on Windows.' }]
  }

  it('handover — 대화 파일을 한 번 읽어 제목·요청·손댄 파일·꼬리를 모두 싣는다', async () => {
    const readTranscript = vi.fn().mockResolvedValue(material)

    const text = await buildTabResumeText('sess1', 'handover', {
      cwd: CWD,
      transcriptPath: '/fake/transcript.jsonl',
      git: fakeGit(),
      readTranscript
    })

    expect(text).not.toBeNull()
    expect(text).toContain('fix-flaky-ci')
    expect(text).toContain('Fix the flaky CI test.')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('It fails only on Windows.')
    expect(readTranscript).toHaveBeenCalledTimes(1)
    expect(readTranscript).toHaveBeenCalledWith('/fake/transcript.jsonl')
  })

  it("update — 대화 파일을 아예 읽지 않는다(git 상태만 쓰므로 읽을 값이 없다)", async () => {
    const readTranscript = vi.fn().mockResolvedValue(material)

    const text = await buildTabResumeText('sess1', 'update', {
      cwd: CWD,
      transcriptPath: '/fake/transcript.jsonl',
      git: fakeGit({
        'rev-parse HEAD': { ok: true, stdout: 'head-now', stderr: '' },
        '-c core.quotepath=false status --short': { ok: true, stdout: ' M src/a.ts\n', stderr: '' }
      }),
      readTranscript
    })

    expect(text).not.toBeNull()
    expect(text).toContain('src/a.ts')
    expect(text).not.toContain('fix-flaky-ci') // 제목은 update 재료가 아니다
    expect(readTranscript).not.toHaveBeenCalled() // 읽지 않는다 — 낭비를 피한다
  })

  it('손댄 파일이 대화에 없으면 git 의 변경 목록으로 내려간다', async () => {
    const readTranscript = vi.fn().mockResolvedValue({ ...material, editedFiles: [] })

    const text = await buildTabResumeText('sess1', 'handover', {
      cwd: CWD,
      transcriptPath: '/fake/transcript.jsonl',
      git: fakeGit({
        'rev-parse HEAD': { ok: true, stdout: 'head-now', stderr: '' },
        '-c core.quotepath=false status --short': { ok: true, stdout: '?? src/from-git.ts\n', stderr: '' }
      }),
      readTranscript
    })

    expect(text).toContain('src/from-git.ts')
  })

  it('transcriptPath 를 모르면 git 만으로 시도한다', async () => {
    const readTranscript = vi.fn().mockResolvedValue(material)

    const text = await buildTabResumeText('sess1', 'handover', {
      cwd: CWD,
      transcriptPath: null,
      git: fakeGit({
        'rev-parse HEAD': { ok: true, stdout: 'head-now', stderr: '' },
        '-c core.quotepath=false status --short': { ok: true, stdout: '?? src/only-git.ts\n', stderr: '' }
      }),
      readTranscript
    })

    expect(text).not.toBeNull()
    expect(text).toContain('src/only-git.ts')
    expect(text).not.toContain('fix-flaky-ci') // 못 읽었으니 제목도 없다
    expect(readTranscript).not.toHaveBeenCalled()
  })

  it('git 도 없고 transcriptPath 도 없으면 null 이고 폐기가 로그로 남는다', async () => {
    const log = vi.fn()

    const text = await buildTabResumeText('sess1', 'handover', {
      cwd: CWD,
      transcriptPath: null,
      git: UNREADABLE_GIT,
      log
    })

    expect(text).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('tab resume skipped')
  })

  it('대화 파일 읽기가 던지면 null 을 돌리고 로그를 남긴다', async () => {
    const log = vi.fn()
    const readTranscript = vi.fn().mockRejectedValue(new Error('EMFILE'))

    const text = await buildTabResumeText('sess1', 'handover', {
      cwd: CWD,
      transcriptPath: '/fake/transcript.jsonl',
      git: fakeGit(),
      readTranscript,
      log
    })

    expect(text).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('tab resume failed')
  })
})
