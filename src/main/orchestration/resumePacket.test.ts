import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildResumePacket } from './resumePacket'
import { LAUNCH_FORBIDDEN } from './coordinator'
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
    'status --short': { ok: true, stdout: '', stderr: '' },
    'diff --stat': { ok: true, stdout: '', stderr: '' }
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
    expect(log.mock.calls[0]?.[0]).toContain('resume packet write failed')
  })

  it('반환된 문장에는 LAUNCH_FORBIDDEN 이 걸리는 문자가 없다', async () => {
    const specPath = path.join(specDir, 'spec.md')
    await fs.writeFile(specPath, '# do the thing\n\nimplement it\n', 'utf8')
    const { s } = seed(specPath)

    const line = await buildResumePacket('sess1', s, { git: fakeGit(), now: () => NOW })

    expect(line).not.toBeNull()
    expect(LAUNCH_FORBIDDEN.test(line as string)).toBe(false)
  })
})
