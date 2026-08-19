import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OrchCoordinator,
  buildSpecFile,
  buildReviewSpecFile,
  launchPrompt,
  LAUNCH_FORBIDDEN,
  type CoordinatorDeps
} from './coordinator'

let dir: string
/** spec 디렉토리는 **워커 cwd 밖**이다 — 배선이 `<userData>/orch/specs`를 주입한다.
 *  cwd 안에 두면 spec 본문(오케스트레이터의 작업 지시)이 사용자 저장소에 남아 커밋된다. */
let specsDir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-orchco-'))
  specsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-orchspec-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(specsDir, { recursive: true, force: true })
})

/** 론치 프롬프트에 실리는 형태(앞슬래시 정규화) */
const posix = (p: string): string => p.replace(/\\/g, '/')

// 설계 판정: 코디네이터는 OrchState를 전혀 읽거나 쓰지 않는다 — 서버가
// 상태를 소유한다. 그래서 CoordinatorDeps에는 getState·setState가 없고, startWorker는
// dispatchId·title·spec·runCwd(및 재사용 시 terminalCwd·terminalProvider·terminalAccountId)를
// 인자로 받는다. handleExit도 상태를 만지므로 server.ts로 옮겼다(이 파일에는 없다).
const makeDeps = (): CoordinatorDeps & {
  spawned: unknown[]
  written: string[]
  killed: string[]
  logs: string[]
  worktrees: string[]
} => {
  const spawned: unknown[] = []
  const written: string[] = []
  const killed: string[] = []
  const logs: string[] = []
  const worktrees: string[] = []
  return {
    spawned,
    written,
    killed,
    logs,
    worktrees,
    specsDir,
    spawnSession: async (o) => {
      spawned.push(o)
      return { id: `sess${spawned.length}` }
    },
    writeToSession: (_id, data) => written.push(data),
    // 기본값 null: codex처럼 판정 불가능한 provider와 동일한 전제 — 즉시 주입(가드 없음)이
    // 기존 테스트(재사용 경로 등)의 기대와 일치한다.
    isBusy: () => null,
    isAlive: () => true,
    killSession: (id) => killed.push(id),
    createWorktree: async (a) => {
      worktrees.push(a.name)
      return { path: path.join(dir, 'wt-' + a.name) }
    },
    accountProvider: () => 'codex',
    log: (m) => logs.push(m)
  }
}

const baseArgs = (dispatchId = 'dsp_1', taskId = 'tsk_1') => ({
  dispatchId,
  taskId,
  title: '인증 리팩터',
  spec: '설계하고 반영하라',
  provider: 'codex' as const,
  accountId: 'acc1',
  runCwd: '', // 각 테스트에서 dir로 채운다
  worktree: 'current'
})

/** 실제 배선이 주입하는 형태의 절대경로(userData 아래) */
const SPEC_ABS = 'C:/Users/u/AppData/Roaming/Astera/orch/specs/tsk_1-dsp_1.md'

describe('launchPrompt', () => {
  it('금지 문자를 포함하지 않는다', () => {
    expect(LAUNCH_FORBIDDEN.test(launchPrompt(SPEC_ABS))).toBe(false)
  })
  it('경로를 포함한다', () => {
    expect(launchPrompt(SPEC_ABS)).toContain(SPEC_ABS)
  })
})

describe('buildSpecFile', () => {
  it('task 제목과 spec 전문을 담는다', () => {
    const out = buildSpecFile({ title: 'T', spec: 'S', taskId: 'tsk_1', dispatchId: 'dsp_1' })
    expect(out).toContain('# T')
    expect(out).toContain('S')
  })
  it('보고 의무 프리앰블에 두 id와 CLI 참조가 들어간다', () => {
    const out = buildSpecFile({ title: 'T', spec: 'S', taskId: 'tsk_1', dispatchId: 'dsp_1' })
    expect(out).toContain('tsk_1')
    expect(out).toContain('dsp_1')
    // 명령 이름으로 부른다 — 세션 PATH에 셔틀 디렉토리가 붙어 있다(manager.ts orchEnv 분기,
    // 있다). 환경변수 경로만 쓰게 하면 접근성이 낮고 읽기 어렵다.
    expect(out).toContain('astera send')
    // **폴백을 함께 담는다**: win32의 MSYS bash는 PATHEXT를 적용하지 않아 셔틀
    // 배포가 어긋나면 `astera`가 command not found가 되고, 그러면 워커의 유일한 보고 경로가
    // 조용히 죽는다(worker_done이 오지 않고 workerState는 ready로 남는다). 절대경로 폴백이
    // 프리앰블에 있어야 에이전트가 스스로 회복할 수 있다 — 이 단정을 지우지 마라.
    expect(out).toContain('ASTERA_CLI')
    expect(out).toContain('worker_done')
    expect(out).toContain('ask')
    expect(out).toContain('--resume')
  })
  it('코드를 본문에 옮기지 말라는 지시를 담는다 — 없으면 워커가 diff를 복사해 토큰을 낭비한다', () => {
    const out = buildSpecFile({ title: 'T', spec: 'S', taskId: 'tsk_1', dispatchId: 'dsp_1' })
    expect(out).toContain('files-modified')
  })
  // committing 이 워크트리 워커에만 켜진다(coordinator.ts의 startWorker가 worktree !== 'current'로
  // 유도한다) — 워크트리는 병합 대상이라 커밋이 없으면 그 일이 다른 결과와 합쳐질 길이 없다.
  it('committing 이 참이면 커밋 의무 절을 보고 의무보다 앞에 넣는다', () => {
    const out = buildSpecFile({ title: 'T', spec: 'S', taskId: 'tsk_1', dispatchId: 'dsp_1', committing: true })
    expect(out).toContain('git add')
    expect(out).toContain('git commit')
    expect(out.indexOf('git commit')).toBeLessThan(out.indexOf('Reporting obligation'))
    // 커밋 의무가 보고 의무를 밀어내지 않았다 — 두 절 모두 있어야 한다
    expect(out).toContain('worker_done')
  })
  it('committing 이 없거나 거짓이면 커밋 의무 절이 없다 — 프로젝트 폴더 워커에는 해당 없다', () => {
    const withoutFlag = buildSpecFile({ title: 'T', spec: 'S', taskId: 'tsk_1', dispatchId: 'dsp_1' })
    const explicitFalse = buildSpecFile({
      title: 'T', spec: 'S', taskId: 'tsk_1', dispatchId: 'dsp_1', committing: false
    })
    for (const out of [withoutFlag, explicitFalse]) {
      expect(out).not.toContain('git commit')
      expect(out).toContain('worker_done')
    }
  })
})

describe('buildReviewSpecFile', () => {
  it('원래 Task 의 요구를 판정 기준으로 싣는다', () => {
    const md = buildReviewSpecFile({ title: 'T', spec: '요구 본문', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('요구 본문')
  })

  it('구현자가 보고한 것과 바꾼 파일을 싣는다', () => {
    const md = buildReviewSpecFile({
      title: 'T',
      spec: 's',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      implReport: '구현자가 남긴 보고 본문',
      filesModified: ['src/a.ts', 'src/b.ts'],
      validated: false
    })
    expect(md).toContain('구현자가 남긴 보고 본문')
    expect(md).toContain('src/a.ts')
    expect(md).toContain('src/b.ts')
  })

  it('검증이 통과했으면 그 사실을 싣는다', () => {
    // 검토자가 컴파일·테스트를 다시 판정하지 않게 하는 근거다
    const md = buildReviewSpecFile({ title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: true })
    expect(md).toContain('it passed')
    expect(md).toContain('is settled')
  })

  it('검증이 없었으면 통과했다고 말하지 않는다', () => {
    const md = buildReviewSpecFile({ title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('No automated validation was attached')
    expect(md).not.toContain('is settled')
    expect(md).not.toContain('it passed')
  })

  // 이 둘이 이 파일의 존재 이유다
  it('볼 것이 "요구가 충족됐는가" 하나임을 못박는다', () => {
    const md = buildReviewSpecFile({ title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('Was the requirement above satisfied?')
    expect(md).toContain('not grounds for rejecting the work')
  })
  it('코드를 바꾸지 말라고 못박는다', () => {
    const md = buildReviewSpecFile({ title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('Do not change any code.')
  })

  it('자기 dispatch id 로 보고하게 한다', () => {
    const md = buildReviewSpecFile({ title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_review', validated: false })
    expect(md).toContain('dsp_review')
    expect(md).toContain('--task-id tsk_1')
  })
})

describe('OrchCoordinator.startWorker', () => {
  it('세션을 띄우고 spec 파일을 쓴다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir })
    expect(r.sessionId).toBe('sess1')
    const written = await fs.readFile(r.specPath, 'utf8')
    expect(written).toContain('인증 리팩터')
  })
  // 위치가 워커 cwd 안(`.orch/`)에서 주입된 specsDir로 옮겨졌다. 단정을 약화시키지 않고
  // 새 위치로 옮기면서, **사용자 저장소에 아무것도 남지 않는다**는 이 태스크의 목적을 함께 고정한다.
  it('spec 파일을 specsDir 아래 taskId-dispatchId.md 로 만들고, 워커 cwd에는 아무것도 만들지 않는다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs('dsp_9', 'tsk_9'), runCwd: dir })
    expect(r.specPath).toBe(path.join(specsDir, 'tsk_9-dsp_9.md'))
    expect(await fs.readFile(r.specPath, 'utf8')).toContain('인증 리팩터')
    // 옛 위치가 되살아나지 않는다
    expect(await fs.stat(path.join(dir, '.orch')).catch(() => null)).toBeNull()
    // 그리고 그 위치만이 아니라 cwd 아래 **아무것도** 생기지 않았다 (dir는 빈 임시 디렉토리다)
    expect(await fs.readdir(dir)).toEqual([])
  })
  // 검토 Dispatch 가 이 경로로 온다. spec 은 **본문**이고 buildSpecFile 이 그것을 구현자의 템플릿으로
  // 감싸므로, 조립이 끝난 검토 파일을 spec 자리에 넣으면 H1 과 보고 의무가 두 벌이 되고 마지막 줄이
  // "바꾼 파일을 --files-modified 로 넘겨라"가 되어 맨 위의 "코드를 바꾸지 말라"와 부딪힌다.
  it('specFileContent 를 주면 그 문자열만 그대로 쓴다 — buildSpecFile 로 다시 감싸지 않는다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const file = buildReviewSpecFile({
      title: '인증 리팩터',
      spec: '설계하고 반영하라',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      validated: true
    })
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, specFileContent: file })
    const written = await fs.readFile(r.specPath, 'utf8')
    expect(written).toBe(file)
    // H1 이 하나뿐이고 구현자의 보고 의무가 섞여 들어오지 않았다
    expect(written.match(/^# /gm)).toHaveLength(1)
    expect(written).not.toContain('--files-modified "path/a,path/b"')
  })
  it('초기 프롬프트가 spec의 절대경로를 담고 앞슬래시만 쓴다 — 워커가 Bash로도 다룬다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir })
    const prompt = (deps.spawned[0] as { initialPrompt: string }).initialPrompt
    expect(prompt).toContain(posix(r.specPath))
    expect(prompt).toContain(posix(specsDir)) // 상대경로가 아니다
    // `\`는 셸의 이스케이프 문자다 (shuttle.ts forSh와 같은 규칙)
    expect(prompt).not.toContain('\\')
    expect(deps.written).toEqual([]) // 타이핑하지 않는다
  })
  // 워커는 기존 세션 탭으로 뜨고 탭 제목만 task.title을 쓴다. 배선이 이 값을
  // SessionManager.spawn의 title로 넘긴다 — 빠뜨리면 워커 탭이 worktree basename으로 떠서
  // 사용자가 어느 작업의 워커인지 구별할 수 없다
  it('탭 제목용으로 task title을 spawnSession에 그대로 넘긴다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.startWorker({ ...baseArgs(), runCwd: dir })
    expect((deps.spawned[0] as { title: string }).title).toBe('인증 리팩터')
  })
  it('--terminal 재사용 경로는 세션을 새로 띄우지 않고 PTY로 주입한다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.startWorker({
      ...baseArgs('dsp_2', 'tsk_2'),
      runCwd: dir,
      terminal: 'sess1',
      terminalCwd: dir
    })
    expect(deps.spawned).toHaveLength(0) // 새로 띄우지 않았다
    expect(deps.written.join('')).toContain(posix(specsDir))
    expect(deps.written.join('')).toContain('\r')
  })
  it('worktree new 면 worktree를 만들고 그 경로를 cwd로 쓴다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({
      ...baseArgs(),
      runCwd: dir,
      worktree: 'new',
      name: 'auth'
    })
    expect(r.cwd).toContain('wt-auth')
  })
  it('경로로 주어진 worktree가 실제로 존재하면 그 경로를 cwd로 쓴다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, worktree: dir })
    expect(r.cwd).toBe(dir)
  })
  it('계정의 provider가 --agent와 다르면 거부한다', async () => {
    const deps = { ...makeDeps(), accountProvider: () => 'claude' as const }
    const co = new OrchCoordinator(deps)
    await expect(co.startWorker({ ...baseArgs(), runCwd: dir })).rejects.toThrow(/provider/)
  })
})

// committing은 a.worktree가 아니라 확정된 cwd에서 유도한다(coordinator.ts의 startWorker 안,
// buildSpecFile 호출 앞 — cwd !== a.runCwd, isSamePath로 비교). a.worktree로 유도했다면 이
// describe의 마지막 두 테스트가 실패했을 것이다 — --terminal 재사용은 cwd를 a.terminalCwd로
// 정하면서 a.worktree를 완전히 무시하므로(위 cwd 대입문 참고), 워크트리 세션을 --worktree를
// 다시 주지 않고 재사용하면(그것이 server.ts 의 handleCommand — worker-start 분기 — 의 기본값 'current' 때문에 자연스러운 호출
// 모양이다) a.worktree만 보는 유도는 워크트리에서 도는 워커의 커밋 의무를 빠뜨린다 — 이 Task가
// 막으려던 실패 모드 그대로다.
describe('OrchCoordinator.startWorker — committing은 확정된 cwd에서 유도한다', () => {
  it("worktree: 'current'면 커밋 의무 절이 없다", async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, worktree: 'current' })
    expect(await fs.readFile(r.specPath, 'utf8')).not.toContain('git commit')
  })
  it("worktree: 'new'면 커밋 의무 절이 있다", async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, worktree: 'new', name: 'auth' })
    expect(await fs.readFile(r.specPath, 'utf8')).toContain('git commit')
  })
  it('명시 경로 worktree(프로젝트 폴더가 아닌 경로)면 커밋 의무 절이 있다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const sub = path.join(dir, 'repo')
    await fs.mkdir(sub)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, worktree: sub })
    expect(await fs.readFile(r.specPath, 'utf8')).toContain('git commit')
  })
  it('--terminal 재사용이고 그 세션의 cwd가 워크트리(runCwd와 다름)면, --worktree를 다시 주지 않아도 커밋 의무가 있다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({
      ...baseArgs(), // worktree: 'current' 그대로 — 재사용 호출이 자연스럽게 이 모양이다
      runCwd: dir,
      terminal: 'sess1',
      terminalCwd: path.join(dir, 'wt-existing') // runCwd와 다른 폴더
    })
    expect(await fs.readFile(r.specPath, 'utf8')).toContain('git commit')
  })
  it('--terminal 재사용이고 그 세션의 cwd가 runCwd와 같으면 커밋 의무가 없다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({
      ...baseArgs(),
      runCwd: dir,
      terminal: 'sess1',
      terminalCwd: dir
    })
    expect(await fs.readFile(r.specPath, 'utf8')).not.toContain('git commit')
  })
})

// spec 위치는 주입값이고 cwd와 무관하다. 그리고 프롬프트에 절대경로가 들어가면서
// LAUNCH_FORBIDDEN 검사의 전제가 바뀌었다 — 예전엔 앱이 만든 hex id만 실려 발화 불가능했지만,
// 이제 사용자명이 든 경로가 실린다(Windows 사용자명에는 `&`·`^`가 올 수 있다).
describe('OrchCoordinator.startWorker — spec 위치와 금지 문자', () => {
  it('네 경로 모두 spec을 같은 specsDir에 만든다 — cwd와 무관하다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const sub = path.join(dir, 'repo')
    await fs.mkdir(sub)
    const rs = [
      await co.startWorker({ ...baseArgs('dsp_a'), runCwd: dir, worktree: 'new', name: 'auth' }),
      await co.startWorker({ ...baseArgs('dsp_b'), runCwd: dir, worktree: 'current' }),
      await co.startWorker({ ...baseArgs('dsp_c'), runCwd: dir, worktree: sub }),
      await co.startWorker({
        ...baseArgs('dsp_d'),
        runCwd: dir,
        terminal: 'sess1',
        terminalCwd: sub
      })
    ]
    expect(rs.map((r) => path.dirname(r.specPath))).toEqual([specsDir, specsDir, specsDir, specsDir])
    expect((await fs.readdir(specsDir)).sort()).toEqual([
      'tsk_1-dsp_a.md',
      'tsk_1-dsp_b.md',
      'tsk_1-dsp_c.md',
      'tsk_1-dsp_d.md'
    ])
    // cwd로 쓰인 두 실디렉토리에는 아무것도 남지 않았다 (wt-auth는 스텁이 만들지 않는다)
    expect(await fs.readdir(sub)).toEqual([])
    expect(await fs.readdir(dir)).toEqual(['repo'])
  })

  it('specsDir에 금지 문자가 있으면 side effect 전에 던진다 — worktree도 spec 파일도 만들지 않는다', async () => {
    const deps = { ...makeDeps(), specsDir: path.join(dir, 'A&B', 'specs') }
    const co = new OrchCoordinator(deps)
    await expect(
      co.startWorker({ ...baseArgs(), runCwd: dir, worktree: 'new', name: 'auth' })
    ).rejects.toThrow(/forbidden/)
    expect(deps.worktrees).toEqual([]) // createWorktree 호출 0회
    expect(deps.spawned).toEqual([])
    expect(deps.written).toEqual([])
    expect(await fs.readdir(dir)).toEqual([]) // spec 파일도, 그 부모 디렉토리도 만들지 않았다
  })

  it('에러 메시지가 문제 문자와 그것이 경로에서 왔다는 것을 담는다', async () => {
    const deps = { ...makeDeps(), specsDir: path.join(dir, 'A&B', 'specs') }
    const co = new OrchCoordinator(deps)
    // 프롬프트 덤프만으로는 사용자가 `C:\Users\A&B\...` 때문임을 알 수 없다
    await expect(co.startWorker({ ...baseArgs(), runCwd: dir })).rejects.toThrow(/&/)
    await expect(co.startWorker({ ...baseArgs(), runCwd: dir })).rejects.toThrow(/specsDir=/)
  })
})

describe('OrchCoordinator.startWorker — 재사용 주입과 busy 판정 (tri-state)', () => {
  it('isBusy가 null이면(판정 불가) 가드 없이 즉시 주입한다', async () => {
    let busyCalls = 0
    const deps = {
      ...makeDeps(),
      isBusy: () => {
        busyCalls++
        return null
      }
    }
    const co = new OrchCoordinator(deps)
    await co.startWorker({ ...baseArgs(), runCwd: dir, terminal: 'sess1', terminalCwd: dir })
    expect(busyCalls).toBe(1) // 한 번만 확인하고 대기 루프 없이 바로 주입
    expect(deps.written.join('')).toContain(posix(specsDir))
  })

  it('isBusy가 false면 즉시 주입한다', async () => {
    let busyCalls = 0
    const deps = {
      ...makeDeps(),
      isBusy: () => {
        busyCalls++
        return false
      }
    }
    const co = new OrchCoordinator(deps)
    await co.startWorker({ ...baseArgs(), runCwd: dir, terminal: 'sess1', terminalCwd: dir })
    expect(busyCalls).toBe(1)
    expect(deps.written.join('')).toContain(posix(specsDir))
  })

  it('isBusy가 true면 유휴 전환까지 대기한 뒤 주입한다', async () => {
    let busyCalls = 0
    const deps = {
      ...makeDeps(),
      isBusy: () => {
        busyCalls++
        return busyCalls <= 2 // 처음 두 번은 busy, 세 번째부터 idle
      }
    }
    const co = new OrchCoordinator(deps)
    await co.startWorker({ ...baseArgs(), runCwd: dir, terminal: 'sess1', terminalCwd: dir })
    expect(busyCalls).toBeGreaterThanOrEqual(3) // idle로 판정될 때까지 반복 확인했다
    expect(deps.written.join('')).toContain(posix(specsDir))
    expect(deps.written.join('')).toContain('\r')
  })

  it('isBusy가 상한을 넘겨도 계속 true면 포기하지 않고 주입하며 로그를 남긴다 (Important 1)', async () => {
    const deps = { ...makeDeps(), isBusy: () => true, idleWaitTimeoutMs: 80 }
    const co = new OrchCoordinator(deps)
    await co.startWorker({ ...baseArgs(), runCwd: dir, terminal: 'sess1', terminalCwd: dir })
    expect(deps.written.join('')).toContain(posix(specsDir))
    expect(deps.written.join('')).toContain('\r')
    expect(deps.logs.some((m) => m.includes('timed out'))).toBe(true)
  })
})

describe('OrchCoordinator.startWorker — 재사용 대상 세션이 죽어 있으면 거부한다 (Important 2)', () => {
  it('isAlive가 false면 던지고 아무것도 쓰지 않는다', async () => {
    const deps = { ...makeDeps(), isAlive: () => false }
    const co = new OrchCoordinator(deps)
    await expect(
      co.startWorker({ ...baseArgs(), runCwd: dir, terminal: 'sess1', terminalCwd: dir })
    ).rejects.toThrow(/not alive/)
    expect(deps.written).toEqual([])
  })
})

describe('OrchCoordinator.startWorker — 존재하지 않는 --worktree 경로는 거부한다 (Important 4)', () => {
  it('경로가 존재하지 않으면 던지고, mkdir({recursive:true})로 실체화하지 않는다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const missing = path.join(dir, 'does', 'not', 'exist')
    await expect(co.startWorker({ ...baseArgs(), runCwd: dir, worktree: missing })).rejects.toThrow(
      /does not exist/
    )
    const stat = await fs.stat(missing).catch(() => null)
    expect(stat).toBeNull() // CWD_MISSING 가드를 무력화하지 않는다 — 실체화되지 않았다
  })
})

describe('OrchCoordinator.startWorker — --terminal의 provider·account 불일치를 거부한다 (Important 5)', () => {
  it('terminalProvider가 --agent와 다르면 거부한다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await expect(
      co.startWorker({
        ...baseArgs(),
        runCwd: dir,
        terminal: 'sess1',
        terminalCwd: dir,
        terminalProvider: 'claude'
      })
    ).rejects.toThrow(/terminal provider mismatch/)
  })
  it('terminalAccountId가 --account와 다르면 거부한다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await expect(
      co.startWorker({
        ...baseArgs(),
        runCwd: dir,
        terminal: 'sess1',
        terminalCwd: dir,
        terminalAccountId: 'acc2'
      })
    ).rejects.toThrow(/terminal account mismatch/)
  })
})

describe('OrchCoordinator.releaseWorker', () => {
  it('retained가 아니고 최신 소유자면 killSession을 부른다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.releaseWorker({ sessionId: 'sess1', retained: false, isLatestOwner: true })
    expect(deps.killed).toEqual(['sess1'])
  })
  it('retained면 닫지 않고 그 사실을 로그에 남긴다', async () => {
    // 조용한 조기 반환이었을 때는 "세션은 살아 있는데 오케스트레이터는 정리됐다고 믿는" 상태가
    // 아무 흔적도 남기지 않았다 — 사용자 화면이 없는 경로라 로그가 유일한 흔적이다.
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.releaseWorker({ sessionId: 'sess1', retained: true, isLatestOwner: true })
    expect(deps.killed).toEqual([])
    expect(deps.logs).toHaveLength(1)
    expect(deps.logs[0]).toContain('sess1')
    expect(deps.logs[0]).toContain('retained')
  })
  it('최신 소유자가 아니면 닫지 않는다 — 재사용된 세션은 더 최신 Dispatch가 소유한다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.releaseWorker({ sessionId: 'sess1', retained: false, isLatestOwner: false })
    expect(deps.killed).toEqual([])
  })
})
