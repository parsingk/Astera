import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OrchCoordinator,
  buildSpecFile,
  buildReviewSpecFile,
  launchPrompt,
  repairWorkerPrompt,
  knowledgeIn,
  LAUNCH_FORBIDDEN,
  type CoordinatorDeps
} from './coordinator'
import type { CheckResult, ReviewIssue } from '../../core/orchestration/types'

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
  // 그 계정 하나짜리 체인 — 배선이 Task.accountIds 로 더 긴 체인을 만들 수 있다(아래 통과 테스트)
  rollAccountIds: ['acc1'],
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
  // 지식이 없는 저장소에서 spec 이 조금이라도 달라지면, 이 기능이 없던 때의 동작을 바꾼 것이다 —
  // 그 비교가 이 절의 유일한 회귀 방어다
  it('지식이 없으면 spec 이 한 글자도 달라지지 않는다', () => {
    const base = buildSpecFile({ title: 'T', spec: 'S', taskId: 'tsk_1', dispatchId: 'dsp_1' })
    const empty = buildSpecFile({
      title: 'T',
      spec: 'S',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      knowledge: { paths: [], more: 0 }
    })
    expect(empty).toBe(base)
    // 위 비교만으로는 부족하다 — 두 호출이 같은 분기를 지나므로 삽입 지점에 줄바꿈이 **대칭으로**
    // 새면 양쪽이 똑같이 틀린 문자열을 내고 통과한다. 그래서 그 지점의 줄바꿈 수를 직접 고정한다.
    expect(base).toContain('S\n\n---\n## Reporting obligation')
  })

  it('지식이 있으면 상대 경로를 목록으로 적는다', () => {
    const out = buildSpecFile({
      title: 'T',
      spec: 'S',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      knowledge: { paths: ['knowledge/decisions/ADR-001-x.md', 'docs/adr/002.md'], more: 0 }
    })
    expect(out).toContain('knowledge/decisions/ADR-001-x.md')
    expect(out).toContain('docs/adr/002.md')
    // 워커가 지워 낼 수 없는 글이라는 표시 — 다른 두 절과 같은 문구다
    expect(out).toContain('assembled by the app — do not delete')
  })

  // 자리가 뜻을 정한다: 무엇을 하는 일인지 읽은 다음에 "이 프로젝트의 결정은 여기 있다"가 와야
  // 쓸모가 있고, 커밋·보고 의무보다는 앞이어야 한다
  it('spec 본문 뒤, 커밋 의무 앞에 온다', () => {
    const out = buildSpecFile({
      title: 'T',
      spec: 'SPEC_BODY',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      committing: true,
      knowledge: { paths: ['knowledge/a.md'], more: 0 }
    })
    expect(out.indexOf('SPEC_BODY')).toBeLessThan(out.indexOf('knowledge/a.md'))
    expect(out.indexOf('knowledge/a.md')).toBeLessThan(out.indexOf('Commit obligation'))
  })

  // 조용히 자르면 그 목록이 "이게 전부"로 읽힌다
  it('잘렸으면 남은 개수를 적는다', () => {
    const out = buildSpecFile({
      title: 'T',
      spec: 'S',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      knowledge: { paths: ['knowledge/a.md'], more: 12 }
    })
    expect(out).toContain('12')
  })
})

describe('buildReviewSpecFile', () => {
  // 이 기능이 있는 이유는 에이전트가 이미 닫힌 결정을 다시 열지 않게 하는 것이고, **닫힌 결정이
  // 다시 열렸는지 잡는 것이 바로 검토자의 일**이다. 검토자에게만 그 목록을 주지 않으면 그 자리가 빈다
  it('프로젝트의 결정 목록을 싣는다', () => {
    const md = buildReviewSpecFile({
      resultPath: 'C:/u/dsp.md.review.json',
      title: 'T',
      spec: 's',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      validated: false,
      knowledge: { paths: ['knowledge/decisions/ADR-004-x.md'], more: 0 }
    })
    expect(md).toContain('knowledge/decisions/ADR-004-x.md')
    expect(md).toContain('assembled by the app — do not delete')
  })

  // 구현자용 문구와 **같지 않아야 한다**. 구현자는 "고치기 전에 읽어라"를 받고, 검토자는 "닫힌 결정을
  // 다시 열었으면 그것이 결함이다"를 받아야 한다 — 같은 글을 두 번 쓰면 이 자리의 값이 사라진다
  it('검토자에게는 구현자와 다른 지시를 준다', () => {
    const md = buildReviewSpecFile({
      resultPath: 'C:/u/dsp.md.review.json',
      title: 'T',
      spec: 's',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      validated: false,
      knowledge: { paths: ['knowledge/a.md'], more: 0 }
    })
    expect(md).not.toContain('before** you change anything')
    expect(md.toLowerCase()).toContain('reopen')
  })

  // 절 제목으로 본다 — 'project' 같은 흔한 낱말로 보면 다른 문장이 그것을 담게 되는 날 조용히
  // 통과한다(이 파일의 validated 분기가 이미 "The project's own build/test configuration" 을 적는다)
  it('지식이 없으면 그 절이 아예 없다', () => {
    const md = buildReviewSpecFile({ resultPath: 'C:/u/dsp.md.review.json', title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).not.toContain("## The project's own decisions")
  })

  it('원래 Task 의 요구를 판정 기준으로 싣는다', () => {
    const md = buildReviewSpecFile({ resultPath: 'C:/u/dsp.md.review.json', title: 'T', spec: '요구 본문', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('요구 본문')
  })

  it('구현자가 보고한 것과 바꾼 파일을 싣는다', () => {
    const md = buildReviewSpecFile({
      resultPath: 'C:/u/dsp.md.review.json',
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
    const md = buildReviewSpecFile({ resultPath: 'C:/u/dsp.md.review.json', title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: true })
    expect(md).toContain('it passed')
    expect(md).toContain('is settled')
  })

  it('검증이 없었으면 통과했다고 말하지 않는다', () => {
    const md = buildReviewSpecFile({ resultPath: 'C:/u/dsp.md.review.json', title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('No automated validation was attached')
    expect(md).not.toContain('is settled')
    expect(md).not.toContain('it passed')
  })

  // 이 둘이 이 파일의 존재 이유다
  it('볼 것이 "요구가 충족됐는가" 하나임을 못박는다', () => {
    const md = buildReviewSpecFile({ resultPath: 'C:/u/dsp.md.review.json', title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('Was the requirement above satisfied?')
    expect(md).toContain('not grounds for rejecting the work')
  })
  it('코드를 바꾸지 말라고 못박는다', () => {
    const md = buildReviewSpecFile({ resultPath: 'C:/u/dsp.md.review.json', title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_1', validated: false })
    expect(md).toContain('Do not change any code.')
  })

  it('자기 dispatch id 로 보고하게 한다', () => {
    const md = buildReviewSpecFile({ resultPath: 'C:/u/dsp.md.review.json', title: 'T', spec: 's', taskId: 'tsk_1', dispatchId: 'dsp_review', validated: false })
    expect(md).toContain('dsp_review')
    expect(md).toContain('--task-id tsk_1')
  })
})

describe('knowledgeIn', () => {
  let tmpDir: string
  const log = (): void => {} // 이 describe의 케이스들은 시간 제한 안에서 끝난다 — 호출되면 안 된다
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-knowledge-'))
  })

  it('convention directory의 파일과 한 층 아래 파일은 상대 경로(슬래시)로 찾는다', async () => {
    // 실제로는 `C:\Users\...` 같은 역슬래시가 있어도 forward slash로 적혀야 한다
    await fs.mkdir(path.join(tmpDir, 'knowledge'))
    await fs.mkdir(path.join(tmpDir, 'knowledge', 'decisions'))
    await fs.writeFile(path.join(tmpDir, 'knowledge', 'README.md'), 'root', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'knowledge', 'decisions', 'ADR-001-x.md'), 'adr', 'utf8')

    const result = await knowledgeIn(tmpDir, log)
    // 정렬되고 exact match — 역슬래시도 절대 경로도 없어야 한다
    expect(result.paths).toEqual(['knowledge/README.md', 'knowledge/decisions/ADR-001-x.md'])
    expect(result.more).toBe(0)
  })

  it('convention directory 아래 두 층은 걷지 않는다', async () => {
    // 내부 루프는 `f.isFile()`만 테스트하므로, 그 한 층 아래의 디렉터리는 걸리지 않는다
    await fs.mkdir(path.join(tmpDir, 'knowledge', 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'knowledge', 'a', 'b', 'deep.md'), 'deep', 'utf8')

    const result = await knowledgeIn(tmpDir, log)
    expect(result.paths).toEqual([])
    expect(result.more).toBe(0)
  })

  it('convention directory가 전혀 없으면 빈 결과를 반환한다', async () => {
    // readdir이 모두 실패하면 빈 목록으로 접힌다
    const result = await knowledgeIn(tmpDir, log)
    expect(result).toEqual({ paths: [], more: 0 })
  })

  it('여러 convention directory를 합친다', async () => {
    await fs.mkdir(path.join(tmpDir, 'knowledge'))
    await fs.mkdir(path.join(tmpDir, 'docs', 'adr'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'knowledge', 'x.md'), 'k', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'docs', 'adr', 'y.md'), 'a', 'utf8')

    const result = await knowledgeIn(tmpDir, log)
    // knowledgeFilesFrom가 정렬하므로 둘 다 나오고 정렬된 순서다
    expect(result.paths).toEqual(['docs/adr/y.md', 'knowledge/x.md'])
    expect(result.more).toBe(0)
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
      resultPath: 'C:/u/dsp.md.review.json',
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
  // 한도에 걸린 워커가 스스로 이어지게 하려면 spawnSession이 롤링 코디네이터에 등록할 체인을
  // 받아야 한다. 코디네이터는 그 체인을 **정하지 않고 순서대로 그대로 넘긴다** — 무엇이 그 목록이
  // 되는지는 배선이 정한다(Task.accountIds 를 읽는 ipc.ts의 deps.startWorker 래퍼).
  it('받은 롤링 체인을 순서대로 spawnSession에 넘긴다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.startWorker({ ...baseArgs(), rollAccountIds: ['acc1', 'acc2'], runCwd: dir })
    expect((deps.spawned[0] as { rollAccountIds?: string[] }).rollAccountIds).toEqual([
      'acc1',
      'acc2'
    ])
  })
  // 재개 문구. 넘기지 않으면 롤링이 앱의 **UI 언어** 기본값을 타이핑한다 — 영어로 지시받은 워커가
  // 다른 언어로 재개되고, 그 문구는 "계속하라"라서 보고 의무를 상기시키지 않는다.
  it('워커 세션에 워커용 재개 문구를 넘긴다 — 보고 명령과 식별자를 담는다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.startWorker({ ...baseArgs(), runCwd: dir })
    const p = (deps.spawned[0] as { rollPrompt?: string }).rollPrompt ?? ''
    expect(p).toContain('worker_done')
    expect(p).toContain('--task-id tsk_1')
    expect(p).toContain('--dispatch-id dsp_1')
    // codex 는 이 문구를 CLI 인자로 넘긴다 — 론치 프롬프트와 같은 금지 문자 규칙을 받는다
    expect(p).not.toMatch(LAUNCH_FORBIDDEN)
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

  // makeDeps().createWorktree 는 디스크에 아무것도 만들지 않는 경로를 돌려준다 — 그래서 이 파일의
  // 다른 startWorker 테스트는 모두 빈 knowledge 분기만 지난다. knowledgeIn 이 runCwd 가 아니라
  // 워커의 cwd 를 훑는다는 것(coordinator.ts의 knowledgeIn 주석이 적어 둔 그 결정)은 그 테스트들
  // 중 어느 것도 확인하지 못한다 — 그 결정이 뒤집혀도 통과한다.
  it('워크트리에 있는 지식 파일이 spec 에 상대 경로로 실린다 — 훑는 뿌리가 runCwd 아니라 cwd 다', async () => {
    // wt 를 워커의 cwd 로 쓰고 runCwd 는 그와 **다른** 빈 디렉토리로 둔다. 둘이 같으면 knowledgeIn
    // 이 cwd 를 훑는지 runCwd 를 훑는지 이 테스트로는 구별할 수 없다 — 어느 쪽을 훑어도 같은
    // knowledge/a.md 를 찾아 통과해 버린다. 다르게 둬야만 "cwd 를 훑는다"는 주장이 실제로 검증된다.
    const wt = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-knowledge-wt-'))
    await fs.mkdir(path.join(wt, 'knowledge'))
    await fs.writeFile(path.join(wt, 'knowledge', 'a.md'), 'decision', 'utf8')

    const deps = { ...makeDeps(), createWorktree: async () => ({ path: wt }) }
    const co = new OrchCoordinator(deps)
    // runCwd: dir 는 beforeEach 가 만든 빈 임시 디렉토리다 — knowledge/ 가 없다. worktree: 'new' 라서
    // createWorktree 가 워커의 cwd 를 정하고, 위 stub 이 그것을 wt 로 고정한다.
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, worktree: 'new', name: 'auth' })

    const written = await fs.readFile(r.specPath, 'utf8')
    expect(written).toContain('knowledge/a.md')
  })

  it('reports the prompt hand-off around a spawn: requested, then confirmed, via argv', async () => {
    const deps = makeDeps()
    const seen: Array<{ phase: string; via: string; promptLength: number; dispatchId: string }> = []
    const co = new OrchCoordinator({
      ...deps,
      onPromptWrite: (e) => seen.push({ phase: e.phase, via: e.via, promptLength: e.promptLength, dispatchId: e.dispatchId })
    })
    await co.startWorker({
      dispatchId: 'dsp_1',
      taskId: 'tsk_1',
      title: 't',
      spec: 's',
      provider: 'codex',
      accountId: 'acc',
      rollAccountIds: ['acc'],
      runCwd: dir,
      worktree: 'current'
    })
    expect(seen.map((s) => s.phase)).toEqual(['requested', 'confirmed'])
    expect(seen.every((s) => s.via === 'argv' && s.dispatchId === 'dsp_1' && s.promptLength > 0)).toBe(true)
    expect(deps.spawned).toHaveLength(1)
  })

  it('reports the prompt hand-off around a typed prompt for a reused terminal', async () => {
    const deps = makeDeps()
    const seen: string[] = []
    const co = new OrchCoordinator({ ...deps, onPromptWrite: (e) => seen.push(`${e.phase}:${e.via}`) })
    await co.startWorker({
      dispatchId: 'dsp_1',
      taskId: 'tsk_1',
      title: 't',
      spec: 's',
      provider: 'codex',
      accountId: 'acc',
      rollAccountIds: ['acc'],
      runCwd: dir,
      worktree: 'current',
      terminal: 'sess-live',
      terminalCwd: dir,
      terminalProvider: 'codex',
      terminalAccountId: 'acc'
    })
    expect(seen).toEqual(['requested:typed', 'confirmed:typed'])
    expect(deps.written).toHaveLength(2)
    expect(deps.written[1]).toBe('\r')
  })

  it('resumes the provider session and names the new dispatch in the phrase', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.startWorker({
      dispatchId: 'dsp_new',
      taskId: 'tsk_1',
      title: 't',
      spec: 's',
      provider: 'codex',
      accountId: 'acc',
      rollAccountIds: ['acc'],
      runCwd: dir,
      worktree: 'current',
      resume: { nativeSessionId: 'native-uuid' }
    })
    const spawned = deps.spawned[0] as { resumeSessionId?: string; resumePrompt?: string; initialPrompt?: string }
    expect(spawned.resumeSessionId).toBe('native-uuid')
    // codex takes the phrase as resumePrompt; claude takes it as the positional initialPrompt
    expect(spawned.resumePrompt).toContain('dsp_new')
    expect(spawned.resumePrompt).toContain('tsk_1')
  })

  it('gives claude the phrase as its initial prompt', async () => {
    const deps = makeDeps()
    deps.accountProvider = () => 'claude'
    const co = new OrchCoordinator(deps)
    await co.startWorker({
      dispatchId: 'dsp_new',
      taskId: 'tsk_1',
      title: 't',
      spec: 's',
      provider: 'claude',
      accountId: 'acc',
      rollAccountIds: ['acc'],
      runCwd: dir,
      worktree: 'current',
      resume: { nativeSessionId: 'native-uuid' }
    })
    const spawned = deps.spawned[0] as { resumeSessionId?: string; resumePrompt?: string; initialPrompt: string }
    expect(spawned.resumeSessionId).toBe('native-uuid')
    expect(spawned.initialPrompt).toContain('dsp_new')
    expect(spawned.resumePrompt).toBeUndefined()
  })

  it('writes the briefing into the spec file before the agent is launched', async () => {
    const deps = makeDeps()
    let specWhenSpawned = ''
    const spawnSession = deps.spawnSession
    deps.spawnSession = async (o) => {
      specWhenSpawned = await fs.readFile(path.join(specsDir, 'tsk_1-dsp_new.md'), 'utf8')
      return spawnSession(o)
    }
    const co = new OrchCoordinator(deps)
    await co.startWorker({
      dispatchId: 'dsp_new',
      taskId: 'tsk_1',
      title: 't',
      spec: 's',
      provider: 'codex',
      accountId: 'acc',
      rollAccountIds: ['acc'],
      runCwd: dir,
      worktree: 'current',
      resume: { briefing: 'PREVIOUS ATTEMPT: it got as far as X' }
    })
    expect(specWhenSpawned).toContain('PREVIOUS ATTEMPT: it got as far as X')
    expect(specWhenSpawned).toContain('Resume briefing')
  })

  it('an ordinary start is unchanged', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.startWorker({
      dispatchId: 'dsp_1', taskId: 'tsk_1', title: 't', spec: 's', provider: 'codex',
      accountId: 'acc', rollAccountIds: ['acc'], runCwd: dir, worktree: 'current'
    })
    const spawned = deps.spawned[0] as { resumeSessionId?: string; initialPrompt: string }
    expect(spawned.resumeSessionId).toBeUndefined()
    expect(spawned.initialPrompt).toContain('Read ')
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

describe('buildSpecFile — repair 절', () => {
  const checks: CheckResult[] = [
    { configId: 'c1', name: 'Typecheck', status: 'passed', exitCode: 0 },
    { configId: 'c2', name: 'Unit tests', status: 'failed', exitCode: 1, outputTail: 'FAIL logout.test.ts\n  ● should invalidate' },
    { configId: 'c3', name: 'Build', status: 'not-run' }
  ]
  const issues: ReviewIssue[] = [
    { id: 'rvw_1', severity: 'high', blocking: true, title: 'Session race', description: 'two writers', file: 'src/auth/session.ts', line: 42, suggestedFix: 'lock' },
    { id: 'rvw_2', severity: 'low', blocking: false, title: 'naming', description: 'nit' }
  ]
  it('check 실패를 이름·exit·출력 꼬리와 함께 싣고 not-run 을 말한다', () => {
    const spec = buildSpecFile({ title: 'T', spec: 'do', taskId: 'tsk_1', dispatchId: 'dsp_2', repair: { reason: 'check-failure', repair: 1, maxFixAttempts: 3, checks } })
    expect(spec).toContain('## Repair request (assembled by the app — do not delete)')
    expect(spec).toContain('This is repair 1 of 3')
    expect(spec).toContain('"Unit tests" — exit 1')
    expect(spec).toContain('● should invalidate')
    expect(spec).toContain('"Build" — not run')
    expect(spec).not.toContain('"Typecheck" — exit')
    expect(spec.indexOf('## Repair request')).toBeLessThan(spec.indexOf('## Reporting obligation'))
    expect(spec).toContain('--dispatch-id dsp_2')
    // reason 이 실제로 쓰인다 — 필드만 받고 버려지지 않는다
    expect(spec).toContain('a completion check failed')
  })
  it('blocking 이슈만 싣고 non-blocking 은 싣지 않는다', () => {
    const spec = buildSpecFile({ title: 'T', spec: 'do', taskId: 'tsk_1', dispatchId: 'dsp_3', repair: { reason: 'review-failure', repair: 2, maxFixAttempts: 3, issues } })
    // 줄 번호 인용 금지 가드(lineNumberCitations.test.ts) 를 피하려고 템플릿 보간으로 짓는다 —
    // 리터럴로 쓰면 파일명 뒤에 콜론과 줄 번호가 곧바로 붙는 모양이 소스에 그대로 남는다.
    expect(spec).toContain(`1. HIGH — Session race — ${issues[0].file}:${issues[0].line}`)
    expect(spec).toContain('Suggested fix: lock')
    expect(spec).not.toContain('naming')
    // review-failure 는 check-failure 와 다른 문구를 받는다
    expect(spec).toContain('review found blocking issues')
  })
  it('계약 문구를 싣는다 — 테스트를 지우거나 약화하지 말고 완료를 선언하지 말라', () => {
    const spec = buildSpecFile({ title: 'T', spec: 'do', taskId: 'tsk_1', dispatchId: 'dsp_2', repair: { reason: 'check-failure', repair: 1, maxFixAttempts: 3, checks } })
    expect(spec).toContain('Do not remove, skip or weaken failing tests')
    expect(spec).toContain('Astera, not you, decides whether the completion conditions are met')
    expect(spec).toContain('smallest correct change')
    // 리뷰 fix 1차, Important 5 — 전에 빠졌던 두 anti-gaming 문구와, 그 문구의 이름이 약속하는
    // "완료를 선언하지 말라"는 리터럴 문장
    expect(spec).toContain('Do not disable lint rules')
    expect(spec).toContain('change how the checks run')
    expect(spec).toContain('Do not declare the task complete in your report')
    // Important 4 — "이 수리 시도는 succeeded 로 보고하라"와 "task 자체는 완료가 아니다"를
    // 갈라 놓는 절. 안 그러면 fix를 했어도 --outcome failed 로 보고해 재검증을 건너뛰고 task 가
    // 그대로 실패로 끝난다.
    expect(spec).toContain('Report `--outcome succeeded` for this repair attempt')
  })
  it('repair 가 없으면 파일이 지금과 같다', () => {
    const a = buildSpecFile({ title: 'T', spec: 'do', taskId: 'tsk_1', dispatchId: 'dsp_1' })
    expect(a).not.toContain('Repair request')
  })
  // Minor: 이름 것이 없으면(check 전부 통과, issue 전부 non-blocking) "무엇이 실패했다" 절 자체가
  // 아무것도 이름 없이 뜨는 것보다, 절이 없는 것이 낫다.
  it('실패한 check 도 blocking 이슈도 없으면 절 자체를 붙이지 않는다', () => {
    const spec = buildSpecFile({
      title: 'T',
      spec: 'do',
      taskId: 'tsk_1',
      dispatchId: 'dsp_9',
      repair: {
        reason: 'check-failure',
        repair: 1,
        maxFixAttempts: 3,
        checks: [{ configId: 'c1', name: 'Typecheck', status: 'passed' }],
        issues: [{ id: 'rvw_9', severity: 'low', blocking: false, title: 'naming', description: 'nit' }]
      }
    })
    expect(spec).not.toContain('Repair request')
  })
  // Minor: outputTail 이 없으면 "Output tail:" 뒤에 빈 들여쓰기 줄이 남지 않는다
  it('outputTail 이 없는 실패 check 는 빈 Output tail 줄을 만들지 않는다', () => {
    const spec = buildSpecFile({
      title: 'T',
      spec: 'do',
      taskId: 'tsk_1',
      dispatchId: 'dsp_9',
      repair: {
        reason: 'check-failure',
        repair: 1,
        maxFixAttempts: 3,
        checks: [{ configId: 'c9', name: 'Lint', status: 'failed', exitCode: 2 }]
      }
    })
    expect(spec).toContain('"Lint" — exit 2')
    expect(spec).not.toContain('Output tail:')
  })
  // Minor: 40줄로 자르면 몇 줄이 잘렸는지 표시한다 — 안 그러면 잘린 사실 자체가 안 보인다
  it('출력이 40줄을 넘으면 몇 줄이 잘렸는지 적는다', () => {
    const many = Array.from({ length: 45 }, (_, i) => `line${i}`).join('\n')
    const spec = buildSpecFile({
      title: 'T',
      spec: 'do',
      taskId: 'tsk_1',
      dispatchId: 'dsp_9',
      repair: {
        reason: 'check-failure',
        repair: 1,
        maxFixAttempts: 3,
        checks: [{ configId: 'c9', name: 'Lint', status: 'failed', exitCode: 2, outputTail: many }]
      }
    })
    expect(spec).toContain('(5 earlier line(s) cut)')
    expect(spec).toContain('line44')
    expect(spec).not.toContain('line0')
  })
})

describe('repairWorkerPrompt', () => {
  it('spec 경로를 가리키고 금지 문자를 쓰지 않는다', () => {
    const p = repairWorkerPrompt('C:/u/specs/tsk_1-dsp_2.md')
    expect(p).toContain('C:/u/specs/tsk_1-dsp_2.md')
    expect(p.match(LAUNCH_FORBIDDEN)).toBeNull()
  })
})

describe('buildReviewSpecFile — 수렴 절', () => {
  const base = { title: 'T', spec: 'req', taskId: 'tsk_1', dispatchId: 'dsp_r', validated: true, resultPath: 'C:/u/specs/tsk_1-dsp_r.md.review.json' }
  it('결과 파일 경로와 JSON 모양을 말한다', () => {
    const spec = buildReviewSpecFile(base)
    expect(spec).toContain('## Structured verdict')
    expect(spec).toContain(base.resultPath)
    expect(spec).toContain('"severity"')
    expect(spec).toContain('critical|high|medium|low|info')
  })
  it('통과한 check 이름을 싣는다', () => {
    const spec = buildReviewSpecFile({ ...base, checks: [{ configId: 'c1', name: 'Typecheck', status: 'passed' }, { configId: 'c2', name: 'Tests', status: 'passed' }] })
    expect(spec).toContain('## Checks that ran')
    expect(spec).toContain('- Typecheck')
    expect(spec).toContain('- Tests')
  })
  it('직전 라운드의 blocking 이슈를 "addressed 인지 확인하라" 고 싣는다', () => {
    const spec = buildReviewSpecFile({ ...base, previousIssues: [{ id: 'rvw_1', severity: 'high', blocking: true, title: 'Session race', description: 'd' }, { id: 'rvw_2', severity: 'low', blocking: false, title: 'nit', description: '' }] })
    expect(spec).toContain('## Previous review round')
    expect(spec).toContain('HIGH — Session race')
    expect(spec).not.toContain('nit')
    expect(spec).toContain('verified as addressed')
  })
  it('의심 파일을 먼저 보라고 싣는다', () => {
    const spec = buildReviewSpecFile({ ...base, suspiciousFiles: ['package.json', 'vitest.config.ts'] })
    expect(spec).toContain('## Files that change how the checks run')
    expect(spec).toContain('- package.json')
  })
  it('없는 절은 붙지 않는다', () => {
    const spec = buildReviewSpecFile(base)
    expect(spec).not.toContain('## Checks that ran')
    expect(spec).not.toContain('## Previous review round')
    expect(spec).not.toContain('## Files that change how the checks run')
  })

  // 리뷰 fix 1차, Important 1 — validated:false 는 "빌드·테스트에 대해 아무것도 증명되지 않았다"고
  // 말하는데, checks 에 통과한 것이 있으면 같은 파일 안에서 그 말과 "## Checks that ran" 이 서로
  // 부딪힌다. 그 문장은 checks 가 비었을 때만 나와야 한다 — 호출자가 낡은 validated 값을 줄 수도
  // 있다는 전제(그 자체를 고치는 것은 다른 task 의 일이다).
  it('checks 에 통과한 것이 있으면 validated:false 문장을 억누른다 — 자기 모순을 막는다', () => {
    const spec = buildReviewSpecFile({
      ...base,
      validated: false,
      checks: [{ configId: 'c1', name: 'Typecheck', status: 'passed' }]
    })
    expect(spec).toContain('## Checks that ran')
    expect(spec).not.toContain('No automated validation was attached')
  })
  it('checks 가 없으면 validated:false 문장이 그대로 남는다', () => {
    const spec = buildReviewSpecFile({ ...base, validated: false })
    expect(spec).toContain('No automated validation was attached')
  })
  it('checks 가 전부 not-run/failed 면(통과한 것이 없다) validated:false 문장이 그대로 남는다', () => {
    const spec = buildReviewSpecFile({
      ...base,
      validated: false,
      checks: [{ configId: 'c1', name: 'Typecheck', status: 'failed', exitCode: 1 }]
    })
    expect(spec).not.toContain('## Checks that ran')
    expect(spec).toContain('No automated validation was attached')
  })

  // 리뷰 fix 1차, Important 2 — 파서는 텍스트 전체에 바로 JSON.parse 를 돌린다. 펜스나 산문을
  // 두르면 파싱이 깨지고 Run 이 사람에게 넘어간다. optional 목록도 실제와 맞춘다: title 은
  // parser 가 필수로 요구하고, description 은 optional 이다(review.ts).
  it('결과 파일에는 JSON 만 담으라고 못박고 title 필수·description 선택을 정확히 말한다', () => {
    const spec = buildReviewSpecFile(base)
    expect(spec).toContain('nothing else')
    expect(spec).toContain('no fences, no commentary')
    expect(spec).toContain('`title` is required')
    expect(spec).toContain('`description`')
  })

  // 리뷰 fix 1차, Important 3 — "무엇이 결함으로 치는가"를 먼저 읽어야 "어디에, 어떤 심각도로
  // 적을지"가 뜻을 갖는다. 순서가 뒤집히면 리뷰어가 판정 기준보다 먼저 판정 형식을 듣는다.
  it('Structured verdict 는 "The one question you answer" 뒤에 온다', () => {
    const spec = buildReviewSpecFile(base)
    expect(spec.indexOf('## The one question you answer')).toBeLessThan(spec.indexOf('## Structured verdict'))
    expect(spec.indexOf('## Structured verdict')).toBeLessThan(spec.indexOf('## Reporting obligation'))
  })
})

// 리뷰 fix 1차, Important 6 — launchPhrase 는 지금까지 어떤 테스트도 exercising 하지 않았다. 브리핑이
// 짚은 세 성질: {specPath} 치환, provider-native resume 이 항상 이긴다, LAUNCH_FORBIDDEN 이 치환된
// 문자열을 본다(치환 전 원문이 아니다).
describe('OrchCoordinator.startWorker — launchPhrase', () => {
  it('{specPath} 를 실제 spec 경로로 치환해 쓴다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, launchPhrase: 'Fix it — read {specPath} now' })
    const spawned = deps.spawned[0] as { initialPrompt: string }
    expect(spawned.initialPrompt).toContain(posix(r.specPath))
    expect(spawned.initialPrompt).not.toContain('{specPath}')
    expect(spawned.initialPrompt).toContain('Fix it — read')
  })
  it('provider-native resume 이 항상 launchPhrase 를 이긴다', async () => {
    const deps = makeDeps()
    const co = new OrchCoordinator(deps)
    await co.startWorker({
      ...baseArgs(),
      runCwd: dir,
      launchPhrase: 'Fix it — read {specPath} now',
      resume: { nativeSessionId: 'native-uuid' }
    })
    // baseArgs()의 provider는 codex다 — codex는 재개 문구를 resumePrompt로 받는다
    const spawned = deps.spawned[0] as { resumePrompt?: string; initialPrompt?: string }
    expect(spawned.resumePrompt).toContain('tsk_1')
    expect(spawned.resumePrompt).not.toContain('Fix it')
    expect(spawned.resumePrompt).not.toContain('{specPath}')
  })
  it('LAUNCH_FORBIDDEN 은 치환 전 원문이 아니라 실제로 보내는(치환된) 문자열을 본다', async () => {
    const deps = { ...makeDeps(), specsDir: path.join(dir, 'A&B', 'specs') }
    const co = new OrchCoordinator(deps)
    // launchPhrase 원문 자체에는 금지 문자가 없다 — {specPath} 치환 뒤에야 specsDir의 '&'가 실린다
    await expect(
      co.startWorker({ ...baseArgs(), runCwd: dir, launchPhrase: 'Read {specPath} and fix it' })
    ).rejects.toThrow(/forbidden/)
  })
  // Minor — .replace('{specPath}', specPath) 의 문자열 치환 형태는 replacement 문자열 안의 $&·$`·$'
  // 를 특수 패턴으로 해석해 결과를 깨뜨린다. specPath 는 임의의 파일시스템 경로이고 그 문자들은
  // LAUNCH_FORBIDDEN 에 없다 — split/join 처럼 치환 특수문자를 타지 않는 형태를 써야 한다.
  it('specPath 에 $\' 같은 교체 특수문자가 있어도 깨지지 않는다', async () => {
    const deps = { ...makeDeps(), specsDir: path.join(dir, "$'weird", 'specs') }
    const co = new OrchCoordinator(deps)
    const r = await co.startWorker({ ...baseArgs(), runCwd: dir, launchPhrase: 'Read {specPath} and fix it' })
    const spawned = deps.spawned[0] as { initialPrompt: string }
    expect(spawned.initialPrompt).toBe(`Read ${posix(r.specPath)} and fix it`)
  })
})
